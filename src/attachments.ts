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

/** The page objects of a PDF (`/Type /Page`, not `/Pages`); a PDF that keeps them in compressed object streams shows
 * none and is taken as Gemini's maximum — an upper bound, never an undercount. */
const PDF_PAGE_OBJECT = /\/Type\s*\/Page(?![s\w])/g;

export function pdfPageCount(data: Buffer): number {
  const found = data.toString('latin1').match(PDF_PAGE_OBJECT)?.length ?? 0;
  return found === 0 ? MAX_PDF_PAGES : Math.min(MAX_PDF_PAGES, found);
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
    const bytes = await sizeOf(path);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `attachment ${path}: ${bytes} bytes, above ${MAX_ATTACHMENT_BYTES}`,
      );
    }
    total += bytes;
    out.push({ path, root, mimeType, bytes });
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
    // The file behind the descriptor must be the one the path names inside the workspace NOW: the path is resolved
    // again (a parent swapped for a symlink resolves elsewhere and is refused) and its inode compared with the
    // descriptor's — a swap of any component between that check and the open cannot change what was opened.
    const { absolutePath } = await resolveInsideWorkspace(a.root, a.path);
    const named = await lstat(absolutePath);
    if (absolutePath !== a.path || named.dev !== info.dev || named.ino !== info.ino) {
      throw new AttachmentError(
        `attachment ${a.path}: is not the workspace file it was when inspected`,
      );
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
