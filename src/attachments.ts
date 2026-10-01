/** `ask` attachments: local image and PDF files sent inline with one question. The threat model, the caps and the
 * token rule are in `docs/DESIGN-attachments.md`; this module keeps them. */
import { constants as fsConstants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { GoogleGenAI, Part } from '@google/genai';
import {
  SandboxError,
  resolveInsideWorkspace,
  resolveWorkspaceRoot,
} from './tools/agentic/sandbox.js';
import { statusOf } from './tools/shared/service-tier.js';

export type AttachmentMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';

/** What Gemini accepts inline that a code question may need: screenshots, diagrams, a PDF spec. */
const MIME_BY_EXTENSION: Readonly<Record<string, AttachmentMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** This server's cap on the raw bytes of one call's attachments. Google's inline-data limit is 20 MB for the whole
 * request (the larger figures on its pages — 100 MB per request, 50 MB per PDF — are for the Files API, which this
 * tool does not use); base64 adds a third (14 MB raw ≈ 18.7 MB encoded), the workspace text may travel in the same
 * request, and `INLINE_REQUEST_LIMIT_BYTES` is checked with both. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 14 * 1024 * 1024;
/** One attachment: well under the request limit, so several fit. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
/** Google's limit on one inline request — files, prompt and system instruction together. The tool checks it with the
 * encoded attachment bytes plus the workspace and prompt bytes whatever the caching mode (an explicit cache may not be
 * built, and the call then runs inline), before any reservation. */
export const INLINE_REQUEST_LIMIT_BYTES = 20_000_000;

/** JSON framing allowed per part of the request (role, keys, quotes, commas) and once for the envelope. */
const REQUEST_FRAMING_BYTES_PER_PART = 64;
const REQUEST_FRAMING_BYTES = 1024;

/** A conservative size of the inline request: every attachment base64-encoded on its own (padding per file), the
 * text the request carries (workspace bodies with their file markers, the prompt, the system instruction) and the
 * JSON framing of every part. */
export function inlineRequestBytes(
  attachmentBytes: readonly number[],
  textBytes: number,
  textParts: number,
): number {
  const encoded = attachmentBytes.reduce((sum, b) => sum + Math.ceil(b / 3) * 4, 0);
  const framing =
    REQUEST_FRAMING_BYTES + REQUEST_FRAMING_BYTES_PER_PART * (attachmentBytes.length + textParts);
  return encoded + textBytes + framing;
}

const SUPPORTED_ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_EXTENSION);

/** What inspection established about one file. */
export interface Attachment {
  /** The canonical path inside the workspace at inspection. */
  readonly path: string;
  /** The file's identity at inspection, exact (64-bit on NFS, XFS and Windows): the read accepts only this device
   * and inode behind the descriptor. */
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mimeType: AttachmentMimeType;
  /** The size at inspection; the read accepts only a file of this size. */
  readonly bytes: number;
}

/** The inline parts, read once, bounded. Tokens are not a field: Gemini counts the assembled parts. */
export interface ReadAttachments {
  readonly parts: Part[];
  readonly bytes: number;
}

/** A refused attachment: `ATTACHMENT_INVALID`, never retryable, raised before any reservation. */
export class AttachmentError extends Error {
  readonly code = 'ATTACHMENT_INVALID';
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** Gemini could not count the parts: `ATTACHMENT_TOKENS_UNCOUNTED` — no local estimate stands in. Retryable when
 * the failure was transient (no HTTP status, a 429 or a 5xx); a 401/403/404 is not. */
export class AttachmentTokensUncountedError extends Error {
  readonly code = 'ATTACHMENT_TOKENS_UNCOUNTED';
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AttachmentTokensUncountedError';
    this.retryable = retryable;
  }
}

function mimeTypeOf(path: string): AttachmentMimeType {
  const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (mime === undefined) {
    throw new AttachmentError(
      `attachment ${path}: unsupported type (one of ${SUPPORTED_ATTACHMENT_EXTENSIONS.join(', ')})`,
    );
  }
  return mime;
}

/** The first bytes a file of the declared type starts with. WebP is `RIFF????WEBP`. */
function hasMagic(mimeType: AttachmentMimeType, data: Buffer): boolean {
  switch (mimeType) {
    case 'image/png':
      return data
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/webp':
      return (
        data.subarray(0, 4).toString('latin1') === 'RIFF' &&
        data.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    case 'application/pdf':
      return data.subarray(0, 5).toString('latin1') === '%PDF-';
  }
}

function describe(err: unknown): string {
  if (err instanceof SandboxError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Validates the list (count, place, type, size, readability) by `stat` before anything is read. A path must
 * resolve inside the workspace (symlinks followed, as `ask_agentic`'s jail does), the leaf must not itself be a
 * symlink, and the sandbox's secret rules apply — a diagram.pdf pointing at a credentials file is refused by name. */
export async function inspectAttachments(
  paths: readonly string[],
  workspaceRoot: string,
): Promise<Attachment[]> {
  if (paths.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`${paths.length} attachments; at most ${MAX_ATTACHMENTS} per call`);
  }
  if (paths.length === 0) return [];
  const root = await resolveWorkspaceRoot(workspaceRoot).catch((err: unknown) => {
    throw new AttachmentError(`workspace ${workspaceRoot}: ${describe(err)}`);
  }); // canonical, as the jail compares
  const out: Attachment[] = [];
  let total = 0;
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
    out.push({ path, dev, ino, mimeType, bytes });
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
    // the leaf as the jail will see it (trimmed, as `resolveInsideWorkspace` trims): a symlink is refused before
    // anything is resolved through it
    const named = await lstat(resolve(workspaceRoot, raw.trim())).catch(() => undefined);
    if (named?.isSymbolicLink())
      throw new AttachmentError(`attachment ${raw}: a symlink is not accepted`);
    const { absolutePath } = await resolveInsideWorkspace(workspaceRoot, raw);
    return absolutePath;
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(`attachment ${raw}: ${describe(err)}`);
  }
}

async function identityOf(path: string): Promise<{ bytes: number; dev: bigint; ino: bigint }> {
  try {
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) throw new AttachmentError(`attachment ${path}: not a regular file`);
    if (info.size === 0n) throw new AttachmentError(`attachment ${path}: empty file`);
    return { bytes: Number(info.size), dev: info.dev, ino: info.ino };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(`attachment ${path}: ${describe(err)}`);
  }
}

/** The inline parts, in the order given; read only after every file passed inspection. The read opens the
 * inspected path with O_NOFOLLOW, accepts only the inspected device, inode and size behind the descriptor, reads the
 * size plus one byte in chunks (a timeout ends it) so a file that grows meanwhile is caught without being
 * materialised, checks the first bytes against the declared type, and re-checks the total. */
export async function readAttachments(
  attachments: readonly Attachment[],
  signal?: AbortSignal,
): Promise<ReadAttachments> {
  const parts: Part[] = [];
  let bytes = 0;
  for (const a of attachments) {
    const data = await readAttachment(a, MAX_ATTACHMENTS_TOTAL_BYTES - bytes, signal);
    if (!hasMagic(a.mimeType, data)) {
      throw new AttachmentError(`attachment ${a.path}: the content is not ${a.mimeType}`);
    }
    bytes += data.length;
    parts.push({ inlineData: { mimeType: a.mimeType, data: data.toString('base64') } });
  }
  return { parts, bytes };
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readAttachment(
  a: Attachment,
  roomLeft: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(a.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); // a symlink leaf fails to open
    const info = await handle.stat({ bigint: true });
    if (!info.isFile())
      throw new AttachmentError(`attachment ${a.path}: not a regular file at read`);
    if (info.dev !== a.dev || info.ino !== a.ino) {
      throw new AttachmentError(`attachment ${a.path}: the opened file is not the one inspected`);
    }
    if (info.size !== BigInt(a.bytes)) {
      throw new AttachmentError(
        `attachment ${a.path}: ${info.size} bytes at read, ${a.bytes} at inspection — changed size since`,
      );
    }
    if (a.bytes > roomLeft) {
      throw new AttachmentError(
        `attachment ${a.path}: ${a.bytes} bytes would take the attachments above this server's cap ${MAX_ATTACHMENTS_TOTAL_BYTES}`,
      );
    }
    return await readExactly(handle, a.bytes, a.path, signal);
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    if (signal?.aborted && err === signal.reason) throw err; // a timeout or cancellation keeps its identity
    throw new AttachmentError(`attachment ${a.path}: ${describe(err)}`);
  } finally {
    await handle?.close();
  }
}

/** Reads `size` bytes and one more, a chunk at a time so a timeout or cancellation ends it: a file that has more than
 * `size` bytes grew after it was measured, one that ends before `size` shrank. */
const READ_CHUNK = 1024 * 1024;
async function readExactly(
  handle: FileHandle,
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
  if (read !== size) throw new AttachmentError(`attachment ${path}: shrank while being read`);
  return buffer.subarray(0, read);
}

/** Whether a failed `countTokens` may succeed when sent again: no HTTP status (a connection failure), a 429 or a
 * 5xx — a 401/403/404 will not. */
function transientStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

/** The tokens Gemini counts for the parts (one free `countTokens` call; measured on 2026-10-01: a 1×1 PNG is 1090
 * tokens on gemini-3-flash and 259 on 2.5-flash-lite — no local figure is right for every model). A 400 means
 * Gemini refused the parts themselves (a corrupt image or PDF): `ATTACHMENT_INVALID`. A cancellation keeps its
 * identity so the caller maps it to TIMEOUT; any other failure, and a malformed count, is uncounted. */
export async function countAttachmentTokens(
  client: GoogleGenAI,
  model: string,
  parts: readonly Part[],
  signal?: AbortSignal,
): Promise<number> {
  if (parts.length === 0) return 0;
  let total: unknown;
  try {
    const response = await client.models.countTokens({
      model,
      contents: [{ role: 'user', parts: [...parts] }],
      ...(signal !== undefined ? { config: { abortSignal: signal } } : {}),
    });
    total = response.totalTokens;
  } catch (err) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : err;
    const status = statusOf(err);
    if (status === 400)
      throw new AttachmentError(`Gemini refused the attachments: ${describe(err)}`);
    throw new AttachmentTokensUncountedError(
      `countTokens failed for the attachments: ${describe(err)}`,
      transientStatus(status),
      { cause: err },
    );
  }
  // a non-empty part cannot count zero or a fraction: such a total would reserve nothing
  if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0) {
    throw new AttachmentTokensUncountedError(
      `countTokens returned no usable total for the attachments (${String(total)})`,
      true,
    );
  }
  return total;
}
