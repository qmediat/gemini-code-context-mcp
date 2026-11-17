/**
 * Build / reuse / invalidate Gemini Context Caches keyed by workspace state.
 *
 * Cache key = `(workspaceRoot, filesHash, model, systemPromptHash)`. When any
 * component changes, we rebuild. When the same key is requested concurrently
 * (two ask() calls in parallel), we coalesce via a per-workspace in-process
 * mutex so only one cache is created.
 *
 * Inline fallback path: for small workspaces or `noCache:true`, we skip the
 * Files API upload entirely and embed file text inline. This avoids unnecessary
 * network latency for workspaces that wouldn't benefit from caching anyway
 * (Gemini rejects caches below 1024 tokens, and small workspaces don't amortise
 * the upload cost over enough queries).
 *
 * Content shape: we emit ONE `{role:'user', parts: [...]}` Content with a
 * `--- FILE: <relpath> ---` text marker before each file's data. This (a) gives
 * the model enough context to resolve imports and architecture, and (b) avoids
 * the consecutive-user-role-violation risk on stricter Gemini models.
 */

import { readFile } from 'node:fs/promises';
import type { Content, GoogleGenAI, Part } from '@google/genai';
import type { ScanResult } from '../indexer/workspace-scanner.js';
import type { ManifestDb } from '../manifest/db.js';
import type { ResolvedModel, WorkspaceRow } from '../types.js';
import { logger, safeForLog } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';
import { type UploadResult, uploadWorkspaceFiles } from './files-uploader.js';

export interface PreparedContext {
  /** Cache resource name (`cachedContents/abc123`) or null if caching skipped. */
  cacheId: string | null;
  cacheExpiresAt: number | null;
  /**
   * Content entries to send as the file-context prefix when NOT using a cache.
   * Contains zero or one `{role:'user'}` entry with all file parts (markers +
   * file-data or inline text) consolidated. Empty when caching is active or
   * the workspace has no files.
   */
  inlineContents: Content[];
  uploaded: UploadResult;
  rebuilt: boolean;
  reused: boolean;
  /**
   * When true, the server operated without hitting the Files API. The caller
   * has the full file text inline and can skip any upload-progress UI.
   */
  inlineOnly: boolean;
}

export interface BuildOptions {
  client: GoogleGenAI;
  manifest: ManifestDb;
  scan: ScanResult;
  model: ResolvedModel;
  systemPromptHash: string;
  systemInstruction?: string;
  ttlSeconds: number;
  /**
   * Minimum estimated workspace tokens required to attempt `caches.create`.
   * Gemini currently enforces 1024; below that, we silently skip the cache
   * build and use inline file parts instead. Default: 1024.
   */
  cacheMinTokens?: number;
  /** Concurrency for Files API uploads. Default: 10. */
  uploadConcurrency?: number;
  emitter: ProgressEmitter;
  allowCaching: boolean;
  /**
   * Optional abort signal (v1.12.1+). When fired, the upload pool stops
   * QUEUEING new per-file work and the post-pool abort check throws
   * `signal.reason` so the caller's `timeoutMs` budget surfaces as a
   * proper TIMEOUT errorCode. Already-flying `client.files.upload`
   * calls complete on their own — the SDK doesn't expose abort plumbing
   * on `files.upload`, so the abort honours user intent best-effort
   * (stops scheduling new work, propagates the abort error after the
   * in-flight tasks settle).
   *
   * Pre-v1.12.1 the upload phase ignored aborts entirely — the signal
   * was only threaded into `generateContent`, so a 30s `timeoutMs`
   * against a workspace whose upload took 90s would burn 60s of
   * bandwidth before the abort took effect at `generateContent`-call
   * time. The fix bounds the worst case to "in-flight pool size × max
   * upload duration" instead of "total file count × max upload duration".
   */
  signal?: AbortSignal;
  /**
   * Caching mode (v1.13.0+). Controls whether `prepareContext` builds
   * an explicit Gemini Context Cache (`caches.create`) or falls through
   * to the inline path and relies on Gemini's automatic implicit
   * caching for Gemini 2.5+/3 models.
   *
   * - `'explicit'` (today's behaviour): build + reuse a Context Cache
   *   for the workspace. Hard ~75 % discount on cached input. Pays
   *   60–180 s `caches.create` cost on file change.
   * - `'implicit'` (v1.13.0+ opt-in): skip `caches.create` entirely;
   *   send file content inline every call. Gemini's automatic implicit
   *   caching applies a discount when the prefix matches across calls
   *   (4 096-token minimum, no guarantee). No rebuild wait on file
   *   change. **Best fit for review→edit→review workflows** where
   *   files change between queries.
   * - `undefined`: caller doesn't care; behave as `'explicit'` (the
   *   v1.12.x default; flip planned for v1.14.0 pending dogfood
   *   telemetry).
   */
  cachingMode?: 'explicit' | 'implicit';
}

/**
 * The TTL a cache we create lives for: whole seconds, at least 60. The create request and the expiry stored in the
 * manifest both read this one value, so a stored expiry never outlives the cache on Google's side.
 */
function effectiveTtlSeconds(requested: number): number {
  return Math.max(60, Math.floor(requested));
}

/**
 * Convert whatever identifier we stored in `files.file_id` back to the
 * `files/<id>` resource name that `client.files.delete` expects.
 *
 * The uploader stores `.uri` in preference to `.name` (see
 * `src/cache/files-uploader.ts:170-176` — `fileData.fileUri` at cache build
 * time rejects the bare `files/abc` form). But the `files.delete` endpoint
 * takes the resource-name form, so we need the reverse transform on
 * teardown. The URI looks like
 * `https://generativelanguage.googleapis.com/v1beta/files/abc123-xyz`;
 * extract everything after the last `/files/` and re-prepend `files/`.
 *
 * Falls back to passing the identifier through unchanged when neither form
 * is recognised — lets the SDK decide, and the surrounding try/catch still
 * protects against propagating the failure.
 */
function toFileResourceName(identifier: string): string {
  if (identifier.startsWith('files/')) return identifier;
  const marker = '/files/';
  const markerIdx = identifier.lastIndexOf(marker);
  if (markerIdx >= 0) {
    const tail = identifier.slice(markerIdx + marker.length);
    // Strip any query string or fragment that might follow the file ID.
    const cleaned = tail.split(/[?#]/)[0] ?? tail;
    if (cleaned.length > 0) return `files/${cleaned}`;
  }
  return identifier;
}

function isUsableExistingCache(
  ws: WorkspaceRow | null,
  scan: ScanResult,
  model: ResolvedModel,
  systemPromptHash: string,
  now: number,
): ws is WorkspaceRow {
  if (!ws) return false;
  if (ws.filesHash !== scan.filesHash) return false;
  if (ws.model !== model.resolved) return false;
  if (ws.systemPromptHash !== systemPromptHash) return false;
  if (!ws.cacheId) return false;
  if (ws.cacheExpiresAt !== null && ws.cacheExpiresAt < now) return false;
  return true;
}

/**
 * Build a single consolidated user-role Content from uploaded files, with
 * `--- FILE: <relpath> ---` markers so the model can resolve paths.
 *
 * Consolidating into ONE Content avoids Gemini's user/model alternation warnings
 * (repeated `role:'user'` entries are tolerated today on flash/pro but the spec
 * discourages them).
 */
function buildContentFromUploaded(files: { fileId: string | null; relpath: string }[]): Content[] {
  const parts: Part[] = [];
  for (const f of files) {
    if (typeof f.fileId !== 'string' || f.fileId.length === 0) continue;
    parts.push({ text: `\n\n--- FILE: ${f.relpath} ---\n` });
    parts.push({
      fileData: {
        fileUri: f.fileId,
        mimeType: 'text/plain',
      },
    });
  }
  if (parts.length === 0) return [];
  return [{ role: 'user', parts }];
}

/**
 * Build inline text Content directly from disk — used on the no-cache path.
 * Skips the Files API entirely: we read each file (async, parallel per worker),
 * prefix with a path marker, and embed as a single `{text}` part. Saves one
 * network round-trip per file and avoids Gemini's 48 h auto-delete housekeeping
 * on small workspaces.
 *
 * Hard aggregate cap (`MAX_INLINE_TOTAL_BYTES`) prevents a single pathological
 * file from blocking the event loop or exhausting V8's string length cap. Files
 * that would push the total over the cap are replaced with a visible
 * `[SKIPPED: inline size cap]` marker so the model knows they were omitted.
 */
const MAX_INLINE_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB aggregate inline content

/**
 * v1.13.0 post-review fix: seed the scan memo from a ScanResult on the
 * inline-return paths (`!allowCaching`, `cachingMode: 'implicit'`,
 * small-workspace). The uploader is the only OTHER writer of the memo
 * columns; on these paths the uploader is skipped, so without this seed
 * the memo Map next call comes back empty and every file re-hashes.
 *
 * Defensive vs `manifest.upsertFile`: this calls the dedicated
 * `refreshFileFingerprints` method which preserves any existing
 * `file_id` / `uploaded_at` / `expires_at` from a prior explicit-cache
 * run. Switching back from `cachingMode: 'implicit'` to `'explicit'` on
 * a workspace that previously uploaded files should still hit the
 * Files-API dedup; orphaning that capability would silently force
 * re-uploads on every mode flip.
 */
function seedScanMemo(manifest: ManifestDb, scan: ScanResult): void {
  if (scan.files.length === 0) return;
  manifest.refreshFileFingerprints(
    scan.files.map((f) => ({
      workspaceRoot: scan.workspaceRoot,
      relpath: f.relpath,
      contentHash: f.contentHash,
      mtimeMs: f.mtimeMs,
      size: f.size,
    })),
  );
}

async function buildInlineContentFromDisk(scan: ScanResult): Promise<Content[]> {
  const parts: Part[] = [];
  let total = 0;
  for (const f of scan.files) {
    if (total + f.size > MAX_INLINE_TOTAL_BYTES) {
      parts.push({
        text: `\n\n--- FILE: ${f.relpath} [SKIPPED: inline size cap reached] ---\n`,
      });
      continue;
    }
    let content: string;
    try {
      content = await readFile(f.absolutePath, 'utf8');
    } catch (err) {
      logger.warn(`failed to read ${safeForLog(f.relpath)}: ${safeForLog(err)}`);
      continue;
    }
    parts.push({ text: `\n\n--- FILE: ${f.relpath} ---\n${content}\n` });
    total += f.size;
  }
  if (parts.length === 0) return [];
  return [{ role: 'user', parts }];
}

/**
 * In-process mutex. Concurrent `prepareContext` calls for the SAME
 * `(workspaceRoot, filesHash, model, systemPromptHash, allowCaching,
 *   cacheMinTokens, cachingMode)` fingerprint coalesce onto a single
 * in-flight promise, avoiding duplicate cache creation (which would leak
 * orphaned Gemini caches at $$$/M-token-hour).
 *
 * Keying on the full fingerprint is critical: `ask` and `code` tools use
 * different system instructions, so their `systemPromptHash` differs. Coalescing
 * on workspaceRoot alone would serve one tool's PreparedContext to the other —
 * wrong cache / system-instruction mismatch. This bug was flagged by GPT + Copilot.
 *
 * v1.14.0 round-1 added `cachingMode` to the fingerprint after Copilot
 * caught a HIGH concurrency race (`/6step` F1): pre-fix, two concurrent
 * calls with different `cachingMode` values produced identical keys, sharing
 * one PreparedContext between them. v1.14.0's default flip transformed this
 * from a niche edge case into the mainline collision shape — see the F1
 * comment inside `inFlightKey()` below for the full failure scenario.
 *
 * Scope: single Node process. Cross-process races (two MCP servers sharing the
 * same manifest DB) are not covered — documented in docs/KNOWN-DEFICITS.md.
 */
const inFlight = new Map<string, Promise<PreparedContext>>();

function inFlightKey(opts: BuildOptions): string {
  return [
    opts.scan.workspaceRoot,
    opts.scan.filesHash,
    opts.model.resolved,
    opts.systemPromptHash,
    String(opts.allowCaching),
    String(opts.cacheMinTokens ?? ''),
    // v1.14.0 round-1 fix (F1, Copilot HIGH): `cachingMode` MUST be in the
    // key. Pre-fix, two concurrent calls — one with `'explicit'` (per-call
    // override), one with `'implicit'` (the v1.14.0 default) — produced
    // identical keys and shared the SAME PreparedContext via the coalescing
    // map below. Whichever raced first determined the return shape; the
    // loser got the wrong caching strategy. Same shape as the v1.13.0
    // round-3 stale-fileId bug — a missing dimension on an equality-keyed
    // lookup. v1.14.0's default flip turned this from a niche edge case
    // into the mainline collision shape because per-call `'explicit'`
    // overrides routinely race the new default. `?? ''` keeps `undefined`
    // distinct from `'explicit'` so a future third caching mode can't
    // silently coalesce with undefined-legacy callers.
    String(opts.cachingMode ?? ''),
  ].join('\u241E'); // record-separator sentinel unlikely to appear in any field
}

export async function prepareContext(opts: BuildOptions): Promise<PreparedContext> {
  const key = inFlightKey(opts);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      return await doPrepareContext(opts);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/** How a call started: the clock read once and the workspace row as the call found it. */
interface CallStart {
  /** A new row's times, a missing `createdAt`, the reuse test's clock and a failed create's `updatedAt`. */
  readonly now: number;
  /** The row whose `createdAt` every write keeps and whose cache a rebuild replaces. */
  readonly existing: WorkspaceRow | null;
}

/** The cache fields of a workspace row; the other fields are the call's fingerprint. */
interface CacheFields {
  readonly cacheId: string | null;
  readonly cacheExpiresAt: number | null;
  readonly fileIds: string[];
  readonly updatedAt: number;
}

/** A cache Google created and named: its id, its expiry and the clock read after the create returned. */
interface CreatedCache {
  readonly cacheId: string;
  readonly cacheExpiresAt: number;
  readonly answeredAtMs: number;
}

/** What a rebuild works from: the call, how it started, the uploads and the file parts the cache holds. */
interface CacheBuild {
  readonly opts: BuildOptions;
  readonly start: CallStart;
  readonly uploaded: UploadResult;
  readonly fileContents: Content[];
}

/** Why a rebuild fell back to inline parts: no named cache came back, or the manifest could not record it. */
type CreateFailure =
  | { readonly stage: 'create'; readonly error: unknown }
  | { readonly stage: 'record'; readonly cacheId: string; readonly error: unknown };

/**
 * The order of the decisions: the inline modes before the reuse test (a `noCache` or implicit call never uses a
 * cache), the reuse test before the token floor (reuse costs nothing, and a workspace that shrank below the floor keeps
 * its valid cache until its TTL instead of orphaning it on Google's side), the uploads only for a build.
 */
async function doPrepareContext(opts: BuildOptions): Promise<PreparedContext> {
  const start = startCall(opts);
  const inlineMode = inlineModeLine(opts);
  if (inlineMode !== null) return prepareInline(opts, start, inlineMode);
  if (
    isUsableExistingCache(start.existing, opts.scan, opts.model, opts.systemPromptHash, start.now)
  ) {
    return reusedCache(start.existing);
  }
  const tooSmall = tokenFloorLine(opts.scan, opts.cacheMinTokens);
  if (tooSmall !== null) return prepareInline(opts, start, tooSmall);
  const uploaded = await uploadForCache(opts);
  return buildCache(opts, start, uploaded);
}

/**
 * The clock read once and the workspace row as found. A workspace seen for the first time gets its row now, before
 * any file row references it: the `files` table has a FK to `workspaces(workspace_root)`.
 */
function startCall(opts: BuildOptions): CallStart {
  const start: CallStart = {
    now: Date.now(),
    existing: opts.manifest.getWorkspace(opts.scan.workspaceRoot),
  };
  if (!start.existing) {
    writeWorkspaceRow(opts, start, {
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      updatedAt: start.now,
    });
  }
  return start;
}

/** Writes the call's workspace row with `fields`, keeping the `createdAt` the call found (its start for a new row). */
function writeWorkspaceRow(opts: BuildOptions, start: CallStart, fields: CacheFields): void {
  opts.manifest.upsertWorkspace({
    workspaceRoot: opts.scan.workspaceRoot,
    filesHash: opts.scan.filesHash,
    model: opts.model.resolved,
    systemPromptHash: opts.systemPromptHash,
    cacheId: fields.cacheId,
    cacheExpiresAt: fields.cacheExpiresAt,
    fileIds: fields.fileIds,
    createdAt: start.existing?.createdAt ?? start.now,
    updatedAt: fields.updatedAt,
  });
}

/**
 * The debug line of a call whose options skip `caches.create`, or null: caching disabled (`noCache`) sends the files
 * with no cache; implicit mode leaves the caching to Gemini 2.5+/3's automatic prefix cache.
 */
function inlineModeLine(opts: BuildOptions): string | null {
  if (opts.cachingMode === 'implicit') {
    return 'caching mode = implicit — embedding files inline from disk; Gemini 2.5+/3 will auto-cache prefix.';
  }
  if (!opts.allowCaching) return 'caching disabled — embedding files inline from disk.';
  return null;
}

/**
 * The debug line of a workspace too small for a context cache, or null. Gemini rejects `caches.create` below 1024
 * tokens, and a small workspace gains nothing from the upload; the estimate is 4 bytes a token.
 */
function tokenFloorLine(scan: ScanResult, cacheMinTokens: number | undefined): string | null {
  const minTokens = cacheMinTokens ?? 1024;
  const estimatedTokens = scan.files.reduce(
    (sum: number, f: { size: number }) => sum + Math.ceil(f.size / 4),
    0,
  );
  if (estimatedTokens < minTokens) {
    return `workspace too small for context cache (~${estimatedTokens} tokens < ${minTokens}); embedding inline.`;
  }
  return null;
}

/**
 * The inline exit: the files read from disk and embedded, no upload, no cache; the row drops its cache pointer. The
 * scan memo is seeded here because the uploader, the only other writer of the memo columns, does not run: without
 * the seed `mtime_ms` / `size` stay NULL, `buildScanMemo` filters the rows out and every file re-hashes next call.
 */
async function prepareInline(
  opts: BuildOptions,
  start: CallStart,
  line: string,
): Promise<PreparedContext> {
  logger.debug(line);
  const inlineContents = await buildInlineContentFromDisk(opts.scan);
  writeWorkspaceRow(opts, start, {
    cacheId: null,
    cacheExpiresAt: null,
    fileIds: [],
    updatedAt: start.now,
  });
  seedScanMemo(opts.manifest, opts.scan);
  return {
    cacheId: null,
    cacheExpiresAt: null,
    inlineContents,
    uploaded: noUploads(),
    rebuilt: false,
    reused: false,
    inlineOnly: true,
  };
}

/** The upload result of a call that uploaded nothing. */
function noUploads(): UploadResult {
  return { files: [], uploadedCount: 0, reusedCount: 0, failedCount: 0, failures: [] };
}

/** The cache the row holds, reused as it is: no upload, no write. */
function reusedCache(existing: WorkspaceRow): PreparedContext {
  logger.debug(`cache hit: ${safeForLog(existing.cacheId)}`);
  return {
    cacheId: existing.cacheId,
    cacheExpiresAt: existing.cacheExpiresAt,
    inlineContents: [],
    uploaded: noUploads(),
    rebuilt: false,
    reused: true,
    inlineOnly: false,
  };
}

/** The workspace files uploaded for a cache; `signal` stops the queueing of uploads once a timeout fires. */
async function uploadForCache(opts: BuildOptions): Promise<UploadResult> {
  const { scan, emitter } = opts;
  emitter.emit(`indexing ${scan.files.length} files…`, 0, scan.files.length);
  const uploaded = await uploadWorkspaceFiles({
    client: opts.client,
    manifest: opts.manifest,
    workspaceRoot: scan.workspaceRoot,
    files: scan.files,
    emitter,
    ...(opts.uploadConcurrency !== undefined ? { concurrency: opts.uploadConcurrency } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  assertUploadsComplete(scan.files.length, uploaded);
  return uploaded;
}

/**
 * Throws when so many uploads failed that the context is clearly lossy, so the caller surfaces an error instead of a
 * partial answer; the workspace row is not written. Up to 5 files any failure counts (a 2-file repo with both uploads
 * failed would otherwise reach Gemini as empty contents); above that, max(3, 5 %) failures.
 */
function assertUploadsComplete(fileCount: number, uploaded: UploadResult): void {
  const failureThreshold = fileCount <= 5 ? 1 : Math.max(3, Math.ceil(fileCount * 0.05));
  if (uploaded.failedCount >= failureThreshold) {
    const preview = uploaded.failures
      .slice(0, 3)
      .map((f) => `${f.relpath}: ${f.error}`)
      .join(' | ');
    throw new Error(
      `Upload failed for ${uploaded.failedCount}/${fileCount} files (threshold ${failureThreshold}). First errors: ${preview}`,
    );
  }
}

/** Builds a new cache from the uploads; a create that fails falls back to the uploaded file parts inline. */
async function buildCache(
  opts: BuildOptions,
  start: CallStart,
  uploaded: UploadResult,
): Promise<PreparedContext> {
  opts.emitter.emit('building context cache…');
  const build: CacheBuild = {
    opts,
    start,
    uploaded,
    fileContents: buildContentFromUploaded(uploaded.files),
  };
  let created: CreatedCache;
  try {
    created = await createCache(build);
  } catch (error) {
    return fallBackInline(build, { stage: 'create', error });
  }
  return recordCreatedCache(build, created);
}

/**
 * Points the row at the new cache, then deletes the previous one. The delete is fired only after the row write and
 * without waiting: a delete that fails leaves an orphan on Google's side until its TTL (bounded by `cacheTtlSeconds`),
 * never a row that points at a deleted cache, and the caller never waits for it.
 */
function recordCreatedCache(build: CacheBuild, created: CreatedCache): PreparedContext {
  const { opts, start, uploaded } = build;
  const { cacheId, cacheExpiresAt } = created;
  try {
    const fileIds = uploadedFileIds(uploaded);
    writeWorkspaceRow(opts, start, {
      cacheId,
      cacheExpiresAt,
      fileIds,
      updatedAt: created.answeredAtMs,
    });
  } catch (error) {
    return fallBackInline(build, { stage: 'record', cacheId, error });
  }
  const previousCacheId = start.existing?.cacheId ?? null;
  if (previousCacheId !== null) void bestEffortDeleteCache(opts.client, previousCacheId);
  return {
    cacheId,
    cacheExpiresAt,
    inlineContents: [],
    uploaded,
    rebuilt: true,
    reused: false,
    inlineOnly: false,
  };
}

/**
 * Creates the cache and reads the clock after it returns: an expiry counted from before a long create would be earlier
 * than Google's. A create that names no cache built none a request can use: it throws, so the rebuild takes the
 * failed-create path (the files inline), never a context with neither a cache nor its files.
 */
async function createCache(build: CacheBuild): Promise<CreatedCache> {
  const { opts } = build;
  const ttl = effectiveTtlSeconds(opts.ttlSeconds);
  const baseConfig = {
    contents: build.fileContents,
    ttl: `${ttl}s`,
    displayName: `gcctx-${opts.scan.workspaceRoot.slice(-40)}`,
  };
  const cacheConfig =
    opts.systemInstruction !== undefined
      ? { ...baseConfig, systemInstruction: opts.systemInstruction }
      : baseConfig;
  const created = await opts.client.caches.create({
    model: opts.model.resolved,
    config: cacheConfig,
  });
  const afterCreateMs = Date.now();
  if (!created.name) throw new Error('caches.create returned no cache name');
  return {
    cacheId: created.name,
    cacheExpiresAt: afterCreateMs + ttl * 1000,
    answeredAtMs: afterCreateMs,
  };
}

/**
 * The failed-create path: the warning, the row written without a cache (`updatedAt` the call's start), the uploaded
 * file parts inline. A cache created but not recorded is deleted before the row write, so its delete is fired even
 * when that write throws too.
 */
function fallBackInline(build: CacheBuild, failure: CreateFailure): PreparedContext {
  const { opts, start, uploaded } = build;
  reportCreateFailure(opts.client, failure);
  const fileIds = uploadedFileIds(uploaded);
  writeWorkspaceRow(opts, start, {
    cacheId: null,
    cacheExpiresAt: null,
    fileIds,
    updatedAt: start.now,
  });
  return {
    cacheId: null,
    cacheExpiresAt: null,
    inlineContents: build.fileContents,
    uploaded,
    rebuilt: false,
    reused: false,
    inlineOnly: false,
  };
}

/** The warning of a failed create; a cache that was created but could not be recorded is deleted, best-effort. */
function reportCreateFailure(client: GoogleGenAI, failure: CreateFailure): void {
  if (failure.stage === 'create') {
    logger.warn(`cache build failed — falling back to inline parts: ${safeForLog(failure.error)}`);
    return;
  }
  logger.warn(
    `recording cache ${safeForLog(failure.cacheId)} in the manifest failed — deleting it, falling back to inline parts: ${safeForLog(failure.error)}`,
  );
  void bestEffortDeleteCache(client, failure.cacheId);
}

/** The Files API ids of the uploads that have one. */
function uploadedFileIds(uploaded: UploadResult): string[] {
  return uploaded.files.map((f) => f.fileId).filter((v): v is string => v !== null);
}

/**
 * Best-effort async delete of a stale cache after a successful rebuild
 * (v1.13.0+), or of a new cache the manifest could not record. Retries 3× with exponential back-off (1 s, 3 s, 9 s) for
 * transient errors. Logs at warn on permanent failure — orphaned caches
 * auto-expire at Google's TTL so the worst case is bounded storage cost.
 *
 * Called as `void bestEffortDeleteCache(...)` so callers don't have to
 * await; the manifest's `cacheId` pointer was already swapped to the new
 * cache before this fires.
 */
async function bestEffortDeleteCache(client: GoogleGenAI, cacheId: string): Promise<void> {
  const delays = [1000, 3000, 9000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      await client.caches.delete({ name: cacheId });
      logger.debug(`async-deleted stale cache ${safeForLog(cacheId)} (attempt ${attempt + 1})`);
      return;
    } catch (err) {
      // Retry transient errors; give up quickly on 4xx (cache already gone, perms, etc.)
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = !msg.includes('NOT_FOUND') && !msg.includes('PERMISSION_DENIED');
      if (!isTransient || attempt === delays.length - 1) {
        logger.warn(
          `async-delete of stale cache ${safeForLog(cacheId)} permanently failed (attempt ${attempt + 1}): ${safeForLog(msg)}. Orphan will auto-expire at TTL.`,
        );
        return;
      }
      const nextDelay = delays[attempt];
      if (nextDelay !== undefined) await new Promise((r) => setTimeout(r, nextDelay));
    }
  }
}

/**
 * Hard-purge a workspace: delete the Gemini Context Cache, release every
 * Files API upload we uploaded for this workspace, and drop the manifest rows.
 *
 * The Files-API release is the non-obvious bit: Gemini auto-deletes uploads
 * 48 h after the original `files.upload`, but storage is billed in the
 * meantime and our `status` tool reports cost from `usage_metrics` only —
 * any leaked uploads show up on Google Cloud billing but not in our reports.
 * Best-effort; individual `files.delete` failures are logged at debug level
 * and do not block the invalidation (the 48 h timer is the safety net).
 *
 * This function is for DELIBERATE resets — `reindex` and `clear` tool calls.
 * The stale-cache self-heal path (ask/code retry after Gemini rejects our
 * `cachedContent`) wants to keep file rows intact for dedup on the rebuild;
 * it should call `markCacheStale()` instead.
 */
export async function invalidateWorkspaceCache(args: {
  client: GoogleGenAI;
  manifest: ManifestDb;
  workspaceRoot: string;
}): Promise<void> {
  const ws = args.manifest.getWorkspace(args.workspaceRoot);
  if (ws?.cacheId) {
    try {
      await args.client.caches.delete({ name: ws.cacheId });
    } catch (err) {
      logger.debug(`cache delete (${safeForLog(ws.cacheId)}) failed: ${safeForLog(err)}`);
    }
  }
  const fileIds = storedFileIds(args.manifest, args.workspaceRoot);
  if (fileIds.length > 0) await releaseUploadedFiles(args.client, fileIds);
  args.manifest.deleteWorkspace(args.workspaceRoot);
}

/**
 * The workspace's Files API ids, each once: several file rows can point at one upload (the uploader's content-hash
 * dedup, the same file at two paths), and a second `files.delete` of it is a wasted call and a 404.
 */
function storedFileIds(manifest: ManifestDb, workspaceRoot: string): string[] {
  return Array.from(
    new Set(
      manifest
        .getFiles(workspaceRoot)
        .map((r) => r.fileId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  );
}

/** Releases the uploads through a pool of at most 10 concurrent deletes. */
async function releaseUploadedFiles(client: GoogleGenAI, fileIds: string[]): Promise<void> {
  const concurrency = Math.min(10, fileIds.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < fileIds.length) {
        const i = idx;
        idx += 1;
        const id = fileIds[i];
        if (!id) continue;
        await releaseFile(client, id);
      }
    }),
  );
}

/**
 * Deletes one upload by its resource name. The manifest stores the `https://…/files/abc` URI (`fileData.fileUri`
 * rejects the bare `files/abc` form at `caches.create`), while `files.delete` takes the resource name. A failure is
 * logged and the purge goes on: Gemini deletes every upload 48 h after it was made.
 */
async function releaseFile(client: GoogleGenAI, id: string): Promise<void> {
  const deleteName = toFileResourceName(id);
  try {
    await client.files.delete({ name: deleteName });
  } catch (err) {
    logger.debug(
      `files.delete (${safeForLog(deleteName)}, stored as ${safeForLog(id)}) failed: ${safeForLog(err)}`,
    );
  }
}

/**
 * Lightweight cache-pointer reset used by the ask/code stale-cache retry
 * path. Nulls out `cache_id` / `cache_expires_at` on the workspace row so
 * the next `prepareContext` builds a fresh cache, but leaves the `files`
 * table alone — the same uploads can be reused via content-hash dedup
 * inside `uploadWorkspaceFiles`.
 *
 * Synchronous and makes no network calls: the cache is already dead on
 * Google's side (that's how we detected the staleness), so `caches.delete`
 * would just 404, and re-uploading files would double-bill for no benefit.
 */
export function markCacheStale(args: {
  manifest: ManifestDb;
  workspaceRoot: string;
}): void {
  const ws = args.manifest.getWorkspace(args.workspaceRoot);
  if (!ws) return;
  args.manifest.upsertWorkspace({
    ...ws,
    cacheId: null,
    cacheExpiresAt: null,
    updatedAt: Date.now(),
  });
}

/**
 * Heuristic check for "cached content is stale / not found" errors from the
 * Gemini API, used by ask/code to decide whether a retry with a rebuilt cache
 * is worth attempting. Matches observed error strings; conservative by design
 * — returns false for any error we don't recognise as cache-specific.
 */
export function isStaleCacheError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /cachedContent|cached[_ ]?content/i.test(msg) &&
    (/not[_ ]?found|not-found|does not exist|expired|404/i.test(msg) || /NOT_FOUND/.test(msg))
  );
}
