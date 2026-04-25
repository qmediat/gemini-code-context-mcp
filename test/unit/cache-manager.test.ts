/**
 * Unit coverage for `prepareContext` (cache-manager).
 *
 * Verifies the four cache-decision branches without hitting the network:
 *   - Cache HIT (matching fingerprint, fresh expiry) — no upload, no rebuild.
 *   - Cache MISS but workspace under inline floor → no upload, inline path.
 *   - allowCaching=false → inline-from-disk path, no Files API call.
 *   - Cache REBUILD when files_hash / model / systemPromptHash differ.
 *   - Pre-rebuild cache deletion when an existing cache_id is present.
 *   - In-process mutex coalescing: two concurrent prepareContext calls share one build.
 *
 * Also covers `isStaleCacheError` heuristic (regex coverage) and `markCacheStale`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isStaleCacheError,
  markCacheStale,
  prepareContext,
} from '../../src/cache/cache-manager.js';
import type { ScanResult } from '../../src/indexer/workspace-scanner.js';
import { ManifestDb } from '../../src/manifest/db.js';
import type { ResolvedModel } from '../../src/types.js';
import type { ProgressEmitter } from '../../src/utils/progress.js';

function mkEmitter(): ProgressEmitter {
  return { emit: vi.fn(), stop: vi.fn() };
}

function mkModel(): ResolvedModel {
  return {
    requested: 'latest-pro-thinking',
    resolved: 'gemini-3-pro-preview',
    fallbackApplied: false,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 65_536,
    category: 'text-reasoning',
    capabilities: {
      supportsThinking: true,
      supportsVision: false,
      supportsCodeExecution: false,
      costTier: 'premium',
    },
  };
}

function mkClient(opts: {
  cachesCreate?: (params: unknown) => Promise<{ name: string }>;
  cachesDelete?: (params: unknown) => Promise<unknown>;
  filesUpload?: (params: unknown) => Promise<{ uri?: string; name?: string }>;
}): GoogleGenAI {
  return {
    caches: {
      create: vi.fn(opts.cachesCreate ?? (async () => ({ name: 'cachedContents/new' }))),
      delete: vi.fn(opts.cachesDelete ?? (async () => ({}))),
    },
    files: {
      upload: vi.fn(
        opts.filesUpload ??
          (async (params: unknown) => ({
            uri: `https://generativelanguage.googleapis.com/v1beta/files/${(params as { file: string }).file}`,
          })),
      ),
    },
  } as unknown as GoogleGenAI;
}

describe('prepareContext', () => {
  let tmp: string;
  let workspaceRoot: string;
  let db: ManifestDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gcctx-cmgr-'));
    // Real workspace dir so the inline-from-disk path can readFile().
    workspaceRoot = join(tmp, 'wks');
    mkdirSync(workspaceRoot);
    db = new ManifestDb(join(tmp, 'manifest.db'));
  });

  afterEach(() => {
    db.close();
  });

  function mkScan(files: { relpath: string; size: number; content?: string }[]): ScanResult {
    const scanned = files.map((f) => {
      const abs = join(workspaceRoot, f.relpath);
      writeFileSync(abs, f.content ?? 'x'.repeat(f.size));
      return {
        relpath: f.relpath,
        absolutePath: abs,
        size: f.size,
        contentHash: `h-${f.relpath}`,
      };
    });
    return {
      workspaceRoot,
      files: scanned,
      filesHash: 'fh-1',
      skippedTooLarge: 0,
      truncated: false,
    };
  }

  it('cache HIT: matching fingerprint + fresh expiry → no upload, no create', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-1',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-1',
      cacheId: 'cachedContents/existing',
      cacheExpiresAt: now + 30 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = mkClient({});

    const result = await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'a.ts', size: 100 }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    expect(result.reused).toBe(true);
    expect(result.rebuilt).toBe(false);
    expect(result.cacheId).toBe('cachedContents/existing');
    expect(result.inlineContents).toEqual([]);
    expect(client.files.upload).not.toHaveBeenCalled();
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(client.caches.delete).not.toHaveBeenCalled();
  });

  it('cache MISS — under inline floor (estimatedTokens < cacheMinTokens) → inline-from-disk', async () => {
    const client = mkClient({});

    const result = await prepareContext({
      client,
      manifest: db,
      // 2 files * 100 bytes = ~50 tokens, well under default 1024 floor.
      scan: mkScan([
        { relpath: 'a.ts', size: 100, content: 'console.log("a")' },
        { relpath: 'b.ts', size: 100, content: 'console.log("b")' },
      ]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    expect(result.inlineOnly).toBe(true);
    expect(result.cacheId).toBeNull();
    expect(result.inlineContents).toHaveLength(1);
    expect(client.files.upload).not.toHaveBeenCalled();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('allowCaching=false → inline path even when workspace is large enough', async () => {
    const client = mkClient({});

    const result = await prepareContext({
      client,
      manifest: db,
      // Big enough to clear the 1024-token floor — but we forbid caching.
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: false,
    });

    expect(result.inlineOnly).toBe(true);
    expect(result.cacheId).toBeNull();
    expect(client.files.upload).not.toHaveBeenCalled();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('cache REBUILD: filesHash mismatch → uploads + creates new cache + deletes old', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-OLD',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-1',
      cacheId: 'cachedContents/stale',
      cacheExpiresAt: now + 30 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = mkClient({
      cachesCreate: async () => ({ name: 'cachedContents/fresh' }),
    });

    const result = await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    expect(result.rebuilt).toBe(true);
    expect(result.cacheId).toBe('cachedContents/fresh');
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/stale' });
    expect(client.caches.create).toHaveBeenCalled();
    expect(client.files.upload).toHaveBeenCalledTimes(1);
    // Manifest was updated with the new cacheId.
    const after = db.getWorkspace(workspaceRoot);
    expect(after?.cacheId).toBe('cachedContents/fresh');
    expect(after?.filesHash).toBe('fh-1');
  });

  it('cache REBUILD: model mismatch (different resolved id) → triggers rebuild', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-1',
      model: 'gemini-2.5-pro', // <-- different from mkModel().resolved
      systemPromptHash: 'sph-1',
      cacheId: 'cachedContents/wrong-model',
      cacheExpiresAt: now + 30 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = mkClient({});

    const result = await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    expect(result.rebuilt).toBe(true);
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/wrong-model' });
  });

  it('cache REBUILD: systemPromptHash mismatch (ask vs code) → triggers rebuild', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-1',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-ask',
      cacheId: 'cachedContents/ask-cache',
      cacheExpiresAt: now + 30 * 60 * 1000,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const client = mkClient({});

    const result = await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-code',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    expect(result.rebuilt).toBe(true);
  });

  // Multi-await pump: drain enough microtasks for the upload pool + readFile
  // chains to settle and reach caches.create. Polls instead of fixed-count
  // yielding because the depth of awaits varies with filesystem speed.
  async function pumpUntil(predicate: () => boolean, maxTicks = 100): Promise<void> {
    for (let i = 0; i < maxTicks; i += 1) {
      if (predicate()) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`pumpUntil timed out after ${maxTicks} ticks`);
  }

  it('in-process mutex: two concurrent prepareContext calls coalesce to one cache build', async () => {
    let createCount = 0;
    let resolveCreate: ((v: { name: string }) => void) | null = null;
    const client = mkClient({
      cachesCreate: () =>
        new Promise<{ name: string }>((res) => {
          createCount += 1;
          resolveCreate = res;
        }),
    });

    const args = {
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    };

    const p1 = prepareContext(args);
    const p2 = prepareContext(args);
    // Wait for the (single) build to reach caches.create.
    await pumpUntil(() => createCount === 1);
    expect(createCount).toBe(1);
    resolveCreate?.({ name: 'cachedContents/coalesced' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cacheId).toBe('cachedContents/coalesced');
    expect(r2.cacheId).toBe('cachedContents/coalesced');
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it('in-process mutex: different systemPromptHash → does NOT coalesce (independent caches)', async () => {
    let createCalls = 0;
    const resolvers: Array<(v: { name: string }) => void> = [];
    const client = mkClient({
      cachesCreate: () =>
        new Promise<{ name: string }>((res) => {
          createCalls += 1;
          resolvers.push(res);
        }),
    });

    const base = {
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    };

    const pAsk = prepareContext({ ...base, systemPromptHash: 'sph-ask' });
    const pCode = prepareContext({ ...base, systemPromptHash: 'sph-code' });
    // Both must reach caches.create independently — different fingerprints.
    await pumpUntil(() => createCalls === 2);
    expect(createCalls).toBe(2);
    resolvers[0]?.({ name: 'cachedContents/ask' });
    resolvers[1]?.({ name: 'cachedContents/code' });
    await Promise.all([pAsk, pCode]);
    expect(client.caches.create).toHaveBeenCalledTimes(2);
  });

  it('cache build fails → falls back to inline contents (does not throw)', async () => {
    const client = mkClient({
      cachesCreate: async () => {
        throw new Error('quota exceeded');
      },
    });

    const result = await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    expect(result.cacheId).toBeNull();
    expect(result.rebuilt).toBe(false);
    // Inline content built from the uploaded fileData parts.
    expect(result.inlineContents.length).toBeGreaterThan(0);
    expect(result.inlineOnly).toBe(false); // distinguishes "fallback after upload" from "small workspace"
  });
});

describe('isStaleCacheError', () => {
  it.each([
    'CachedContent not found',
    'cachedContent does not exist',
    '404 cached_content',
    'NOT_FOUND: cachedContent expired',
    'cached_content not-found',
  ])('matches %s', (msg) => {
    expect(isStaleCacheError(new Error(msg))).toBe(true);
  });

  it.each([
    'rate limit',
    'INVALID_ARGUMENT: bad schema',
    'fetch failed',
    'Cache hit', // not an error pattern
  ])('does not match %s', (msg) => {
    expect(isStaleCacheError(new Error(msg))).toBe(false);
  });

  it('handles non-Error inputs', () => {
    expect(isStaleCacheError('cachedContent NOT_FOUND')).toBe(true);
    expect(isStaleCacheError(null)).toBe(false);
    expect(isStaleCacheError(undefined)).toBe(false);
  });
});

describe('markCacheStale', () => {
  let tmp: string;
  let db: ManifestDb;
  const ws = '/test/ws';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gcctx-stale-'));
    db = new ManifestDb(join(tmp, 'manifest.db'));
  });

  afterEach(() => {
    db.close();
  });

  it('nulls cacheId/cacheExpiresAt without touching files table', () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot: ws,
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId: 'cachedContents/about-to-die',
      cacheExpiresAt: now + 60_000,
      fileIds: ['files/a'],
      createdAt: now,
      updatedAt: now,
    });
    db.upsertFile({
      workspaceRoot: ws,
      relpath: 'a.ts',
      contentHash: 'hh',
      fileId: 'files/a',
      uploadedAt: now,
      expiresAt: now + 47 * 3600 * 1000,
    });

    markCacheStale({ manifest: db, workspaceRoot: ws });

    const after = db.getWorkspace(ws);
    expect(after?.cacheId).toBeNull();
    expect(after?.cacheExpiresAt).toBeNull();
    // Files table untouched — uploader can dedupe-reuse on rebuild.
    expect(db.getFiles(ws)).toHaveLength(1);
  });

  it('no-op when workspace row missing', () => {
    expect(() => markCacheStale({ manifest: db, workspaceRoot: '/nonexistent' })).not.toThrow();
  });
});
