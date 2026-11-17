/**
 * The budget ledger and TPM throttle calls of `ask_agentic`. Each pass (a loop iteration or the forced-finalization
 * pass) is an independent `generateContent` billable, so each is reserved and closed on its own, once, by `closePass`:
 * a pass whose model call completed — the stream reached its end, or `generateContent` returned — is booked at what it
 * billed (`recordBilledCall`, the rule of `ask` / `code` — its reservation finalised under a daily cap, a usage row
 * without one) and its TPM reservation released at the input it billed, whatever failed after the call (reading the
 * response, the tool batch, the iteration's timeout); a pass whose call did not complete (refused, failed at its
 * opening or mid-stream, aborted before its end) has both reservations cancelled. A ledger failure while settling is
 * logged, never thrown. A pass booked when it failed reports its billed fields in the error result, as a failed `ask`
 * / `code` call reports its completed requests'.
 */

import type { GenerateContentResponse } from '@google/genai';
import { abortableSleep } from '../../gemini/retry.js';
import { toMicrosUsd } from '../../utils/cost-estimator.js';
import type { ToolContext } from '../registry.js';
import {
  type BilledFields,
  type LedgerEntry,
  billedFields,
  billedInputTokens,
  billedUsage,
  recordBilledCall,
  releaseReservation,
} from '../shared/call-ledger.js';
import { type UsageCounts, usageCounts } from './response.js';
import type { AgenticRun } from './run.js';

export type BudgetReservation = ReturnType<ToolContext['manifest']['reserveBudget']>;

/** A TPM reservation id that was never taken. */
export const NO_THROTTLE_RESERVATION = -1;

/**
 * A pass's model call as far as it went: `completed` is set the moment the call completed (its work is billed), before
 * its response is read; `usage` holds the counts read from the response, zero until they are read.
 */
export interface PassCall {
  completed: boolean;
  usage: UsageCounts;
}

/** A pass's model call before it is made. */
export function callNotMade(): PassCall {
  return {
    completed: false,
    usage: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
  };
}

/**
 * Mark a pass's model call completed, then read its usage into it: the mark comes first, so a read that throws leaves
 * a call that is booked (at the estimate). Returns the usage read.
 */
export function completeCall(
  call: PassCall,
  usageMetadata: GenerateContentResponse['usageMetadata'],
): UsageCounts {
  call.completed = true;
  call.usage = usageCounts(usageMetadata);
  return call.usage;
}

/** A pass's reservations and when it started. */
export interface PassReservations {
  /** The daily-budget reservation; `null` without a daily cap. */
  reservationId: number | null;
  throttleReservationId: number;
  /** The input-token estimate both reservations were taken for. */
  estimate: number;
  startedAt: number;
}

/** Reserve one pass's estimated cost against the daily budget cap. */
export function reservePass(run: AgenticRun, costUsd: number): BudgetReservation {
  const { ctx } = run;
  return ctx.manifest.reserveBudget({
    workspaceRoot: run.workspaceRoot,
    toolName: 'ask_agentic',
    model: run.resolved.resolved,
    estimatedCostMicros: toMicrosUsd(costUsd),
    dailyBudgetMicros: toMicrosUsd(ctx.config.dailyBudgetUsd),
    nowMs: Date.now(),
  });
}

/**
 * Take a pass's TPM reservation for `inputTokens` and wait out its delay. The id is recorded in `holder`
 * before the wait, so a timeout firing during the wait (`abortableSleep` rejects with the pass's
 * TimeoutError) still finds it to cancel; `waitingLine` words the progress line from the seconds to wait.
 */
export async function waitForTpm(
  run: AgenticRun,
  holder: { throttleReservationId: number },
  inputTokens: number,
  signal: AbortSignal,
  waitingLine: (seconds: number) => string,
): Promise<void> {
  const reservation = run.ctx.throttle.reserve(run.resolved.resolved, inputTokens);
  holder.throttleReservationId = reservation.releaseId;
  if (reservation.delayMs > 0) {
    run.emitter.emit(waitingLine(Math.ceil(reservation.delayMs / 1000)));
    await abortableSleep(reservation.delayMs, signal);
  }
}

/** Release both reservations of a pass whose call never completed; `label` names the pass in the log. */
function cancelPass(ctx: ToolContext, pass: PassReservations, label: string): void {
  releaseReservation(ctx.manifest, label, pass.reservationId);
  if (pass.throttleReservationId !== NO_THROTTLE_RESERVATION) {
    ctx.throttle.cancel(pass.throttleReservationId);
  }
}

/** Where an `ask_agentic` pass is booked: it sends no cached content, so no caching mode is recorded. */
function ledgerEntryOf(run: AgenticRun): LedgerEntry {
  return {
    workspaceRoot: run.workspaceRoot,
    toolName: 'ask_agentic',
    model: run.resolved.resolved,
    serviceTier: undefined,
    cachingMode: null,
  };
}

/**
 * Close a pass, on every exit it has: settled as billed when its model call completed — its billed fields returned —,
 * both reservations cancelled when it did not (`null`). Called once per pass; `label` names the pass in the log.
 */
export function closePass(
  run: AgenticRun,
  pass: PassReservations,
  call: PassCall,
  label = 'ask_agentic',
): BilledFields | null {
  if (!call.completed) {
    cancelPass(run.ctx, pass, label);
    return null;
  }
  return settleBilledPass(run, pass, call.usage, label);
}

/**
 * Settle a pass whose API call completed (its tokens were billed, even when reading the response threw afterwards).
 * The input it billed is the prompt tokens it reported, else — a response without usage, or a read that threw before
 * the usage — the pass's estimate (`billedInputTokens`): under-billing a completed call is the worse error. A loop
 * iteration's estimate is a fixed 50,000 tokens, so such a booking can be below what the pass sent. The booking and the
 * TPM release use that one figure; the booking's `durationMs` is the pass's wall time; a booking that cannot be written
 * is logged by `recordBilledCall`. Returns the billed fields the result reports.
 */
function settleBilledPass(
  run: AgenticRun,
  pass: PassReservations,
  usage: UsageCounts,
  label: string,
): BilledFields {
  const billedInput = billedInputTokens(usage.promptTokenCount, pass.estimate);
  const billed = billedUsage(
    {
      promptTokenCount: billedInput,
      candidatesTokenCount: usage.candidatesTokenCount,
      thoughtsTokenCount: usage.thoughtsTokenCount,
    },
    run.resolved.resolved,
    undefined,
  );
  recordBilledCall(
    run.ctx.manifest,
    pass.reservationId,
    ledgerEntryOf(run),
    billed,
    Date.now() - pass.startedAt,
    label,
  );
  if (pass.throttleReservationId !== NO_THROTTLE_RESERVATION) {
    run.ctx.throttle.release(pass.throttleReservationId, billedInput);
  }
  return billedFields(billed);
}
