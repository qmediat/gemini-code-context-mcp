/**
 * The ledger side of an `ask` / `code` call: what its completed requests billed, and how the call settles its budget
 * reservation — on an answer, and on a failure.
 *
 * `GEMINI_DAILY_BUDGET_USD` bounds completed spend: every request that streamed to its end was billed, so its
 * reported usage, at list price, stays in the ledger whatever becomes of the call; only the unspent remainder of the
 * reservation is released. A call that fails before any request completed releases its reservation whole.
 */

import type { RanCachingMode } from '../../cache/caching-mode.js';
import type { ManifestDb } from '../../manifest/db.js';
import { estimateCostUsd, toMicrosUsd } from '../../utils/cost-estimator.js';
import { logger } from '../../utils/logger.js';
import type { CompletedRequests, DecodeUsage } from './continuation.js';

/** The tool a ledger row belongs to. */
export type LedgerTool = 'ask' | 'code';

/** What the completed requests of a call billed: their reported tokens and their cost at list price. */
export interface BilledUsage {
  readonly cachedTokens: number;
  readonly uncachedTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  /** Every input token, cached or not: what the per-minute quota counts. */
  readonly promptTokens: number;
  readonly costUsd: number;
}

/** The usage fields of a result: an answer, an `OUTPUT_CAP` stop, or a failure after completed requests. */
export interface UsageFields {
  readonly cachedTokens: number;
  readonly uncachedTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly costEstimateUsd: number;
  readonly continuationHops: number;
}

/** Where a call's spend is booked. */
export interface LedgerEntry {
  readonly workspaceRoot: string;
  readonly toolName: LedgerTool;
  readonly model: string;
  readonly serviceTier: 'standard' | 'flex' | undefined;
  readonly cachingMode: RanCachingMode;
}

/** A call that failed, as its ledger sees it. */
export interface FailedCall {
  readonly toolName: LedgerTool;
  /** The budget reservation the call holds; `null` without a daily cap. */
  readonly reservationId: number | null;
  /** The booking of the decode that ran; `null` when the call failed before any decode started. */
  readonly entry: LedgerEntry | null;
  readonly completed: CompletedRequests;
  readonly durationMs: number;
}

const tokens = (n: number | undefined): number => (typeof n === 'number' ? n : 0);

/** The tokens a (summed) usage reports and their cost: the one cost function of a settled call. */
export function billedUsage(
  usage: DecodeUsage | undefined,
  model: string,
  serviceTier: 'standard' | 'flex' | undefined,
): BilledUsage {
  const prompt = tokens(usage?.promptTokenCount);
  const cached = tokens(usage?.cachedContentTokenCount);
  const uncached = Math.max(0, prompt - cached);
  const output = tokens(usage?.candidatesTokenCount);
  const thinking = tokens(usage?.thoughtsTokenCount);
  const costUsd = estimateCostUsd({
    model,
    serviceTier,
    uncachedInputTokens: uncached,
    cachedInputTokens: cached,
    outputTokens: output,
    thinkingTokens: thinking,
  });
  return {
    cachedTokens: cached,
    uncachedTokens: uncached,
    outputTokens: output,
    thinkingTokens: thinking,
    promptTokens: prompt,
    costUsd,
  };
}

export function usageFields(billed: BilledUsage, continuationHops: number): UsageFields {
  return {
    cachedTokens: billed.cachedTokens,
    uncachedTokens: billed.uncachedTokens,
    outputTokens: billed.outputTokens,
    thinkingTokens: billed.thinkingTokens,
    costEstimateUsd: Math.round(billed.costUsd * 10000) / 10000,
    continuationHops,
  };
}

/**
 * Books a call at what it billed: its reservation finalised at that cost (the rest released), or — with no daily cap,
 * so no reservation — a usage row. A finalise that throws leaves the reservation's estimate booked, which stays a
 * bound; it is logged.
 */
export function recordBilledCall(
  manifest: ManifestDb,
  reservationId: number | null,
  entry: LedgerEntry,
  billed: BilledUsage,
  durationMs: number,
): void {
  const settled = {
    cachedTokens: billed.cachedTokens,
    uncachedTokens: billed.uncachedTokens,
    costUsdMicro: toMicrosUsd(billed.costUsd),
    durationMs,
    cachingMode: entry.cachingMode,
    cachedContentTokenCount: billed.cachedTokens,
  };
  if (reservationId === null) {
    manifest.insertUsageMetric({
      workspaceRoot: entry.workspaceRoot,
      toolName: entry.toolName,
      model: entry.model,
      occurredAt: Date.now(),
      ...settled,
    });
    return;
  }
  try {
    manifest.finalizeBudgetReservation(reservationId, settled);
  } catch (finalizeErr) {
    logger.error(
      `${entry.toolName}: finalizeBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate (${settled.costUsdMicro} micros). Error: ${String(finalizeErr)}`,
    );
  }
}

/**
 * Settles the ledger of a failed call. With no request completed the reservation is released whole; after one or
 * more, the ledger keeps what they billed and the result gets their usage and the continuation requests whose
 * stream opened.
 * A ledger write that throws is logged and never replaces the call's own error.
 */
export function settleFailedCall(manifest: ManifestDb, failed: FailedCall): UsageFields | null {
  if (failed.entry === null || failed.completed.count === 0) {
    releaseReservation(manifest, failed.toolName, failed.reservationId);
    return null;
  }
  const billed = billedUsage(
    failed.completed.usage(),
    failed.entry.model,
    failed.entry.serviceTier,
  );
  try {
    recordBilledCall(manifest, failed.reservationId, failed.entry, billed, failed.durationMs);
  } catch (recordErr) {
    logger.error(
      `${failed.toolName}: the usage of ${failed.completed.count} completed request(s) could not be recorded. Error: ${String(recordErr)}`,
    );
  }
  return usageFields(billed, failed.completed.continuationHops());
}

function releaseReservation(
  manifest: ManifestDb,
  toolName: LedgerTool,
  reservationId: number | null,
): void {
  if (reservationId === null) return;
  try {
    manifest.cancelBudgetReservation(reservationId);
  } catch (cancelErr) {
    logger.error(
      `${toolName}: cancelBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate. Error: ${String(cancelErr)}`,
    );
  }
}
