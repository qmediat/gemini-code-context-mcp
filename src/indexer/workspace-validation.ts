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

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, sep as pathSep, relative } from 'node:path';

/**
 * Files / dirs at a path root that strongly suggest it's a real codebase.
 * Scoped to things that appear in the ROOT — per-file markers deeper in the
 * tree (README.md, .gitignore) aren't reliable signals.
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
  // Editor integration (weak signals, still better than none)
  '.projectile',
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
 */
export function validateWorkspacePath(workspaceRoot: string): void {
  if (!isAbsolute(workspaceRoot)) {
    throw new WorkspaceValidationError(
      `workspace must be an absolute path (got '${workspaceRoot}')`,
    );
  }

  let exists = false;
  try {
    exists = statSync(workspaceRoot).isDirectory();
  } catch {
    // not accessible or not a directory
  }
  if (!exists) {
    throw new WorkspaceValidationError(
      `workspace '${workspaceRoot}' does not exist or is not a directory`,
    );
  }

  if (isUnderCwd(workspaceRoot)) return;

  for (const marker of WORKSPACE_MARKERS) {
    if (existsSync(join(workspaceRoot, marker))) return;
  }

  if (process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE === 'true') {
    return;
  }

  const sample = WORKSPACE_MARKERS.slice(0, 5).join(', ');
  throw new WorkspaceValidationError(
    `Refusing to scan '${workspaceRoot}': path is not under the host's cwd and contains no recognised workspace marker ` +
      `(${sample}, …). If intentional, set GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE=true.`,
  );
}
