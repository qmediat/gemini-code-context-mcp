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
import { logger } from '../utils/logger.js';
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
}

function ttlString(seconds: number): string {
  return `${Math.max(60, Math.floor(seconds))}s`;
}

function isUsableExistingCache(
  ws: WorkspaceRow | null,
  scan: ScanResult,
  model: ResolvedModel,
  systemPromptHash: string,
  now: number,
): boolean {
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
      logger.warn(`failed to read ${f.relpath}: ${String(err)}`);
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
 * `(workspaceRoot, filesHash, model, systemPromptHash, allowCaching, cacheMinTokens)`
 * fingerprint coalesce onto a single in-flight promise, avoiding duplicate
 * cache creation (which would leak orphaned Gemini caches at $$$/M-token-hour).
 *
 * Keying on the full fingerprint is critical: `ask` and `code` tools use
 * different system instructions, so their `systemPromptHash` differs. Coalescing
 * on workspaceRoot alone would serve one tool's PreparedContext to the other —
 * wrong cache / system-instruction mismatch. This bug was flagged by GPT + Copilot.
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

async function doPrepareContext(opts: BuildOptions): Promise<PreparedContext> {
  const { client, manifest, scan, model, systemPromptHash, ttlSeconds, emitter, allowCaching } =
    opts;
  const now = Date.now();
  const existing = manifest.getWorkspace(scan.workspaceRoot);

  // 1) Ensure the workspace row exists before any file rows reference it.
  //    The `files` table has a FK to `workspaces(workspace_root)`, so first-time
  //    uploads on a new workspace would otherwise fail with FOREIGN KEY constraint.
  if (!existing) {
    manifest.upsertWorkspace({
      workspaceRoot: scan.workspaceRoot,
      filesHash: scan.filesHash,
      model: model.resolved,
      systemPromptHash,
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  // 2) If caching is disabled upfront, skip the Files API entirely and embed
  //    file text inline. No upload round-trip, no 48 h housekeeping.
  if (!allowCaching) {
    logger.debug('caching disabled — embedding files inline from disk.');
    const inlineContents = await buildInlineContentFromDisk(scan);
    manifest.upsertWorkspace({
      workspaceRoot: scan.workspaceRoot,
      filesHash: scan.filesHash,
      model: model.resolved,
      systemPromptHash,
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return {
      cacheId: null,
      cacheExpiresAt: null,
      inlineContents,
      uploaded: { files: [], uploadedCount: 0, reusedCount: 0, failedCount: 0, failures: [] },
      rebuilt: false,
      reused: false,
      inlineOnly: true,
    };
  }

  // 3) Reuse existing cache if fingerprints match. This runs BEFORE the
  //    token-floor check because reuse costs nothing — even a workspace that
  //    shrank below the floor should keep its valid cache until TTL expiry
  //    rather than being forced inline (which would orphan the cache on
  //    Google's side). Reordering from the previous build->reuse order was
  //    flagged by GPT review.
  if (isUsableExistingCache(existing, scan, model, systemPromptHash, now)) {
    logger.debug(`cache hit: ${existing?.cacheId}`);
    return {
      cacheId: existing?.cacheId ?? null,
      cacheExpiresAt: existing?.cacheExpiresAt ?? null,
      inlineContents: [],
      uploaded: { files: [], uploadedCount: 0, reusedCount: 0, failedCount: 0, failures: [] },
      rebuilt: false,
      reused: true,
      inlineOnly: false,
    };
  }

  // 4) Token-floor check — Gemini rejects `caches.create` below 1024 tokens.
  //    Skip the Files API entirely — there's no cache-build benefit for small
  //    workspaces and we save the upload overhead. Only applies when we're
  //    about to BUILD a new cache (reuse above already returned).
  const minTokens = opts.cacheMinTokens ?? 1024;
  const estimatedTokens = scan.files.reduce(
    (sum: number, f: { size: number }) => sum + Math.ceil(f.size / 4),
    0,
  );
  if (estimatedTokens < minTokens) {
    logger.debug(
      `workspace too small for context cache (~${estimatedTokens} tokens < ${minTokens}); embedding inline.`,
    );
    const inlineContents = await buildInlineContentFromDisk(scan);
    manifest.upsertWorkspace({
      workspaceRoot: scan.workspaceRoot,
      filesHash: scan.filesHash,
      model: model.resolved,
      systemPromptHash,
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return {
      cacheId: null,
      cacheExpiresAt: null,
      inlineContents,
      uploaded: { files: [], uploadedCount: 0, reusedCount: 0, failedCount: 0, failures: [] },
      rebuilt: false,
      reused: false,
      inlineOnly: true,
    };
  }

  // 5) Upload files (parallel pool inside uploadWorkspaceFiles).
  emitter.emit(`indexing ${scan.files.length} files…`, 0, scan.files.length);
  const uploaded = await uploadWorkspaceFiles({
    client,
    manifest,
    workspaceRoot: scan.workspaceRoot,
    files: scan.files,
    emitter,
    ...(opts.uploadConcurrency !== undefined ? { concurrency: opts.uploadConcurrency } : {}),
  });

  // If enough uploads failed that the context is clearly lossy, bail now so the
  // caller surfaces an error instead of silently returning a partial answer.
  // Threshold: tiny workspaces (≤5 files) fail-fast on ANY upload failure; larger
  // workspaces tolerate ≤5 % or <3 failures. The tiny-workspace carve-out
  // prevents a 2-file repo with both uploads failing from falling through to a
  // confusing Gemini 400 on empty contents.
  const failureThreshold =
    scan.files.length <= 5 ? 1 : Math.max(3, Math.ceil(scan.files.length * 0.05));
  if (uploaded.failedCount >= failureThreshold) {
    const preview = uploaded.failures
      .slice(0, 3)
      .map((f) => `${f.relpath}: ${f.error}`)
      .join(' | ');
    throw new Error(
      `Upload failed for ${uploaded.failedCount}/${scan.files.length} files (threshold ${failureThreshold}). First errors: ${preview}`,
    );
  }

  // 6) Delete any stale cache BEFORE attempting to build the new one.
  //    If the new build fails, the catch block can null-out cacheId in the
  //    manifest without leaking a reference on Google's side.
  if (existing?.cacheId) {
    try {
      await client.caches.delete({ name: existing.cacheId });
      logger.debug(`deleted stale cache ${existing.cacheId} before rebuild`);
    } catch (err) {
      logger.debug(`pre-rebuild cache delete (${existing.cacheId}) failed: ${String(err)}`);
    }
  }

  // 7) Build a new cache.
  emitter.emit('building context cache…');
  const fileContents = buildContentFromUploaded(uploaded.files);
  try {
    const baseConfig = {
      contents: fileContents,
      ttl: ttlString(ttlSeconds),
      displayName: `gcctx-${scan.workspaceRoot.slice(-40)}`,
    };
    const cacheConfig =
      opts.systemInstruction !== undefined
        ? { ...baseConfig, systemInstruction: opts.systemInstruction }
        : baseConfig;

    const created = await client.caches.create({
      model: model.resolved,
      config: cacheConfig,
    });
    // Re-read the clock AFTER create returns — long uploads would otherwise
    // make our tracked `cacheExpiresAt` artificially earlier than Google's.
    const afterCreateMs = Date.now();
    const cacheId = created.name ?? null;
    const cacheExpiresAt = afterCreateMs + ttlSeconds * 1000;

    manifest.upsertWorkspace({
      workspaceRoot: scan.workspaceRoot,
      filesHash: scan.filesHash,
      model: model.resolved,
      systemPromptHash,
      cacheId,
      cacheExpiresAt,
      fileIds: uploaded.files.map((f) => f.fileId).filter((v): v is string => v !== null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: afterCreateMs,
    });

    return {
      cacheId,
      cacheExpiresAt,
      inlineContents: [],
      uploaded,
      rebuilt: true,
      reused: false,
      inlineOnly: false,
    };
  } catch (err) {
    logger.warn(`cache build failed — falling back to inline parts: ${String(err)}`);
    manifest.upsertWorkspace({
      workspaceRoot: scan.workspaceRoot,
      filesHash: scan.filesHash,
      model: model.resolved,
      systemPromptHash,
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: uploaded.files.map((f) => f.fileId).filter((v): v is string => v !== null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return {
      cacheId: null,
      cacheExpiresAt: null,
      inlineContents: fileContents,
      uploaded,
      rebuilt: false,
      reused: false,
      inlineOnly: false,
    };
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
      logger.debug(`cache delete (${ws.cacheId}) failed: ${String(err)}`);
    }
  }

  // De-duplicate fileIds: the manifest's `files` table can have multiple
  // (workspaceRoot, relpath) rows pointing at the SAME `fileId` when the
  // uploader reused an existing upload via content-hash dedup (a tool whose
  // workspace contains the same file at two paths, or a rebuild that found
  // an existing in-batch dedup hit). Without `Set`, we'd `files.delete(X)`
  // multiple times — wasteful API calls + 404 noise after the first delete.
  const fileIds = Array.from(
    new Set(
      args.manifest
        .getFiles(args.workspaceRoot)
        .map((r) => r.fileId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  );
  if (fileIds.length > 0) {
    const concurrency = Math.min(10, fileIds.length);
    let idx = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (idx < fileIds.length) {
          const i = idx;
          idx += 1;
          const id = fileIds[i];
          if (!id) continue;
          try {
            await args.client.files.delete({ name: id });
          } catch (err) {
            logger.debug(`files.delete (${id}) failed: ${String(err)}`);
          }
        }
      }),
    );
  }

  args.manifest.deleteWorkspace(args.workspaceRoot);
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
