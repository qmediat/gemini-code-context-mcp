import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearHashCache, hashFile, mergeHashes } from '../../src/indexer/hasher.js';

describe('hasher', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gcctx-hasher-'));
    clearHashCache();
  });

  afterEach(() => {
    clearHashCache();
  });

  it('produces stable sha256 for the same content', async () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'hello world');
    const first = await hashFile(path);
    const second = await hashFile(path);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different content', async () => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'alpha');
    writeFileSync(b, 'beta');
    const ha = await hashFile(a);
    const hb = await hashFile(b);
    expect(ha).not.toBe(hb);
  });

  it('merges file hashes deterministically regardless of input order', () => {
    const inputA = [
      { relpath: 'src/b.ts', hash: 'bbb' },
      { relpath: 'src/a.ts', hash: 'aaa' },
    ];
    const inputB = [
      { relpath: 'src/a.ts', hash: 'aaa' },
      { relpath: 'src/b.ts', hash: 'bbb' },
    ];
    expect(mergeHashes(inputA)).toBe(mergeHashes(inputB));
  });

  it('produces different merged hash when a file changes', () => {
    const before = mergeHashes([
      { relpath: 'src/a.ts', hash: 'aaa' },
      { relpath: 'src/b.ts', hash: 'bbb' },
    ]);
    const after = mergeHashes([
      { relpath: 'src/a.ts', hash: 'aaa2' },
      { relpath: 'src/b.ts', hash: 'bbb' },
    ]);
    expect(before).not.toBe(after);
  });
});
