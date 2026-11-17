/**
 * The budget ledger and TPM throttle calls of `ask_agentic`. Each pass (a loop iteration or the forced-finalization
 * pass) is an independent `generateContent` billable, so each gets its own reservation and settles it: a pass that
 * reached Google is booked at what it billed and its TPM reservation released at the input it sent; a pass that never
 * did has both reservations cancelled. A ledger failure while settling is logged, never thrown. A Gemini 429's retry
 * hint seeds the throttle once per error, whichever catch meets it first.
 */

import { abortableSleep } from '../../gemini/retry.js';
import { estimateCostUsd, toMicrosUsd } from '../../utils/cost-estimator.js';
import { logger, safeForLog } from '../../utils/logger.js';
import type { ToolContext } from '../registry.js';
import { billedInputTokens } from '../shared/call-ledger.js';
import { isGemini429, parseRetryDelayMs } from '../shared/throttle.js';
import type { UsageCounts } from './response.js';
import type { AgenticRun } from './run.js';

export type BudgetReservation = ReturnType<ToolContext['manifest']['reserveBudget']>;

/** A TPM reservation id that was never taken. */
export const NO_THROTTLE_RESERVATION = -1;

/** The 429s whose retry hint has seeded the throttle: an iteration's 429 reaches the call's outer catch too. */
const seededRetryHints = new WeakSet<object>();

/**
 * The retry delay a Gemini 429 carries (`retryInfo.retryDelay`), or `null` for any other failure or a 429 without
 * one. The first time an error is met its delay seeds the throttle's hint for `model`, which later calls honour
 * through `throttle.reserve`; meeting the same error again seeds nothing.
 */
export function seedRetryHint(ctx: ToolContext, model: string, err: unknown): number | null {
  if (!isGemini429(err)) return null;
  const delayMs = parseRetryDelayMs(err.message);
  if (delayMs === null || seededRetryHints.has(err)) return delayMs;
  seededRetryHints.add(err);
  ctx.throttle.recordRetryHint(model, delayMs);
  return delayMs;
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

/**
 * Finalise an iteration's budget reservation with actual cost from usage metadata. `durationMs` is
 * per-iteration wall time (matching `ask`/`code`), so the manifest row reflects real latency — agentic
 * loops used to write `0` here, breaking usage-analytics queries (PR #24 round-4, Copilot P1).
 */
function bookIteration(
  run: AgenticRun,
  reservationId: number,
  usage: UsageCounts,
  durationMs: number,
): void {
  const actualCost = estimateCostUsd({
    model: run.resolved.resolved,
    uncachedInputTokens: usage.promptTokenCount,
    cachedInputTokens: 0,
    outputTokens: usage.candidatesTokenCount,
    thinkingTokens: usage.thoughtsTokenCount,
  });
  try {
    run.ctx.manifest.finalizeBudgetReservation(reservationId, {
      cachedTokens: 0,
      uncachedTokens: usage.promptTokenCount,
      costUsdMicro: toMicrosUsd(actualCost),
      durationMs,
    });
  } catch (finalizeErr) {
    logger.error(
      `ask_agentic: finalizeBudgetReservation failed for id=${reservationId}: ${String(finalizeErr)}`,
    );
  }
}

/** Settle a completed iteration: book its cost, release its TPM reservation with the actual input tokens. */
export function settleIteration(
  run: AgenticRun,
  reservationId: number | null,
  throttleReservationId: number,
  usage: UsageCounts,
  durationMs: number,
): void {
  if (reservationId !== null) {
    bookIteration(run, reservationId, usage, durationMs);
  }
  if (throttleReservationId !== NO_THROTTLE_RESERVATION) {
    run.ctx.throttle.release(throttleReservationId, usage.promptTokenCount);
  }
}

/** The finalization pass's reservations and when it started. */
export interface RescueReservations {
  reservationId: number | null;
  throttleReservationId: number;
  /** The input-token estimate both reservations were taken for. */
  estimate: number;
  startedAt: number;
}

/**
 * Settle a finalization pass whose API call returned (its tokens were billed, even when parsing the
 * response threw afterwards). If parse-after-await threw, `usage` is still {0,0,0}: the billed input
 * falls back to the estimate — under-billing a known-completed API call is a worse failure mode than
 * over-billing on a parse-error edge case (the operator's dailyBudget cap stays a true upper bound
 * either way).
 *
 * CC2 fix (v1.15.0 PR-Round-1, Copilot): the budget finalize and the throttle release share ONE
 * `billedUncachedTokens`. Pre-fix the asymmetry meant when Google's response omitted usageMetadata,
 * budget finalize used the estimate (correct) but throttle.release passed 0, mutating the TPM window
 * entry to 0 — under-throttling subsequent calls.
 */
export function settleBilledRescue(
  run: AgenticRun,
  reservations: RescueReservations,
  usage: UsageCounts,
): void {
  const billedUncachedTokens = billedInputTokens(usage.promptTokenCount, reservations.estimate);
  if (reservations.reservationId !== null) {
    const actualCost = estimateCostUsd({
      model: run.resolved.resolved,
      uncachedInputTokens: billedUncachedTokens,
      cachedInputTokens: 0,
      outputTokens: usage.candidatesTokenCount,
      thinkingTokens: usage.thoughtsTokenCount,
    });
    try {
      run.ctx.manifest.finalizeBudgetReservation(reservations.reservationId, {
        cachedTokens: 0,
        uncachedTokens: billedUncachedTokens,
        costUsdMicro: toMicrosUsd(actualCost),
        durationMs: Date.now() - reservations.startedAt,
      });
    } catch (finalizeErr) {
      logger.error(
        `ask_agentic finalization: finalize reservation failed: ${safeForLog(finalizeErr)}`,
      );
    }
  }
  if (reservations.throttleReservationId !== NO_THROTTLE_RESERVATION) {
    run.ctx.throttle.release(reservations.throttleReservationId, billedUncachedTokens);
  }
}
