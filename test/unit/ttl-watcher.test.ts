/**
 * TtlWatcher background refresh behavior.
 *
 * Verifies the watcher's tick logic by passing it pre-seeded `Date.now()`
 * timestamps and invoking `tick()` directly via a type-erased cast. The cast
 * is intentional — the watcher's `tick()`, internal `hot` map, and `client`
 * are private because they're implementation details, but pinning eviction
 * and refresh decisions on actual map state is the most direct way to test
 * the unit's contract. The alternative (driving via `setInterval` + observing
 * `caches.update` calls only) would conflate the timer with the decision
 * logic and require fake timers, hiding logic bugs behind scheduling races.
 *
 * Coverage:
 *   - Hot workspace whose cache nears expiry → caches.update fired + manifest writeback.
 *   - Hot workspace with plenty of TTL left → no caches.update.
 *   - Cold workspace (last used > HOT_WINDOW_MS ago) → evicted, no caches.update.
 *   - Manifest cache_id changed externally → entry evicted (stale pointer).
 *   - 404 / NOT_FOUND from caches.update → entry dropped + manifest cacheId nulled.
 *   - Concurrent ticks (re-entrancy guard): second firing skips while first runs.
 *   - A shared keep-alive refresh outlives the abort of the call that started it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlWatcher } from '../../src/cache/ttl-watcher.js';
import { ManifestDb } from '../../src/manifest/db.js';

interface PrivateTick {
  tick(): Promise<void>;
}

function mkClient(updateImpl: (params: unknown) => Promise<unknown>): GoogleGenAI {
  return {
    caches: { update: vi.fn(updateImpl) },
  } as unknown as GoogleGenAI;
}

describe('TtlWatcher', () => {
  let tmp: string;
  let db: ManifestDb;
  const ws = '/test/wks';
  const cacheId = 'cachedContents/abc';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gcctx-ttlw-'));
    db = new ManifestDb(join(tmp, 'manifest.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedHot(args: { now: number; ttlMs: number; ttlSeconds: number }): TtlWatcher {
    db.upsertWorkspace({
      workspaceRoot: ws,
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId,
      cacheExpiresAt: args.now + args.ttlMs,
      fileIds: [],
      createdAt: args.now,
      updatedAt: args.now,
    });
    const client = mkClient(async () => ({}));
    const watcher = new TtlWatcher(client, db);
    watcher.markHot(ws, cacheId, args.ttlSeconds);
    return watcher;
  }

  it('refreshes a hot cache that expires within REFRESH_IF_EXPIRES_WITHIN_MS', async () => {
    const now = Date.now();
    // 5 min until expiry → inside refresh window (15 min).
    const watcher = seedHot({ now, ttlMs: 5 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;

    await (watcher as unknown as PrivateTick).tick();

    expect(client.caches.update).toHaveBeenCalledWith({
      name: cacheId,
      config: { ttl: '3600s' },
    });
    const after = db.getWorkspace(ws);
    // Manifest writeback advances cacheExpiresAt by ttlSeconds.
    expect(after?.cacheExpiresAt).toBeGreaterThan(now + 5 * 60 * 1000);
  });

  it('keepAlive extends a cache that expires within the window at once, without waiting for a tick', async () => {
    const now = Date.now();
    // 3 min left: the next tick (every 5 min) could come after the cache expired
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;

    await watcher.keepAlive(ws, cacheId, 3600);

    expect(client.caches.update).toHaveBeenCalledWith({ name: cacheId, config: { ttl: '3600s' } });
    expect(db.getWorkspace(ws)?.cacheExpiresAt).toBeGreaterThan(now + 3_500_000);
  });

  it('keepAlive under a signal: a refresh that never settles releases the caller at the abort, with its reason', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    vi.mocked(client.caches.update).mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const reason = new DOMException('Timed out after 1000 ms (total wall-clock)', 'TimeoutError');

    const pending = watcher.keepAlive(ws, cacheId, 3600, controller.signal);
    controller.abort(reason);
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (err: unknown) => err,
      ),
      new Promise((done) => setTimeout(() => done('still waiting'), 1_000)),
    ]);

    expect(outcome).toBe(reason);
    expect(client.caches.update).toHaveBeenCalledWith({ name: cacheId, config: { ttl: '3600s' } });
  });

  it('the call that started a shared refresh aborts: it leaves with its reason, the other keep-alive gets the extended cache', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    const answer = deferred<unknown>();
    const answeredExpiry = now + 3_600_000;
    // the SDK rejects an update whose own abortSignal fires
    vi.mocked(client.caches.update).mockImplementation(((params: {
      config?: { abortSignal?: AbortSignal };
    }) => {
      const updateSignal = params.config?.abortSignal;
      return new Promise((done, fail) => {
        updateSignal?.addEventListener('abort', () => fail(updateSignal.reason));
        void answer.promise.then(done);
      });
    }) as never);
    const starter = new AbortController();
    const reason = new DOMException('Timed out after 1000 ms (total wall-clock)', 'TimeoutError');

    const first = watcher.keepAlive(ws, cacheId, 3600, starter.signal);
    const second = watcher.keepAlive(ws, cacheId, 3600, new AbortController().signal);
    await settleMicrotasks();
    starter.abort(reason);
    await expect(first).rejects.toBe(reason);
    answer.resolve({ expireTime: new Date(answeredExpiry).toISOString() });
    await expect(second).resolves.toBeUndefined();

    expect(db.getWorkspace(ws)?.cacheExpiresAt).toBe(answeredExpiry);
    expect(client.caches.update).toHaveBeenCalledTimes(1);
  });

  it('the background tick refreshes with no abort signal', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 5 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;

    await (watcher as unknown as PrivateTick).tick();

    const params = vi.mocked(client.caches.update).mock.calls[0]?.[0];
    expect(params?.config).toEqual({ ttl: '3600s' });
    expect(params?.config).not.toHaveProperty('abortSignal');
  });

  it('two concurrent keep-alives of one cache send one caches.update, and both wait for it', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    const answer = deferred<unknown>();
    vi.mocked(client.caches.update).mockImplementation(() => answer.promise as never);

    const first = watcher.keepAlive(ws, cacheId, 3600, new AbortController().signal);
    const second = watcher.keepAlive(ws, cacheId, 3600, new AbortController().signal);
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await settleMicrotasks();
    expect(secondDone).toBe(false);
    answer.resolve({});
    await Promise.all([first, second]);

    expect(client.caches.update).toHaveBeenCalledTimes(1);
  });

  it('a tick while a keep-alive refreshes the same cache joins it: one caches.update', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    const answer = deferred<unknown>();
    vi.mocked(client.caches.update).mockImplementation(() => answer.promise as never);

    const keepAlive = watcher.keepAlive(ws, cacheId, 3600);
    const tick = (watcher as unknown as PrivateTick).tick();
    answer.resolve({});
    await Promise.all([keepAlive, tick]);

    expect(client.caches.update).toHaveBeenCalledTimes(1);
  });

  it('stores the expiry the API answered, on the row as it stands after the round-trip', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    const answeredExpiry = now + 3_000_000;
    vi.mocked(client.caches.update).mockImplementation(async () => {
      // the row is rewritten while the refresh is on the wire
      const row = db.getWorkspace(ws);
      if (row) db.upsertWorkspace({ ...row, filesHash: 'rewritten' });
      return { expireTime: new Date(answeredExpiry).toISOString() } as never;
    });

    await watcher.keepAlive(ws, cacheId, 3600);

    const after = db.getWorkspace(ws);
    expect(after?.cacheExpiresAt).toBe(answeredExpiry);
    expect(after?.filesHash).toBe('rewritten');
  });

  it('keepAlive under a signal that already fired sends no caches.update and rejects with its reason', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    const controller = new AbortController();
    const reason = new DOMException('Timed out', 'TimeoutError');
    controller.abort(reason);

    await expect(watcher.keepAlive(ws, cacheId, 3600, controller.signal)).rejects.toBe(reason);
    expect(client.caches.update).not.toHaveBeenCalled();
  });

  it('a manifest that cannot be read fails neither the keep-alive nor the tick', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    vi.spyOn(db, 'getWorkspace').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    await expect(watcher.keepAlive(ws, cacheId, 3600)).resolves.toBeUndefined();
    await expect((watcher as unknown as PrivateTick).tick()).resolves.toBeUndefined();
  });

  it('a manifest that cannot be written after the refresh fails no keep-alive', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 3 * 60 * 1000, ttlSeconds: 3600 });
    vi.spyOn(db, 'upsertWorkspace').mockImplementation(() => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });

    await expect(watcher.keepAlive(ws, cacheId, 3600)).resolves.toBeUndefined();
  });

  it('keepAlive leaves a cache with plenty of time as it is, and marks it hot', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 30 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    const hot = (watcher as unknown as { hot: Map<string, { lastUsed: number }> }).hot;
    const entry = hot.get(ws);
    if (entry) entry.lastUsed = now - 9 * 60 * 1000;

    await watcher.keepAlive(ws, cacheId, 3600);

    expect(client.caches.update).not.toHaveBeenCalled();
    expect(hot.get(ws)?.lastUsed).toBeGreaterThanOrEqual(now);
  });

  it('skips refresh when plenty of TTL is left', async () => {
    const now = Date.now();
    // 30 min until expiry → outside refresh window (15 min).
    const watcher = seedHot({ now, ttlMs: 30 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;

    await (watcher as unknown as PrivateTick).tick();
    expect(client.caches.update).not.toHaveBeenCalled();
  });

  it('evicts cold workspaces (last used > HOT_WINDOW_MS ago) without calling caches.update', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 5 * 60 * 1000, ttlSeconds: 3600 });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;
    // Force lastUsed into the past beyond HOT_WINDOW_MS (10 min).
    const hot = (watcher as unknown as { hot: Map<string, { lastUsed: number }> }).hot;
    const entry = hot.get(ws);
    if (entry) entry.lastUsed = now - 11 * 60 * 1000;

    await (watcher as unknown as PrivateTick).tick();

    expect(client.caches.update).not.toHaveBeenCalled();
    expect(hot.has(ws)).toBe(false);
  });

  it('evicts when manifest cache_id no longer matches (external rebuild)', async () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 5 * 60 * 1000, ttlSeconds: 3600 });
    // Simulate an external rebuild: manifest now has a different cacheId.
    db.upsertWorkspace({
      workspaceRoot: ws,
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId: 'cachedContents/different',
      cacheExpiresAt: now + 10 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = (watcher as unknown as { client: GoogleGenAI }).client;

    await (watcher as unknown as PrivateTick).tick();

    expect(client.caches.update).not.toHaveBeenCalled();
    const hot = (watcher as unknown as { hot: Map<string, unknown> }).hot;
    expect(hot.has(ws)).toBe(false);
  });

  it('drops entry + nulls manifest cacheId on 404 / NOT_FOUND from caches.update', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot: ws,
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId,
      cacheExpiresAt: now + 5 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = mkClient(async () => {
      throw new Error('404 NOT_FOUND: cachedContent does not exist');
    });
    const watcher = new TtlWatcher(client, db);
    watcher.markHot(ws, cacheId, 3600);

    await (watcher as unknown as PrivateTick).tick();

    const after = db.getWorkspace(ws);
    expect(after?.cacheId).toBeNull();
    expect(after?.cacheExpiresAt).toBeNull();
    const hot = (watcher as unknown as { hot: Map<string, unknown> }).hot;
    expect(hot.has(ws)).toBe(false);
  });

  it('keeps entry on transient (non-404) update failure', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot: ws,
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId,
      cacheExpiresAt: now + 5 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = mkClient(async () => {
      throw new Error('500 internal');
    });
    const watcher = new TtlWatcher(client, db);
    watcher.markHot(ws, cacheId, 3600);

    await (watcher as unknown as PrivateTick).tick();

    const after = db.getWorkspace(ws);
    expect(after?.cacheId).toBe(cacheId); // unchanged
    const hot = (watcher as unknown as { hot: Map<string, unknown> }).hot;
    expect(hot.has(ws)).toBe(true); // still hot — will retry next tick
  });

  it('re-entrancy guard: a second tick fires through to a no-op while the first is pending', async () => {
    const now = Date.now();
    let resolveUpdate: (() => void) | null = null;
    const updateFn = vi.fn(
      () =>
        new Promise<unknown>((res) => {
          resolveUpdate = () => res({});
        }),
    );
    db.upsertWorkspace({
      workspaceRoot: ws,
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId,
      cacheExpiresAt: now + 5 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = { caches: { update: updateFn } } as unknown as GoogleGenAI;
    const watcher = new TtlWatcher(client, db);
    watcher.markHot(ws, cacheId, 3600);

    const first = (watcher as unknown as PrivateTick).tick();
    // Yield so first tick reaches the await point inside caches.update.
    await Promise.resolve();
    const second = (watcher as unknown as PrivateTick).tick();
    // Second should resolve immediately (re-entrancy guard).
    await second;
    expect(updateFn).toHaveBeenCalledTimes(1);
    // Now finish the first.
    resolveUpdate?.();
    await first;
    expect(updateFn).toHaveBeenCalledTimes(1);
  });

  it('start() / stop() lifecycle does not throw and clears hot map', () => {
    const now = Date.now();
    const watcher = seedHot({ now, ttlMs: 5 * 60 * 1000, ttlSeconds: 3600 });
    watcher.start();
    watcher.start(); // idempotent
    watcher.stop();
    const hot = (watcher as unknown as { hot: Map<string, unknown> }).hot;
    expect(hot.size).toBe(0);
  });
});

/** A promise and the function that resolves it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every queued microtask run. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
