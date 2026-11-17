/**
 * `ask`'s attachments: inspected, read and counted by Gemini before the scan, the preflight, the budget reservation
 * and the throttle; the refusals that end a call over them; the request-size refusal; their result fields.
 */

import {
  AttachmentError,
  AttachmentTokensUncountedError,
  INLINE_REQUEST_LIMIT_BYTES,
  countAttachmentTokens,
  inlineRequestBytes,
  inspectAttachments,
  readAttachments,
} from '../../attachments.js';
import { safeForLog } from '../../utils/logger.js';
import { type TextToolResult, errorResult } from '../registry.js';
import type { StepOutcome } from '../shared/eager-call.js';
import type { ServiceTierName } from '../shared/service-tier.js';
import type { AskAttached, AskResolved, PreparedAttachments } from './call.js';
import { SYSTEM_INSTRUCTION_Q_AND_A } from './instruction.js';

/** The attachments of one call: inspected, read and counted by Gemini, in that order — a refused file is never read,
 * a file that fails to read is never counted, and nothing has been reserved yet. */
async function prepareAttachments(
  client: Parameters<typeof countAttachmentTokens>[0],
  paths: readonly string[],
  workspaceRoot: string,
  model: string,
  signal: AbortSignal,
): Promise<PreparedAttachments> {
  const attached = await inspectAttachments(paths, workspaceRoot);
  const { parts, bytes } = await readAttachments(attached, signal);
  const tokens = await countAttachmentTokens(client, model, parts, signal);
  return { attached, parts, bytes, tokens };
}

/**
 * The attachments of one call, or the refusal that ends it: a model without vision, a bad file (never retryable), a
 * count Gemini could not give. Inspected, read and counted under the call's signal — before the scan, the preflight,
 * the budget reservation and the throttle: a bad file costs nothing.
 */
export async function attachAsk(call: AskResolved): Promise<StepOutcome<AskAttached>> {
  const { resolved, eager } = call;
  const paths = call.input.attachments ?? [];
  const meta = { serviceTier: call.serviceTier, resolvedModel: resolved.resolved };
  if (paths.length > 0 && !resolved.capabilities.supportsVision) {
    return {
      end: errorResult(
        `ask: ${paths.length} attachment(s) given, but ${safeForLog(resolved.resolved)} does not support vision — use \`latest-vision\` or a model that lists it`,
        { errorCode: 'ATTACHMENTS_UNSUPPORTED', retryable: false, ...meta },
      ),
    };
  }
  try {
    const attachments = await prepareAttachments(
      call.ctx.client,
      paths,
      eager.workspaceRoot,
      resolved.resolved,
      eager.timeout.signal,
    );
    return { next: { ...call, attachments } };
  } catch (err) {
    if (!(err instanceof AttachmentError) && !(err instanceof AttachmentTokensUncountedError))
      throw err;
    return {
      end: errorResult(`ask: ${err.message}`, {
        errorCode: err.code,
        retryable: err.retryable,
        ...meta,
      }),
    };
  }
}

/** The bytes of one workspace file as the request carries it: its body and its `--- FILE: <relpath> ---` marker. */
const FILE_MARKER_BYTES = '\n\n--- FILE:  ---\n\n'.length;
function inlineFileBytes(files: readonly { relpath: string; size: number }[]): number {
  return files.reduce(
    (sum, f) => sum + f.size + Buffer.byteLength(f.relpath, 'utf8') + FILE_MARKER_BYTES,
    0,
  );
}

/** Google's inline request limit holds whatever the caching mode (an explicit cache may not be built and the call
 * then runs inline): the refusal, before any reservation, when a conservative size of the request — the attachments
 * encoded, the workspace bodies with their markers, the prompt, the system instruction, the JSON framing — crosses
 * it; nothing otherwise. */
export function inlineRequestRefusal(
  prepared: PreparedAttachments,
  files: readonly { relpath: string; size: number }[],
  prompt: string,
  serviceTier: ServiceTierName,
): TextToolResult | undefined {
  if (prepared.attached.length === 0) return undefined;
  const textBytes =
    inlineFileBytes(files) +
    Buffer.byteLength(prompt, 'utf8') +
    Buffer.byteLength(SYSTEM_INSTRUCTION_Q_AND_A, 'utf8');
  const requestBytes = inlineRequestBytes(
    prepared.attached.map((a) => a.bytes),
    textBytes,
    files.length + 2, // the prompt and the system instruction
  );
  if (requestBytes <= INLINE_REQUEST_LIMIT_BYTES) return undefined;
  return errorResult(
    `ask: the inline request would carry ${requestBytes} bytes (the attachments base64-encoded, the workspace with its file markers, the prompt, the system instruction and the JSON framing), above Google's ${INLINE_REQUEST_LIMIT_BYTES}-byte limit for inline data; use fewer or smaller attachments, or narrow the workspace with includeGlobs / excludeGlobs`,
    {
      errorCode: 'REQUEST_TOO_LARGE',
      retryable: false,
      serviceTier,
      ...attachmentMetadata(prepared),
    },
  );
}

/** `structuredContent` fields of a call with attachments; nothing on a call without. */
export function attachmentMetadata(prepared: PreparedAttachments): Record<string, unknown> {
  if (prepared.attached.length === 0) return {};
  return {
    attachments: prepared.attached.map((a) => ({
      path: a.path,
      mimeType: a.mimeType,
      bytes: a.bytes,
    })),
    attachmentTokens: prepared.tokens,
  };
}
