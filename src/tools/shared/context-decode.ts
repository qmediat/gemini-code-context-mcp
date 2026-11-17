/**
 * The decode of an `ask` / `code` call on its prepared context — the one place both tools run it.
 *
 * - Ledger: the booking of the running decode stays in `tracking`, which the call's failure path reads.
 * - Cache: before each request is sent, the cache the decode reads is marked hot and, when it expires within the
 *   watcher's refresh window (15 minutes), extended at once (`TtlWatcher.keepAlive`) — so no request of a decode
 *   (minutes each: 188–241 s measured) is sent on a cache that expires before it ends; the watcher's own tick only
 *   refreshes caches used in its last 10 minutes, every 5.
 * - Throttle: each request holds its own TPM reservation (`DispatchThrottle`).
 * - Stall watchdog: paused when a request's stream ends; the next request's first chunk re-arms it.
 * - Stale cache: a cache Gemini rejects is rebuilt and the decode run again ONCE, only while no request of the decode
 *   has completed. After a completed request the error goes to the caller with the completed requests booked: a
 *   restart would bill the whole decode again under a budget reservation sized for one decode.
 */

import type { GenerateContentConfig, GenerateContentParameters, GoogleGenAI } from '@google/genai';
import {
  type PreparedContext,
  isStaleCacheError,
  markCacheStale,
} from '../../cache/cache-manager.js';
import type { RanCachingMode } from '../../cache/caching-mode.js';
import type { TtlWatcher } from '../../cache/ttl-watcher.js';
import type { ManifestDb } from '../../manifest/db.js';
import { logger } from '../../utils/logger.js';
import { type TimeoutController, isTimeoutAbort } from './abort-timeout.js';
import type { LedgerEntry } from './call-ledger.js';
import {
  type CompletedRequests,
  type DecodeCall,
  type DecodeLimits,
  type DecodedResponse,
  runDecode,
} from './continuation.js';
import type { DispatchThrottle } from './dispatch-throttle.js';
import { statusOf } from './service-tier.js';

/** What the call's failure path reads of its running decode. */
export interface DecodeTracking {
  /** The booking of the running decode; `null` before one starts and once the call has settled. */
  ledgerEntry: LedgerEntry | null;
  /** A request's stream opened: a later transport failure is mid-stream, billed work. */
  streamOpened: boolean;
}

/** The request of a decode on one prepared context. */
export interface ContextRequest {
  readonly contents: GenerateContentParameters['contents'];
  readonly config: GenerateContentConfig;
}

/** The workspace cache a decode reads, and who keeps it alive. */
export interface CacheUpkeep {
  readonly ttlWatcher: Pick<TtlWatcher, 'markHot' | 'keepAlive'>;
  readonly manifest: ManifestDb;
  readonly ttlSeconds: number;
  /** Builds the context again (on a fresh cache): the call's own `prepareContext`. */
  readonly prepare: () => Promise<PreparedContext>;
}

export interface ContextDecodeCall {
  readonly client: GoogleGenAI;
  /** The call's booking but its caching mode, which is the prepared context's. */
  readonly booking: Omit<LedgerEntry, 'cachingMode'>;
  readonly cachingMode: (prep: PreparedContext) => RanCachingMode;
  readonly request: (prep: PreparedContext) => ContextRequest;
  readonly cache: CacheUpkeep;
  /** Attempts to OPEN each request (`networkAttempts` of the tier). */
  readonly openAttempts: number;
  readonly limits: DecodeLimits;
  readonly timeout: TimeoutController;
  /** The call's progress channel. */
  readonly emit: (message: string) => void;
  readonly completed: CompletedRequests;
  readonly tracking: DecodeTracking;
  readonly throttle: DispatchThrottle;
  /** The first request's input estimate: what its throttle reservation holds. */
  readonly estimatedInputTokens: number;
}

export interface ContextDecode {
  readonly response: DecodedResponse;
  /** The context the answer was decoded on: the prepared one, or the one rebuilt after a stale cache. */
  readonly prep: PreparedContext;
  readonly retriedOnStaleCache: boolean;
}

/** Decode on `initial`; on a stale cache before any request completed, once more on a rebuilt context. */
export async function decodeOnContext(
  call: ContextDecodeCall,
  initial: PreparedContext,
): Promise<ContextDecode> {
  await call.throttle.reserve(call.booking.model, call.estimatedInputTokens);
  let decoded: ContextDecode;
  try {
    const response = await decodeOn(call, initial, call.booking.toolName);
    decoded = { response, prep: initial, retriedOnStaleCache: false };
  } catch (err) {
    if (!initial.cacheId || !isStaleCacheError(err)) throw err;
    decoded = await retryOnFreshCache(call, initial.cacheId, err);
  }
  // used just now: the watcher keeps it warm for the calls that follow
  if (decoded.prep.cacheId) {
    call.cache.ttlWatcher.markHot(
      call.booking.workspaceRoot,
      decoded.prep.cacheId,
      call.cache.ttlSeconds,
    );
  }
  return decoded;
}

/**
 * A request is about to be sent on `prep`: its cache, if it reads one, is kept alive for it — under the call's
 * signal, so a timeout during the refresh ends the call as a timeout before the request is opened.
 */
async function keepAlive(call: ContextDecodeCall, prep: PreparedContext): Promise<void> {
  if (!prep.cacheId) return;
  await call.cache.ttlWatcher.keepAlive(
    call.booking.workspaceRoot,
    prep.cacheId,
    call.cache.ttlSeconds,
    call.timeout.signal,
  );
}

async function decodeOn(
  call: ContextDecodeCall,
  prep: PreparedContext,
  label: string,
): Promise<DecodedResponse> {
  call.tracking.ledgerEntry = { ...call.booking, cachingMode: call.cachingMode(prep) };
  await keepAlive(call, prep);
  const { contents, config } = call.request(prep);
  return runDecode({
    client: call.client,
    model: call.booking.model,
    contents,
    config,
    openAttempts: call.openAttempts,
    label,
    limits: call.limits,
    collector: collectorOf(call),
    onRequestOpened: () => {
      call.tracking.streamOpened = true;
    },
    completed: call.completed,
    beforeReopen: () => call.throttle.renew(),
    hooks: {
      firstRequestInput: call.estimatedInputTokens,
      afterRequest: (usage) => {
        call.timeout.pauseStall();
        call.throttle.settle(usage?.promptTokenCount);
      },
      beforeContinuation: async (inputTokens) => {
        await keepAlive(call, prep);
        await call.throttle.reserve(call.booking.model, inputTokens);
      },
    },
  });
}

/** The collector of every request: the call's signal, its thinking on the progress channel, the stall watchdog. */
function collectorOf(call: ContextDecodeCall): DecodeCall['collector'] {
  return {
    signal: call.timeout.signal,
    // The model's reasoning surfaces live, throttled by the collector so the progress channel is not flooded.
    onThoughtChunk: (text) => {
      const trimmed = text.trim().slice(0, 80);
      if (trimmed.length > 0) call.emit(`thinking: ${trimmed}…`);
    },
    // Every chunk (text or thought) of every request proves the stream alive.
    onChunkReceived: () => call.timeout.recordChunk(),
  };
}

async function retryOnFreshCache(
  call: ContextDecodeCall,
  staleCacheId: string,
  staleErr: unknown,
): Promise<ContextDecode> {
  const tool = call.booking.toolName;
  const completedInDecode = call.completed.completedInLatestDecode;
  if (completedInDecode > 0) {
    markCacheStale({ manifest: call.cache.manifest, workspaceRoot: call.booking.workspaceRoot });
    throw new Error(
      `${tool}: the context cache ${staleCacheId} expired during a long decode, after ${completedInDecode} completed request(s); the decode is not restarted (a restart would bill every request again). The completed requests are billed and reported; call again to build a fresh cache.`,
      { cause: staleErr },
    );
  }
  logger.warn(`Gemini rejected cached content ${staleCacheId}; invalidating and retrying once.`);
  try {
    // The pointer only: the file rows stay, so the rebuild reuses uploaded files by content hash.
    markCacheStale({ manifest: call.cache.manifest, workspaceRoot: call.booking.workspaceRoot });
    const rebuilt = await call.cache.prepare();
    // A fresh reservation, stamped when the retry is sent.
    await call.throttle.reserve(call.booking.model, call.estimatedInputTokens);
    const response = await decodeOn(call, rebuilt, `${tool} (stale-cache retry)`);
    return { response, prep: rebuilt, retriedOnStaleCache: true };
  } catch (retryErr) {
    throw retryFailure(tool, retryErr, staleErr);
  }
}

/**
 * The error of a failed stale-cache retry: a timeout and an HTTP error (a 429 / 503, whose status and retry hint the
 * caller reads) as they came; anything else wrapped over the stale-cache error, which stays its cause.
 */
function retryFailure(tool: string, retryErr: unknown, staleErr: unknown): unknown {
  if (isTimeoutAbort(retryErr) || statusOf(retryErr) !== undefined) return retryErr;
  return new Error(
    `${tool} retry after stale cache failed: ${
      retryErr instanceof Error ? retryErr.message : String(retryErr)
    }`,
    { cause: staleErr },
  );
}
