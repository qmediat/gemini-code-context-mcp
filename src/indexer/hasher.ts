/**
 * Content hashing with bounded in-memory cache (keyed by path + mtime + size).
 *
 * We use SHA-256 because its output is small, collision-resistant, and hex-stable.
 * The mtime/size key ensures we recompute when the file changes without re-reading
 * unchanged files on hot paths (status, reindex, repeated asks).
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  hash: string;
}

const MAX_CACHE_ENTRIES = 5_000;
const cache = new Map<string, CacheEntry>();

function rememberHash(path: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(path, entry);
}

/**
 * Hash a file's content, using cached value when mtime+size match.
 *
 * Accepts an optional pre-fetched `Stats` to avoid a redundant `stat` syscall —
 * callers that already have the stats (e.g. `workspace-scanner` after size check)
 * can pass them in to halve filesystem metadata traffic.
 */
export async function hashFile(absolutePath: string, prefetched?: Stats): Promise<string> {
  const stats = prefetched ?? (await stat(absolutePath));
  const cached = cache.get(absolutePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.hash;
  }

  const buf = await readFile(absolutePath);
  const hash = createHash('sha256').update(buf).digest('hex');
  rememberHash(absolutePath, { mtimeMs: stats.mtimeMs, size: stats.size, hash });
  return hash;
}

/**
 * Merge individual file hashes into a single workspace hash.
 *
 * Uses `localeCompare` for sorting so duplicate relpaths (should not occur given
 * the scanner's Set-based dedup, but defensive matters when hashes feed cache keys)
 * get a deterministic equality result. A comparator that never returns 0 violates
 * the Array.sort contract and can yield engine-dependent ordering.
 */
export function mergeHashes(fileHashes: ReadonlyArray<{ relpath: string; hash: string }>): string {
  const sorted = [...fileHashes].sort((a, b) => a.relpath.localeCompare(b.relpath));
  const hasher = createHash('sha256');
  for (const { relpath, hash } of sorted) {
    hasher.update(relpath);
    hasher.update('\0');
    hasher.update(hash);
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

/** Clear the in-memory hash cache. Primarily for tests. */
export function clearHashCache(): void {
  cache.clear();
}
