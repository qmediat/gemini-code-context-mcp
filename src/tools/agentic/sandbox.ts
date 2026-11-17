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

import { realpath, stat } from 'node:fs/promises';
import { basename, sep as pathSep, relative, resolve } from 'node:path';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILE_NAMES_LOWER,
  type PathKind,
  SECRET_EXCLUDE_DIRS,
  isDotnetBuildOutput,
  pathHitsDir,
} from '../../indexer/globs.js';

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

/** Which list of the secret denylist a file name is on: its exact basename, or its extension. */
export type SecretList = 'basename' | 'extension';

/**
 * The list of the secret denylist `fileName` (a basename) is on, case-insensitively, or `null` when it is on neither.
 * The one test of the denylist: `read_file` refuses such a file (`resolveInsideWorkspace`), `list_directory` hides it,
 * and the walk of `find_files` and `grep` never visits it — its name, size and content stay out of every response.
 */
export function secretListOf(fileName: string): SecretList | null {
  const lowerBase = fileName.toLowerCase();
  if (AGENTIC_SECRET_BASENAMES_LOWER.has(lowerBase)) return 'basename';
  return AGENTIC_SECRET_EXTENSIONS.some((ext) => lowerBase.endsWith(ext)) ? 'extension' : null;
}

/**
 * Where each code fires (v1.9.0 — keep this map current as new throw sites
 * are added):
 *
 *   PATH_TRAVERSAL     — sandbox.ts (jail violation: symlink escape, abs path outside)
 *   SECRET_DENYLIST    — sandbox.ts (basename / extension / dir on hardcoded secret list)
 *   EXCLUDED_DIR       — sandbox.ts (DEFAULT_EXCLUDE_DIRS hit, excludedDirError)
 *                        AND workspace-tools.ts top-level gates (v1.9.0+):
 *                        listDirectoryExecutor + grepExecutor's pathPrefix,
 *                        when the requested dir matches user-supplied excludeGlobs
 *   EXCLUDED_FILE      — workspace-tools.ts (v1.9.0+): readFileExecutor when
 *                        the file is excluded by user globs (filename / extension
 *                        / dir-prefix). Generic message — no path leak.
 *   EXCLUDED_FILENAME  — sandbox.ts (DEFAULT_EXCLUDE_FILE_NAMES hit, refuseDefaultExcluded)
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

/** The argument trimmed; an empty, non-string or whitespace-only argument is refused before any file system call. */
function cleanedPathArgument(relOrAbs: string): string {
  if (typeof relOrAbs !== 'string' || relOrAbs.length === 0) {
    throw new SandboxError('PATH_TRAVERSAL', 'path argument is empty', relOrAbs);
  }
  const cleaned = relOrAbs.trim();
  if (cleaned.length === 0) {
    throw new SandboxError('PATH_TRAVERSAL', 'path argument is whitespace only', relOrAbs);
  }
  return cleaned;
}

/** The real path of the nearest ancestor of `candidate` that exists, or `null` when none does up to the file system
 * root. `candidate` itself is not tried: the caller's `realpath` of it has already failed. */
async function nearestExistingAncestor(candidate: string): Promise<string | null> {
  let parent = candidate;
  while (true) {
    const next = resolve(parent, '..');
    if (next === parent) return null; // hit filesystem root
    parent = next;
    try {
      return await realpath(parent);
    } catch {
      /* keep walking */
    }
  }
}

/**
 * The refusal of a target that does not exist. The structural jail still holds on its nearest existing ancestor, so a
 * path that is structurally illegal is refused as traversal and never answered with "file not found": an ancestor
 * inside the jail means the leaf is legitimately absent in the workspace (`NOT_FOUND`); one outside means the request
 * tried to escape through a path whose leaf does not exist (`PATH_TRAVERSAL`).
 */
async function refuseMissingPath(
  workspaceRoot: string,
  candidate: string,
  relOrAbs: string,
): Promise<never> {
  const existingAncestor = await nearestExistingAncestor(candidate);
  if (existingAncestor === null) {
    throw new SandboxError('NOT_FOUND', `path has no existing ancestor: ${relOrAbs}`, relOrAbs);
  }
  if (!isInside(workspaceRoot, existingAncestor)) {
    throw new SandboxError('PATH_TRAVERSAL', `path escapes workspace root: ${relOrAbs}`, relOrAbs);
  }
  throw new SandboxError('NOT_FOUND', `path does not exist: ${relOrAbs}`, relOrAbs);
}

/** The canonical (symlink-resolved) form of `candidate`, inside the jail. The jail is enforced on the RESOLVED path,
 * so a symlink inside the root that points outside it is caught. */
async function realpathInsideRoot(
  workspaceRoot: string,
  candidate: string,
  relOrAbs: string,
): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return refuseMissingPath(workspaceRoot, candidate, relOrAbs);
  }
  if (!isInside(workspaceRoot, resolved)) {
    throw new SandboxError(
      'PATH_TRAVERSAL',
      `path escapes workspace root (symlink or absolute outside): ${relOrAbs}`,
      relOrAbs,
    );
  }
  return resolved;
}

/** Content denylist: secrets by basename or extension, case-insensitively — macOS/APFS and Windows/NTFS are
 * case-insensitive by default, so `.ENV` (or `.Env.Local`, `CREDENTIALS`, …) is the same file as `.env`. */
function refuseSecretFile(base: string, relOrAbs: string): void {
  const secretList = secretListOf(base);
  if (secretList !== null) {
    throw new SandboxError(
      'SECRET_DENYLIST',
      `filename on secret-${secretList} denylist: ${base}`,
      relOrAbs,
    );
  }
}

/**
 * The refusal of a path that `pathHitsDir` placed in the excluded directory `dir`. `SECRET_EXCLUDE_DIRS` wins over
 * the generic list, so `.ssh/id_ed25519` yields `SECRET_DENYLIST` (not `EXCLUDED_DIR`) — "user tried to exfiltrate"
 * stays distinct from "this dir is just boring build output" in observability; functionally both are blocked. The
 * message says whether the path is inside the directory, is the directory, or is a file named like it.
 */
function excludedDirError(
  dir: string,
  relLower: string,
  kind: PathKind,
  relOrAbs: string,
): SandboxError {
  const dirLower = dir.toLowerCase();
  if (SECRET_EXCLUDE_DIRS.has(dirLower)) {
    return new SandboxError(
      'SECRET_DENYLIST',
      `path is inside a secret-bearing directory: ${dir}`,
      relOrAbs,
    );
  }
  const namesTheDir = relLower === dirLower || relLower.endsWith(`/${dirLower}`);
  if (!namesTheDir) {
    return new SandboxError('EXCLUDED_DIR', `path is inside excluded directory: ${dir}`, relOrAbs);
  }
  const detail =
    kind === 'dir'
      ? `path is an excluded directory: ${dir}`
      : `path is a file named like an excluded directory: ${dir}`;
  return new SandboxError('EXCLUDED_DIR', detail, relOrAbs);
}

/**
 * The default excludes, in this order: the excluded directories, the excluded file names, .NET build output.
 *
 * Excluded-dir check: the POSIX relative path sitting under any entry of `DEFAULT_EXCLUDE_DIRS` is refused. Same
 * semantics as `globs.ts#isPathExcluded`, but it reuses the table rather than the function to skip the MatchConfig
 * plumbing (the path is already inside the jail, so only dir-name matching matters). The comparison is on the
 * lowercased path and entries, so on a case-insensitive file system `NODE_MODULES/foo.js` does not slip past.
 *
 * `DEFAULT_EXCLUDE_FILE_NAMES` (lockfiles, `tsconfig.tsbuildinfo`, …) are matched through their lowercased `Set`, so
 * mis-cased files (`PACKAGE-LOCK.JSON`) match too; their code `EXCLUDED_FILENAME` is distinct from `EXCLUDED_DIR` so
 * the calling model can tell a refused file name from a refused directory in the `functionResponse.error` payload.
 */
function refuseDefaultExcluded(
  base: string,
  relLower: string,
  kind: PathKind,
  relOrAbs: string,
): void {
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    if (pathHitsDir(relLower, dir.toLowerCase(), kind)) {
      throw excludedDirError(dir, relLower, kind, relOrAbs);
    }
  }
  if (DEFAULT_EXCLUDE_FILE_NAMES_LOWER.has(base.toLowerCase())) {
    throw new SandboxError(
      'EXCLUDED_FILENAME',
      `filename on default exclude list: ${base}`,
      relOrAbs,
    );
  }
  if (isDotnetBuildOutput(relLower, kind)) {
    throw new SandboxError(
      'EXCLUDED_DIR',
      'path is .NET build output (bin/…/Debug or Release)',
      relOrAbs,
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
 *
 * The steps run in this order and each refuses with its own code: the argument, the jail, the secret denylist (before
 * the `stat` of the target), the default excludes.
 */
export async function resolveInsideWorkspace(
  workspaceRoot: string,
  relOrAbs: string,
): Promise<ResolvedPath> {
  const candidate = resolve(workspaceRoot, cleanedPathArgument(relOrAbs));
  const resolved = await realpathInsideRoot(workspaceRoot, candidate, relOrAbs);
  const rel = toPosix(relative(workspaceRoot, resolved));
  const base = basename(resolved);
  refuseSecretFile(base, relOrAbs);
  const kind = await kindOf(resolved, relOrAbs);
  refuseDefaultExcluded(base, rel.toLowerCase(), kind, relOrAbs);
  return { absolutePath: resolved, relpath: rel, kind };
}

/** A path inside the workspace, resolved: what it is decides whether it can be an excluded directory itself. */
export interface ResolvedPath {
  absolutePath: string;
  relpath: string;
  kind: PathKind;
}

async function kindOf(resolved: string, relOrAbs: string): Promise<PathKind> {
  try {
    return (await stat(resolved)).isDirectory() ? 'dir' : 'file';
  } catch {
    throw new SandboxError('NOT_FOUND', `path does not exist: ${relOrAbs}`, relOrAbs);
  }
}
