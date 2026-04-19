/**
 * Upload scanned files to the Gemini Files API with hash-based dedup.
 *
 * For each `ScannedFile` we look up an existing fresh `file_id` in the manifest
 * keyed by content hash — if found AND the file has enough lifetime left to
 * outlast a fresh Context Cache, we reuse it. Otherwise we upload.
 *
 * Files API auto-deletes uploads after 48h (Google-managed). We track
 * `expires_at = uploadedAt + 47h`. When a reuse candidate's remaining life
 * drops below `CACHE_BUILD_SAFETY_MARGIN_MS`, we re-upload so the subsequent
 * Context Cache doesn't end up pointing at a file Google is about to delete.
 *
 * Uploads run in a bounded concurrent pool so a 500-file workspace doesn't
 * block on serial HTTP round-trips.
 */

import { basename } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import type { ScannedFile } from '../indexer/workspace-scanner.js';
import type { ManifestDb } from '../manifest/db.js';
import type { FileRow } from '../types.js';
import { logger } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';

const FILES_API_TTL_MS = 47 * 3600 * 1000; // 1 h safety margin before 48 h auto-delete
/**
 * Files are unsafe to reuse when Google is about to delete them. A cache build
 * takes 30-90 s and the cache itself lives for `cacheTtlSeconds` (default 1 h),
 * so if the underlying file has less than this margin left, re-upload.
 */
const CACHE_BUILD_SAFETY_MARGIN_MS = 2 * 3600 * 1000; // 2 h
const DEFAULT_UPLOAD_CONCURRENCY = 10;

/**
 * All source files upload as `text/plain`. Gemini accepts plain UTF-8 for any
 * source format, and crucially: `fileData.fileUri` references must carry the
 * SAME mime type declared at upload — otherwise `caches.create` returns 400
 * "Request contains an invalid argument" (verified empirically).
 *
 * Per-extension MIME tuning (json → application/json, md → text/markdown) is
 * tracked in `docs/ACCEPTED-RISKS.md`; it requires threading the per-file
 * mime through `FileRow` + `buildContentFromUploaded` so upload and reference
 * agree. Deferred pending evidence that the quality delta is worth the
 * complexity.
 */
function uploadMimeType(_relpath: string): string {
  return 'text/plain';
}

export interface UploadFailure {
  relpath: string;
  error: string;
}

export interface UploadResult {
  /** Rows matching what we now have in the manifest. */
  files: FileRow[];
  uploadedCount: number;
  reusedCount: number;
  /** Files that failed to upload. Caller decides how to surface this to the user. */
  failedCount: number;
  failures: UploadFailure[];
}

/**
 * Run `task` over `items` with up to `concurrency` in flight. Order of
 * results matches order of items. Never throws — every failure is captured
 * as a rejected `PromiseSettledResult` in the returned array.
 */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        const item = items[i];
        if (item === undefined) continue;
        try {
          const value = await task(item, i);
          results[i] = { status: 'fulfilled', value };
        } catch (err) {
          results[i] = { status: 'rejected', reason: err };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function uploadWorkspaceFiles(args: {
  client: GoogleGenAI;
  manifest: ManifestDb;
  workspaceRoot: string;
  files: ScannedFile[];
  emitter: ProgressEmitter;
  concurrency?: number;
}): Promise<UploadResult> {
  const { client, manifest, workspaceRoot, files, emitter } = args;
  const concurrency = args.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
  const now = Date.now();
  const out: FileRow[] = new Array(files.length);
  let uploadedCount = 0;
  let reusedCount = 0;
  let completed = 0;
  const failures: UploadFailure[] = [];

  // First pass: decide reuse vs upload without hitting the network.
  const plan = files.map((file) => {
    const existing = manifest.findFileRowByHash(workspaceRoot, file.contentHash, now);
    const canReuse =
      existing?.fileId != null &&
      (existing.expiresAt == null || existing.expiresAt > now + CACHE_BUILD_SAFETY_MARGIN_MS);
    return { file, existing: canReuse ? existing : null };
  });

  // In-batch dedup: two ScannedFiles with identical contentHash shouldn't both
  // upload. We share the first upload's Promise and resolve both to the same
  // fileId. Keyed on contentHash; scoped to this batch (not persisted).
  const inBatchUploads = new Map<string, Promise<string>>();

  await runPool(plan, concurrency, async (entry, i) => {
    // Reuse path: preserve original uploadedAt / expiresAt so the Google-side
    // 48 h clock continues from the original upload, not from our reuse moment.
    if (entry.existing?.fileId) {
      reusedCount += 1;
      const row: FileRow = {
        workspaceRoot,
        relpath: entry.file.relpath,
        contentHash: entry.file.contentHash,
        fileId: entry.existing.fileId,
        uploadedAt: entry.existing.uploadedAt,
        expiresAt: entry.existing.expiresAt,
      };
      manifest.upsertFile(row);
      out[i] = row;
      completed += 1;
      emitter.emit(
        `indexed ${completed}/${files.length}: ${entry.file.relpath}`,
        completed,
        files.length,
      );
      return;
    }

    // Same-batch dedup: if another worker is already uploading this content hash,
    // wait for their result instead of duplicating the upload.
    const existingUpload = inBatchUploads.get(entry.file.contentHash);
    let fileId: string;
    let isDuplicate = false;
    if (existingUpload) {
      fileId = await existingUpload;
      isDuplicate = true;
    } else {
      const uploadPromise = (async () => {
        const uploaded = await client.files.upload({
          file: entry.file.absolutePath,
          config: {
            mimeType: uploadMimeType(entry.file.relpath),
            displayName: basename(entry.file.relpath),
          },
        });
        // Prefer `.uri` — Gemini rejects `files/abc123` (the admin-API name)
        // when used as `fileData.fileUri`. Verified via integration test.
        const id = uploaded.uri ?? uploaded.name ?? null;
        if (!id) {
          throw new Error(`Files API returned no identifier for ${entry.file.relpath}`);
        }
        return id;
      })();
      inBatchUploads.set(entry.file.contentHash, uploadPromise);
      fileId = await uploadPromise;
      uploadedCount += 1;
    }

    const row: FileRow = {
      workspaceRoot,
      relpath: entry.file.relpath,
      contentHash: entry.file.contentHash,
      fileId,
      uploadedAt: now,
      expiresAt: now + FILES_API_TTL_MS,
    };
    manifest.upsertFile(row);
    out[i] = row;
    if (isDuplicate) reusedCount += 1;
    completed += 1;
    emitter.emit(
      `indexed ${completed}/${files.length}: ${entry.file.relpath}`,
      completed,
      files.length,
    );
  }).then((settled) => {
    // Collect failures after the pool finishes — don't lose the mapping to files.
    for (let i = 0; i < settled.length; i += 1) {
      const r = settled[i];
      const file = files[i];
      if (r?.status === 'rejected' && file) {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        logger.warn(`upload failed for ${file.relpath}: ${message}`);
        failures.push({ relpath: file.relpath, error: message });
      }
    }
  });

  // Pack only the successful rows into the final contiguous array for callers.
  const files_out: FileRow[] = [];
  for (const row of out) if (row) files_out.push(row);

  return {
    files: files_out,
    uploadedCount,
    reusedCount,
    failedCount: failures.length,
    failures,
  };
}
