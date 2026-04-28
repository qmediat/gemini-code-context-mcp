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
import { logger, safeForLog } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';
import { runPool } from '../utils/run-pool.js';

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

export async function uploadWorkspaceFiles(args: {
  client: GoogleGenAI;
  manifest: ManifestDb;
  workspaceRoot: string;
  files: ScannedFile[];
  emitter: ProgressEmitter;
  concurrency?: number;
  /**
   * Optional abort signal (v1.12.1+). Checked at the top of every per-file
   * task in the pool. When fired, all not-yet-started tasks short-circuit
   * with an AbortError and the upload phase rejects — letting the caller's
   * `timeoutMs` budget propagate through the upload phase. In-flight
   * `client.files.upload` calls are NOT individually cancellable (the SDK
   * doesn't expose abort plumbing on `files.upload`), so already-flying
   * uploads complete; the abort just stops queueing more work and surfaces
   * the user's intent at the next pool yield point.
   */
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { client, manifest, workspaceRoot, files, emitter } = args;
  const concurrency = args.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
  const signal = args.signal;
  const now = Date.now();
  const out: FileRow[] = new Array(files.length);
  let uploadedCount = 0;
  let reusedCount = 0;
  let completed = 0;
  const failures: UploadFailure[] = [];

  // v1.13.0 progress-emit throttle. On a 500-file workspace, the previous
  // per-file emit dispatched 500 MCP notifications inside ~3 s — most of
  // them serialised over stdio for the same effective UI state ("X/500
  // indexed"). Cap the emit cadence at ≥250 ms apart OR ≥25 files of
  // progress, whichever comes first; ALWAYS emit the final completion so
  // the progress UI doesn't hang at e.g. 475/500. Only the index
  // notifications are throttled — abort/error events stay immediate.
  const PROGRESS_EMIT_INTERVAL_MS = 250;
  const PROGRESS_EMIT_FILE_STEP = 25;
  let lastEmitTimeMs = 0;
  let lastEmitCompleted = 0;
  const emitProgress = (relpath: string): void => {
    const isFinal = completed === files.length;
    const tNow = Date.now();
    const stepReached = completed - lastEmitCompleted >= PROGRESS_EMIT_FILE_STEP;
    const intervalReached = tNow - lastEmitTimeMs >= PROGRESS_EMIT_INTERVAL_MS;
    if (!(isFinal || stepReached || intervalReached)) return;
    lastEmitTimeMs = tNow;
    lastEmitCompleted = completed;
    emitter.emit(`indexed ${completed}/${files.length}: ${relpath}`, completed, files.length);
  };

  // Pre-flight: don't start the pool at all if abort already fired.
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Operation aborted', 'AbortError');
  }

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
    // Mid-pool abort check. `runPool` schedules tasks lazily, so by the
    // time this task starts, the user's `timeoutMs` may have already
    // fired. Bail before doing any further I/O. Already-flying tasks
    // (the ones currently inside `client.files.upload`) complete on
    // their own — `files.upload` doesn't expose abort plumbing.
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Operation aborted', 'AbortError');
    }
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
        mtimeMs: entry.file.mtimeMs,
        size: entry.file.size,
      };
      manifest.upsertFile(row);
      out[i] = row;
      completed += 1;
      emitProgress(entry.file.relpath);
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
      mtimeMs: entry.file.mtimeMs,
      size: entry.file.size,
    };
    manifest.upsertFile(row);
    out[i] = row;
    if (isDuplicate) reusedCount += 1;
    completed += 1;
    emitProgress(entry.file.relpath);
  }).then((settled) => {
    // Collect failures after the pool finishes — don't lose the mapping to files.
    //
    // v1.13.0 post-review (FN3, gemini P1): abort-induced rejections are NOT
    // genuine upload failures — they're cooperative bail-outs from the per-task
    // abort guard at the top of the worker. Treating them as "failed" pollutes
    // stderr with N-completed warns AND inflates `failures`, both of which
    // mislead the user before the post-pool re-throw at line ~246 surfaces the
    // real `signal.reason` (typically a TimeoutError that maps to
    // `errorCode: 'TIMEOUT'`). On a 400-file repo with concurrency 10 and an
    // abort fired at completed=12, this could spew ~388 warn lines.
    const aborted = signal?.aborted === true;
    for (let i = 0; i < settled.length; i += 1) {
      const r = settled[i];
      const file = files[i];
      if (r?.status === 'rejected' && file) {
        const reason = r.reason;
        if (
          aborted &&
          (reason === signal?.reason || (reason instanceof Error && reason.name === 'AbortError'))
        ) {
          continue;
        }
        const message = reason instanceof Error ? reason.message : String(reason);
        logger.warn(`upload failed for ${safeForLog(file.relpath)}: ${safeForLog(message)}`);
        failures.push({ relpath: file.relpath, error: message });
      }
    }
  });

  // Post-pool abort propagation (v1.12.1). `runPool` catches per-task
  // errors and returns a settled-results array, so the in-task abort
  // throw above just becomes "Upload failed for X" in `failures`. To
  // honour the user's `timeoutMs` semantics — and surface a proper
  // TIMEOUT errorCode at the tool layer instead of a generic
  // "upload failed" — we re-check the signal AFTER the pool completes
  // and throw `signal.reason` (the canonical TimeoutError DOMException
  // with `timeoutKind` property). The outer `isTimeoutAbort` walk
  // then maps it to `errorCode: 'TIMEOUT'` cleanly.
  //
  // Caught regression from /coderev v1.12.1 audit (Copilot finding
  // COP-2): pre-fix the abort was silently swallowed by runPool.
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Operation aborted during file upload', 'AbortError');
  }

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
