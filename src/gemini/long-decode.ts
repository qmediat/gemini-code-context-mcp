/**
 * Long decode — the facts of Gemini 4's continuation protocol and the output cap a call runs under.
 *
 * Google's reference (docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/gemini): on a Gemini 4
 * model a response that reaches the per-request decode limit stops with `finishReason: CONTINUATION` and a
 * `continuationToken`; the ORIGINAL request sent again with `continuationToken` set to the latest token continues
 * it, up to 1 048 576 decoded tokens in total. Thinking tokens count against the decode, and every request bills
 * its whole input again: the prompt plus everything decoded before it.
 */

import { logger } from '../utils/logger.js';
import { categorizeModel, isTextGenCategory } from './model-taxonomy.js';
import type { PreflightInput } from './token-counter.js';

/** The most a Gemini 4 decode can produce over all its requests. */
export const LONG_DECODE_TOTAL_TOKENS = 1_048_576;

/** The most one streaming request decodes before it stops with `CONTINUATION` (a non-streaming one: 32 768). */
export const LONG_DECODE_STREAM_REQUEST_TOKENS = 65_536;

/** A text model of the Gemini 4 family (`gemini-4-<codename>`, `gemini-4.1-<codename>`, their `-preview` twins). */
const GEMINI_4_ID = /^gemini-4(?:\.\d+)?-/i;

/** The API a client was built for: the Gemini Developer API (an API key) or Vertex AI. */
export type ApiBackend = 'developer' | 'vertex';

/**
 * The total a decode of `modelId` may reach through continuation, or `null` for a model without long decode. Long
 * decode runs on the Gemini Developer API only: on Vertex AI every model is clamped to its per-request limit,
 * whatever the shape of its id. The model registry carries it beside the advertised input and output limits.
 */
export function longDecodeTokenLimitOf(modelId: string, backend: ApiBackend): number | null {
  if (backend !== 'developer' || !GEMINI_4_ID.test(modelId)) return null;
  return isTextGenCategory(categorizeModel(modelId)) ? LONG_DECODE_TOTAL_TOKENS : null;
}

/**
 * Input a continuation request bills beyond the prompt and the tokens decoded before it. Measured on
 * gemini-4-hydrogen in two runs: +125 tokens (99 712-token prompt, request 2 billed 165 373) and +89; reserved at
 * twice the larger, rounded up.
 */
export const CONTINUATION_REQUEST_OVERHEAD_TOKENS = 256;

/** The output cap of one call: what goes on the wire and how many requests the decode may take. */
export interface OutputCap {
  /**
   * `maxOutputTokens` on the wire; `undefined` sends none and the model applies its own default. A cap the input window
   * cut to one request sends the cut value (`boundByInputWindow`).
   */
  readonly wire: number | undefined;
  /**
   * The most the call decodes: the wire cap, else the model's per-request limit (its default) — less when the
   * model's input window bounds a long decode (`boundByInputWindow`).
   */
  readonly effective: number;
  /** The model's advertised per-request output limit. */
  readonly perRequest: number;
  /**
   * The most a caller may ask for: the long-decode total on a model with long decode, else `perRequest`; for a prompt
   * the input window bounds, what that window leaves.
   */
  readonly ceiling: number;
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
  return {
    wire,
    effective,
    perRequest,
    ceiling,
    maxRequests: maxDecodeRequests(effective, perRequest),
  };
}

/** A long decode's cap cut so that no continuation request's input passes the model's input window. */
export interface InputWindowCut {
  /** The cap before the cut: the caller's, clamped to the model's limits. */
  readonly from: number;
  /** The cap the decode runs under. */
  readonly to: number;
  /** The model's input window that cut it. */
  readonly inputTokenLimit: number;
}

/** The cap a decode runs under, and the cut the input window made to it (`null`: none). */
export interface BoundedOutputCap {
  readonly cap: OutputCap;
  readonly cut: InputWindowCut | null;
}

/**
 * The cap of a long decode bounded by the model's input window W. Request k sends the prompt P again plus every token
 * decoded before it, and the client opens no further request once the decoded tokens reached the cap: under a cap of
 * at most W − P − O no request's input passes W. The premise — the API refuses a continuation request whose prompt
 * plus decoded tokens pass W — is assumed, not measured: the repository holds a measurement of what a continuation
 * request bills, none of a refusal at the window (docs/FOLLOW-UP-PRS.md T41).
 *
 * The cap is never cut below one request's limit — the first request sends the prompt alone, which the preflight
 * bounds. A cut that leaves several requests keeps the caller's `wire`: the client stops the decode at `effective`,
 * after `maxRequests`. A cut that leaves one request sends the cut value as `maxOutputTokens`, so the server holds it
 * (a stop at it is `MAX_TOKENS`) — one streaming request would otherwise decode past it. Without a counted prompt or
 * an advertised window nothing is cut.
 */
export function boundByInputWindow(
  cap: OutputCap,
  promptTokens: number | undefined,
  inputTokenLimit: number | null,
): BoundedOutputCap {
  if (cap.maxRequests <= 1 || promptTokens === undefined || inputTokenLimit === null) {
    return { cap, cut: null };
  }
  const room = inputTokenLimit - promptTokens - CONTINUATION_REQUEST_OVERHEAD_TOKENS;
  const most = Math.min(cap.ceiling, Math.max(room, cap.perRequest));
  if (cap.effective <= most) return { cap, cut: null };
  const maxRequests = maxDecodeRequests(most, cap.perRequest);
  return {
    cap: {
      wire: maxRequests === 1 ? most : cap.wire,
      effective: most,
      perRequest: cap.perRequest,
      ceiling: most,
      maxRequests,
    },
    cut: { from: cap.effective, to: most, inputTokenLimit },
  };
}

/** The progress and log line of a cut cap. */
export function describeInputWindowCut(cut: InputWindowCut): string {
  const n = (v: number): string => v.toLocaleString('en-US');
  return `maxOutputTokens cut from ${n(cut.from)} to ${n(cut.to)}: each continuation request sends the prompt again plus everything decoded before it, and the model's ${n(cut.inputTokenLimit)}-token input window holds no more`;
}

/** What `capThatRuns` bounds: the cap a tool resolved, the prompt's count and the model's input window. */
export interface CapToBound {
  /** The tool's name, which prefixes the note of a cut. */
  readonly tool: string;
  readonly cap: OutputCap;
  /** The preflight's count of the prompt, when it ran. */
  readonly promptTokens: number | undefined;
  readonly inputTokenLimit: number | null;
  /** The call's progress channel. */
  readonly emit: (message: string) => void;
}

/**
 * The cap a call's decode runs under: a long decode never sends a continuation request past the model's input
 * window (`boundByInputWindow`). A cut is said on the call's progress channel and in the log.
 */
export function capThatRuns(call: CapToBound): BoundedOutputCap {
  const bounded = boundByInputWindow(call.cap, call.promptTokens, call.inputTokenLimit);
  if (bounded.cut === null) return bounded;
  const note = `${call.tool}: ${describeInputWindowCut(bounded.cut)}`;
  call.emit(note);
  logger.warn(note);
  return bounded;
}

/** The answer the output cap keeps beside a thinking budget: Gemini requires `thinkingBudget < maxOutputTokens`. */
export const ANSWER_RESERVE_TOKENS = 1_024;

/**
 * The refusal of a caller's positive `thinkingBudget` that leaves less than the answer reserve under the caller's own
 * `maxOutputTokens` (`cap`: what that cap became under the model's limits) — refused, never clamped to 0, which
 * Gemini 3 Pro answers with a 400 that hides the cause. `null` when it fits, or the caller set either one not.
 */
export function thinkingBudgetRefusal(
  budget: number | undefined,
  requestedCap: number | undefined,
  cap: number,
): string | null {
  if (budget === undefined || budget <= 0 || requestedCap === undefined) return null;
  const least = budget + ANSWER_RESERVE_TOKENS;
  if (cap >= least) return null;
  return `thinkingBudget (${budget}) + ${ANSWER_RESERVE_TOKENS}-token answer reserve exceeds maxOutputTokens (${cap}). Raise \`maxOutputTokens\` to at least ${least}, or lower \`thinkingBudget\`.`;
}

/** The preflight's count modes (`preflightMode` of `ask` and `code`). */
export type PreflightMode = NonNullable<PreflightInput['preflightMode']>;

/**
 * The count mode the preflight runs in. A decode that may take more than one request bills its prompt once per
 * request, so the budget reservation takes the exact count (`countTokens`) whatever mode was asked for; a
 * one-request call keeps the caller's mode.
 */
export function preflightModeFor(
  requested: PreflightMode | undefined,
  cap: OutputCap,
): PreflightMode | undefined {
  return cap.maxRequests > 1 ? 'exact' : requested;
}

/** The requests a decode of `cap` tokens may take when each request decodes up to `perRequest` tokens. */
export function maxDecodeRequests(cap: number, perRequest: number): number {
  if (perRequest <= 0) return 1;
  return Math.max(1, Math.ceil(cap / perRequest));
}

/** The most one streaming request of a model with per-request limit `perRequest` decodes (M). */
function streamRequestTokens(perRequest: number): number {
  return Math.max(perRequest, LONG_DECODE_STREAM_REQUEST_TOKENS);
}

/**
 * The input tokens the continuation requests bill again, at most, for a prompt of `promptTokens` tokens:
 *
 *   R = ceil(C / L)                               requests (the client stops there; L = the per-request limit)
 *   M = max(L, 65 536)                            the most one streaming request decodes
 *   O = CONTINUATION_REQUEST_OVERHEAD_TOKENS      what a continuation request bills beyond the two terms below
 *   re-billed input = Σ_{k=1..R−1} (P + min(k·M, C) + O)
 *
 * Request k sends the prompt P again plus the tokens decoded before it, which are at most k·M and below the cap C
 * (the client opens no request once the decoded tokens reached C). The first request's prompt is not part of this
 * sum.
 */
export function continuationInputTokens(
  promptTokens: number,
  cap: number,
  perRequest: number,
): number {
  const requests = maxDecodeRequests(cap, perRequest);
  const perRequestCeiling = streamRequestTokens(perRequest);
  let total = 0;
  for (let k = 1; k < requests; k++) {
    total +=
      promptTokens + Math.min(k * perRequestCeiling, cap) + CONTINUATION_REQUEST_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * The most a decode of cap C produces (thinking and answer). One request honours `maxOutputTokens` = C. Over several
 * requests C stays the bound only while Google holds `maxOutputTokens` over the whole chain, which the client cannot
 * check: it stops after a request ends, once the decoded tokens reached C, so a server that holds the cap per
 * request lets the last request run up to one request's decode past it — at most C + M − 1, and never more than
 * R requests of M.
 */
export function decodedTokensBound(cap: number, perRequest: number): number {
  const requests = maxDecodeRequests(cap, perRequest);
  if (requests === 1) return cap;
  const perRequestCeiling = streamRequestTokens(perRequest);
  return Math.min(requests * perRequestCeiling, cap + perRequestCeiling - 1);
}
