/**
 * One decode over one or more requests (Gemini 4 long decode, `src/gemini/long-decode.ts`).
 *
 * A request that stops with `finishReason: CONTINUATION` and a continuation token is followed by the same request
 * with `continuationToken` set to the latest token — the payload is never changed and the text decoded so far is
 * never appended to it. Every request is sent with `automaticContinuation: false`, so the SDK hands each request's
 * end back here: this loop counts the requests, stops at the cap the budget reservation assumed, and
 * never re-sends a request that already streamed (billed) work.
 *
 * The requests share the caller's abort signal and chunk callback, so `timeoutMs` covers the whole decode and the
 * stall watchdog every gap between two chunks of a request; the caller's `afterRequest` hook pauses the watchdog
 * between requests, as before the first. A request that made no progress (the same token again, nothing decoded)
 * is not continued. The result is ONE response: the text and thought summary of every request in order, the usage
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
import { abortableSleep, withNetworkRetry } from '../../gemini/retry.js';
import { logger } from '../../utils/logger.js';
import { billedInputTokens } from './call-ledger.js';
import { statusOf } from './service-tier.js';
import {
  type CollectedResponse,
  type StreamCollectorOptions,
  THOUGHTS_SUMMARY_MAX_CHARS,
  collectStream,
} from './stream-collector.js';
import { isGemini429, parseRetryDelayMs } from './throttle.js';

/** The long-decode sentences of the `maxOutputTokens` description of `ask` and `code`. */
export const LONG_DECODE_CAP_DESCRIPTION =
  "On a model with long decode (Gemini 4: Argon, Carbon, Hydrogen) a value above its per-request limit is sent up to 1,048,576: a response that reaches the per-request limit continues in further requests until the model stops or the cap is reached, and the result's `continuationHops` counts them. Each continuation request bills the prompt again plus everything decoded before it, so a long decode costs more than one request; the budget reservation counts that input too. Use it when a high thinking level leaves no room for the answer (`errorCode: 'OUTPUT_CAP'`, thinking tokens count against the cap). An answer cut at the cap comes back with `truncated: true` and its `finishReason`.";

/** One request's stream, as the SDK opens it. */
type DecodeStream = AsyncGenerator<GenerateContentResponse>;

/** Opens one request of the decode: the first with no token, each continuation with the latest one. */
export type OpenDecodeRequest = (continuationToken: string | undefined) => Promise<DecodeStream>;

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
  /**
   * SDK calls that OPEN each request (a failure before any response), network retries and reopenings after a refusal
   * together; a stream that opened is never re-sent.
   */
  readonly openAttempts: number;
  /** The log prefix of a retried opening (`ask`, `code (stale-cache retry)`). */
  readonly label: string;
  readonly limits: DecodeLimits;
  /** The abort signal (required: it reaches every request), the thought and chunk callbacks. */
  readonly collector: StreamCollectorOptions & { readonly signal: AbortSignal };
  /** Called each time a request's stream opened: from then on its work is billed. */
  readonly onRequestOpened: () => void;
  /** The call's record of its requests, kept across its decodes and its failures. */
  readonly completed: CompletedRequests;
  /** What the caller does between the requests (`DecodeHooks`, its `completed` is the one above). */
  readonly hooks?: Omit<DecodeHooks, 'completed'>;
  /**
   * A refused continuation request is about to be reopened, its wait over: what the request holds for the window it
   * is sent in (the per-minute reservation) is taken again. A rejection ends the decode before the reopening.
   */
  readonly beforeReopen?: () => Promise<void>;
}

/** What runs between the requests of a decode. */
export interface DecodeHooks {
  /**
   * The input the decode's first request is estimated to send: a request that reports no usage is billed at it, plus
   * the tokens decoded before the request (`billedInputTokens`).
   */
  readonly firstRequestInput?: number;
  /** The call's record of its requests: each one that streamed to its end goes in at once. */
  readonly completed?: CompletedRequests;
  /** A request streamed to its end, with the usage it reported. */
  readonly afterRequest?: (usage: DecodeUsage | undefined) => void;
  /**
   * A continuation request is about to open, with the input it sends: the first request's prompt plus every token
   * decoded so far. It may wait (the per-minute window); a rejection ends the decode before the request is sent.
   */
  readonly beforeContinuation?: (inputTokens: number) => Promise<void>;
}

/** The usage a request reports for itself. */
export type DecodeUsage = NonNullable<GenerateContentResponse['usageMetadata']>;

/**
 * Every request of one call that streamed to its end. Each one is billed whatever becomes of the call — an answer,
 * a later request that fails, a stale-cache retry that starts a new decode — so the call settles its ledger from
 * here, never from the answer alone. A request that reported no input is billed at the input it was estimated to
 * send (`billedInputTokens`).
 */
export class CompletedRequests {
  private readonly billed: DecodeUsage[] = [];
  private total = 0;
  private completedInDecode = 0;
  private sentInDecode = 0;

  /** A new decode of the call starts: its requests are counted from zero. */
  beginDecode(): void {
    this.completedInDecode = 0;
    this.sentInDecode = 0;
  }

  /** A request of the latest decode went to the API (its stream opened or the API refused it). */
  sent(): void {
    this.sentInDecode += 1;
  }

  /** A request streamed to its end with `usage`; `inputEstimate` is the input it was estimated to send. */
  record(usage: DecodeUsage | undefined, inputEstimate: number): void {
    const promptTokenCount = billedInputTokens(usage?.promptTokenCount, inputEstimate);
    this.billed.push({ ...usage, promptTokenCount });
    this.total += 1;
    this.completedInDecode += 1;
  }

  /** The requests of the call that completed, over all its decodes. */
  get count(): number {
    return this.total;
  }

  /** The requests of the latest decode that completed. */
  get completedInLatestDecode(): number {
    return this.completedInDecode;
  }

  /**
   * The continuation requests the latest decode sent: every request that went to the API, but the first — whether
   * the decode answered, failed in a request, or stopped before the next request was sent.
   */
  continuationHops(): number {
    return Math.max(0, this.sentInDecode - 1);
  }

  /** Each counter summed over the completed requests that have it; `undefined` before any request completed. */
  usage(): DecodeUsage | undefined {
    return sumUsage(this.billed);
  }
}

/**
 * Run the decode: each request opens through `withNetworkRetry` (only the opening is retried — a mid-stream
 * failure would bill the work again), a continuation request refused at its opening is reopened with the same token
 * (`reopenRefused`), and the requests are collected into one response.
 */
export function runDecode(call: DecodeCall): Promise<DecodedResponse> {
  const open: OpenDecodeRequest = async (continuationToken) => {
    const budget = new OpeningBudget(call.openAttempts);
    const send = (): Promise<DecodeStream> => sendRequest(call, continuationToken, budget);
    try {
      const stream =
        continuationToken === undefined ? await send() : await reopenRefused(send, call, budget);
      call.onRequestOpened();
      return stream;
    } finally {
      // Counted once per request, however many attempts its opening took; a request never sent is not counted.
      if (budget.spent > 0) call.completed.sent();
    }
  };
  call.completed.beginDecode();
  return collectDecode(open, call.limits, call.collector, {
    ...call.hooks,
    completed: call.completed,
  });
}

/**
 * The SDK calls one request's opening may still make: the network retries of every attempt and the reopenings after a
 * refusal draw on the same `openAttempts`.
 */
class OpeningBudget {
  private used = 0;

  constructor(private readonly attempts: number) {}

  spend(): void {
    this.used += 1;
  }

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.attempts - this.used);
  }
}

/** Open one request with the calls `budget` has left; each call that goes to the SDK is spent from it. */
function sendRequest(
  call: DecodeCall,
  continuationToken: string | undefined,
  budget: OpeningBudget,
): Promise<DecodeStream> {
  const signal = call.collector.signal;
  return withNetworkRetry(
    () => {
      budget.spend();
      return call.client.models.generateContentStream({
        model: call.model,
        contents: call.contents,
        config: {
          ...call.config,
          automaticContinuation: false,
          ...(continuationToken !== undefined ? { continuationToken } : {}),
          abortSignal: signal,
        },
      });
    },
    {
      attempts: budget.remaining,
      signal,
      onRetry: (attempt, err) => logRetry(call.label, attempt, err),
    },
  );
}

function logRetry(label: string, attempt: number, err: unknown): void {
  logger.warn(
    `${label}: retrying generateContent after transient network failure (attempt ${attempt}): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

/**
 * The statuses a request is refused with at its opening, before any of it is billed: a quota (429) and an
 * overloaded server (503).
 */
const REFUSED_AT_OPENING: ReadonlySet<number> = new Set([429, 503]);

/** The wait before the first reopening when Google sent no retry hint; each further one waits three times longer. */
const REOPEN_BASE_WAIT_MS = 2_000;

/**
 * Open a continuation request; a 429 or 503 at its opening (nothing of it billed yet) waits Google's retry hint, else
 * the base wait, takes its per-minute reservation again (`beforeReopen`) and reopens with the same token — while the
 * request's opening budget lasts (`openAttempts` SDK calls, network retries included), every wait abortable by the
 * call's signal (`timeoutMs`). A refused first request is not reopened: nothing of the call is billed yet, and the
 * caller sees the 429 / 503 as before.
 */
async function reopenRefused(
  send: () => Promise<DecodeStream>,
  call: DecodeCall,
  budget: OpeningBudget,
): Promise<DecodeStream> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      const status = statusOf(err);
      if (status === undefined || !REFUSED_AT_OPENING.has(status) || budget.remaining === 0)
        throw err;
      const waitMs =
        (isGemini429(err) ? parseRetryDelayMs(err.message) : null) ?? reopenWaitMs(attempt);
      logger.warn(
        `${call.label}: continuation request refused at its opening (HTTP ${status}); reopening with the same token in ${waitMs} ms (attempt ${attempt})`,
      );
      await abortableSleep(waitMs, call.collector.signal);
      await call.beforeReopen?.();
    }
  }
}

function reopenWaitMs(attempt: number): number {
  return REOPEN_BASE_WAIT_MS * 3 ** (attempt - 1);
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
  hooks: DecodeHooks = {},
): Promise<DecodedResponse> {
  const requests: CollectedResponse[] = [];
  const firstInput = hooks.firstRequestInput ?? 0;
  let input = firstInput;
  let token: string | undefined;
  for (;;) {
    const collected = await collectStream(await open(token), opts);
    hooks.completed?.record(collected.usageMetadata, input);
    hooks.afterRequest?.(collected.usageMetadata);
    requests.push(collected);
    const next = nextContinuationToken(requests, token, limits);
    if (next === undefined) return mergeRequests(requests);
    input = continuationInput(requests, firstInput);
    await hooks.beforeContinuation?.(input);
    token = next;
  }
}

/**
 * The token to continue with, or `undefined` when the decode is over, has reached its limits, or made no progress
 * in its last request.
 */
function nextContinuationToken(
  requests: readonly CollectedResponse[],
  openedWith: string | undefined,
  limits: DecodeLimits,
): string | undefined {
  const last = requests[requests.length - 1];
  if (last === undefined || last.continuationToken === null) return undefined;
  if (last.candidates?.[0]?.finishReason !== FinishReason.CONTINUATION) return undefined;
  if (requests.length >= limits.maxRequests) return undefined;
  if (decodedTokens(requests) >= limits.cap) return undefined;
  if (!madeProgress(last, openedWith)) return undefined;
  return last.continuationToken;
}

/**
 * A request that stopped with CONTINUATION moved the decode on: it returned a token other than the one it was opened
 * with and decoded at least one token. Replaying the same token, or a request that decoded nothing, would only bill
 * the whole input again for the same stop.
 */
function madeProgress(request: CollectedResponse, openedWith: string | undefined): boolean {
  const decoded = decodedTokens([request]);
  if (request.continuationToken !== openedWith && decoded > 0) return true;
  logger.warn(
    `long decode: a request stopped with CONTINUATION ${
      decoded > 0 ? 'and returned the token it was opened with' : 'having decoded no token'
    }; the decode stops there`,
  );
  return false;
}

/**
 * The input a continuation request sends: the first request's prompt (its estimate when it reported none) plus every
 * token decoded so far.
 */
function continuationInput(requests: readonly CollectedResponse[], firstInput: number): number {
  const prompt = billedInputTokens(requests[0]?.usageMetadata?.promptTokenCount, firstInput);
  return prompt + decodedTokens(requests);
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
