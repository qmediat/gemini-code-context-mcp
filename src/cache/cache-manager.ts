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

import { readFileSync } from 'node:fs';
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
 * Skips the Files API entirely: we read each file, prefix with a path marker,
 * and embed as a single `{text}` part. Saves one network round-trip per file
 * and avoids Gemini's 48 h auto-delete housekeeping on small workspaces.
 */
function buildInlineContentFromDisk(scan: ScanResult): Content[] {
  const parts: Part[] = [];
  for (const f of scan.files) {
    let content: string;
    try {
      content = readFileSync(f.absolutePath, 'utf8');
    } catch (err) {
      logger.warn(`failed to read ${f.relpath}: ${String(err)}`);
      continue;
    }
    parts.push({ text: `\n\n--- FILE: ${f.relpath} ---\n${content}\n` });
  }
  if (parts.length === 0) return [];
  return [{ role: 'user', parts }];
}

/**
 * In-process mutex. Concurrent `prepareContext` calls for the same workspace
 * coalesce onto a single in-flight promise, avoiding duplicate cache creation
 * (which would leak orphaned Gemini caches at $$$/M-token-hour).
 *
 * Scope: single Node process. Cross-process races (two MCP servers sharing the
 * same manifest DB) are not covered — documented in docs/KNOWN-DEFICITS.md.
 */
const inFlight = new Map<string, Promise<PreparedContext>>();

export async function prepareContext(opts: BuildOptions): Promise<PreparedContext> {
  const key = opts.scan.workspaceRoot;
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
    const inlineContents = buildInlineContentFromDisk(scan);
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

  // 3) Token-floor check — Gemini rejects caches below 1024 tokens. Skip the
  //    Files API entirely here too — there's no cache benefit for small
  //    workspaces and we save the upload overhead.
  const minTokens = opts.cacheMinTokens ?? 1024;
  const estimatedTokens = scan.files.reduce(
    (sum: number, f: { size: number }) => sum + Math.ceil(f.size / 4),
    0,
  );
  if (estimatedTokens < minTokens) {
    logger.debug(
      `workspace too small for context cache (~${estimatedTokens} tokens < ${minTokens}); embedding inline.`,
    );
    const inlineContents = buildInlineContentFromDisk(scan);
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

  // 4) Cache-eligible path. Reuse existing cache if fingerprints match.
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
  // Threshold: 5 % of files or ≥ 3 failures (whichever is larger).
  const failureThreshold = Math.max(3, Math.ceil(scan.files.length * 0.05));
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
  args.manifest.deleteWorkspace(args.workspaceRoot);
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
