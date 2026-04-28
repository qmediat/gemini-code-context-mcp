/**
 * Recursively scan a workspace directory, returning hashed file entries.
 *
 * Respects default include extensions + exclude directories, plus user overrides
 * passed via `MatchConfig`. Enforces a soft file-count cap and a per-file size cap.
 *
 * v1.13.0+: when `manifestMemo` is supplied, files whose `(mtime_ms, size)`
 * match the previously-stored values reuse the stored content hash and skip
 * re-hashing — typically ~95% of files on a warm rescan, cutting scan
 * wall-clock by ≥10× on large workspaces.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, sep as pathSep, relative } from 'node:path';
import type { FileRow } from '../types.js';
import { runPool } from '../utils/run-pool.js';
import { type MatchConfig, defaultMatchConfig, isFileIncluded, isPathExcluded } from './globs.js';
import { hashFile, mergeHashes } from './hasher.js';

/**
 * v1.13.0+: build the per-file fingerprint map the scanner consults to skip
 * re-hashing. Rows lacking `mtimeMs` or `size` (pre-1.13 manifests, or rows
 * the uploader hasn't refreshed yet) are dropped — those files always
 * re-hash on the next scan.
 */
export function buildScanMemo(rows: readonly FileRow[]): Map<string, ScanMemoEntry> {
  const memo = new Map<string, ScanMemoEntry>();
  for (const row of rows) {
    if (typeof row.mtimeMs !== 'number' || typeof row.size !== 'number') continue;
    memo.set(row.relpath, {
      contentHash: row.contentHash,
      mtimeMs: row.mtimeMs,
      size: row.size,
    });
  }
  return memo;
}

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

/**
 * v1.13.0+: per-file fingerprint stored on the previous scan, used by the
 * scan memo to skip re-hashing when nothing material has changed.
 *
 * `contentHash` is the SHA256 we'd have computed; `mtimeMs` is the file's
 * mtime in ms; `size` is the byte count. ALL THREE must match for the memo
 * to fire — `mtime` alone would mis-cache the (rare) case where two writes
 * within a 1-second resolution window leave the same `mtime` but different
 * content. Size adds a second gate that catches that.
 */
export interface ScanMemoEntry {
  contentHash: string;
  mtimeMs: number;
  size: number;
}

export interface ScanOptions {
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
  maxFiles: number;
  maxFileSizeBytes: number;
  /**
   * Concurrency for the per-file `stat` + `hashFile` loop. v1.13.0 default
   * (20) measured ~6× faster than the serial loop on a 670k-token workspace.
   * Capped low enough that small workspaces don't pay setup overhead.
   */
  hashConcurrency?: number;
  /**
   * v1.13.0+: scan-memo lookup. Map keyed by relpath (POSIX-style, matches
   * what the scanner produces). When `mtimeMs` and `size` from `stat()`
   * match the entry, the scanner reuses `contentHash` and skips reading the
   * file from disk. Pass empty (or `undefined`) to force a fresh hash for
   * every file — equivalent to `forceRescan`.
   */
  manifestMemo?: ReadonlyMap<string, ScanMemoEntry>;
  /**
   * v1.13.0+: bypass the scan memo and re-hash every file. Useful when the
   * caller suspects the manifest is stale (e.g. after a manual filesystem
   * mutation outside the dev workflow) and wants a forced verification scan.
   */
  forceRescan?: boolean;
}

export interface ScannedFile {
  relpath: string;
  absolutePath: string;
  size: number;
  contentHash: string;
  /** v1.13.0+: file mtime in ms, used by the scan memo on subsequent scans. */
  mtimeMs: number;
  /**
   * v1.13.0+: did the scan memo fire for this file? Operators can sum these
   * to see how often the warm path is exercised.
   */
  memoHit: boolean;
}

export interface ScanResult {
  workspaceRoot: string;
  files: ScannedFile[];
  filesHash: string;
  skippedTooLarge: number;
  truncated: boolean;
  /**
   * v1.13.0+: count of files that hit the scan memo (mtime+size unchanged
   * since last scan, content hash reused without reading the file). Useful
   * for status/observability — when this is near zero on what should be a
   * warm scan, something is invalidating the memo (e.g. a build step
   * touching every file).
   */
  memoHitCount: number;
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

  const memo = options.forceRescan ? undefined : options.manifestMemo;
  const concurrency = Math.max(1, options.hashConcurrency ?? 20);

  // Per-file stat+hash runs as a bounded-concurrency pool. The work is mostly
  // I/O (read the file, push bytes through SHA256), so going wider than
  // single-threaded gives a ~6× speedup on 670k-token workspaces. Memo hits
  // are essentially free (one `stat()` + a Map lookup), so the pool drains
  // very quickly on warm scans.
  type Entry = { file: ScannedFile } | { skipped: true };
  const settled = await runPool<string, Entry>(picked, concurrency, async (absolutePath) => {
    const stats = await stat(absolutePath);
    if (stats.size > options.maxFileSizeBytes) {
      return { skipped: true };
    }
    const rel = toPosix(relative(workspaceRoot, absolutePath));
    const memoEntry = memo?.get(rel);
    const memoHit =
      memoEntry !== undefined &&
      memoEntry.mtimeMs === stats.mtimeMs &&
      memoEntry.size === stats.size;
    const hash = memoHit
      ? (memoEntry as ScanMemoEntry).contentHash
      : await hashFile(absolutePath, stats);
    return {
      file: {
        relpath: rel,
        absolutePath,
        size: stats.size,
        contentHash: hash,
        mtimeMs: stats.mtimeMs,
        memoHit,
      },
    };
  });

  // Drain the settled array preserving input order so `filesHash` stays
  // deterministic. Any rejection (a `stat`/`hashFile` throw) bubbles —
  // workspace scanning has no per-file recovery story; an unreadable file
  // means the rescan is broken and the caller needs to surface that.
  const files: ScannedFile[] = [];
  let skippedTooLarge = 0;
  let memoHitCount = 0;
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    }
    const entry = result.value;
    if ('skipped' in entry) {
      skippedTooLarge += 1;
      continue;
    }
    files.push(entry.file);
    if (entry.file.memoHit) memoHitCount += 1;
  }

  const filesHash = mergeHashes(files.map((f) => ({ relpath: f.relpath, hash: f.contentHash })));

  return {
    workspaceRoot,
    files,
    filesHash,
    skippedTooLarge,
    truncated,
    memoHitCount,
  };
}
