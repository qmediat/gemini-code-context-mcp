/**
 * Unit coverage for `uploadWorkspaceFiles`.
 *
 * Verifies (without hitting the network):
 *   - Hash-based dedup against manifest (reuse path preserves uploadedAt/expiresAt).
 *   - Safety-margin re-upload when an existing row is < 2 h from expiry.
 *   - In-batch dedup (two ScannedFiles with same hash share one upload).
 *   - Per-upload failures collected in `failures[]` without throwing.
 *   - `concurrency` clamps `client.files.upload` parallelism (max-in-flight).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadWorkspaceFiles } from '../../src/cache/files-uploader.js';
import type { ScannedFile } from '../../src/indexer/workspace-scanner.js';
import { ManifestDb } from '../../src/manifest/db.js';
import type { ProgressEmitter } from '../../src/utils/progress.js';

function mkEmitter(): ProgressEmitter {
  return { emit: vi.fn(), stop: vi.fn() };
}

function mkScanned(relpath: string, hash: string, abs: string, size = 100): ScannedFile {
  return { relpath, contentHash: hash, absolutePath: abs, size };
}

function mkClient(uploadImpl: (params: unknown) => Promise<{ uri?: string; name?: string }>) {
  return {
    files: { upload: vi.fn(uploadImpl) },
  } as unknown as GoogleGenAI;
}

describe('uploadWorkspaceFiles', () => {
  let tmp: string;
  let db: ManifestDb;
  const workspaceRoot = '/test/wks';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gcctx-uploader-'));
    db = new ManifestDb(join(tmp, 'manifest.db'));
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'h0',
      model: 'm',
      systemPromptHash: '',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('reuses an existing fresh upload by content hash (no client.files.upload call)', async () => {
    const now = Date.now();
    db.upsertFile({
      workspaceRoot,
      relpath: 'a.ts',
      contentHash: 'hashA',
      fileId: 'https://generativelanguage.googleapis.com/v1beta/files/old',
      uploadedAt: now - 60 * 1000,
      expiresAt: now + 24 * 3600 * 1000, // 24 h left → safe
    });
    const client = mkClient(async () => {
      throw new Error('should not upload');
    });
    const file = join(tmp, 'a.ts');
    writeFileSync(file, 'x');

    const result = await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files: [mkScanned('a.ts', 'hashA', file)],
      emitter: mkEmitter(),
    });

    expect(result.reusedCount).toBe(1);
    expect(result.uploadedCount).toBe(0);
    expect(client.files.upload).not.toHaveBeenCalled();
    // Reuse path preserves the original upload identity.
    expect(result.files[0]?.fileId).toBe(
      'https://generativelanguage.googleapis.com/v1beta/files/old',
    );
  });

  it('re-uploads when an existing row expires within the cache-build safety margin (< 2 h)', async () => {
    const now = Date.now();
    db.upsertFile({
      workspaceRoot,
      relpath: 'b.ts',
      contentHash: 'hashB',
      fileId: 'https://generativelanguage.googleapis.com/v1beta/files/expiring-soon',
      uploadedAt: now - 46 * 3600 * 1000,
      expiresAt: now + 30 * 60 * 1000, // 30 min left → unsafe
    });
    const client = mkClient(async () => ({
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/fresh',
    }));
    const file = join(tmp, 'b.ts');
    writeFileSync(file, 'x');

    const result = await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files: [mkScanned('b.ts', 'hashB', file)],
      emitter: mkEmitter(),
    });

    expect(result.uploadedCount).toBe(1);
    expect(result.reusedCount).toBe(0);
    expect(client.files.upload).toHaveBeenCalledTimes(1);
    expect(result.files[0]?.fileId).toBe(
      'https://generativelanguage.googleapis.com/v1beta/files/fresh',
    );
  });

  it('in-batch dedup: two files with the same hash share one upload call', async () => {
    const uploadFn = vi.fn(async () => ({
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/shared',
    }));
    const client = { files: { upload: uploadFn } } as unknown as GoogleGenAI;
    const f1 = join(tmp, 'first.ts');
    const f2 = join(tmp, 'duplicate.ts');
    writeFileSync(f1, 'same');
    writeFileSync(f2, 'same');

    const result = await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files: [mkScanned('first.ts', 'hashSAME', f1), mkScanned('duplicate.ts', 'hashSAME', f2)],
      emitter: mkEmitter(),
      concurrency: 4,
    });

    // First wins as upload, second reuses in-batch.
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(result.uploadedCount).toBe(1);
    expect(result.reusedCount).toBe(1);
    expect(result.files).toHaveLength(2);
    // Both rows resolve to the SAME fileId (the shared upload).
    expect(result.files[0]?.fileId).toBe(result.files[1]?.fileId);
  });

  it('captures per-file upload failures in failures[] without throwing the whole batch', async () => {
    const uploadFn = vi.fn(async (params: { file: string }) => {
      if (params.file.includes('bad')) {
        throw new Error('quota exceeded');
      }
      return { uri: `https://generativelanguage.googleapis.com/v1beta/files/${params.file}` };
    });
    const client = { files: { upload: uploadFn } } as unknown as GoogleGenAI;

    const ok = join(tmp, 'good.ts');
    const bad = join(tmp, 'bad.ts');
    writeFileSync(ok, 'a');
    writeFileSync(bad, 'b');

    const result = await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files: [mkScanned('good.ts', 'hashOK', ok), mkScanned('bad.ts', 'hashBAD', bad)],
      emitter: mkEmitter(),
    });

    expect(result.uploadedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.failures).toEqual([{ relpath: 'bad.ts', error: 'quota exceeded' }]);
    // Successful file lands in `files[]`; failed file is dropped.
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.relpath).toBe('good.ts');
  });

  it('respects concurrency cap on parallel upload pool', async () => {
    let inFlight = 0;
    let observedMax = 0;
    const uploadFn = vi.fn(async (params: { file: string }) => {
      inFlight += 1;
      observedMax = Math.max(observedMax, inFlight);
      // Yield to the event loop so the pool can saturate.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { uri: `https://generativelanguage.googleapis.com/v1beta/files/${params.file}` };
    });
    const client = { files: { upload: uploadFn } } as unknown as GoogleGenAI;

    const N = 8;
    const files: ScannedFile[] = [];
    for (let i = 0; i < N; i += 1) {
      const p = join(tmp, `f${i}.ts`);
      writeFileSync(p, String(i));
      files.push(mkScanned(`f${i}.ts`, `h${i}`, p));
    }

    await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files,
      emitter: mkEmitter(),
      concurrency: 3,
    });

    expect(uploadFn).toHaveBeenCalledTimes(N);
    expect(observedMax).toBeLessThanOrEqual(3);
    expect(observedMax).toBeGreaterThan(1); // proves pool is actually parallel
  });

  it('throws if SDK returns neither uri nor name', async () => {
    const client = mkClient(async () => ({}));
    const file = join(tmp, 'orphan.ts');
    writeFileSync(file, 'z');

    const result = await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files: [mkScanned('orphan.ts', 'hashZ', file)],
      emitter: mkEmitter(),
    });

    // Pool collects the throw as a failure, not a thrown promise.
    expect(result.failedCount).toBe(1);
    expect(result.failures[0]?.error).toMatch(/no identifier/);
  });

  it('emits progress notifications on each completion', async () => {
    const emitter = mkEmitter();
    const client = mkClient(async (params: unknown) => ({
      uri: `https://generativelanguage.googleapis.com/v1beta/files/${(params as { file: string }).file}`,
    }));

    const f1 = join(tmp, 'p1.ts');
    const f2 = join(tmp, 'p2.ts');
    writeFileSync(f1, '1');
    writeFileSync(f2, '2');

    await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files: [mkScanned('p1.ts', 'h1', f1), mkScanned('p2.ts', 'h2', f2)],
      emitter,
    });

    expect(emitter.emit).toHaveBeenCalled();
    const calls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
    // Each progress update names the file and shows N/total.
    expect(calls.some((c) => /indexed 1\/2/.test(c[0] as string))).toBe(true);
    expect(calls.some((c) => /indexed 2\/2/.test(c[0] as string))).toBe(true);
  });
});
