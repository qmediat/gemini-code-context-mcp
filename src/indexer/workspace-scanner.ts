/**
 * Recursively scan a workspace directory, returning hashed file entries.
 *
 * Respects default include extensions + exclude directories, plus user overrides
 * passed via `MatchConfig`. Enforces a soft file-count cap and a per-file size cap.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, sep as pathSep, relative } from 'node:path';
import { type MatchConfig, defaultMatchConfig, isFileIncluded, isPathExcluded } from './globs.js';
import { hashFile, mergeHashes } from './hasher.js';

/**
 * Normalise a path separator to POSIX-style `/`.
 *
 * `node:path.relative()` returns OS-native separators (`\` on Windows), but our
 * glob checks in `globs.ts` and the cache-key hashing expect `/`. Every relpath
 * that flows out of the scanner is normalised here so Windows users see the same
 * exclude/include behaviour as POSIX users.
 */
function toPosix(p: string): string {
  return pathSep === '/' ? p : p.split(pathSep).join('/');
}

export interface ScanOptions {
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
  maxFiles: number;
  maxFileSizeBytes: number;
}

export interface ScannedFile {
  relpath: string;
  absolutePath: string;
  size: number;
  contentHash: string;
}

export interface ScanResult {
  workspaceRoot: string;
  files: ScannedFile[];
  filesHash: string;
  skippedTooLarge: number;
  truncated: boolean;
}

async function walk(
  root: string,
  currentDir: string,
  config: MatchConfig,
  acc: string[],
  seen: Set<string>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const rel = toPosix(relative(root, absolutePath));

    if (entry.isDirectory()) {
      if (isPathExcluded(rel, config)) continue;
      await walk(root, absolutePath, config, acc, seen);
      continue;
    }

    if (entry.isFile()) {
      if (!isFileIncluded(rel, config)) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      acc.push(absolutePath);
    }
  }
}

export async function scanWorkspace(
  workspaceRoot: string,
  options: ScanOptions,
): Promise<ScanResult> {
  const matchOpts: { includeGlobs?: readonly string[]; excludeGlobs?: readonly string[] } = {};
  if (options.includeGlobs !== undefined) matchOpts.includeGlobs = options.includeGlobs;
  if (options.excludeGlobs !== undefined) matchOpts.excludeGlobs = options.excludeGlobs;
  const config = defaultMatchConfig(matchOpts);

  const absolutes: string[] = [];
  await walk(workspaceRoot, workspaceRoot, config, absolutes, new Set());
  absolutes.sort();

  const truncated = absolutes.length > options.maxFiles;
  const picked = truncated ? absolutes.slice(0, options.maxFiles) : absolutes;

  const files: ScannedFile[] = [];
  let skippedTooLarge = 0;

  for (const absolutePath of picked) {
    const stats = await stat(absolutePath);
    if (stats.size > options.maxFileSizeBytes) {
      skippedTooLarge += 1;
      continue;
    }
    const rel = toPosix(relative(workspaceRoot, absolutePath));
    // Pass the already-fetched stats to avoid a second stat() inside hashFile.
    const hash = await hashFile(absolutePath, stats);
    files.push({ relpath: rel, absolutePath, size: stats.size, contentHash: hash });
  }

  const filesHash = mergeHashes(files.map((f) => ({ relpath: f.relpath, hash: f.contentHash })));

  return {
    workspaceRoot,
    files,
    filesHash,
    skippedTooLarge,
    truncated,
  };
}
