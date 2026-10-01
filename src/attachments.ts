import { constants as fsConstants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
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
 * request, 50 MB for PDFs, 20 MB including text for images); base64 adds a third (14 MB raw ≈ 18.7 MB encoded), and
 * in implicit caching mode the workspace text travels in the same request — the cap stays under every figure. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 14 * 1024 * 1024; // ≈ 18.7 MB once base64-encoded
/** One attachment: well under the request limit, so several fit. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

export const SUPPORTED_ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_EXTENSION);

export interface Attachment {
  /** The canonical path inside the workspace at inspection time. */
  readonly path: string;
  /** The file's identity at inspection (device and inode): the read opens the path and accepts only this file. */
  readonly dev: number;
  readonly ino: number;
  /** The canonical workspace root the path was checked against; the read checks again. */
  readonly root: string;
  readonly mimeType: string;
  readonly bytes: number;
}

/** Gemini's token price of an image (≤ 384 px) or of one PDF page. */
export const TOKENS_PER_IMAGE_OR_PAGE = 258;
/** A large image is tiled 768×768: an upper bound for a 10 MB photo (about 4000×3000 → 20 tiles, rounded up). */
export const MAX_TILES_PER_IMAGE = 24;
/** Gemini reads at most this many pages of a PDF. */
export const MAX_PDF_PAGES = 1000;

/** The page count of a PDF as an upper bound, from what its bytes show in clear:
 *  1. the largest `/Count N` of a `/Pages` node — the root node's count covers every leaf page, compressed or not,
 *     and an intermediate node's count is smaller, so the largest `/Count` seen is the total;
 *  2. no `/Count` in clear but an object stream (`/ObjStm`) — pages may hide in it: Gemini's maximum;
 *  3. neither — every object is in clear: the `/Type /Page` objects (none at all: Gemini's maximum).
 * Never an undercount: a PDF that hides its page tree is over-reserved and settled by the ledger. */
const PDF_PAGES_COUNT =
  /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g;
const PDF_PAGE_OBJECT = /\/Type\s*\/Page(?![s\w])/g;
const PDF_OBJECT_STREAM = /\/Type\s*\/ObjStm\b/;

export function pdfPageCount(data: Buffer): number {
  const text = data.toString('latin1');
  let counted = 0;
  for (const m of text.matchAll(PDF_PAGES_COUNT))
    counted = Math.max(counted, Number(m[1] ?? m[2] ?? 0));
  const visible = text.match(PDF_PAGE_OBJECT)?.length ?? 0;
  if (counted > 0) return Math.min(MAX_PDF_PAGES, Math.max(counted, visible));
  if (PDF_OBJECT_STREAM.test(text) || visible === 0) return MAX_PDF_PAGES;
  return Math.min(MAX_PDF_PAGES, visible);
}

/** An UPPER-BOUND token estimate of one attachment from its bytes: an image as the most tiles Gemini makes of a 10 MB
 * photo, a PDF by its page objects (or Gemini's maximum when they are not visible). */
export function attachmentTokens(mimeType: string, data: Buffer): number {
  if (mimeType === 'application/pdf') return pdfPageCount(data) * TOKENS_PER_IMAGE_OR_PAGE;
  return MAX_TILES_PER_IMAGE * TOKENS_PER_IMAGE_OR_PAGE;
}

export interface ReadAttachments {
  readonly parts: Part[];
  /** The upper-bound token estimate of every part, for the preflight, the budget and the throttle. */
  readonly tokens: number;
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
    const { bytes, dev, ino } = await identityOf(path);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `attachment ${path}: ${bytes} bytes, above ${MAX_ATTACHMENT_BYTES}`,
      );
    }
    total += bytes;
    out.push({ path, root, dev, ino, mimeType, bytes });
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
    // the leaf as the caller named it: a symlink is refused before anything is resolved through it
    const named = await lstat(resolve(workspaceRoot, raw)).catch(() => undefined);
    if (named?.isSymbolicLink())
      throw new AttachmentError(`attachment ${raw}: a symlink is not accepted`);
    const { absolutePath } = await resolveInsideWorkspace(workspaceRoot, raw);
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

async function identityOf(path: string): Promise<{ bytes: number; dev: number; ino: number }> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new AttachmentError(`attachment ${path}: not a regular file`);
    if (info.size === 0) throw new AttachmentError(`attachment ${path}: empty file`);
    return { bytes: info.size, dev: info.dev, ino: info.ino };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(
      `attachment ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The inline parts, in the order given; read only after every file passed inspection. Between inspection and
 * read the file may have been swapped: the path is checked against the jail again, opened with O_NOFOLLOW (a symlink
 * put in its place fails to open), measured through the open descriptor, read up to its size plus one byte so a file
 * that grew is caught without being materialised, and the total is checked again. Every failure is an
 * AttachmentError. */
export async function readAttachments(
  attachments: readonly Attachment[],
  signal?: AbortSignal,
): Promise<ReadAttachments> {
  const parts: Part[] = [];
  let tokens = 0;
  let total = 0;
  for (const a of attachments) {
    const data = await readAttachment(a, MAX_ATTACHMENTS_TOTAL_BYTES - total, signal); // what the total still allows
    total += data.length;
    tokens += attachmentTokens(a.mimeType, data);
    parts.push({ inlineData: { mimeType: a.mimeType, data: data.toString('base64') } });
  }
  return { parts, tokens };
}

async function readAttachment(
  a: Attachment,
  roomLeft: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(a.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); // a symlink leaf fails to open
    const info = await handle.stat();
    if (!info.isFile())
      throw new AttachmentError(`attachment ${a.path}: not a regular file at read`);
    // The opened file must be the file inspected: its device and inode, recorded at inspection inside the workspace,
    // are compared with the descriptor's. A path component swapped before, during or after the open yields another
    // inode and is refused; no second walk of the path is involved, so there is nothing to toggle.
    if (info.dev !== a.dev || info.ino !== a.ino) {
      throw new AttachmentError(`attachment ${a.path}: the opened file is not the one inspected`);
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `attachment ${a.path}: ${info.size} bytes at read, above ${MAX_ATTACHMENT_BYTES}`,
      );
    }
    if (info.size > roomLeft) {
      throw new AttachmentError(
        `attachment ${a.path}: ${info.size} bytes at read would take the attachments above this server's cap ${MAX_ATTACHMENTS_TOTAL_BYTES}`,
      );
    }
    return await readExactly(handle, info.size, a.path, signal);
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    if (signal?.aborted && err === signal.reason) throw err; // a timeout or cancellation keeps its identity
    const why =
      err instanceof SandboxError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new AttachmentError(`attachment ${a.path}: ${why}`);
  } finally {
    await handle?.close();
  }
}

/** Reads `size` bytes and one more, a chunk at a time so a timeout or cancellation ends it: a file that has more than
 * `size` bytes grew after it was measured. */
const READ_CHUNK = 1024 * 1024;
async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(size + 1);
  let read = 0;
  for (;;) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new AttachmentError(`attachment ${path}: read aborted`);
    }
    const { bytesRead } = await handle.read(
      buffer,
      read,
      Math.min(READ_CHUNK, buffer.length - read),
      read,
    );
    if (bytesRead === 0) break;
    read += bytesRead;
    if (read > size) throw new AttachmentError(`attachment ${path}: grew while being read`);
  }
  return buffer.subarray(0, read);
}
