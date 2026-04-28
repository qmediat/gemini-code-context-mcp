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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadWorkspaceFiles } from '../../src/cache/files-uploader.js';
import type { ScannedFile } from '../../src/indexer/workspace-scanner.js';
import { ManifestDb } from '../../src/manifest/db.js';
import { logger } from '../../src/utils/logger.js';
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
    rmSync(tmp, { recursive: true, force: true });
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

  // Deterministic concurrency check: each upload registers on a barrier and
  // waits to be released. We let the pool fully saturate (observe exactly
  // `cap` concurrent in-flight), then drain via barrier release. No wall-clock.
  // With cap=3 and 8 files the test sees observedMax === 3; with cap=1 the
  // pool runs strictly sequentially → observedMax === 1. A broken impl that
  // hardcoded `concurrency: 2` would fail BOTH assertions, not silently pass.
  async function probeConcurrency(cap: number, fileCount: number): Promise<number> {
    let inFlight = 0;
    let observedMax = 0;
    let completedCount = 0;
    // Resolvers waiting to be released, in arrival order.
    const heldResolvers: Array<() => void> = [];

    const uploadFn = vi.fn(async (params: { file: string }) => {
      inFlight += 1;
      observedMax = Math.max(observedMax, inFlight);
      // Block until the test releases this worker.
      await new Promise<void>((resolve) => heldResolvers.push(resolve));
      inFlight -= 1;
      completedCount += 1;
      return { uri: `https://generativelanguage.googleapis.com/v1beta/files/${params.file}` };
    });
    const client = { files: { upload: uploadFn } } as unknown as GoogleGenAI;

    const files: ScannedFile[] = [];
    for (let i = 0; i < fileCount; i += 1) {
      const p = join(tmp, `cap${cap}-f${i}.ts`);
      writeFileSync(p, String(i));
      files.push(mkScanned(`cap${cap}-f${i}.ts`, `cap${cap}-h${i}`, p));
    }

    const work = uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files,
      emitter: mkEmitter(),
      concurrency: cap,
    });

    // Pump-release cycle: every iteration waits for one or more workers to
    // become held, releases ALL currently held, then yields. Repeats until
    // every file's upload has completed. Since `runPool` only spawns `cap`
    // workers (each loops), we'll hold AT MOST cap at a time → observedMax = cap.
    while (completedCount < fileCount) {
      // Let the pool reach steady state for this batch.
      await new Promise((r) => setImmediate(r));
      while (heldResolvers.length > 0) {
        heldResolvers.shift()?.();
      }
    }
    await work;

    expect(uploadFn).toHaveBeenCalledTimes(fileCount);
    return observedMax;
  }

  it('respects concurrency cap on parallel upload pool (concurrency=3)', async () => {
    const max = await probeConcurrency(3, 8);
    // Effective cap is the configured value, not just "bounded somewhere ≤ cap".
    // Without exact equality here, a pool hardcoded to 2 would silently pass.
    expect(max).toBe(3);
  });

  it('honours concurrency=1 (sequential, proves cap is effective not aspirational)', async () => {
    const max = await probeConcurrency(1, 4);
    expect(max).toBe(1);
  });

  it('captures "no identifier" SDK responses as failures (does not throw the batch)', async () => {
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

  // ---------------------------------------------------------------------------
  // v1.12.1 + v1.12.2 — `signal?: AbortSignal` threading
  //
  // Three abort defenses guard the upload pool, each pinned by one test:
  //
  //   (a) Pre-flight: never enter the pool if the signal already fired.
  //   (b) Mid-pool: per-task check before each `client.files.upload` call.
  //   (c) Post-pool: after `runPool` returns, re-check and throw the
  //       canonical reason — `runPool` collects per-task errors as
  //       'rejected' settled results, so the per-task throw alone never
  //       reached the caller pre-v1.12.1 round-2 (Copilot finding COP-2).
  //
  // The post-pool defense is the one that actually surfaces a `TIMEOUT`
  // errorCode at the tool layer; the per-task defense is best-effort
  // short-circuiting of new work.
  // ---------------------------------------------------------------------------

  it('throws immediately when signal is already aborted (pre-flight short-circuit, v1.12.1)', async () => {
    // Defends against the caller racing the abort BEFORE invoking
    // `uploadWorkspaceFiles` — without this guard, the pool would have
    // entered runPool and processed at least one task before the
    // per-task check fired.
    const upload = vi.fn(async (_params: unknown) => ({
      uri: 'https://example.invalid/files/x',
    }));
    const client = mkClient(upload);
    const f1 = join(tmp, 'a.ts');
    writeFileSync(f1, 'a');

    const controller = new AbortController();
    const reason = new DOMException('Timed out after 1000 ms (total wall-clock)', 'TimeoutError');
    controller.abort(reason);

    await expect(
      uploadWorkspaceFiles({
        client,
        manifest: db,
        workspaceRoot,
        files: [mkScanned('a.ts', 'h1', f1)],
        emitter: mkEmitter(),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    // No SDK calls — short-circuit fired before runPool even started.
    expect(upload).not.toHaveBeenCalled();
  });

  it('post-runPool abort propagates `signal.reason` (Copilot COP-2 closure, v1.12.1)', async () => {
    // The headline regression test for the v1.12.1 round-2 fix:
    // pre-fix `runPool` collected per-task abort throws as 'rejected'
    // settled results, swallowing the canonical reason and surfacing as
    // a generic "upload failed" entry in `failures`. Post-fix the
    // explicit post-pool check re-throws the controller's reason so the
    // outer tool layer can map it to `errorCode: 'TIMEOUT'`.
    //
    // Strategy: mock `client.files.upload` to fire abort mid-flight
    // (via setImmediate so the abort lands AFTER runPool starts but
    // BEFORE all tasks settle — exercising the post-pool path
    // specifically rather than the pre-flight one).
    let uploadCount = 0;
    const controller = new AbortController();
    const canonicalReason = new DOMException(
      'Timed out after 50 ms (total wall-clock)',
      'TimeoutError',
    );
    Object.assign(canonicalReason, { timeoutKind: 'total' as const });

    const upload = vi.fn(async (_params: unknown) => {
      uploadCount += 1;
      if (uploadCount === 1) {
        // First task: fire the abort synchronously inside the upload
        // call. The await still resolves the promise normally (we
        // don't throw here), but by the time runPool moves to the
        // SECOND task, `signal.aborted === true`. The per-task check
        // at the top of the second task throws, runPool catches it as
        // `'rejected'`, and the post-pool guard then throws
        // `signal.reason` to the outer caller.
        controller.abort(canonicalReason);
      }
      return { uri: `https://example.invalid/files/${uploadCount}` };
    });
    const client = mkClient(upload);

    const files = Array.from({ length: 5 }, (_, i) => {
      const f = join(tmp, `f${i}.ts`);
      writeFileSync(f, String(i));
      return mkScanned(`f${i}.ts`, `h${i}`, f);
    });

    await expect(
      uploadWorkspaceFiles({
        client,
        manifest: db,
        workspaceRoot,
        files,
        emitter: mkEmitter(),
        // Concurrency 1 keeps the abort timing deterministic — the
        // first task fires the abort synchronously; runPool schedules
        // the second, the per-task guard throws AbortError, runPool
        // catches it as 'rejected'; post-pool guard sees aborted and
        // throws canonicalReason.
        concurrency: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(canonicalReason);

    // First upload completed; second was guarded out per-task.
    expect(uploadCount).toBe(1);
  });

  it('post-pool synthesizes AbortError when signal.reason is not an Error (defensive, v1.12.1)', async () => {
    // Edge case: `controller.abort('string-reason')` sets `signal.reason`
    // to a non-Error value. The post-pool block falls back to a
    // synthetic `DOMException('Operation aborted during file upload',
    // 'AbortError')` so the abort still propagates as a recognizable
    // error rather than `throw 'string-reason'`.
    let uploadCount = 0;
    const controller = new AbortController();
    const upload = vi.fn(async (_params: unknown) => {
      uploadCount += 1;
      if (uploadCount === 1) {
        controller.abort('this-is-a-string-not-an-error');
      }
      return { uri: `https://example.invalid/files/${uploadCount}` };
    });
    const client = mkClient(upload);

    const files = Array.from({ length: 3 }, (_, i) => {
      const f = join(tmp, `g${i}.ts`);
      writeFileSync(f, String(i));
      return mkScanned(`g${i}.ts`, `g${i}`, f);
    });

    await expect(
      uploadWorkspaceFiles({
        client,
        manifest: db,
        workspaceRoot,
        files,
        emitter: mkEmitter(),
        concurrency: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Operation aborted/);
  });

  // v1.13.0 round-2 (FN3, gemini P1): mid-pool aborts must NOT spam
  // `logger.warn('upload failed for X')` for every queued task that didn't
  // start. Pre-fix a 100-file workspace aborted at completed=10 produced
  // ~90 misleading warns before the post-pool guard re-threw signal.reason.
  it('FN3 fix: mid-pool abort suppresses per-task warn-log + failures-collection spam', async () => {
    let uploadCount = 0;
    const controller = new AbortController();
    const canonicalReason = new DOMException('Timed out', 'TimeoutError');
    Object.assign(canonicalReason, { timeoutKind: 'total' as const });

    const upload = vi.fn(async (_params: unknown) => {
      uploadCount += 1;
      if (uploadCount === 1) {
        controller.abort(canonicalReason);
      }
      return { uri: `https://example.invalid/files/${uploadCount}` };
    });
    const client = mkClient(upload);

    // 30 files, concurrency 1 — first upload fires abort, remaining ~29 hit
    // the per-task guard. Pre-fix: 29 warns. Post-fix: 0 warns.
    const files = Array.from({ length: 30 }, (_, i) => {
      const f = join(tmp, `spam${i}.ts`);
      writeFileSync(f, String(i));
      return mkScanned(`spam${i}.ts`, `spam${i}`, f);
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      uploadWorkspaceFiles({
        client,
        manifest: db,
        workspaceRoot,
        files,
        emitter: mkEmitter(),
        concurrency: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(canonicalReason);

    // CORE assertion: zero "upload failed" warns from abort-induced rejections.
    const uploadFailedWarns = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((msg) => msg.startsWith('upload failed for '));
    expect(uploadFailedWarns).toHaveLength(0);

    warnSpy.mockRestore();
  });

  // FN3 follow-up: discrimination must NOT swallow GENUINE upload failures
  // when the signal is also aborted. (Edge case: an upload throws a
  // legitimate 5xx Error AT THE SAME TIME the user aborts — we still want
  // to know about the network failure.) The current discrimination keys on
  // `reason === signal.reason || reason.name === 'AbortError'` so a real
  // `Error('500 server error')` survives.
  it('FN3 discrimination: genuine non-abort upload errors still surface as warns', async () => {
    const controller = new AbortController();

    const upload = vi.fn(async (params: unknown) => {
      const file = (params as { file: string }).file;
      if (file.endsWith('boom.ts')) {
        throw new Error('500 internal server error');
      }
      return { uri: `https://example.invalid/files/${file}` };
    });
    const client = mkClient(upload);

    const files = [
      mkScanned('ok.ts', 'ok', join(tmp, 'ok.ts')),
      mkScanned('boom.ts', 'boom', join(tmp, 'boom.ts')),
    ];
    writeFileSync(join(tmp, 'ok.ts'), 'ok');
    writeFileSync(join(tmp, 'boom.ts'), 'boom');

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // No abort fires here — pure upload failure path.
    const result = await uploadWorkspaceFiles({
      client,
      manifest: db,
      workspaceRoot,
      files,
      emitter: mkEmitter(),
      concurrency: 1,
      signal: controller.signal,
    });

    expect(result.failedCount).toBe(1);
    expect(result.failures[0]?.relpath).toBe('boom.ts');
    const uploadFailedWarns = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((msg) => msg.startsWith('upload failed for boom.ts'));
    expect(uploadFailedWarns.length).toBe(1);

    warnSpy.mockRestore();
  });
});
