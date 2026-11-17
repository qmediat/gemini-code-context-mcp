/**
 * How an `ask` / `code` call settles — the one place both tools do it, so they book the same way and return the same
 * fields.
 *
 * - An answer: the ledger books every completed request at what it billed (best-effort: a failed write is logged, the
 *   answer is returned); a stop at the output cap with no text is an `OUTPUT_CAP` error with the usage, the model,
 *   the tier and the finish reason.
 * - A failure: a 429's retry hint seeds the per-minute throttle, the ledger keeps what the completed requests billed
 *   and releases the rest (all of it when none completed), and the request's per-minute reservation is dropped.
 */

import type { InputWindowCut } from '../../gemini/long-decode.js';
import type { ManifestDb } from '../../manifest/db.js';
import {
  type FailedCall,
  type LedgerEntry,
  type UsageFields,
  billedUsage,
  recordBilledCall,
  settleFailedCall,
  usageFields,
} from './call-ledger.js';
import type { CompletedRequests, DecodedResponse } from './continuation.js';
import type { DispatchThrottle } from './dispatch-throttle.js';
import {
  type AnswerFinish,
  type CapThatRan,
  OUTPUT_CAP_ERROR_CODE,
  answerFinish,
  emptyAtOutputCap,
} from './thinking.js';
import { type TpmThrottle, seedRetryHint } from './throttle.js';

/** A call whose decode answered. */
export interface AnsweredCall {
  readonly manifest: ManifestDb;
  readonly reservationId: number | null;
  /** The booking: the tool, the model, the tier, the caching mode that ran. */
  readonly entry: LedgerEntry;
  readonly completed: CompletedRequests;
  readonly response: DecodedResponse;
  /** The cap the decode ran under. */
  readonly cap: CapThatRan;
  /** The cut the model's input window made to the caller's cap; `null`: none. */
  readonly cut: InputWindowCut | null;
  readonly durationMs: number;
}

/** A stop at the output cap with no answer: the message (without the tool's prefix) and the result's fields. */
export interface OutputCapStop {
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface SettledAnswer {
  /** What the call billed, for the result. */
  readonly usage: UsageFields;
  readonly finish: AnswerFinish;
  /** The input-window cut as a result field (`outputCapCutByInputWindow`), or nothing. */
  readonly cutFields: Readonly<Record<string, unknown>>;
  /** Set when the call stopped at the cap before writing an answer: the caller returns it as an error. */
  readonly outputCapStop: OutputCapStop | null;
}

/**
 * Book the answered call at what its requests billed, and say whether it stopped at the cap with no answer. The booking
 * is best-effort (`recordBilledCall` logs a failed write and never throws): the paid answer is returned whatever the
 * ledger does.
 */
export function settleAnswer(call: AnsweredCall): SettledAnswer {
  const billed = billedUsage(call.completed.usage(), call.entry.model, call.entry.serviceTier);
  recordBilledCall(call.manifest, call.reservationId, call.entry, billed, call.durationMs);
  const usage = usageFields(billed, call.response.continuationHops);
  const finish = answerFinish(call.response);
  const cutFields = inputWindowCutFields(call.cut);
  const starved = emptyAtOutputCap(call.response, billed.thinkingTokens, call.cap, call.cut);
  const outputCapStop =
    starved === null
      ? null
      : {
          message: starved,
          fields: {
            errorCode: OUTPUT_CAP_ERROR_CODE,
            retryable: false,
            resolvedModel: call.entry.model,
            serviceTier: call.entry.serviceTier,
            finishReason: finish.finishReason,
            ...usage,
            ...cutFields,
          },
        };
  return { usage, finish, cutFields, outputCapStop };
}

function inputWindowCutFields(cut: InputWindowCut | null): Readonly<Record<string, unknown>> {
  return cut === null ? {} : { outputCapCutByInputWindow: cut };
}

/** A call that failed, with what its failure path settles. */
export interface FailedCallSettlement {
  readonly manifest: ManifestDb;
  readonly failed: FailedCall;
  readonly err: unknown;
  /** The resolved model a 429's retry hint is recorded for; `null` before the model was resolved. */
  readonly model: string | null;
  readonly throttle: Pick<TpmThrottle, 'recordRetryHint'>;
  readonly dispatch: DispatchThrottle;
}

/**
 * Settle a failed call; its usage when completed requests were billed, else `null`. A 429's retry hint seeds the
 * throttle through `seedRetryHint`, once per error. A ledger write that throws is logged by `recordBilledCall` /
 * `settleFailedCall` and never replaces the call's own error.
 */
export function settleFailure(settlement: FailedCallSettlement): UsageFields | null {
  const { err, model } = settlement;
  if (model !== null) {
    seedRetryHint(settlement.throttle, model, err);
  }
  const usage = settleFailedCall(settlement.manifest, settlement.failed);
  settlement.dispatch.cancel();
  return usage;
}
