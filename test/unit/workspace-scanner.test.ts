import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearHashCache } from '../../src/indexer/hasher.js';
import {
  type ScanMemoEntry,
  buildScanMemo,
  scanWorkspace,
} from '../../src/indexer/workspace-scanner.js';
import type { FileRow } from '../../src/types.js';

describe('workspace scanner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gcctx-scan-'));
    clearHashCache();
  });

  afterEach(() => {
    clearHashCache();
  });

  it('includes source files and excludes node_modules', async () => {
    writeFileSync(join(root, 'index.ts'), 'export const a = 1;');
    writeFileSync(join(root, 'README.md'), '# hi');
    mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'foo', 'index.js'), 'ignored');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ignored');

    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['README.md', 'index.ts']);
  });

  it('skips files larger than maxFileSizeBytes', async () => {
    writeFileSync(join(root, 'small.ts'), 'small');
    writeFileSync(join(root, 'big.ts'), 'x'.repeat(1000));

    const result = await scanWorkspace(root, { maxFiles: 100, maxFileSizeBytes: 100 });
    expect(result.skippedTooLarge).toBe(1);
    expect(result.files.map((f) => f.relpath)).toEqual(['small.ts']);
  });

  it('respects user-provided excludeGlobs (by directory name)', async () => {
    mkdirSync(join(root, 'generated'), { recursive: true });
    writeFileSync(join(root, 'src.ts'), 'a');
    writeFileSync(join(root, 'generated', 'x.ts'), 'b');

    const result = await scanWorkspace(root, {
      maxFiles: 100,
      maxFileSizeBytes: 100_000,
      excludeGlobs: ['generated'],
    });
    expect(result.files.map((f) => f.relpath)).toEqual(['src.ts']);
  });

  it('respects user-provided includeGlobs for extra extensions', async () => {
    writeFileSync(join(root, 'a.custom'), 'x');
    writeFileSync(join(root, 'b.ts'), 'y');

    const result = await scanWorkspace(root, {
      maxFiles: 100,
      maxFileSizeBytes: 100_000,
      includeGlobs: ['.custom'],
    });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['a.custom', 'b.ts']);
  });

  it('produces a deterministic filesHash for the same content', async () => {
    writeFileSync(join(root, 'a.ts'), 'const x = 1;');
    writeFileSync(join(root, 'b.ts'), 'const y = 2;');
    const first = await scanWorkspace(root, { maxFiles: 100, maxFileSizeBytes: 100_000 });
    const second = await scanWorkspace(root, { maxFiles: 100, maxFileSizeBytes: 100_000 });
    expect(first.filesHash).toBe(second.filesHash);
  });

  it('produces a different filesHash when a file changes', async () => {
    writeFileSync(join(root, 'a.ts'), 'const x = 1;');
    const first = await scanWorkspace(root, { maxFiles: 100, maxFileSizeBytes: 100_000 });
    writeFileSync(join(root, 'a.ts'), 'const x = 999;');
    clearHashCache();
    const second = await scanWorkspace(root, { maxFiles: 100, maxFileSizeBytes: 100_000 });
    expect(first.filesHash).not.toBe(second.filesHash);
  });

  // v1.5.0 — excludeGlobs pattern normalization (Fix A). Pre-fix these all
  // fell through to excludeDirs as literal strings and silently matched nothing.
  it('skips tsconfig.tsbuildinfo by default (Fix B: default excluded extension)', async () => {
    writeFileSync(join(root, 'tsconfig.tsbuildinfo'), 'x'.repeat(200));
    writeFileSync(join(root, 'index.ts'), 'export const a = 1;');

    const result = await scanWorkspace(root, { maxFiles: 100, maxFileSizeBytes: 100_000 });
    expect(result.files.map((f) => f.relpath)).toEqual(['index.ts']);
  });

  it('excludeGlobs `*.ext` pattern drops matching files (Fix A)', async () => {
    writeFileSync(join(root, 'build.log'), 'log content');
    writeFileSync(join(root, 'index.ts'), 'export const a = 1;');

    const result = await scanWorkspace(root, {
      maxFiles: 100,
      maxFileSizeBytes: 100_000,
      excludeGlobs: ['*.log'],
      includeGlobs: ['.log'], // deliberately contradictory — exclude wins
    });
    expect(result.files.map((f) => f.relpath)).toEqual(['index.ts']);
  });

  it('excludeGlobs literal filename drops the specific file (Fix A)', async () => {
    writeFileSync(join(root, 'pr27-diff.txt'), 'diff');
    writeFileSync(join(root, 'keep.txt'), 'other');

    const result = await scanWorkspace(root, {
      maxFiles: 100,
      maxFileSizeBytes: 100_000,
      excludeGlobs: ['pr27-diff.txt'],
    });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['keep.txt']);
  });

  it('excludeGlobs path-prefix works after POSIX normalisation (Fix A)', async () => {
    mkdirSync(join(root, 'src', 'lib', 'db', 'migrations', 'meta'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib', 'db', 'migrations', 'meta', '0001_snapshot.json'), '{}');
    writeFileSync(join(root, 'src', 'lib', 'db', 'schema.ts'), 'export const s = {};');

    const result = await scanWorkspace(root, {
      maxFiles: 100,
      maxFileSizeBytes: 100_000,
      excludeGlobs: ['./src/lib/db/migrations/meta/'], // note leading ./ and trailing /
    });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['src/lib/db/schema.ts']);
  });

  // --- PR #24 round-4 regressions (eager-path case-insensitive closure) ---

  it('R4#1: excludes `NODE_MODULES/` (mixed-case) on case-insensitive FS', async () => {
    // Simulates macOS (APFS) / Windows (NTFS) where `Node_Modules/` and
    // `node_modules/` resolve to the same inode. Before round-4 the eager
    // scanner iterated in with strict `===`/`startsWith` and uploaded the
    // entire dir to Gemini.
    writeFileSync(join(root, 'index.ts'), 'export const a = 1;');
    mkdirSync(join(root, 'Node_Modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'Node_Modules', 'dep', 'pkg.ts'), 'export const bad = 1;');

    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['index.ts']);
  });

  it('R4#1: excludes mixed-case lockfile basename (PACKAGE-LOCK.JSON)', async () => {
    // Mirror-image test on the filename side.
    writeFileSync(join(root, 'index.ts'), 'export const a = 1;');
    writeFileSync(join(root, 'PACKAGE-LOCK.JSON'), '{}');

    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['index.ts']);
  });

  it('R4#1: user-supplied excludeGlobs dir case-insensitive', async () => {
    // User writes `excludeGlobs: ['Vendor']` on a repo that actually has
    // `vendor/` on disk. Pre-round-4 the strict-equality path missed it.
    mkdirSync(join(root, 'vendor', 'lib'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'lib', 'ext.ts'), 'export const v = 1;');
    writeFileSync(join(root, 'keep.ts'), 'export const k = 1;');

    const result = await scanWorkspace(root, {
      maxFiles: 100,
      maxFileSizeBytes: 100_000,
      excludeGlobs: ['Vendor'],
    });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['keep.ts']);
  });

  it('R4#1: uppercase source extension `.TS` is included via case-insensitive match', async () => {
    // Case-insensitive include side: `App.TS` on macOS/Windows is still
    // a TypeScript file. Pre-round-4 eager scanner dropped it.
    writeFileSync(join(root, 'App.TS'), 'export const a = 1;');
    writeFileSync(join(root, 'helper.ts'), 'export const b = 1;');

    const result = await scanWorkspace(root, { maxFiles: 100, maxFileSizeBytes: 100_000 });
    const paths = result.files.map((f) => f.relpath).sort();
    expect(paths).toEqual(['App.TS', 'helper.ts']);
  });

  // v1.13.0 — scan memo: skip per-file hashing when (mtime_ms, size) match
  // the previously-stored values. Memo hits reuse the stored content hash
  // verbatim — even when the file's actual content has drifted, IF mtime
  // and size are unchanged. That's the documented trade-off; an explicit
  // forceRescan or `reindex` invocation breaks the memo.
  describe('scan memo (v1.13.0+)', () => {
    it('reuses stored contentHash when mtime and size match', async () => {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
      const cold = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
      });
      expect(cold.files).toHaveLength(1);
      expect(cold.memoHitCount).toBe(0);
      const [coldFile] = cold.files;
      if (!coldFile) throw new Error('cold scan produced no files');

      // Simulate the manifest having a row for this file with matching
      // mtime+size. The scanner should reuse the contentHash and report
      // memoHit=true even though the file is physically there to read.
      const memo = new Map<string, ScanMemoEntry>([
        [
          coldFile.relpath,
          {
            contentHash: 'sentinel-hash',
            mtimeMs: coldFile.mtimeMs,
            size: coldFile.size,
          },
        ],
      ]);
      const warm = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
        manifestMemo: memo,
      });
      expect(warm.memoHitCount).toBe(1);
      expect(warm.files[0]?.contentHash).toBe('sentinel-hash');
      expect(warm.files[0]?.memoHit).toBe(true);
    });

    it('rehashes when size changes even if mtime would still match', async () => {
      const path = join(root, 'a.ts');
      writeFileSync(path, 'export const a = 1;');
      const cold = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
      });
      const [coldFile] = cold.files;
      if (!coldFile) throw new Error('cold scan produced no files');

      // Lie about size: pretend the manifest had stored a different size.
      // Scanner must reject the memo entry and re-hash from disk.
      const memo = new Map<string, ScanMemoEntry>([
        [
          coldFile.relpath,
          {
            contentHash: 'sentinel-hash',
            mtimeMs: coldFile.mtimeMs,
            size: coldFile.size + 1,
          },
        ],
      ]);
      const warm = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
        manifestMemo: memo,
      });
      expect(warm.memoHitCount).toBe(0);
      expect(warm.files[0]?.contentHash).toBe(coldFile.contentHash);
      expect(warm.files[0]?.contentHash).not.toBe('sentinel-hash');
    });

    it('rehashes when mtime changes even if size would still match', async () => {
      const path = join(root, 'a.ts');
      writeFileSync(path, 'export const a = 1;');
      const cold = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
      });
      const [coldFile] = cold.files;
      if (!coldFile) throw new Error('cold scan produced no files');

      // Bump the file's mtime forward by 1 second on disk; scanner sees
      // a new mtime and the memo (which has the OLD mtime) misses.
      const newMtimeSec = Math.floor(coldFile.mtimeMs / 1000) + 5;
      utimesSync(path, newMtimeSec, newMtimeSec);

      const memo = new Map<string, ScanMemoEntry>([
        [
          coldFile.relpath,
          {
            contentHash: 'sentinel-hash',
            mtimeMs: coldFile.mtimeMs, // old mtime
            size: coldFile.size,
          },
        ],
      ]);
      const warm = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
        manifestMemo: memo,
      });
      expect(warm.memoHitCount).toBe(0);
      expect(warm.files[0]?.contentHash).not.toBe('sentinel-hash');
    });

    it('forceRescan: true bypasses the memo even on a perfect match', async () => {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
      const cold = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
      });
      const [coldFile] = cold.files;
      if (!coldFile) throw new Error('cold scan produced no files');

      const memo = new Map<string, ScanMemoEntry>([
        [
          coldFile.relpath,
          {
            contentHash: 'sentinel-hash',
            mtimeMs: coldFile.mtimeMs,
            size: coldFile.size,
          },
        ],
      ]);
      const warm = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
        manifestMemo: memo,
        forceRescan: true,
      });
      expect(warm.memoHitCount).toBe(0);
      expect(warm.files[0]?.contentHash).not.toBe('sentinel-hash');
    });

    it('verifies the merged filesHash is stable across cold→warm rescans', async () => {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
      writeFileSync(join(root, 'b.ts'), 'export const b = 2;');
      const cold = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
      });

      const memo = new Map<string, ScanMemoEntry>(
        cold.files.map((f) => [
          f.relpath,
          {
            contentHash: f.contentHash,
            mtimeMs: f.mtimeMs,
            size: f.size,
          },
        ]),
      );
      const warm = await scanWorkspace(root, {
        maxFiles: 100,
        maxFileSizeBytes: 100_000,
        manifestMemo: memo,
      });
      expect(warm.filesHash).toBe(cold.filesHash);
      expect(warm.memoHitCount).toBe(2);
    });
  });

  describe('buildScanMemo (v1.13.0+)', () => {
    it('drops rows lacking mtimeMs or size (pre-1.13 manifests)', () => {
      const rows: FileRow[] = [
        // Pre-1.13 row — no mtimeMs/size. Drops.
        {
          workspaceRoot: '/ws',
          relpath: 'old.ts',
          contentHash: 'hh1',
          fileId: null,
          uploadedAt: null,
          expiresAt: null,
        },
        // Post-1.13 row — full fingerprint. Kept.
        {
          workspaceRoot: '/ws',
          relpath: 'new.ts',
          contentHash: 'hh2',
          fileId: null,
          uploadedAt: null,
          expiresAt: null,
          mtimeMs: 1000,
          size: 50,
        },
      ];
      const memo = buildScanMemo(rows);
      expect(memo.size).toBe(1);
      expect(memo.get('new.ts')?.contentHash).toBe('hh2');
      expect(memo.has('old.ts')).toBe(false);
    });

    it('returns an empty map on an empty input (first-run case)', () => {
      const memo = buildScanMemo([]);
      expect(memo.size).toBe(0);
    });
  });

  // v1.13.0 — ScannedFile now carries mtimeMs alongside size, so the
  // uploader can persist them to the manifest for the next memo lookup.
  it('ScannedFile exposes mtimeMs and matches stat() output', async () => {
    const path = join(root, 'a.ts');
    writeFileSync(path, 'x');
    const stats = statSync(path);
    const result = await scanWorkspace(root, {
      maxFiles: 100,
      maxFileSizeBytes: 100_000,
    });
    expect(result.files[0]?.mtimeMs).toBe(stats.mtimeMs);
  });
});
