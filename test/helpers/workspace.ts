/**
 * Workspace fixtures in the shapes the tools receive them: a scan (`ScanResult`, what a mocked `scanWorkspace`
 * returns) and a prepared context (`PreparedContext`, what a mocked `prepareContext` returns).
 */

import { join } from 'node:path';
import type { PreparedContext } from '../../src/cache/cache-manager.js';
import type { ScanResult } from '../../src/indexer/workspace-scanner.js';

export interface OneFileScanOptions {
  readonly root?: string;
  readonly relpath?: string;
  /** The file's size in bytes: what the tools' bytes/4 estimates read. */
  readonly size?: number;
  readonly filesHash?: string;
}

/** A scan that found one file. */
export function oneFileScan(opts: OneFileScanOptions = {}): ScanResult {
  const root = opts.root ?? '/fake';
  const relpath = opts.relpath ?? 'a.ts';
  return {
    workspaceRoot: root,
    filesHash: opts.filesHash ?? 'abc',
    files: [
      {
        relpath,
        absolutePath: join(root, relpath),
        size: opts.size ?? 100,
        contentHash: 'h1',
        mtimeMs: 0,
        memoHit: false,
      },
    ],
    skippedTooLarge: 0,
    excludedDirs: [],
    excludedDirsTotal: 0,
    skippedNonSource: 0,
    truncated: false,
    memoHitCount: 0,
  };
}

/** The workspace most tool suites scan: one 100-byte file in `/fake`. */
export const ONE_FILE_SCAN: ScanResult = oneFileScan();

/** A context sent inline: no cache built or reused, no upload. */
export const INLINE_CONTEXT: PreparedContext = {
  cacheId: null,
  cacheExpiresAt: null,
  inlineContents: [],
  reused: false,
  rebuilt: false,
  inlineOnly: true,
  uploaded: { files: [], uploadedCount: 0, reusedCount: 0, failedCount: 0, failures: [] },
};
