/**
 * One decode over one or more requests (Gemini 4 long decode, `src/gemini/long-decode.ts`).
 *
 * A request that stops with `finishReason: CONTINUATION` and a continuation token is followed by the same request
 * with `continuationToken` set to the latest token — the payload is never changed and the text decoded so far is
 * never appended to it. Every request is sent with `automaticContinuation: false`, so the SDK hands each request's
 * end back here: this loop counts the requests, stops at the cap the budget reservation assumed, and
 * never re-sends a request that already streamed (billed) work.
 *
 * The requests share the caller's abort signal and chunk callback, so `timeoutMs` and the stall watchdog cover the
 * whole decode. The result is ONE response: the text and thought summary of every request in order, the usage
 * summed over the requests (each one bills its own input again), the last request's finish reason.
 */

import {
  FinishReason,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GoogleGenAI,
  type Part,
} from '@google/genai';
import { withNetworkRetry } from '../../gemini/retry.js';
import { logger } from '../../utils/logger.js';
import {
  type CollectedResponse,
  type StreamCollectorOptions,
  THOUGHTS_SUMMARY_MAX_CHARS,
  collectStream,
} from './stream-collector.js';

/** The long-decode sentences of the `maxOutputTokens` description of `ask` and `code`. */
export const LONG_DECODE_CAP_DESCRIPTION =
  "On a model with long decode (Gemini 4: Argon, Carbon, Hydrogen) a value above its per-request limit is sent up to 1,048,576: a response that reaches the per-request limit continues in further requests until the model stops or the cap is reached, and the result's `continuationHops` counts them. Each continuation request bills the prompt again plus everything decoded before it, so a long decode costs more than one request; the budget reservation counts that input too. Use it when a high thinking level leaves no room for the answer (`errorCode: 'OUTPUT_CAP'`, thinking tokens count against the cap).";

/** Opens one request of the decode: the first with no token, each continuation with the latest one. */
export type OpenDecodeRequest = (
  continuationToken: string | undefined,
) => Promise<AsyncGenerator<GenerateContentResponse>>;

/** Where the decode stops at the latest: `OutputCap.maxRequests` requests, `OutputCap.effective` decoded tokens. */
export interface DecodeLimits {
  readonly maxRequests: number;
  readonly cap: number;
}

export interface DecodedResponse extends CollectedResponse {
  /** The requests after the first one: 0 for a call that ended in one request. */
  readonly continuationHops: number;
}

/** One decode as `ask` and `code` run it: the request, how its opening is retried, and the decode's limits. */
export interface DecodeCall {
  readonly client: GoogleGenAI;
  readonly model: string;
  readonly contents: GenerateContentParameters['contents'];
  /** The request config; `automaticContinuation: false` is set on it here, the abort signal is the collector's. */
  readonly config: GenerateContentConfig;
  /** Attempts to OPEN each request (a failure before any response); a stream that opened is never re-sent. */
  readonly openAttempts: number;
  /** The log prefix of a retried opening (`ask`, `code (stale-cache retry)`). */
  readonly label: string;
  readonly limits: DecodeLimits;
  /** The abort signal (required: it reaches every request), the thought and chunk callbacks. */
  readonly collector: StreamCollectorOptions & { readonly signal: AbortSignal };
  /** Called each time a request's stream opened: from then on its work is billed. */
  readonly onRequestOpened: () => void;
  /** The call's record of the requests that streamed to their end, kept across its decodes and its failures. */
  readonly completed: CompletedRequests;
}

/** The usage a request reports for itself. */
export type DecodeUsage = NonNullable<GenerateContentResponse['usageMetadata']>;

/**
 * Every request of one call that streamed to its end. Each one is billed whatever becomes of the call — an answer,
 * a later request that fails, a stale-cache retry that starts a new decode — so the call settles its ledger from
 * here, never from the answer alone.
 */
export class CompletedRequests {
  private readonly reported: DecodeUsage[] = [];
  private total = 0;
  private inLatestDecode = 0;

  /** A new decode of the call starts: its requests are counted from zero. */
  beginDecode(): void {
    this.inLatestDecode = 0;
  }

  record(usage: DecodeUsage | undefined): void {
    if (usage !== undefined) this.reported.push(usage);
    this.total += 1;
    this.inLatestDecode += 1;
  }

  /** The requests of the call that completed, over all its decodes. */
  get count(): number {
    return this.total;
  }

  /**
   * The continuation requests the latest decode sent: one after each of its completed requests but the answer —
   * so after `n` completed requests, `n - 1` when the decode answered and `n` when the next one failed.
   */
  continuationHops(failed: boolean): number {
    return Math.max(0, failed ? this.inLatestDecode : this.inLatestDecode - 1);
  }

  /** Each counter summed over the completed requests that reported it; `undefined` when none reported usage. */
  usage(): DecodeUsage | undefined {
    return sumUsage(this.reported);
  }
}

/**
 * Run the decode: each request opens through `withNetworkRetry` (only the opening is retried — a mid-stream
 * failure would bill the work again) and is collected into one response.
 */
export function runDecode(call: DecodeCall): Promise<DecodedResponse> {
  const signal = call.collector.signal;
  const open: OpenDecodeRequest = async (continuationToken) => {
    const stream = await withNetworkRetry(
      () =>
        call.client.models.generateContentStream({
          model: call.model,
          contents: call.contents,
          config: {
            ...call.config,
            automaticContinuation: false,
            ...(continuationToken !== undefined ? { continuationToken } : {}),
            abortSignal: signal,
          },
        }),
      {
        attempts: call.openAttempts,
        signal,
        onRetry: (attempt, retryErr) => {
          logger.warn(
            `${call.label}: retrying generateContent after transient network failure (attempt ${attempt}): ${
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`,
          );
        },
      },
    );
    call.onRequestOpened();
    return stream;
  };
  call.completed.beginDecode();
  return collectDecode(open, call.limits, call.collector, call.completed);
}

/** The usage counters a request reports for itself and the decode sums. */
const USAGE_COUNTERS = [
  'promptTokenCount',
  'cachedContentTokenCount',
  'candidatesTokenCount',
  'thoughtsTokenCount',
  'toolUsePromptTokenCount',
  'totalTokenCount',
] as const satisfies readonly (keyof DecodeUsage)[];

/**
 * Collect the decode: one request, plus a continuation request after each one that stopped with CONTINUATION.
 * Each request that streamed to its end goes into `completed` at once: a later request's failure leaves it there.
 */
export async function collectDecode(
  open: OpenDecodeRequest,
  limits: DecodeLimits,
  opts: StreamCollectorOptions,
  completed?: CompletedRequests,
): Promise<DecodedResponse> {
  const requests: CollectedResponse[] = [];
  let token: string | undefined;
  for (;;) {
    const collected = await collectStream(await open(token), opts);
    completed?.record(collected.usageMetadata);
    requests.push(collected);
    token = nextContinuationToken(requests, limits);
    if (token === undefined) return mergeRequests(requests);
  }
}

/** The token to continue with, or `undefined` when the decode is over or has reached its limits. */
function nextContinuationToken(
  requests: readonly CollectedResponse[],
  limits: DecodeLimits,
): string | undefined {
  const last = requests[requests.length - 1];
  if (last === undefined || last.continuationToken === null) return undefined;
  if (last.candidates?.[0]?.finishReason !== FinishReason.CONTINUATION) return undefined;
  if (requests.length >= limits.maxRequests) return undefined;
  if (decodedTokens(requests) >= limits.cap) return undefined;
  return last.continuationToken;
}

/** The tokens the requests decoded so far: thinking and answer. */
function decodedTokens(requests: readonly CollectedResponse[]): number {
  let total = 0;
  for (const r of requests) {
    total +=
      (r.usageMetadata?.thoughtsTokenCount ?? 0) + (r.usageMetadata?.candidatesTokenCount ?? 0);
  }
  return total;
}

function mergeRequests(requests: readonly CollectedResponse[]): DecodedResponse {
  const first = requests[0];
  const last = requests[requests.length - 1];
  if (first === undefined || last === undefined)
    throw new Error('collectDecode: no request was collected');
  if (requests.length === 1) return { ...first, continuationHops: 0 };
  const thoughts = requests.flatMap((r) => (r.thoughtsSummary === null ? [] : [r.thoughtsSummary]));
  return {
    text: requests.map((r) => r.text).join(''),
    candidates: mergeCandidates(requests),
    usageMetadata: sumUsage(reportedUsage(requests)),
    thoughtsSummary:
      thoughts.length > 0 ? thoughts.join('\n').slice(0, THOUGHTS_SUMMARY_MAX_CHARS) : null,
    chunkCount: requests.reduce((n, r) => n + r.chunkCount, 0),
    firstChunkAt: first.firstChunkAt,
    lastChunkAt: last.lastChunkAt,
    continuationToken: last.continuationToken,
    continuationHops: requests.length - 1,
  };
}

/** The last request's candidates (its finish reason and metadata), each with the parts of every request. */
function mergeCandidates(requests: readonly CollectedResponse[]): CollectedResponse['candidates'] {
  const last = requests[requests.length - 1]?.candidates;
  if (last === undefined) return undefined;
  return last.map((cand, i) => {
    const index = cand.index ?? i;
    const parts: Part[] = requests.flatMap(
      (r) => r.candidates?.find((c, j) => (c.index ?? j) === index)?.content?.parts ?? [],
    );
    return {
      ...cand,
      content: { ...(cand.content ?? {}), role: cand.content?.role ?? 'model', parts },
    };
  });
}

function reportedUsage(requests: readonly CollectedResponse[]): DecodeUsage[] {
  return requests.flatMap((r) => (r.usageMetadata === undefined ? [] : [r.usageMetadata]));
}

/** Each counter summed over the usages reported; `undefined` when none was. */
function sumUsage(reported: readonly DecodeUsage[]): DecodeUsage | undefined {
  if (reported.length === 0) return undefined;
  const sum: DecodeUsage = {};
  for (const counter of USAGE_COUNTERS) {
    const values = reported.flatMap((u) => (typeof u[counter] === 'number' ? [u[counter]] : []));
    if (values.length > 0) sum[counter] = values.reduce((a, b) => a + b, 0);
  }
  return sum;
}
