/**
 * Guard against arbitrary-path indexing.
 *
 * The tools accept a `workspace` argument that flows directly into
 * `scanWorkspace`, which recursively reads + hashes + uploads matching files
 * to the Gemini Files API. Without validation, a malicious or prompt-injected
 * MCP client can redirect that pipeline at `$HOME`, `/etc`, or anywhere else
 * the server process has read access — exfiltrating local secrets.
 *
 * Validation passes if ANY of:
 *
 *   1. The path is under `process.cwd()` (the MCP host's working directory is
 *      itself a trust signal — the user launched us there).
 *   2. The path contains at least one recognised workspace marker
 *      (`.git`, `package.json`, `Cargo.toml`, etc.) at its root.
 *   3. `GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE=true` is set — escape hatch for
 *      users with genuinely unconventional roots (CI sandboxes, build dirs).
 *
 * Otherwise we throw with a user-visible message explaining the check.
 *
 * This is defense in depth, not a silver bullet: a workspace with `.git` inside
 * `$HOME/.ssh` would still pass, and attackers who control the path AND can
 * plant a marker bypass the check. The goal is to stop the common accidental
 * and prompt-injection paths, not every conceivable abuse.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep as pathSep, relative } from 'node:path';

/**
 * Files / dirs at a path root that strongly suggest it's a real codebase.
 * Scoped to things that appear in the ROOT — per-file markers deeper in the
 * tree (README.md, .gitignore) aren't reliable signals.
 *
 * The list deliberately omits weak signals like editor scratch files
 * (`.projectile`) — this is a security guard, not a "feels like a project"
 * heuristic. Stronger signals only: a VCS dir, a build/dependency manifest
 * with structure, or a known polyglot marker (Dockerfile, Makefile, flake.nix
 * are kept because they're load-bearing single-file projects, not editor
 * fragments).
 */
export const WORKSPACE_MARKERS: readonly string[] = [
  // VCS
  '.git',
  '.hg',
  '.svn',
  '.jj',
  // JS / TS
  'package.json',
  'deno.json',
  'deno.jsonc',
  'bun.lockb',
  // Python
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  // Go / Rust / C family
  'go.mod',
  'Cargo.toml',
  'CMakeLists.txt',
  'Makefile',
  // JVM
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  // Ruby / PHP / Elixir
  'Gemfile',
  'composer.json',
  'mix.exs',
  // Infra / misc
  'Dockerfile',
  'flake.nix',
  'shell.nix',
  'build.zig',
] as const;

export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
}

/** True if `child` is `cwd` itself or a descendant of it. Case-sensitive on POSIX, case-preserving on Windows via `path.relative`. */
function isUnderCwd(child: string, cwd: string = process.cwd()): boolean {
  const rel = relative(cwd, child);
  if (rel === '' || rel === '.') return true;
  if (rel === '..') return false;
  if (rel.startsWith(`..${pathSep}`)) return false;
  if (isAbsolute(rel)) return false; // different drive on Windows
  return true;
}

/**
 * Throw `WorkspaceValidationError` if `workspaceRoot` is not a plausible
 * codebase root. Intended to be called from tool entry points after
 * `resolve(input.workspace ?? cwd)` but before any filesystem scan.
 *
 * The check is performed against the **canonical** path (`fs.realpath`),
 * not the literal argument. Without this, a symlink under cwd pointing at
 * `/etc` (or `$HOME`, or anywhere else) would pass the cwd-descendant test
 * — defeating the purpose of the guard. Resolving to the canonical path
 * first means the cwd ancestry test sees the real target every time.
 */
export function validateWorkspacePath(workspaceRoot: string): void {
  if (!isAbsolute(workspaceRoot)) {
    throw new WorkspaceValidationError(
      `workspace must be an absolute path (got '${workspaceRoot}')`,
    );
  }

  // Canonicalise BEFORE any cwd / marker check — see the doc-comment above
  // for the symlink-bypass rationale. `realpathSync` throws ENOENT for
  // missing paths, EACCES for unreadable parents, ELOOP for circular
  // symlinks; we surface each with a precise message instead of mapping
  // them all onto "does not exist".
  let canonical: string;
  try {
    canonical = realpathSync(workspaceRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'does not exist'
        : code === 'EACCES'
          ? 'is not accessible (permission denied)'
          : code === 'ELOOP'
            ? 'is part of a symlink cycle'
            : `could not be resolved (${code ?? 'unknown error'})`;
    throw new WorkspaceValidationError(`workspace '${workspaceRoot}' ${reason}`);
  }

  let isDir = false;
  try {
    isDir = statSync(canonical).isDirectory();
  } catch (err) {
    // Should not normally fire — realpath succeeded — but defensive: surface
    // as a regular validation error rather than letting an unexpected stat
    // failure leak out as an unhandled exception.
    throw new WorkspaceValidationError(
      `workspace '${workspaceRoot}' resolved to '${canonical}' but stat failed: ${String(err)}`,
    );
  }
  if (!isDir) {
    throw new WorkspaceValidationError(
      `workspace '${workspaceRoot}' resolved to '${canonical}' which is not a directory`,
    );
  }

  // Canonicalise cwd too so the ancestry check compares like-with-like.
  // macOS has common cwd symlinks: `/var → /private/var`, `/tmp → /private/tmp`.
  // Without this, a workspace legitimately under cwd (after realpath on both
  // sides agrees) gets rejected because `relative('/var/foo', '/private/var/foo/ws')`
  // returns `'../../private/var/foo/ws'`, which fails the cwd-descendant test.
  // If the `realpathSync(process.cwd())` call itself fails (unlikely — cwd
  // removed mid-flight, EACCES), fall back to the raw `process.cwd()` to
  // preserve the previous behaviour rather than introduce a new hard failure.
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(process.cwd());
  } catch {
    canonicalCwd = process.cwd();
  }

  if (isUnderCwd(canonical, canonicalCwd)) return;

  for (const marker of WORKSPACE_MARKERS) {
    if (existsSync(join(canonical, marker))) return;
  }

  if (process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE === 'true') {
    return;
  }

  const sample = WORKSPACE_MARKERS.slice(0, 5).join(', ');
  throw new WorkspaceValidationError(
    `Refusing to scan '${workspaceRoot}'${canonical !== workspaceRoot ? ` (resolves to '${canonical}')` : ''}: path is not under the host's cwd and contains no recognised workspace marker ` +
      `(${sample}, …). If intentional, set GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE=true.`,
  );
}
