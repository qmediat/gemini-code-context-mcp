/**
 * Upload scanned files to the Gemini Files API with hash-based dedup.
 *
 * For each `ScannedFile` we look up an existing fresh `file_id` in the manifest
 * keyed by content hash — if found, we reuse it. Otherwise we upload and persist.
 *
 * Files API auto-deletes uploads after 48h (Google-managed). We track
 * `expires_at = uploadedAt + 47h` to force re-upload before Google's deletion.
 */

import { basename } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import type { ScannedFile } from '../indexer/workspace-scanner.js';
import type { ManifestDb } from '../manifest/db.js';
import type { FileRow } from '../types.js';
import { logger } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';

const FILES_API_TTL_MS = 47 * 3600 * 1000; // 1h safety margin before 48h auto-delete

function guessMimeType(_relpath: string): string {
  // Gemini accepts `text/plain` for any UTF-8 source. Keep it simple.
  return 'text/plain';
}

export interface UploadResult {
  /** Rows matching what we now have in the manifest. */
  files: FileRow[];
  uploadedCount: number;
  reusedCount: number;
}

export async function uploadWorkspaceFiles(args: {
  client: GoogleGenAI;
  manifest: ManifestDb;
  workspaceRoot: string;
  files: ScannedFile[];
  emitter: ProgressEmitter;
}): Promise<UploadResult> {
  const { client, manifest, workspaceRoot, files, emitter } = args;
  const now = Date.now();
  const out: FileRow[] = [];
  let uploadedCount = 0;
  let reusedCount = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (!file) continue;
    emitter.emit(`uploading ${i + 1}/${files.length}: ${file.relpath}`, i + 1, files.length);

    // Reuse existing upload when the same content hash is already registered
    // for this workspace and still within Google's 48 h deletion window.
    // IMPORTANT: preserve the ORIGINAL uploadedAt/expiresAt — Google's auto-delete
    // timer starts at original upload, not at our reuse moment.
    const existingRow = manifest.findFileRowByHash(workspaceRoot, file.contentHash, now);
    if (existingRow?.fileId) {
      reusedCount += 1;
      const row: FileRow = {
        workspaceRoot,
        relpath: file.relpath,
        contentHash: file.contentHash,
        fileId: existingRow.fileId,
        uploadedAt: existingRow.uploadedAt,
        expiresAt: existingRow.expiresAt,
      };
      manifest.upsertFile(row);
      out.push(row);
      continue;
    }

    try {
      const uploaded = await client.files.upload({
        file: file.absolutePath,
        config: {
          mimeType: guessMimeType(file.relpath),
          displayName: basename(file.relpath),
        },
      });
      // Prefer `.uri` — that's the full https URL Gemini expects in
      // `fileData.fileUri` references inside cache contents / generateContent.
      // `.name` (`files/abc123`) is the admin-API resource name; passing it as
      // fileUri yields a 400 "Cannot fetch content from the provided URL".
      const fileId = uploaded.uri ?? uploaded.name ?? null;
      if (!fileId) {
        logger.warn(`Files API returned no identifier for ${file.relpath} — skipping.`);
        continue;
      }
      uploadedCount += 1;
      const row: FileRow = {
        workspaceRoot,
        relpath: file.relpath,
        contentHash: file.contentHash,
        fileId,
        uploadedAt: now,
        expiresAt: now + FILES_API_TTL_MS,
      };
      manifest.upsertFile(row);
      out.push(row);
    } catch (err) {
      logger.warn(`upload failed for ${file.relpath}: ${String(err)}`);
    }
  }

  return { files: out, uploadedCount, reusedCount };
}
