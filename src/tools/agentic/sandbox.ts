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
import { DEFAULT_EXCLUDE_DIRS, DEFAULT_EXCLUDE_FILE_NAMES } from '../../indexer/globs.js';

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

export type SandboxErrorCode =
  | 'PATH_TRAVERSAL'
  | 'SECRET_DENYLIST'
  | 'EXCLUDED_DIR'
  | 'EXCLUDED_FILENAME'
  | 'NON_SOURCE_FILE'
  | 'NOT_A_DIRECTORY'
  | 'NOT_FOUND'
  | 'NOT_INSIDE_ROOT';

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
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    if (rel === dir) {
      throw new SandboxError('EXCLUDED_DIR', `path is an excluded directory: ${dir}`, relOrAbs);
    }
    if (rel.startsWith(`${dir}/`) || rel.includes(`/${dir}/`)) {
      throw new SandboxError('EXCLUDED_DIR', `path is inside excluded directory: ${dir}`, relOrAbs);
    }
  }
  // And one more pass over DEFAULT_EXCLUDE_FILE_NAMES — lockfiles,
  // tsconfig.tsbuildinfo, etc. — they were uninteresting even in the
  // eager path, and definitely shouldn't cost agentic iterations.
  // Uses `EXCLUDED_FILENAME` (distinct from `EXCLUDED_DIR`) so the
  // calling model can tell "this is a blacklisted filename" from
  // "this is a blacklisted directory" in the `functionResponse.error`
  // payload (PR #24 review by Grok).
  if (DEFAULT_EXCLUDE_FILE_NAMES.includes(base)) {
    throw new SandboxError(
      'EXCLUDED_FILENAME',
      `filename on default exclude list: ${base}`,
      relOrAbs,
    );
  }

  return { absolutePath: resolved, relpath: rel };
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  // Compare with the native separator so Windows behaves correctly; the
  // caller's relpath is converted to POSIX *after* this structural check.
  return candidate.startsWith(`${root}${pathSep}`);
}

function toPosix(p: string): string {
  return pathSep === '/' ? p : p.split(pathSep).join('/');
}
