/**
 * Per-call attachments for `ask`: local image or PDF files sent inline with the prompt (Gemini `inlineData` parts).
 * They are never part of the workspace cache: a screenshot belongs to one question, not to the repository.
 *
 * Limits are Gemini's for inline data (20 MB per request) and a per-file cap below it; a file that cannot be read,
 * has an unsupported type or breaks a limit fails the call loud — never a silent skip.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { Part } from '@google/genai';

/** What Gemini accepts inline that a code question may need: screenshots, diagrams, a PDF spec. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

/** Gemini's inline-data request limit; the whole request (prompt + parts) must stay under it. */
export const MAX_INLINE_TOTAL_BYTES = 20 * 1024 * 1024;
/** One attachment: well under the request limit, so several fit. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

export const SUPPORTED_ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_EXTENSION);

export interface Attachment {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: number;
}

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

function mimeTypeOf(path: string): string {
  const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (mime === undefined) {
    throw new AttachmentError(
      `attachment ${path}: unsupported type (one of ${SUPPORTED_ATTACHMENT_EXTENSIONS.join(', ')})`,
    );
  }
  return mime;
}

/** Validates the list (count, type, size, readability) by stat before anything is read. */
export async function inspectAttachments(
  paths: readonly string[],
  cwd: string,
): Promise<Attachment[]> {
  if (paths.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`${paths.length} attachments; at most ${MAX_ATTACHMENTS} per call`);
  }
  const out: Attachment[] = [];
  let total = 0;
  for (const raw of paths) {
    const path = resolve(cwd, raw);
    const mimeType = mimeTypeOf(path);
    const bytes = await sizeOf(path);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `attachment ${path}: ${bytes} bytes, above ${MAX_ATTACHMENT_BYTES}`,
      );
    }
    total += bytes;
    out.push({ path, mimeType, bytes });
  }
  if (total > MAX_INLINE_TOTAL_BYTES) {
    throw new AttachmentError(
      `attachments total ${total} bytes, above Gemini's inline limit ${MAX_INLINE_TOTAL_BYTES}`,
    );
  }
  return out;
}

async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new AttachmentError(`attachment ${path}: not a regular file`);
    if (info.size === 0) throw new AttachmentError(`attachment ${path}: empty file`);
    return info.size;
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(
      `attachment ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The inline parts, in the order given; read only after every file passed inspection. */
export async function attachmentParts(attachments: readonly Attachment[]): Promise<Part[]> {
  const parts: Part[] = [];
  for (const a of attachments) {
    const data = await readFile(a.path);
    parts.push({ inlineData: { mimeType: a.mimeType, data: data.toString('base64') } });
  }
  return parts;
}
