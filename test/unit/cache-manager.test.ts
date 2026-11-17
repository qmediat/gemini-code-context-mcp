/**
 * Unit coverage for `prepareContext` (cache-manager).
 *
 * Verifies the four cache-decision branches without hitting the network:
 *   - Cache HIT (matching fingerprint, fresh expiry) — no upload, no rebuild.
 *   - Cache MISS but workspace under inline floor → no upload, inline path.
 *   - allowCaching=false → inline-from-disk path, no Files API call.
 *   - Cache REBUILD when files_hash / model / systemPromptHash differ.
 *   - Pre-rebuild cache deletion when an existing cache_id is present.
 *   - In-process mutex coalescing: two concurrent prepareContext calls share one build; a rejected
 *     build is not served to the next call.
 *   - A create that fails, names no cache, or cannot be recorded: what is deleted, kept and warned.
 *
 * Also covers `isStaleCacheError` heuristic (regex coverage), `markCacheStale` and the
 * workspace purge (`invalidateWorkspaceCache`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CachedContent, GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PreparedContext,
  invalidateWorkspaceCache,
  isStaleCacheError,
  markCacheStale,
  prepareContext,
} from '../../src/cache/cache-manager.js';
import type { ScanResult } from '../../src/indexer/workspace-scanner.js';
import { ManifestDb } from '../../src/manifest/db.js';
import type { ResolvedModel } from '../../src/types.js';
import { logger } from '../../src/utils/logger.js';
import type { ProgressEmitter } from '../../src/utils/progress.js';

function mkEmitter(): ProgressEmitter {
  return { emit: vi.fn(), stop: vi.fn() };
}

function mkModel(): ResolvedModel {
  return {
    requested: 'latest-pro-thinking',
    resolved: 'gemini-3-pro-preview',
    fallbackApplied: false,
    supportsCaching: true,
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
  cachesCreate?: (params: unknown) => Promise<{ name?: string }>;
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

/** A created cache as `caches.create` answers it, living `ttlSeconds` from `createdAtMs`. */
function mkCreated(createdAtMs: number, ttlSeconds: number): CachedContent {
  const createTime = new Date(createdAtMs).toISOString();
  return {
    name: 'cachedContents/created',
    displayName: 'gcctx-created',
    model: 'models/gemini-3-pro-preview',
    createTime,
    updateTime: createTime,
    expireTime: new Date(createdAtMs + ttlSeconds * 1000).toISOString(),
    usageMetadata: { totalTokenCount: 2_000 },
  };
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
    rmSync(tmp, { recursive: true, force: true });
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
        // v1.13.0+: ScannedFile carries mtimeMs/memoHit so the scan memo
        // can hydrate after an inline-path call (FN1 fix).
        mtimeMs: Date.now(),
        memoHit: false,
      };
    });
    return {
      workspaceRoot,
      files: scanned,
      filesHash: 'fh-1',
      skippedTooLarge: 0,
      excludedDirs: [],
      excludedDirsTotal: 0,
      skippedNonSource: 0,
      truncated: false,
      memoHitCount: 0,
    };
  }

  /**
   * The workspace row a previous call left: `cacheId`, living 30 minutes from `at`, under this call's fingerprint
   * (`fh-1`, so the call may reuse it) unless `filesHash` names another (so the call rebuilds).
   */
  function seedRow(cacheId: string | null, filesHash = 'fh-1', at = Date.now()): void {
    db.upsertWorkspace({
      workspaceRoot,
      filesHash,
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-1',
      cacheId,
      cacheExpiresAt: at + 30 * 60 * 1000,
      fileIds: [],
      createdAt: at,
      updatedAt: at,
    });
  }

  /** An explicit-cache call on a workspace of one 8 000-byte file (above the token floor), TTL 3600 s. */
  function prepare(client: GoogleGenAI): Promise<PreparedContext> {
    return prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'kept.ts', size: 8_000 }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });
  }

  /** Runs `act` with `logger.warn` captured: its result and the warnings it logged. */
  async function withWarnings<T>(act: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const value = await act();
      return { value, warnings: warn.mock.calls.map((call) => String(call[0])) };
    } finally {
      warn.mockRestore();
    }
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

  it('v1.13.0 cachingMode="implicit": skips caches.create, returns inline contents (rely on Gemini auto-cache)', async () => {
    const client = mkClient({});

    const result = await prepareContext({
      client,
      manifest: db,
      // Big enough to trip the explicit-cache path under default behaviour.
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true, // would normally cache; mode override forces inline
      cachingMode: 'implicit',
    });

    expect(result.inlineOnly).toBe(true);
    expect(result.cacheId).toBeNull();
    expect(result.inlineContents.length).toBeGreaterThan(0);
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(client.files.upload).not.toHaveBeenCalled();

    // Manifest still gets a workspace row so subsequent calls see the
    // current filesHash (preserves invalidation semantics).
    const ws = db.getWorkspace(workspaceRoot);
    expect(ws).not.toBeNull();
    expect(ws?.cacheId).toBeNull();

    // FN1 regression pin (post-review): the implicit-mode inline path MUST
    // seed mtime_ms / size on file rows so the next-call scan memo can
    // short-circuit hashing. Pre-fix this branch never called upsertFile,
    // and the v1.13.0 perf headline silently degraded to cold-every-call.
    const fileRows = db.getFiles(workspaceRoot);
    expect(fileRows.length).toBe(1);
    expect(fileRows[0]?.mtimeMs).toEqual(expect.any(Number));
    expect(fileRows[0]?.size).toEqual(expect.any(Number));
    expect(fileRows[0]?.contentHash).toBe('h-big.ts');
    // file_id / uploaded_at / expires_at MUST stay null on the inline path —
    // refreshFileFingerprints preserves whatever was there (here: nothing,
    // since this is a fresh DB). Switching to explicit later would re-upload
    // and populate these.
    expect(fileRows[0]?.fileId).toBeNull();
    expect(fileRows[0]?.uploadedAt).toBeNull();
  });

  it('v1.13.0 FN1 fix: small-workspace inline path also seeds mtime_ms / size for memo reuse', async () => {
    const client = mkClient({});

    const result = await prepareContext({
      client,
      manifest: db,
      // Below default cacheMinTokens=1024 → small-workspace inline branch.
      scan: mkScan([{ relpath: 'tiny.ts', size: 100, content: 'a' }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    expect(result.inlineOnly).toBe(true);
    expect(result.cacheId).toBeNull();
    expect(client.caches.create).not.toHaveBeenCalled();

    const fileRows = db.getFiles(workspaceRoot);
    expect(fileRows.length).toBe(1);
    expect(fileRows[0]?.mtimeMs).toEqual(expect.any(Number));
    expect(fileRows[0]?.size).toEqual(expect.any(Number));
  });

  it('v1.13.0 round-3 (HIGH): refreshFileFingerprints CLEARS stale fileId/uploadedAt/expiresAt when content_hash changes across explicit→implicit switch', async () => {
    // ROUND-3 corrected pin (replaces the round-2 test that locked in the
    // pre-fix corruption). Scenario A from /6step round-3:
    //   1. Explicit upload: row carries fileId='files/abc123' for OLD content
    //      (hash 'h-big.ts-OLD').
    //   2. User edits big.ts so the hash becomes 'h-big.ts'.
    //   3. User runs implicit; refreshFileFingerprints fires.
    // After fix: file_id MUST be NULL, because the old fileId points at OLD
    // bytes on Google's servers — preserving it would let a later
    // findFileRowByHash(ws, 'h-big.ts', now) hand back the stale fileId and
    // route NEW content through the OLD upload (silent context corruption).
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-prev',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-prev',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    db.upsertFile({
      workspaceRoot,
      relpath: 'big.ts',
      contentHash: 'h-big.ts-OLD',
      fileId: 'files/abc123',
      uploadedAt: now - 60_000,
      expiresAt: now + 47 * 3600 * 1000,
      mtimeMs: 1700000000000,
      size: 9000,
    });

    const client = mkClient({});
    await prepareContext({
      client,
      manifest: db,
      // mkScan generates contentHash = `h-${relpath}` = 'h-big.ts' — a HASH
      // CHANGE from the seeded 'h-big.ts-OLD'.
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
      cachingMode: 'implicit',
    });

    const fileRows = db.getFiles(workspaceRoot);
    // CONTENT-HASH CHANGED → upload metadata cleared.
    expect(fileRows[0]?.fileId).toBeNull();
    expect(fileRows[0]?.uploadedAt).toBeNull();
    expect(fileRows[0]?.expiresAt).toBeNull();
    // mtime / size / contentHash refresh to the new scan's values.
    expect(fileRows[0]?.contentHash).toBe('h-big.ts');
    expect(fileRows[0]?.mtimeMs).not.toBe(1700000000000);
  });

  it('v1.13.0 round-3 (HIGH): refreshFileFingerprints PRESERVES fileId/uploadedAt/expiresAt when content_hash unchanged', async () => {
    // The legitimate cross-mode reuse path. Scenario:
    //   1. Explicit upload: row carries fileId='files/abc123' for content
    //      hash 'h-big.ts'.
    //   2. User flips to implicit WITHOUT editing big.ts.
    //   3. refreshFileFingerprints sees same hash; preserves fileId so a
    //      future switch BACK to explicit can hit Files-API dedup.
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-prev',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-prev',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    db.upsertFile({
      workspaceRoot,
      relpath: 'big.ts',
      // SAME hash that mkScan will produce — content is stable across the mode flip.
      contentHash: 'h-big.ts',
      fileId: 'files/abc123',
      uploadedAt: now - 60_000,
      expiresAt: now + 47 * 3600 * 1000,
      mtimeMs: 1700000000000,
      size: 9000,
    });

    const client = mkClient({});
    await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
      cachingMode: 'implicit',
    });

    const fileRows = db.getFiles(workspaceRoot);
    // CONTENT-HASH UNCHANGED → upload metadata preserved (the reuse path).
    expect(fileRows[0]?.fileId).toBe('files/abc123');
    expect(fileRows[0]?.uploadedAt).toBe(now - 60_000);
    expect(fileRows[0]?.expiresAt).toBe(now + 47 * 3600 * 1000);
    // mtime / size / contentHash always refresh — they sit OUTSIDE the
    // round-3 conditional CASE in refreshFileFingerprints' SET clause.
    // This assertion pins that mtime is unconditional, so a future
    // "improvement" that wraps every column in CASE would surface here
    // rather than silently freezing mtime updates.
    expect(fileRows[0]?.contentHash).toBe('h-big.ts');
    expect(fileRows[0]?.mtimeMs).not.toBe(1700000000000);
  });

  it('v1.13.0 round-3 regression: findFileRowByHash does NOT return a stale fileId after content edit', async () => {
    // End-to-end regression for the silent-corruption scenario from /6step
    // round-3 finding #1. Pre-fix: dedup query returns a row with NEW
    // content_hash + OLD fileId, routing new content through old bytes.
    // Post-fix: the stale fileId is nulled when content_hash changes, so
    // the dedup query (which filters file_id IS NOT NULL) returns null.
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-prev',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-prev',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    // Step 1: pretend an explicit run uploaded big.ts with OLD content.
    db.upsertFile({
      workspaceRoot,
      relpath: 'big.ts',
      contentHash: 'h-OLD',
      fileId: 'files/poisoned',
      uploadedAt: now - 60_000,
      expiresAt: now + 47 * 3600 * 1000,
      mtimeMs: 1700000000000,
      size: 9000,
    });

    // Step 2: user edits big.ts (new hash) and runs implicit. Memo seed fires.
    const client = mkClient({});
    await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
      cachingMode: 'implicit',
    });

    // Step 3: dedup query for the NEW content hash MUST NOT return the
    // stale fileId. Pre-fix: returns row with fileId='files/poisoned'.
    // Post-fix: returns null (file_id is now NULL on the row).
    const dedupHit = db.findFileRowByHash(workspaceRoot, 'h-big.ts', now);
    expect(dedupHit).toBeNull();
  });

  it('v1.13.0 round-3 regression: cross-file leak via shared content_hash (Scenario B) is closed', async () => {
    // The harder corruption shape from /6step round-3 finding #1:
    //   1. Explicit upload of file1.ts populates fileId='files/foo' for hash H_FOO.
    //   2. User edits file1.ts → content hashes to H_BAR.
    //   3. Implicit run; refreshFileFingerprints fires.
    //   4. User adds file2.ts whose content ALSO hashes to H_BAR (e.g. they
    //      copy-pasted file1.ts's new contents into file2.ts).
    //   5. Explicit run uploads. uploader's findFileRowByHash(ws, H_BAR, now)
    //      MUST NOT return the file1.ts row's stale fileId — otherwise
    //      file2.ts gets routed through 'files/foo' on Google's servers
    //      (which holds H_FOO bytes), and Gemini's prompt sees OLD content
    //      under file2.ts's relpath. Silent wrong-answer-no-error.
    // Post-fix: refreshFileFingerprints nulls the fileId when H_FOO ≠ H_BAR,
    // so even though the row matches H_BAR by content_hash, the dedup query's
    // `file_id IS NOT NULL` filter excludes it.
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-prev',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-prev',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    // Step 1: explicit upload — file1.ts at hash H_FOO with fileId='files/foo'.
    db.upsertFile({
      workspaceRoot,
      relpath: 'file1.ts',
      contentHash: 'H_FOO',
      fileId: 'files/foo',
      uploadedAt: now - 60_000,
      expiresAt: now + 47 * 3600 * 1000,
      mtimeMs: 1700000000000,
      size: 200,
    });

    // Step 2-3: user edits file1.ts → H_BAR; implicit run fires
    // refreshFileFingerprints. Use the public method directly (avoid the
    // mkScan helper's contentHash convention so we control the hash names).
    db.refreshFileFingerprints([
      {
        workspaceRoot,
        relpath: 'file1.ts',
        contentHash: 'H_BAR',
        mtimeMs: now,
        size: 200,
      },
    ]);

    // After refresh, file1.ts row has content_hash=H_BAR + fileId=null
    // (cleared by the conditional CASE since H_FOO ≠ H_BAR).
    const file1After = db.getFiles(workspaceRoot).find((r) => r.relpath === 'file1.ts');
    expect(file1After?.contentHash).toBe('H_BAR');
    expect(file1After?.fileId).toBeNull();

    // Step 4-5: a NEW file2.ts with content that ALSO hashes to H_BAR runs
    // through the explicit upload path. The dedup query for H_BAR MUST NOT
    // return file1.ts's poisoned row. Empirically: query returns null because
    // the only H_BAR row in the system has file_id=null after step 3.
    const dedupHit = db.findFileRowByHash(workspaceRoot, 'H_BAR', now);
    expect(dedupHit).toBeNull();

    // Sanity: a fresh upload of file2.ts would create its OWN fileId; no
    // cross-file leak. (Simulated here by upsertFile; in prod the uploader
    // would do this after dedup miss.)
    db.upsertFile({
      workspaceRoot,
      relpath: 'file2.ts',
      contentHash: 'H_BAR',
      fileId: 'files/file2-fresh',
      uploadedAt: now,
      expiresAt: now + 47 * 3600 * 1000,
      mtimeMs: now,
      size: 200,
    });
    const file2 = db.getFiles(workspaceRoot).find((r) => r.relpath === 'file2.ts');
    expect(file2?.fileId).toBe('files/file2-fresh'); // distinct from file1's old 'files/foo'
  });

  it('v1.13.0 async caches.delete: stale cache cleanup happens AFTER caches.create succeeds', async () => {
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

    const callOrder: string[] = [];
    const client = mkClient({
      cachesCreate: async () => {
        callOrder.push('create');
        return { name: 'cachedContents/fresh' };
      },
      cachesDelete: async (params: unknown) => {
        callOrder.push(`delete:${(params as { name: string }).name}`);
        return {};
      },
    });

    await prepareContext({
      client,
      manifest: db,
      scan: mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]),
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    });

    // Drain microtask queue so the void-fired delete runs.
    await new Promise((r) => setTimeout(r, 0));

    // Order check: create MUST happen before delete (manifest swap is the
    // commit point; if delete ran first and create then failed, we'd lose
    // both caches with no rollback).
    const createIdx = callOrder.indexOf('create');
    const deleteIdx = callOrder.indexOf('delete:cachedContents/stale');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(createIdx);

    // Manifest already points at the new cache when the delete fires.
    const after = db.getWorkspace(workspaceRoot);
    expect(after?.cacheId).toBe('cachedContents/fresh');
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
    // The mutex registers via synchronous `inFlight.get → set` (no await
    // between the two), so the second call resolves to the SAME inflight
    // promise that the first call started — but identity (`p1 === p2`) does
    // NOT hold because `async function` always wraps the return value in a
    // fresh promise. Coalescing is observable instead via call count below
    // (`caches.create` invoked exactly once + both promises resolve to the
    // same cacheId).
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
    // Different fingerprints → independent inflight entries → both reach
    // caches.create. (Promise identity (`pAsk !== pCode`) is trivially true
    // because async function always wraps — so it proves nothing here. The
    // load-bearing observable is the create call count.)
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

  it.each([
    ['an empty name', { name: '' }],
    ['no name', {}],
  ])(
    'a cache created with %s is no cache: the files go inline, the manifest holds none',
    async (_, created) => {
      const client = mkClient({ cachesCreate: async () => created });

      const result = await prepareContext({
        client,
        manifest: db,
        scan: mkScan([{ relpath: 'named.ts', size: 8_000 }]),
        model: mkModel(),
        systemPromptHash: 'sph-1',
        ttlSeconds: 3600,
        emitter: mkEmitter(),
        allowCaching: true,
      });

      expect(result.cacheId).toBeNull();
      expect(result.cacheExpiresAt).toBeNull();
      expect(result.rebuilt).toBe(false);
      expect(result.inlineOnly).toBe(false);
      expect(result.inlineContents).toHaveLength(1);
      expect(db.getWorkspace(workspaceRoot)?.cacheId).toBeNull();
    },
  );

  it.each([
    [30, 60],
    [90.7, 90],
  ])(
    'a TTL of %s s is stored as the cache lives: %s s, the TTL the create request sent',
    async (requested, lives) => {
      const createdAtMs = Date.parse('2026-11-17T12:00:00.000Z');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(createdAtMs);
      try {
        const client = mkClient({ cachesCreate: async () => mkCreated(createdAtMs, lives) });

        const result = await prepareContext({
          client,
          manifest: db,
          scan: mkScan([{ relpath: 'ttl.ts', size: 8_000 }]),
          model: mkModel(),
          systemPromptHash: 'sph-1',
          ttlSeconds: requested,
          emitter: mkEmitter(),
          allowCaching: true,
        });

        const expiresAt = createdAtMs + lives * 1000;
        expect(client.caches.create).toHaveBeenCalledWith(
          expect.objectContaining({ config: expect.objectContaining({ ttl: `${lives}s` }) }),
        );
        expect(result.cacheExpiresAt).toBe(expiresAt);
        expect(db.getWorkspace(workspaceRoot)?.cacheExpiresAt).toBe(expiresAt);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('a stored empty cache id is no cache: a rebuild over it deletes nothing', async () => {
    seedRow('', 'fh-OLD');
    const client = mkClient({});

    const result = await prepare(client);

    expect(result.rebuilt).toBe(true);
    expect(client.caches.delete).not.toHaveBeenCalled();
  });

  it('a create that names no cache warns that the files go inline and that an unnamed cache may be billed', async () => {
    const client = mkClient({ cachesCreate: async () => ({ name: '' }) });

    const { warnings } = await withWarnings(() => prepare(client));

    expect(warnings).toEqual([
      "cache build failed — falling back to inline parts: caches.create returned no cache name; a cache may exist on Google's side under no name this server can delete, billed until its TTL (3600 s)",
    ]);
  });

  /**
   * How a traced rebuild goes: the row it finds (`cachedContents/previous` unless named; `null` a row without a cache),
   * what the create answers (a cache named `cachedContents/created` by default) and which row writes fail.
   */
  interface RebuildTrace {
    readonly previous?: string | null;
    readonly create?: () => Promise<{ name?: string }>;
    readonly writeFails?: (cacheId: string | null) => boolean;
  }

  /**
   * A rebuild over the row `trace` names, under another fingerprint. `calls` lists, in order, each row write as
   * `write:<cacheId>` and each cache delete as `delete:<name>`; `outcome` is the call's result or its rejection.
   */
  async function traceRebuild(trace: RebuildTrace = {}) {
    const createdAtMs = Date.now();
    seedRow(
      trace.previous === undefined ? 'cachedContents/previous' : trace.previous,
      'fh-OLD',
      createdAtMs,
    );
    const calls: string[] = [];
    const write = db.upsertWorkspace.bind(db);
    vi.spyOn(db, 'upsertWorkspace').mockImplementation((row) => {
      calls.push(`write:${row.cacheId}`);
      if (trace.writeFails?.(row.cacheId)) throw new Error('SQLITE_FULL: database or disk is full');
      write(row);
    });
    const client = mkClient({
      cachesCreate: trace.create ?? (async () => mkCreated(createdAtMs, 3600)),
      cachesDelete: async (params: unknown) =>
        calls.push(`delete:${(params as { name: string }).name}`),
    });
    const { value: outcome, warnings } = await withWarnings(() =>
      prepare(client).catch((error: unknown) => error),
    );
    return { client, outcome, calls, warnings };
  }

  /**
   * A rebuild over the row of `cachedContents/previous` whose create succeeds and whose manifest write of the new cache
   * fails (with `everyWrite`, the failed-create row write fails too), traced as `traceRebuild` traces it.
   */
  function prepareWithFailingCacheWrite(everyWrite = false) {
    return traceRebuild({
      writeFails: (cacheId) => everyWrite || cacheId !== null,
    });
  }

  /** The prepared context of `prepareWithFailingCacheWrite`, which resolves unless every write fails. */
  async function preparedWithFailingCacheWrite() {
    const { outcome, ...rest } = await prepareWithFailingCacheWrite();
    if (outcome instanceof Error) throw outcome;
    return { result: outcome as PreparedContext, ...rest };
  }

  it('a manifest write that fails after the create deletes the new cache; the files go inline', async () => {
    const { client, result } = await preparedWithFailingCacheWrite();

    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/created' });
    expect(result.cacheId).toBeNull();
    expect(result.inlineContents).toHaveLength(1);
    expect(db.getWorkspace(workspaceRoot)?.cacheId).toBeNull();
  });

  it('a manifest write that fails after the create is warned with the cache it deletes and the cause', async () => {
    const { warnings } = await preparedWithFailingCacheWrite();

    expect(warnings).toEqual([
      'recording cache cachedContents/created in the manifest failed — deleting it, falling back to inline parts: SQLITE_FULL: database or disk is full',
    ]);
  });

  it('a record failure deletes the new cache before the row write and the previous one after it', async () => {
    const { calls } = await preparedWithFailingCacheWrite();

    expect(calls).toEqual([
      'write:cachedContents/created',
      'delete:cachedContents/created',
      'write:null',
      'delete:cachedContents/previous',
    ]);
  });

  it('a record failure still deletes the new cache when the row write without a cache fails too', async () => {
    const { client, outcome } = await prepareWithFailingCacheWrite(true);

    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain('SQLITE_FULL');
    expect(client.caches.delete).toHaveBeenCalledExactlyOnceWith({
      name: 'cachedContents/created',
    });
  });

  it('a record failure of a create named as the previous cache deletes that cache once, before the row write', async () => {
    const { calls } = await traceRebuild({
      create: async () => ({ name: 'cachedContents/previous' }),
      writeFails: (cacheId) => cacheId !== null,
    });

    expect(calls).toEqual([
      'write:cachedContents/previous',
      'delete:cachedContents/previous',
      'write:null',
    ]);
  });

  it('a rebuild whose create answers with the previous cache name keeps that cache: the row names it', async () => {
    const { client, calls } = await traceRebuild({
      create: async () => ({ name: 'cachedContents/previous' }),
    });

    expect(calls).toEqual(['write:cachedContents/previous']);
    expect(client.caches.delete).not.toHaveBeenCalled();
    expect(db.getWorkspace(workspaceRoot)?.cacheId).toBe('cachedContents/previous');
  });

  it('a record failure keeps the uploads: the row holds their ids, the context their parts', async () => {
    const { result } = await preparedWithFailingCacheWrite();

    const uri = `https://generativelanguage.googleapis.com/v1beta/files/${join(workspaceRoot, 'kept.ts')}`;
    expect(db.getWorkspace(workspaceRoot)?.fileIds).toEqual([uri]);
    expect(result.inlineOnly).toBe(false);
    expect(result.inlineContents[0]?.parts).toContainEqual({
      fileData: { fileUri: uri, mimeType: 'text/plain' },
    });
  });

  it.each([
    [
      'a create that throws',
      async (): Promise<{ name?: string }> => {
        throw new Error('503 UNAVAILABLE');
      },
    ],
    ['an unnamed create', async (): Promise<{ name?: string }> => ({ name: '' })],
  ])(
    '%s over a live cache deletes the previous cache after the row is written without one',
    async (_, create) => {
      const { calls } = await traceRebuild({ create });

      expect(calls).toEqual(['write:null', 'delete:cachedContents/previous']);
      expect(db.getWorkspace(workspaceRoot)?.cacheId).toBeNull();
    },
  );

  it('a failed create whose row write throws deletes no cache: the row still names the previous one', async () => {
    const { outcome, calls } = await traceRebuild({
      create: async () => ({ name: '' }),
      writeFails: () => true,
    });

    expect(String(outcome)).toContain('SQLITE_FULL');
    expect(calls).toEqual(['write:null']);
    expect(db.getWorkspace(workspaceRoot)?.cacheId).toBe('cachedContents/previous');
  });

  it('a failed create over a row without a cache deletes nothing', async () => {
    const { client, calls } = await traceRebuild({
      previous: null,
      create: async () => ({ name: '' }),
    });

    expect(calls).toEqual(['write:null']);
    expect(client.caches.delete).not.toHaveBeenCalled();
  });

  it('a failed create deletes the cache the row named at its start, not one another call recorded meanwhile', async () => {
    const { calls } = await traceRebuild({
      create: async () => {
        seedRow('cachedContents/other', 'fh-OTHER');
        return { name: '' };
      },
    });

    expect(calls).toEqual([
      'write:cachedContents/other',
      'write:null',
      'delete:cachedContents/previous',
    ]);
  });

  it("a failed create logs the previous cache's delete as a stale cache's", async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      await traceRebuild({ create: async () => ({ name: '' }) });
      await new Promise((settle) => setImmediate(settle));

      expect(debug.mock.calls.map((call) => String(call[0]))).toContain(
        'async-deleted stale cache cachedContents/previous (attempt 1)',
      );
    } finally {
      debug.mockRestore();
    }
  });

  it.each([
    ['an empty stored cache id is refused: a new cache is built', '', false],
    ['a stored cache id is reused', 'cachedContents/live', true],
  ])('the reuse test on a matching row: %s', async (_, cacheId, reused) => {
    seedRow(cacheId);
    const client = mkClient({});

    const result = await prepare(client);

    expect(result.reused).toBe(reused);
    expect(client.caches.create).toHaveBeenCalledTimes(reused ? 0 : 1);
  });

  it('a build that rejects leaves no in-flight entry: the next call builds again', async () => {
    let uploads = 0;
    const client = mkClient({
      filesUpload: async () => {
        uploads += 1;
        if (uploads === 1) throw new Error('400 INVALID_ARGUMENT: bad file');
        return { uri: 'https://generativelanguage.googleapis.com/v1beta/files/retry' };
      },
    });

    const { value: first } = await withWarnings(() =>
      prepare(client).catch((error: unknown) => error),
    );
    const second = await prepare(client);

    expect(String(first)).toMatch(/^Error: Upload failed for 1\/1 files/);
    expect(second.cacheId).toBe('cachedContents/new');
    expect(uploads).toBe(2);
  });

  it('the stored expiry counts from the clock after the create answered, not from the call start', async () => {
    const startMs = Date.parse('2026-11-18T12:00:00.000Z');
    let nowMs = startMs;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const client = mkClient({
        cachesCreate: async () => {
          nowMs += 90_000;
          return mkCreated(nowMs, 3600);
        },
      });

      await prepare(client);

      expect(db.getWorkspace(workspaceRoot)?.cacheExpiresAt).toBe(startMs + 90_000 + 3_600_000);
    } finally {
      clock.mockRestore();
    }
  });

  // v1.14.0 round-1 review fix (F1, Copilot HIGH): the in-flight coalescing
  // key MUST include `cachingMode`. Pre-fix, two concurrent prepareContext
  // calls with different cachingModes produced identical keys → shared one
  // PreparedContext → loser got the wrong caching strategy (e.g. 'implicit'
  // caller received an explicit cacheId, or vice versa). v1.14.0's default
  // flip transformed this from a niche edge to the mainline collision shape.
  // This test fires both modes concurrently and asserts each receives the
  // shape it asked for.
  it('v1.14.0 F1 fix: concurrent prepareContext with different cachingModes do NOT coalesce', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-1',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-1',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });

    const client = mkClient({
      cachesCreate: async () => ({ name: 'cachedContents/explicit-built' }),
    });

    // Same workspace, same model, same systemPromptHash, same allowCaching,
    // same cacheMinTokens — only `cachingMode` differs.
    const sharedScan = mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]);
    const sharedOpts = {
      client,
      manifest: db,
      scan: sharedScan,
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
    };

    // Fire both concurrently. Pre-fix: both keys collide → one PreparedContext
    // shared → assertions diverge (one of the two won't match its requested mode).
    // Post-fix: the cachingMode dimension distinguishes them → each path runs
    // independently → both receive the shape they asked for.
    const [implicitResult, explicitResult] = await Promise.all([
      prepareContext({ ...sharedOpts, cachingMode: 'implicit' }),
      prepareContext({ ...sharedOpts, cachingMode: 'explicit' }),
    ]);

    // Implicit caller MUST get inlineOnly + cacheId=null.
    expect(implicitResult.inlineOnly).toBe(true);
    expect(implicitResult.cacheId).toBeNull();
    expect(implicitResult.inlineContents.length).toBeGreaterThan(0);

    // Explicit caller MUST get a real cacheId, no inline contents.
    expect(explicitResult.cacheId).toBe('cachedContents/explicit-built');
    expect(explicitResult.inlineOnly).toBe(false);
    expect(explicitResult.inlineContents).toEqual([]);
    expect(explicitResult.rebuilt).toBe(true);

    // Empirical confirmation that the explicit branch ran caches.create
    // — this would NOT have fired if the implicit branch had won the
    // coalescing race and returned its inlineOnly result for both callers.
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  // Companion regression: same-mode concurrent calls SHOULD still coalesce
  // (the documented behaviour of the in-flight mutex — coalescing prevents
  // duplicate cache builds that would leak orphan caches at $$$/h). This
  // test pins that the F1 fix didn't accidentally break the legitimate
  // coalescing path.
  it('v1.14.0 F1 fix: concurrent same-mode calls STILL coalesce (mutex preserved)', async () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot,
      filesHash: 'fh-1',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph-1',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });

    const client = mkClient({
      cachesCreate: async () => ({ name: 'cachedContents/once' }),
    });

    const sharedScan = mkScan([{ relpath: 'big.ts', size: 10_000, content: 'X'.repeat(10_000) }]);
    const sharedOpts = {
      client,
      manifest: db,
      scan: sharedScan,
      model: mkModel(),
      systemPromptHash: 'sph-1',
      ttlSeconds: 3600,
      emitter: mkEmitter(),
      allowCaching: true,
      cachingMode: 'explicit' as const,
    };

    const [a, b] = await Promise.all([prepareContext(sharedOpts), prepareContext(sharedOpts)]);

    // Both callers MUST receive the same cacheId.
    expect(a.cacheId).toBe('cachedContents/once');
    expect(b.cacheId).toBe('cachedContents/once');
    // caches.create MUST have fired ONCE — coalescing is the whole point of
    // the in-flight mutex. If F1's fix had over-keyed (e.g. on a non-stable
    // dimension), this would fire twice and the test would surface the
    // regression.
    expect(client.caches.create).toHaveBeenCalledTimes(1);
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

describe('invalidateWorkspaceCache', () => {
  const ws = '/test/purged';
  let tmp: string;
  let manifest: ManifestDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gcctx-purge-'));
    manifest = new ManifestDb(join(tmp, 'manifest.db'));
  });

  afterEach(() => {
    manifest.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A workspace row holding `cacheId`, with one uploaded file row per stored identifier. */
  function seedUploads(cacheId: string | null, fileIds: string[]): void {
    const at = Date.parse('2026-11-17T12:00:00.000Z');
    manifest.upsertWorkspace({
      workspaceRoot: ws,
      filesHash: 'fh',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'sph',
      cacheId,
      cacheExpiresAt: cacheId === null ? null : at + 3_600_000,
      fileIds,
      createdAt: at,
      updatedAt: at,
    });
    fileIds.forEach((fileId, i) => {
      manifest.upsertFile({
        workspaceRoot: ws,
        relpath: `src/f${i}.ts`,
        contentHash: `h${i}`,
        fileId,
        uploadedAt: at,
        expiresAt: at + 47 * 3_600_000,
      });
    });
  }

  /** A client whose deletes take the resource name as the SDK's do; with `fail`, every delete rejects. */
  function mkPurgeClient(fail = false) {
    const settle = async () => {
      if (fail) throw new Error('503 UNAVAILABLE');
      return {};
    };
    const deleteByName = () => vi.fn<(params: { name: string }) => Promise<object>>(settle);
    return { caches: { delete: deleteByName() }, files: { delete: deleteByName() } };
  }

  function purge(client: ReturnType<typeof mkPurgeClient>): Promise<void> {
    return invalidateWorkspaceCache({
      client: client as unknown as GoogleGenAI,
      manifest,
      workspaceRoot: ws,
    });
  }

  it('purging a workspace deletes its cache and drops its manifest rows', async () => {
    seedUploads('cachedContents/purged', ['files/a1']);
    const client = mkPurgeClient();

    await purge(client);

    expect(client.caches.delete).toHaveBeenCalledExactlyOnceWith({ name: 'cachedContents/purged' });
    expect(manifest.getWorkspace(ws)).toBeNull();
    expect(manifest.getFiles(ws)).toEqual([]);
  });

  it('purging releases each uploaded file once, by its resource name', async () => {
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/abc-1?alt=media';
    seedUploads('cachedContents/purged', [uri, 'files/def-2', uri, 'opaque-id']);
    const client = mkPurgeClient();

    await purge(client);

    const released = client.files.delete.mock.calls.map((call) => call[0]);
    expect(released).toHaveLength(3);
    expect(released).toEqual(
      expect.arrayContaining([
        { name: 'files/abc-1' },
        { name: 'files/def-2' },
        { name: 'opaque-id' },
      ]),
    );
  });

  it('purging releases every upload when there are more than the 10 concurrent deletes', async () => {
    const fileIds = Array.from({ length: 12 }, (_, i) => `files/u${i}`);
    seedUploads('cachedContents/purged', fileIds);
    const client = mkPurgeClient();

    await purge(client);

    const released = client.files.delete.mock.calls.map((call) => call[0].name);
    expect(released.sort()).toEqual([...fileIds].sort());
  });

  it('purging releases the uploads through a pool of 10 concurrent deletes', async () => {
    seedUploads(
      'cachedContents/purged',
      Array.from({ length: 25 }, (_, i) => `files/p${i}`),
    );
    let inFlight = 0;
    let mostInFlight = 0;
    const client = mkPurgeClient();
    client.files.delete.mockImplementation(async () => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((settle) => setImmediate(settle));
      inFlight -= 1;
      return {};
    });

    await purge(client);

    expect(client.files.delete).toHaveBeenCalledTimes(25);
    expect(mostInFlight).toBe(10);
  });

  it('purging skips a stored empty cache id and an empty file id', async () => {
    seedUploads('', ['', 'files/kept']);
    const client = mkPurgeClient();

    await purge(client);

    expect(client.caches.delete).not.toHaveBeenCalled();
    expect(client.files.delete).toHaveBeenCalledExactlyOnceWith({ name: 'files/kept' });
  });

  it('a workspace without a cache has its files released and no cache deleted', async () => {
    seedUploads(null, ['files/only']);
    const client = mkPurgeClient();

    await purge(client);

    expect(client.caches.delete).not.toHaveBeenCalled();
    expect(client.files.delete).toHaveBeenCalledExactlyOnceWith({ name: 'files/only' });
    expect(manifest.getWorkspace(ws)).toBeNull();
  });

  it('failed deletes are logged and the purge still drops the manifest rows', async () => {
    seedUploads('cachedContents/purged', ['files/a1', 'files/b2']);
    const client = mkPurgeClient(true);
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      await purge(client);

      expect(client.files.delete).toHaveBeenCalledTimes(2);
      expect(debug.mock.calls.map((call) => String(call[0]))).toEqual([
        'cache delete (cachedContents/purged) failed: 503 UNAVAILABLE',
        'files.delete (files/a1, stored as files/a1) failed: 503 UNAVAILABLE',
        'files.delete (files/b2, stored as files/b2) failed: 503 UNAVAILABLE',
      ]);
      expect(manifest.getWorkspace(ws)).toBeNull();
    } finally {
      debug.mockRestore();
    }
  });
});
