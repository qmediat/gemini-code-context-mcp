/**
 * Per-call attachments for `ask`: local image or PDF files sent inline with the prompt (Gemini `inlineData` parts).
 * They are never part of the workspace cache: a screenshot belongs to one question, not to the repository.
 *
 * Limits are Gemini's for inline data (20 MB per request) and a per-file cap below it; a file that cannot be read,
 * has an unsupported type or breaks a limit fails the call loud — never a silent skip.
 */
import { lstat, readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Part } from '@google/genai';
import {
  SandboxError,
  resolveInsideWorkspace,
  resolveWorkspaceRoot,
} from './tools/agentic/sandbox.js';

/** What Gemini accepts inline that a code question may need: screenshots, diagrams, a PDF spec. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** This package's cap on the raw bytes of one call's attachments. Google's own figures differ by page (100 MB per
 * request, 50 MB for PDFs, 20 MB including text for images); base64 adds a third, and in implicit caching mode the
 * workspace text travels in the same request — the cap stays well under every figure. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
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

/** Validates the list (count, place, type, size, readability) by stat before anything is read. A path must resolve
 * inside the workspace (symlinks followed, as ask_agentic's jail does), the leaf must not itself be a symlink, and the
 * sandbox's secret rules apply — a diagram.pdf pointing at a credentials file is refused by name. */
export async function inspectAttachments(
  paths: readonly string[],
  workspaceRoot: string,
): Promise<Attachment[]> {
  if (paths.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`${paths.length} attachments; at most ${MAX_ATTACHMENTS} per call`);
  }
  const out: Attachment[] = [];
  let total = 0;
  const root = paths.length > 0 ? await resolveWorkspaceRoot(workspaceRoot) : workspaceRoot; // canonical, as the jail compares
  for (const raw of paths) {
    const path = await insideWorkspace(root, raw);
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
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new AttachmentError(
      `attachments total ${total} bytes, above this server's cap ${MAX_ATTACHMENTS_TOTAL_BYTES}`,
    );
  }
  return out;
}

/** The canonical path inside the workspace, or an AttachmentError naming why not. */
async function insideWorkspace(workspaceRoot: string, raw: string): Promise<string> {
  try {
    const { absolutePath } = await resolveInsideWorkspace(workspaceRoot, raw);
    const leaf = await lstat(absolutePath).catch(() => undefined);
    if (leaf?.isSymbolicLink())
      throw new AttachmentError(`attachment ${raw}: a symlink is not accepted`);
    return absolutePath;
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    const why =
      err instanceof SandboxError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new AttachmentError(`attachment ${raw}: ${why}`);
  }
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
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `attachment ${a.path}: grew to ${data.length} bytes between inspection and read`,
      );
    }
    parts.push({ inlineData: { mimeType: a.mimeType, data: data.toString('base64') } });
  }
  return parts;
}
