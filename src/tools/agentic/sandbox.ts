/**
 * Path-safety primitives for agentic workspace tools.
 *
 * The `ask_agentic` path exposes Gemini function calls that read arbitrary
 * user-supplied paths. If the model (or a prompt-injected document) smuggles
 * `../../.ssh/id_ed25519` or a symlink pointing outside the workspace, we
 * must reject at every step — not only at schema validation.
 *
 * Two classes of defence:
 *   1. **Structural jail** via `realpath` on BOTH the root and the target.
 *      Prevents symlink escape and `..` traversal. `path.resolve +
 *      startsWith(root)` is NOT safe — a symlink inside the root that points
 *      outside the root will lexically look fine but actually escape.
 *
 *   2. **Content denylist** — even inside the jail, refuse known secret-
 *      bearing filenames (`.env`, `*.pem`, `.ssh/*`, `credentials`…) and
 *      path fragments that match `DEFAULT_EXCLUDE_DIRS` (already covers
 *      `.aws`, `.kube`, `.gnupg`, etc.). Belt and suspenders.
 *
 * Codex PR #20 review #2 flagged that `resolve+startsWith` is symlink-
 * unsafe. This module implements `realpath + root jail` per that feedback.
 */

import { realpath } from 'node:fs/promises';
import { basename, sep as pathSep, relative, resolve } from 'node:path';
import { DEFAULT_EXCLUDE_DIRS, DEFAULT_EXCLUDE_FILE_NAMES_LOWER } from '../../indexer/globs.js';

/** Filename-basename entries that NEVER leak through `read_file`. Even when
 * the path resolves safely under the workspace root, any of these basenames
 * is a hard reject — protects against secrets dropped into the project by
 * the user (`.env.local`) or by dev tooling (`credentials`).
 *
 * Stored in lowercase so the lookup set works on case-insensitive
 * filesystems (macOS APFS, Windows NTFS) where `.ENV` resolves to the same
 * file as `.env`. The `Set` below is built at load time. */
const AGENTIC_SECRET_BASENAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.staging',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.git-credentials',
  '.htpasswd',
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'service-account.json',
];

/** Lowercased `Set` for O(1) case-insensitive basename denylist lookup. */
const AGENTIC_SECRET_BASENAMES_LOWER: ReadonlySet<string> = new Set(
  AGENTIC_SECRET_BASENAMES.map((s) => s.toLowerCase()),
);

/** Extensions that frequently carry sensitive key material. Extra gate on
 * top of `AGENTIC_SECRET_BASENAMES`. Matched via `endsWith(lowerBase, ext)`. */
const AGENTIC_SECRET_EXTENSIONS: readonly string[] = [
  '.pem',
  '.key',
  '.crt',
  '.cer',
  '.p12',
  '.pfx',
  '.p8',
  '.asc',
  '.gpg',
  '.keystore',
  '.jks',
  '.ppk',
  '.ovpn',
];

/**
 * Where each code fires (v1.9.0 — keep this map current as new throw sites
 * are added):
 *
 *   PATH_TRAVERSAL     — sandbox.ts (jail violation: symlink escape, abs path outside)
 *   SECRET_DENYLIST    — sandbox.ts (basename / extension / dir on hardcoded secret list)
 *   EXCLUDED_DIR       — sandbox.ts (DEFAULT_EXCLUDE_DIRS hit, line ~302)
 *                        AND workspace-tools.ts top-level gates (v1.9.0+):
 *                        listDirectoryExecutor + grepExecutor's pathPrefix,
 *                        when the requested dir matches user-supplied excludeGlobs
 *   EXCLUDED_FILE      — workspace-tools.ts (v1.9.0+): readFileExecutor when
 *                        the file is excluded by user globs (filename / extension
 *                        / dir-prefix). Generic message — no path leak.
 *   EXCLUDED_FILENAME  — sandbox.ts (DEFAULT_EXCLUDE_FILE_NAMES hit, line ~321)
 *   NON_SOURCE_FILE    — workspace-tools.ts: readFileExecutor when no
 *                        include-extension matches (path retained — different
 *                        threat model from EXCLUDED_FILE)
 *   NOT_A_DIRECTORY    — workspace-tools.ts (listDir / grep when target is a file)
 *   NOT_FOUND          — sandbox.ts (resolveInsideWorkspace, missing path)
 *                        AND workspace-tools.ts (executor-side fs errors)
 *   NOT_INSIDE_ROOT    — sandbox.ts (jail violation, in-workspace check)
 *   INVALID_INPUT      — workspace-tools.ts (empty pattern, malformed regex)
 *
 * If you add a new throw site for an existing code, update this map.
 */
export type SandboxErrorCode =
  | 'PATH_TRAVERSAL'
  | 'SECRET_DENYLIST'
  | 'EXCLUDED_DIR'
  | 'EXCLUDED_FILE'
  | 'EXCLUDED_FILENAME'
  | 'NON_SOURCE_FILE'
  | 'NOT_A_DIRECTORY'
  | 'NOT_FOUND'
  | 'NOT_INSIDE_ROOT'
  | 'INVALID_INPUT';

/**
 * Directories that carry sensitive material and should trip the
 * `SECRET_DENYLIST` error code (not the generic `EXCLUDED_DIR`). The
 * distinction matters for observability: a downstream audit log tracing
 * "model tried to read secrets" vs. "model tried to read a generated
 * dist file" can filter on the error code. Functionally both are
 * rejected, so security posture is identical.
 *
 * Introduced in PR #24 round-3 self-review finding #7.
 */
const SECRET_EXCLUDE_DIRS: ReadonlySet<string> = new Set(
  [
    '.ssh',
    '.aws',
    '.gnupg',
    '.gpg',
    '.kube',
    '.docker',
    '.1password',
    '.pki',
    '.gcloud',
    '.azure',
    '.config/gcloud',
    '.config/azure',
    'Keychains',
  ].map((s) => s.toLowerCase()),
);

// ---------------------------------------------------------------------------
// Path-compare helpers (declared at the top of the file so no function is
// referenced before its declaration in source order — a defensive tidy-up
// after PR #24 round-3 review flagged the hoisting-dependent layout. JS
// `function` declarations are hoisted to the enclosing scope, so the
// previous order worked at runtime — but a future refactor replacing
// `function` with `const arrow` would introduce a TDZ crash. Putting them
// BEFORE `resolveInsideWorkspace` removes that footgun.
// ---------------------------------------------------------------------------

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  // Compare with the native separator so Windows behaves correctly; the
  // caller's relpath is converted to POSIX *after* this structural check.
  return candidate.startsWith(`${root}${pathSep}`);
}

function toPosix(p: string): string {
  return pathSep === '/' ? p : p.split(pathSep).join('/');
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly requestedPath: string;
  constructor(code: SandboxErrorCode, message: string, requestedPath: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.requestedPath = requestedPath;
  }
}

/** Absolute, real (symlink-resolved) path of `rootInput`. The caller must
 * cache this value for the life of an agentic call so we avoid repeated
 * `realpath` calls on the same root. */
export async function resolveWorkspaceRoot(rootInput: string): Promise<string> {
  try {
    return await realpath(resolve(rootInput));
  } catch (err) {
    throw new SandboxError(
      'NOT_FOUND',
      `workspace root does not exist or is unreadable: ${rootInput} (${String(err)})`,
      rootInput,
    );
  }
}

/**
 * Resolve `relOrAbs` to a real (symlink-resolved) absolute path, or throw
 * `SandboxError` if it escapes the workspace or matches a denylist.
 *
 * Returns both the resolved absolute path and the POSIX relative path —
 * callers need the absolute for FS operations and the relative for logging
 * and response payloads. Relative path is always forward-slash form
 * regardless of host OS.
 *
 * Missing-file policy: when the target path doesn't exist on disk, we
 * still enforce the structural jail on the PARENT of the missing leaf so
 * a request like `read_file(".ssh/id_ed25519")` fails with `PATH_TRAVERSAL`
 * even if that specific file is absent. Without walking to a real parent
 * we'd leak a `NOT_FOUND` error that confirms the path shape to an
 * attacker — indirect enumeration signal. Acceptable trade-off: the
 * missing-file error for a valid path inside the root still surfaces as
 * `NOT_FOUND` once the parent resolves.
 */
export async function resolveInsideWorkspace(
  workspaceRoot: string,
  relOrAbs: string,
): Promise<{ absolutePath: string; relpath: string }> {
  if (typeof relOrAbs !== 'string' || relOrAbs.length === 0) {
    throw new SandboxError('PATH_TRAVERSAL', 'path argument is empty', relOrAbs);
  }
  // Empty after normalisation (only whitespace) → reject.
  const cleaned = relOrAbs.trim();
  if (cleaned.length === 0) {
    throw new SandboxError('PATH_TRAVERSAL', 'path argument is whitespace only', relOrAbs);
  }

  const candidate = resolve(workspaceRoot, cleaned);

  // First pass: try to realpath the target. If it exists, we get a canonical
  // symlink-resolved form. If not, walk up to the nearest existing parent
  // and realpath that — so we detect escapes through symlinks that exist
  // even if the leaf does not.
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    // Target doesn't exist (yet). Walk to nearest existing ancestor so we
    // can still assert "the parent is inside the workspace". This avoids
    // leaking "file not found" for paths that are structurally illegal.
    let parent = candidate;
    let existingAncestor: string | null = null;
    while (true) {
      const next = resolve(parent, '..');
      if (next === parent) break; // hit filesystem root
      parent = next;
      try {
        existingAncestor = await realpath(parent);
        break;
      } catch {
        /* keep walking */
      }
    }
    if (existingAncestor === null) {
      throw new SandboxError('NOT_FOUND', `path has no existing ancestor: ${relOrAbs}`, relOrAbs);
    }
    // Assert the existing ancestor is inside the jail. If YES, the missing
    // leaf is legitimately absent inside the workspace; we return a
    // `NOT_FOUND`. If NO, the request was trying to escape via a path
    // whose leaf doesn't exist — treat as traversal.
    if (!isInside(workspaceRoot, existingAncestor)) {
      throw new SandboxError(
        'PATH_TRAVERSAL',
        `path escapes workspace root: ${relOrAbs}`,
        relOrAbs,
      );
    }
    throw new SandboxError('NOT_FOUND', `path does not exist: ${relOrAbs}`, relOrAbs);
  }

  // realpath succeeded — enforce jail on the RESOLVED path so symlinks are caught.
  if (!isInside(workspaceRoot, resolved)) {
    throw new SandboxError(
      'PATH_TRAVERSAL',
      `path escapes workspace root (symlink or absolute outside): ${relOrAbs}`,
      relOrAbs,
    );
  }

  const rel = toPosix(relative(workspaceRoot, resolved));

  // Content denylist (Codex #4): secrets-by-basename + extension.
  // Both checks are case-insensitive — macOS/APFS and Windows/NTFS are
  // case-insensitive by default, so `.ENV` resolves to the same inode as
  // `.env`. Comparing pre-lowercased protects against a file literally
  // stored as `.ENV` (or `.Env.Local`, `CREDENTIALS`, …) bypassing the
  // list. Extension check was already case-insensitive; basename check
  // used to be strict-equal — bug reported in PR #24 review by Gemini.
  const base = basename(resolved);
  const lowerBase = base.toLowerCase();
  if (AGENTIC_SECRET_BASENAMES_LOWER.has(lowerBase)) {
    throw new SandboxError(
      'SECRET_DENYLIST',
      `filename on secret-basename denylist: ${base}`,
      relOrAbs,
    );
  }
  for (const ext of AGENTIC_SECRET_EXTENSIONS) {
    if (lowerBase.endsWith(ext)) {
      throw new SandboxError(
        'SECRET_DENYLIST',
        `filename on secret-extension denylist: ${base}`,
        relOrAbs,
      );
    }
  }

  // Excluded-dir check: if the POSIX relative path sits under any entry in
  // `DEFAULT_EXCLUDE_DIRS`, refuse. Same semantics as `globs.ts#isPathExcluded`
  // but we reuse the table rather than the function to skip the MatchConfig
  // plumbing (we already know we're inside the jail, so only dir-name
  // matching matters here).
  //
  // Case-insensitive matching (PR #24 round-3 #2): we compare against the
  // lowercased relative path + lowercased dir entries so macOS APFS /
  // Windows NTFS (case-insensitive by default) don't let a file named
  // `NODE_MODULES/foo.js` slip past a strict-case check.
  //
  // `SECRET_EXCLUDE_DIRS` wins before the generic list so `.ssh/id_ed25519`
  // yields `SECRET_DENYLIST` (not `EXCLUDED_DIR`) — distinguishes "user
  // tried to exfiltrate" from "this dir is just boring build output" in
  // observability. Functionally both are blocked.
  const relLower = rel.toLowerCase();
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    const dirLower = dir.toLowerCase();
    const isHit =
      relLower === dirLower ||
      relLower.startsWith(`${dirLower}/`) ||
      relLower.includes(`/${dirLower}/`);
    if (!isHit) continue;
    const code: SandboxErrorCode = SECRET_EXCLUDE_DIRS.has(dirLower)
      ? 'SECRET_DENYLIST'
      : 'EXCLUDED_DIR';
    const detail =
      code === 'SECRET_DENYLIST'
        ? `path is inside a secret-bearing directory: ${dir}`
        : relLower === dirLower
          ? `path is an excluded directory: ${dir}`
          : `path is inside excluded directory: ${dir}`;
    throw new SandboxError(code, detail, relOrAbs);
  }
  // And one more pass over DEFAULT_EXCLUDE_FILE_NAMES — lockfiles,
  // tsconfig.tsbuildinfo, etc. — they were uninteresting even in the
  // eager path, and definitely shouldn't cost agentic iterations.
  // Uses the lowercased `Set` so mis-cased files (e.g. `PACKAGE-LOCK.JSON`
  // on case-insensitive FS) still match. Uses `EXCLUDED_FILENAME`
  // (distinct from `EXCLUDED_DIR`) so the calling model can tell
  // "this is a blacklisted filename" from "this is a blacklisted
  // directory" in the `functionResponse.error` payload.
  if (DEFAULT_EXCLUDE_FILE_NAMES_LOWER.has(lowerBase)) {
    throw new SandboxError(
      'EXCLUDED_FILENAME',
      `filename on default exclude list: ${base}`,
      relOrAbs,
    );
  }

  return { absolutePath: resolved, relpath: rel };
}
