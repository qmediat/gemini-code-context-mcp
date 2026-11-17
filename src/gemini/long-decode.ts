/**
 * Long decode — the facts of Gemini 4's continuation protocol and the output cap a call runs under.
 *
 * Google's reference (docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/gemini): on a Gemini 4
 * model a response that reaches the per-request decode limit stops with `finishReason: CONTINUATION` and a
 * `continuationToken`; the ORIGINAL request sent again with `continuationToken` set to the latest token continues
 * it, up to 1 048 576 decoded tokens in total. Thinking tokens count against the decode, and every request bills
 * its whole input again: the prompt plus everything decoded before it.
 */

import { categorizeModel, isTextGenCategory } from './model-taxonomy.js';

/** The most a Gemini 4 decode can produce over all its requests. */
export const LONG_DECODE_TOTAL_TOKENS = 1_048_576;

/** The most one streaming request decodes before it stops with `CONTINUATION` (a non-streaming one: 32 768). */
export const LONG_DECODE_STREAM_REQUEST_TOKENS = 65_536;

/** A text model of the Gemini 4 family (`gemini-4-<codename>`, `gemini-4.1-<codename>`, their `-preview` twins). */
const GEMINI_4_ID = /^gemini-4(?:\.\d+)?-/i;

/**
 * The total a decode of `modelId` may reach through continuation, or `null` for a model without long decode.
 * The model registry carries it beside the advertised input and output limits.
 */
export function longDecodeTokenLimitOf(modelId: string): number | null {
  if (!GEMINI_4_ID.test(modelId)) return null;
  return isTextGenCategory(categorizeModel(modelId)) ? LONG_DECODE_TOTAL_TOKENS : null;
}

/** The output cap of one call: what goes on the wire and how many requests the decode may take. */
export interface OutputCap {
  /** `maxOutputTokens` on the wire; `undefined` sends none and the model applies its own default. */
  readonly wire: number | undefined;
  /** The most the call decodes: the wire cap, else the model's per-request limit (its default). */
  readonly effective: number;
  /** The model's advertised per-request output limit. */
  readonly perRequest: number;
  /** The requests the decode may take: 1 unless the cap is above the per-request limit on a long-decode model. */
  readonly maxRequests: number;
}

export interface OutputCapInputs {
  /** The caller's `maxOutputTokens`, if any. */
  readonly requested: number | undefined;
  /** `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT`: send the per-request limit when the caller sets no cap. */
  readonly forceMax: boolean;
  readonly outputTokenLimit: number | null;
  /** `ResolvedModel.longDecodeTokenLimit`; `undefined` reads as none. */
  readonly longDecodeTokenLimit: number | null | undefined;
  /** The per-request limit assumed when the model advertises none. */
  readonly fallbackLimit: number;
}

/**
 * The caller's cap is clamped to the model's per-request limit, or — on a model with long decode — to its long
 * decode total. Without a caller's cap nothing goes on the wire (one request, the model's default), unless the
 * operator forces the per-request limit.
 */
export function resolveOutputCap(inputs: OutputCapInputs): OutputCap {
  const perRequest =
    typeof inputs.outputTokenLimit === 'number' && inputs.outputTokenLimit > 0
      ? inputs.outputTokenLimit
      : inputs.fallbackLimit;
  const ceiling = Math.max(perRequest, inputs.longDecodeTokenLimit ?? 0);
  const wire =
    inputs.requested !== undefined
      ? Math.min(inputs.requested, ceiling)
      : inputs.forceMax
        ? perRequest
        : undefined;
  const effective = wire ?? perRequest;
  return { wire, effective, perRequest, maxRequests: maxDecodeRequests(effective, perRequest) };
}

/** The requests a decode of `cap` tokens may take when each request decodes up to `perRequest` tokens. */
export function maxDecodeRequests(cap: number, perRequest: number): number {
  if (perRequest <= 0) return 1;
  return Math.max(1, Math.ceil(cap / perRequest));
}

/**
 * The input tokens the continuation requests bill again, at most, for a prompt of `promptTokens` tokens:
 *
 *   R = ceil(C / L)                               requests (the client stops there; L = the per-request limit)
 *   M = max(L, 65 536)                            the most one streaming request decodes
 *   re-billed input = Σ_{k=1..R−1} (P + min(k·M, C))
 *
 * Request k sends the prompt P again plus the tokens decoded before it, which are at most k·M and never more than
 * the cap C. The first request's prompt is not part of this sum. The decoded tokens themselves are at most C:
 * `maxOutputTokens` = C travels on every request.
 */
export function continuationInputTokens(
  promptTokens: number,
  cap: number,
  perRequest: number,
): number {
  const requests = maxDecodeRequests(cap, perRequest);
  const perRequestCeiling = Math.max(perRequest, LONG_DECODE_STREAM_REQUEST_TOKENS);
  let total = 0;
  for (let k = 1; k < requests; k++) {
    total += promptTokens + Math.min(k * perRequestCeiling, cap);
  }
  return total;
}
