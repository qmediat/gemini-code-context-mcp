/**
 * The machinery of one `ask` / `code` call and its failure path — the one place both tools open, settle on a failure
 * and close a call.
 *
 * - Opened before the call's first await: the progress emitter, then the timeout controller (its total timer arms at
 *   once, its stall timer at the first chunk), then the per-request TPM throttle on the controller's signal.
 * - One tracking object, one completed-request accumulator, one dispatch throttle and one failure trail live through
 *   the whole call: every step writes into them the moment it has a value, the failure path reads them.
 * - A failure is settled first (the error line, a 429's retry hint, the ledger, the TPM reservation dropped), then
 *   classified (a timeout's progress line); each tool builds its result from the classification, in its own order.
 */

import { logger, safeForLog } from '../../utils/logger.js';
import { type ProgressEmitter, createProgressEmitter } from '../../utils/progress.js';
import type { ToolContext } from '../registry.js';
import {
  type TimedOutCall,
  type TimedTool,
  type TimeoutController,
  type ToolTimeoutKnobs,
  isTimeoutAbort,
  timedOutCall,
  toolTimeoutController,
} from './abort-timeout.js';
import type { UsageFields } from './call-ledger.js';
import type { DecodeTracking } from './context-decode.js';
import { CompletedRequests } from './continuation.js';
import { DispatchThrottle } from './dispatch-throttle.js';
import {
  type ServiceTierName,
  type TierErrorMeta,
  statusOf,
  tierErrorMeta,
} from './service-tier.js';
import { settleFailure } from './settle-call.js';

/** What the failure path reports of the model: written once the model and its tier resolved. */
export interface ModelReached {
  readonly resolvedModel: string;
  readonly serviceTier: ServiceTierName;
}

/** What a call's failure path reads besides the decode's tracking: each field written by its step the moment its
 * value exists. */
export interface FailureTrail<M extends ModelReached> {
  /** The daily-budget reservation held: set as soon as `reserveBudget` returned its id; cleared before the answer is
   * booked, and by the failure path. */
  reservationId: number | null;
  /** Set once the model and its tier resolved; `null` before: no retry hint is seeded, the requested tier is
   * reported. */
  model: M | null;
}

/** What opens a call. */
export interface EagerCallRequest {
  readonly tool: TimedTool;
  /** The per-call `timeoutMs` / `stallMs`; an unset one falls back to the tool's env var. */
  readonly knobs: ToolTimeoutKnobs;
  /** The tier asked for (per call, else the configured one): what a failure reports before the model resolved. */
  readonly requestedTier: ServiceTierName;
  readonly workspaceRoot: string;
  readonly started: number;
}

/** The machinery of one `ask` / `code` call, created before its first await. */
export interface EagerCall<M extends ModelReached> {
  readonly tool: TimedTool;
  readonly workspaceRoot: string;
  readonly started: number;
  readonly requestedTier: ServiceTierName;
  readonly emitter: ProgressEmitter;
  readonly timeout: TimeoutController;
  readonly dispatch: DispatchThrottle;
  /** Every request that completed is billed: the ledger settles from these, on an answer and on a failure alike. */
  readonly completed: CompletedRequests;
  /** The running decode's booking and whether a stream opened (a later failure is then billed work, not re-sent). */
  readonly tracking: DecodeTracking;
  readonly trail: FailureTrail<M>;
}

interface FailureCommon<M extends ModelReached> {
  /** What the completed requests billed; `null` when no decode started, none of its requests completed, or the call
   * failed after its answer was settled (the decode's entry was cleared then). */
  readonly usage: UsageFields | null;
  /** The trail's model at the failure; `null` before the model resolved. */
  readonly model: M | null;
  readonly requestedTier: ServiceTierName;
}

/** A call its controller aborted: the progress line `<tool>: aborted after …` is emitted. */
export interface TimedOutEagerCall<M extends ModelReached> extends FailureCommon<M> {
  readonly kind: 'timeout';
  /** The limit that fired and its message. */
  readonly timedOut: TimedOutCall;
  /** Both knobs of the controller, whichever fired: the result reports both. */
  readonly timeoutMs: number | null;
  readonly stallMs: number | null;
}

/** A call that failed otherwise. */
export interface ErroredEagerCall<M extends ModelReached> extends FailureCommon<M> {
  readonly kind: 'error';
  /** `<tool> failed: <message>`. */
  readonly message: string;
  readonly tierMeta: TierErrorMeta;
  readonly httpStatus: number | undefined;
}

/** A failed call, settled and classified. */
export type FailedEagerCall<M extends ModelReached> = TimedOutEagerCall<M> | ErroredEagerCall<M>;

/** Open a call: synchronous, so the controller exists before the call's first await. */
export function openEagerCall<M extends ModelReached>(
  request: EagerCallRequest,
  ctx: ToolContext,
): EagerCall<M> {
  const completed = new CompletedRequests();
  const tracking: DecodeTracking = { ledgerEntry: null, streamOpened: false };
  const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
  const timeout = toolTimeoutController(request.tool, request.knobs);
  // Each request of the decode holds its own TPM reservation; a failure drops the one held.
  const dispatch = new DispatchThrottle({
    throttle: ctx.throttle,
    enabled: ctx.config.tpmThrottleLimit > 0,
    signal: timeout.signal,
    emit: (message) => emitter.emit(message),
  });
  return {
    tool: request.tool,
    workspaceRoot: request.workspaceRoot,
    started: request.started,
    requestedTier: request.requestedTier,
    emitter,
    timeout,
    dispatch,
    completed,
    tracking,
    trail: { reservationId: null, model: null },
  };
}

/**
 * Settle a failed call, then classify it. A 429's retry hint seeds the throttle once the model resolved; the ledger
 * keeps what the completed requests billed and releases the rest of the reservation (all of it when none completed);
 * the TPM reservation held is dropped. A timeout's progress line follows the settlement.
 */
export function settleFailedEager<M extends ModelReached>(
  call: EagerCall<M>,
  ctx: ToolContext,
  err: unknown,
): FailedEagerCall<M> {
  logger.error(`${call.tool} failed: ${safeForLog(err)}`);
  const usage = settleFailure({
    manifest: ctx.manifest,
    failed: {
      toolName: call.tool,
      reservationId: call.trail.reservationId,
      entry: call.tracking.ledgerEntry,
      completed: call.completed,
      durationMs: Date.now() - call.started,
    },
    err,
    model: call.trail.model?.resolvedModel ?? null,
    throttle: ctx.throttle,
    dispatch: call.dispatch,
  });
  call.trail.reservationId = null;
  const common = { usage, model: call.trail.model, requestedTier: call.requestedTier };
  if (isTimeoutAbort(err)) return timedOutFailure(call, err, common);
  return {
    kind: 'error',
    ...common,
    message: `${call.tool} failed: ${err instanceof Error ? err.message : String(err)}`,
    tierMeta: tierErrorMeta(err, call.tracking.streamOpened),
    httpStatus: statusOf(err),
  };
}

/** The timeout of a call: the limit that fired, said on the progress channel, and both knobs of its controller. */
function timedOutFailure<M extends ModelReached>(
  call: EagerCall<M>,
  err: unknown,
  common: FailureCommon<M>,
): TimedOutEagerCall<M> {
  const timedOut = timedOutCall(call.tool, err, call.timeout);
  call.emitter.emit(`${call.tool}: aborted after ${timedOut.limitMs ?? '?'}ms ${timedOut.kind}`);
  return {
    kind: 'timeout',
    ...common,
    timedOut,
    timeoutMs: call.timeout.timeoutMs,
    stallMs: call.timeout.stallMs,
  };
}

/** Close a call, on every path: the controller disposed, then the emitter stopped. */
export function closeEagerCall(call: EagerCall<ModelReached>): void {
  call.timeout.dispose();
  call.emitter.stop();
}
