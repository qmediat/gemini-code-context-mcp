import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearHashCache } from '../../src/indexer/hasher.js';
import { scanWorkspace } from '../../src/indexer/workspace-scanner.js';

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

  // v1.4.2 — excludeGlobs pattern normalization (Fix A). Pre-fix these all
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
});
