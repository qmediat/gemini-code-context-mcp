/**
 * TtlWatcher background refresh behavior.
 *
 * Verifies (with vi.useFakeTimers + manual `tick()` calls — the watcher's
 * private tick is exercised via type-erased access for direct, race-free testing):
 *   - Hot workspace whose cache nears expiry → caches.update fired + manifest writeback.
 *   - Hot workspace with plenty of TTL left → no caches.update.
 *   - Cold workspace (last used > HOT_WINDOW_MS ago) → evicted, no caches.update.
 *   - Manifest cache_id changed externally → entry evicted (stale pointer).
 *   - 404 / NOT_FOUND from caches.update → entry dropped + manifest cacheId nulled.
 *   - Concurrent ticks (re-entrancy guard): second firing skips while first runs.
 */

import { mkdtempSync } from 'node:fs';
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
    vi.useRealTimers();
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
