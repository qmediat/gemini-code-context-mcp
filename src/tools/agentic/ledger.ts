/**
 * The budget ledger and TPM throttle calls of `ask_agentic`. Each pass (a loop iteration or the forced-finalization
 * pass) is an independent `generateContent` billable, so each is reserved and settled on its own: a pass that reached
 * Google is booked at what it billed (`recordBilledCall`, the rule of `ask` / `code` — its reservation finalised under
 * a daily cap, a usage row without one) and its TPM reservation released at the input it billed; a pass that never
 * did has both reservations cancelled. A ledger failure while settling is logged, never thrown.
 */

import { abortableSleep } from '../../gemini/retry.js';
import { toMicrosUsd } from '../../utils/cost-estimator.js';
import { logger, safeForLog } from '../../utils/logger.js';
import type { ToolContext } from '../registry.js';
import {
  type LedgerEntry,
  billedInputTokens,
  billedUsage,
  recordBilledCall,
} from '../shared/call-ledger.js';
import type { UsageCounts } from './response.js';
import type { AgenticRun } from './run.js';

export type BudgetReservation = ReturnType<ToolContext['manifest']['reserveBudget']>;

/** A TPM reservation id that was never taken. */
export const NO_THROTTLE_RESERVATION = -1;

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

/** Release both reservations of a pass that never reached Google's billing; `label` names the pass in the log. */
export function cancelPass(
  ctx: ToolContext,
  reservationId: number | null,
  throttleReservationId: number,
  label: string,
): void {
  if (reservationId !== null) {
    try {
      ctx.manifest.cancelBudgetReservation(reservationId);
    } catch (cancelErr) {
      logger.error(`${label}: cancelBudgetReservation failed: ${safeForLog(cancelErr)}`);
    }
  }
  if (throttleReservationId !== NO_THROTTLE_RESERVATION) {
    ctx.throttle.cancel(throttleReservationId);
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
 * Settle a pass whose API call returned (its tokens were billed, even when reading the response threw afterwards).
 * The input it billed is the prompt tokens it reported, else — a response without usage, or a read that threw before
 * the usage — the pass's estimate (`billedInputTokens`): under-billing a completed call is the worse error, and the
 * estimate keeps the daily cap and the TPM window a bound. The booking and the TPM release use that one figure; the
 * booking's `durationMs` is the pass's wall time.
 */
export function settleBilledPass(
  run: AgenticRun,
  pass: PassReservations,
  usage: UsageCounts,
  label = 'ask_agentic',
): void {
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
  try {
    recordBilledCall(
      run.ctx.manifest,
      pass.reservationId,
      ledgerEntryOf(run),
      billed,
      Date.now() - pass.startedAt,
      label,
    );
  } catch (recordErr) {
    logger.error(
      `ask_agentic: the usage of a billed pass could not be recorded: ${safeForLog(recordErr)}`,
    );
  }
  if (pass.throttleReservationId !== NO_THROTTLE_RESERVATION) {
    run.ctx.throttle.release(pass.throttleReservationId, billedInput);
  }
}
