/**
 * Build / reuse / invalidate Gemini Context Caches keyed by workspace state.
 *
 * We key a cache on `(workspaceRoot, filesHash, model, systemPromptHash)`. When
 * any of those change, we invalidate and rebuild. The cache holds uploaded-file
 * references (via Files API URIs) so follow-up `ask`/`code` calls can reference
 * the cache ID and pay cached-token rates instead of full input rates.
 *
 * Not all models support caching — we check `supportsLongContext` as a heuristic.
 * When caching is skipped, we fall back to passing file parts inline on every call.
 */

import type { Content, GoogleGenAI } from '@google/genai';
import type { ScanResult } from '../indexer/workspace-scanner.js';
import type { ManifestDb } from '../manifest/db.js';
import type { ResolvedModel, WorkspaceRow } from '../types.js';
import { logger } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';
import { type UploadResult, uploadWorkspaceFiles } from './files-uploader.js';

export interface PreparedContext {
  /** Cache resource name (e.g. `cachedContents/abc123`) or null if caching skipped. */
  cacheId: string | null;
  cacheExpiresAt: number | null;
  /** File parts to include inline when the cache wasn't used (or as context when cache-miss). */
  inlineFileParts: Content[];
  uploaded: UploadResult;
  rebuilt: boolean;
  reused: boolean;
}

export interface BuildOptions {
  client: GoogleGenAI;
  manifest: ManifestDb;
  scan: ScanResult;
  model: ResolvedModel;
  systemPromptHash: string;
  systemInstruction?: string;
  ttlSeconds: number;
  emitter: ProgressEmitter;
  allowCaching: boolean;
}

function buildFilePartsFromManifest(
  files: { fileId: string | null; relpath: string }[],
): Content[] {
  const parts = files
    .filter((f): f is { fileId: string; relpath: string } => typeof f.fileId === 'string')
    .map((f) => ({
      role: 'user',
      parts: [
        {
          fileData: {
            fileUri: f.fileId,
            mimeType: 'text/plain',
          },
        },
      ],
    }));
  return parts;
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

export async function prepareContext(opts: BuildOptions): Promise<PreparedContext> {
  const { client, manifest, scan, model, systemPromptHash, ttlSeconds, emitter, allowCaching } =
    opts;
  const now = Date.now();
  const existing = manifest.getWorkspace(scan.workspaceRoot);

  // 1) Upload / reuse file contents first — needed whether we cache or not.
  emitter.emit(`indexing ${scan.files.length} files…`, 0, scan.files.length);
  const uploaded = await uploadWorkspaceFiles({
    client,
    manifest,
    workspaceRoot: scan.workspaceRoot,
    files: scan.files,
    emitter,
  });

  const inlineFileParts = buildFilePartsFromManifest(uploaded.files);

  if (!allowCaching) {
    logger.debug('caching disabled for this model — using inline parts only.');
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
      inlineFileParts,
      uploaded,
      rebuilt: false,
      reused: false,
    };
  }

  // 2) Reuse existing cache if fingerprints match.
  if (isUsableExistingCache(existing, scan, model, systemPromptHash, now)) {
    logger.debug(`cache hit: ${existing?.cacheId}`);
    return {
      cacheId: existing?.cacheId ?? null,
      cacheExpiresAt: existing?.cacheExpiresAt ?? null,
      inlineFileParts,
      uploaded,
      rebuilt: false,
      reused: true,
    };
  }

  // 3) Build a new cache.
  emitter.emit('building context cache…');
  try {
    const baseConfig = {
      contents: inlineFileParts,
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
    const cacheId = created.name ?? null;
    const cacheExpiresAt = now + ttlSeconds * 1000;

    manifest.upsertWorkspace({
      workspaceRoot: scan.workspaceRoot,
      filesHash: scan.filesHash,
      model: model.resolved,
      systemPromptHash,
      cacheId,
      cacheExpiresAt,
      fileIds: uploaded.files.map((f) => f.fileId).filter((v): v is string => v !== null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    // Invalidate stale cache on Gemini side if we had one.
    if (existing?.cacheId && existing.cacheId !== cacheId) {
      try {
        await client.caches.delete({ name: existing.cacheId });
      } catch {
        /* best-effort */
      }
    }

    return {
      cacheId,
      cacheExpiresAt,
      inlineFileParts,
      uploaded,
      rebuilt: true,
      reused: false,
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
      inlineFileParts,
      uploaded,
      rebuilt: false,
      reused: false,
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
