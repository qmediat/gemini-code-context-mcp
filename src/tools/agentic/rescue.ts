/**
 * The forced-finalization rescue: the loop exhausted `maxIterations` without an organic final-text turn, so ONE more
 * `generateContent` runs with `toolConfig.functionCallingConfig.mode = NONE` — the model is prohibited from emitting
 * more function calls (Gemini API spec: NONE = "equivalent to sending a request without any function declarations")
 * and must answer in text using the conversation it has already accumulated. This converts what was previously an
 * opaque error into a synthesized text answer derived from the tool responses gathered so far. If the forced call
 * itself fails (timeout, network, budget exhausted, empty text), the caller still gets a structured failure signal.
 *
 * v1.14.2: the rescue pass is NOT gated on `maxTotalInputTokens`. It is the documented exit path for "loop ran out
 * of iterations without final text" and blocking it on rescue's own potential overshoot defeats the v1.14.1 feature —
 * an operator running near the cap would never get the synthesised answer the rescue is designed to produce. Rescue
 * cost remains bounded by the `dailyBudgetUsd` reservation, wall-clock by `iterationTimeoutMs` — else by the
 * finalization default (`phase-defaults.ts`). Cap-overshoot is signalled via `overBudget: true` on the result so
 * callers can detect the trade.
 *
 * The rescue calls `generateContent`, not the stream: its pass clock has the phases `tpm-wait` and `finalization` —
 * entered by each request and by a retry's announcement, so each request, its backoff included, gets the whole default
 * — and no stream gap to watch. Its call is marked completed the moment `generateContent` returned (`completeCall`, the
 * idiom of the loop iteration), before the response is read.
 */

import type { GenerateContentConfig, GenerateContentResponse } from '@google/genai';
import { ApiError, FunctionCallingConfigMode } from '@google/genai';
import { withNetworkRetry } from '../../gemini/retry.js';
import { logger } from '../../utils/logger.js';
import { isTimeoutAbort } from '../shared/abort-timeout.js';
import type { BilledFields } from '../shared/call-ledger.js';
import { isGemini429, seedRetryHint } from '../shared/throttle.js';
import { SYSTEM_INSTRUCTION_FINALIZATION } from './instructions.js';
import {
  NO_THROTTLE_RESERVATION,
  type PassCall,
  type PassReservations,
  callNotMade,
  closePass,
  completeCall,
  reservePass,
  waitForTpm,
} from './ledger.js';
import { type PassClock, type PassTimeout, createPassClock, passTimeoutOf } from './pass-clock.js';
import { type UsageCounts, thinkingSummaryOf } from './response.js';
import {
  type AgenticRun,
  type LoopState,
  PER_ITERATION_INPUT_TOKENS,
  passReservationUsd,
} from './run.js';

/**
 * P4 (v1.15.0): caller-visible rescue failure-class signal, surfaced as
 * `structuredContent.rescueErrorCode` so wrappers can branch retry behaviour
 * without log scraping. Strict union — extend here when adding new error
 * classes.
 *
 * - 'TIMEOUT'    — iterationTimeoutMs, else the finalization default, fired (isTimeoutAbort)
 * - 'RATE_LIMIT' — Google 429 (isGemini429: ApiError + status===429)
 * - 'INTERNAL'   — the call completed (await returned), but reading its
 *                  response threw — the pass is booked, but the caller
 *                  sees a structured failure. Distinguishes "API ok, our
 *                  code bug" from "API failure" so wrappers don't blindly
 *                  retry our parse bugs.
 * - 'API_ERROR'  — `instanceof ApiError` with status≠429 (4xx other
 *                  than 429, or 5xx). Wrapper should NOT retry 4xx
 *                  (fix the payload) but MAY retry 5xx with backoff.
 * - 'NETWORK'    — fetch-layer / DNS / TCP / pre-dispatch SDK error.
 *                  Real transient connectivity case; safe to retry.
 * - 'EMPTY_TEXT' — set in success path: API returned, but extracted
 *                  text was empty after .trim(). Budget IS finalized.
 */
export type RescueErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'INTERNAL'
  | 'API_ERROR'
  | 'NETWORK'
  | 'EMPTY_TEXT';

/** What the finalization pass produced. */
export interface RescueOutcome {
  /** The answer, trimmed; empty when the pass produced none. */
  text: string;
  usage: UsageCounts;
  thinkingSummary: string | null;
  /** Whether the finalization `generateContent` call was dispatched (regardless of outcome) — `apiCalls`
   * counts it even when a mid-flight timeout or a pre-response network failure left the usage at 0. */
  attempted: boolean;
  /** `null` when the rescue produced text (the answer then carries `convergenceForced: true`) or was skipped. */
  errorCode: RescueErrorCode | null;
  /** The failure's message, cut to 500 characters; `null` unless the call threw. */
  errorMessage: string | null;
  /** v1.14.2 Fix 5: WHY the rescue pass was skipped — 'daily-budget' when `reserveBudget` rejected. */
  skipReason: 'daily-budget' | null;
  /** The pass's billed fields when its call completed and it was booked; `null` when it was skipped or cancelled. */
  billed: BilledFields | null;
  /** What ended the pass when it timed out (`errorCode: 'TIMEOUT'`), read from its clock; `null` otherwise. */
  timeout: PassTimeout | null;
}

/** The parts of the finalization call that outlive its `try`. */
interface RescueFlight extends PassReservations {
  /** The model call: marked completed the moment `generateContent` returned, before its response is read, so a
   * throw while it is read still books the pass. */
  call: PassCall;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * v1.14.2: dynamic estimate for the rescue pass — the actual size of the last observed iteration
 * (+5k margin for SYSTEM_INSTRUCTION_FINALIZATION + thinking-config overhead) instead of the static
 * `PER_ITERATION_INPUT_TOKENS` baseline. Used by BOTH the daily-budget reservation AND the
 * TPM-throttle reservation so cost and rate-limit gates stay symmetric (the reservation covers the
 * replayed conversation). Fallback to the static estimate when the loop produced no usage record.
 *
 * v1.15.0 (P5): also folds in `lastToolResponseTokens` — the tool-response Parts appended to
 * `conversation` AFTER the last iteration's `generateContent` returned. The rescue's prompt replays
 * the entire accumulated conversation, so its actual size ≈ last-iter prompt + the tool responses
 * appended after; without them a final iteration that read several large files concurrently could
 * under-reserve TPM by 100k+ tokens and 429 mid-flight.
 */
function finalizationEstimateOf(state: LoopState): number {
  return state.lastIterationPromptTokens > 0
    ? state.lastIterationPromptTokens + state.lastToolResponseTokens + 5_000
    : PER_ITERATION_INPUT_TOKENS;
}

/** The pass's budget reservation id, or `null` — not enforced, or refused (then `outcome.skipReason`). */
function reserveRescue(run: AgenticRun, costUsd: number, outcome: RescueOutcome): number | null {
  if (!run.budget.dailyBudgetEnforced) return null;
  const reserve = reservePass(run, costUsd);
  if (!('rejected' in reserve)) return reserve.id;
  const spent = (reserve.spentMicros / 1_000_000).toFixed(4);
  run.emitter.emit(
    `skipping forced-finalization pass — daily budget cap reached (spent $${spent})`,
  );
  logger.warn(
    `ask_agentic: skipping forced-finalization pass — daily budget cap reached (spent $${spent})`,
  );
  outcome.skipReason = 'daily-budget';
  return null;
}

/**
 * The finalization call. G2 fix: `tools` (function declarations) are omitted — per Gemini API spec,
 * `mode: NONE` is "equivalent to sending a request without any function declarations"; sending the
 * declarations alongside NONE wastes ~150-300 input tokens and contradicts the spec we depend on.
 */
function callFinalization(
  run: AgenticRun,
  state: LoopState,
  baseConfigNoTools: GenerateContentConfig,
  clock: PassClock,
): Promise<GenerateContentResponse> {
  const model = run.resolved.resolved;
  const { signal } = clock;
  return withNetworkRetry(
    () => {
      clock.enter('finalization');
      return run.ctx.client.models.generateContent({
        model,
        contents: state.conversation,
        config: {
          ...baseConfigNoTools,
          systemInstruction: SYSTEM_INSTRUCTION_FINALIZATION,
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
          },
          abortSignal: signal,
        },
      });
    },
    {
      signal,
      onRetry: (attempt, retryErr) => {
        clock.enter('finalization');
        logger.warn(`ask_agentic finalization: retry attempt ${attempt}: ${errorText(retryErr)}`);
      },
    },
  );
}

/** Read the returned response. An empty text is a rescue failure mode (model dispatched, returned a
 * candidate with no extractable text) — distinct from timeouts / 429s / network errors. */
function readFinalization(
  response: GenerateContentResponse,
  usage: UsageCounts,
  outcome: RescueOutcome,
): void {
  outcome.usage = usage;
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  outcome.text = (response.text ?? parts.map((p) => p.text ?? '').join('')).trim();
  outcome.thinkingSummary = thinkingSummaryOf(parts);
  if (outcome.text.length === 0) {
    outcome.errorCode = 'EMPTY_TEXT';
  }
}

/**
 * Classify a rescue failure for caller-facing telemetry. Order matters — earlier branches signal the
 * most user-actionable remediation:
 *   1. TIMEOUT — checked first because a 429 surfaced via an aborted-fetch can race the timeout signal.
 *   2. RATE_LIMIT — wait the retry-hint window then retry (429).
 *   3. INTERNAL — a completed call means the await returned cleanly; any throw past that point is
 *      processing logic our side, not Gemini's API — investigate, do not retry blindly.
 *   4. API_ERROR — Gemini returned a non-429 4xx/5xx; distinct from NETWORK so wrappers don't retry
 *      400 INVALID_ARGUMENT forever.
 *   5. NETWORK — fetch-layer / DNS / TCP / SDK pre-dispatch; safe to retry.
 */
function rescueFailureCode(
  finalErr: unknown,
  retryDelayMs: number | null,
  callCompleted: boolean,
): RescueErrorCode {
  if (isTimeoutAbort(finalErr)) {
    logger.warn('ask_agentic finalization: timed out after maxIterations exhaustion');
    return 'TIMEOUT';
  }
  if (isGemini429(finalErr)) {
    logger.warn(
      `ask_agentic finalization: 429 rate-limit (retryDelay=${retryDelayMs ?? 'unknown'}ms)`,
    );
    return 'RATE_LIMIT';
  }
  if (callCompleted) {
    logger.warn(`ask_agentic finalization: post-await processing failed: ${errorText(finalErr)}`);
    return 'INTERNAL';
  }
  if (finalErr instanceof ApiError) {
    logger.warn(
      `ask_agentic finalization: Gemini API returned ${finalErr.status ?? 'unknown'}: ${finalErr.message.slice(0, 200)}`,
    );
    return 'API_ERROR';
  }
  logger.warn(`ask_agentic finalization: network failure: ${errorText(finalErr)}`);
  return 'NETWORK';
}

/** The rescue's generateContent can also 429 — its retry hint seeds the throttle cache for future
 * ask_agentic / ask / code calls, the same way the per-iteration catch does. A timeout records what fired. */
function recordRescueFailure(
  run: AgenticRun,
  finalErr: unknown,
  clock: PassClock,
  callCompleted: boolean,
  outcome: RescueOutcome,
): void {
  const finalRetryDelayMs = seedRetryHint(run.ctx.throttle, run.resolved.resolved, finalErr);
  outcome.errorCode = rescueFailureCode(finalErr, finalRetryDelayMs, callCompleted);
  if (outcome.errorCode === 'TIMEOUT') outcome.timeout = passTimeoutOf(clock, finalErr);
  outcome.errorMessage =
    finalErr instanceof Error ? finalErr.message.slice(0, 500) : String(finalErr).slice(0, 500);
}

/** Dispatch the finalization call and read its answer. The API attempt is marked before dispatch (after
 * the throttle wait, so a throttle-wait abort doesn't count it). */
async function dispatchRescue(
  run: AgenticRun,
  state: LoopState,
  flight: RescueFlight,
  clock: PassClock,
  outcome: RescueOutcome,
): Promise<void> {
  if (run.budget.tpmEnforced) {
    // The dynamic estimate, the same value and margin as the daily-budget reserve: over-reserve =
    // transient throttle wait (harmless); under-reserve = 429 risk; the bias is intentional.
    await waitForTpm(
      run,
      flight,
      flight.estimate,
      clock.signal,
      (seconds) => `finalization throttle: waiting ${seconds}s for TPM window…`,
    );
  }
  const { tools: _unusedTools, ...baseConfigNoTools } = run.baseConfig;
  outcome.attempted = true;
  const response = await callFinalization(run, state, baseConfigNoTools, clock);
  const usage = completeCall(flight.call, response);
  readFinalization(response, usage, outcome);
}

/** Run the pass under its own clock; close it by its call (`closePass`): booked when the call completed, both
 * reservations cancelled when it did not. */
async function attemptRescue(
  run: AgenticRun,
  state: LoopState,
  reservationId: number | null,
  estimate: number,
  outcome: RescueOutcome,
): Promise<void> {
  run.emitter.emit('running forced-finalization pass (tools disabled)');
  const clock = createPassClock(run.knobs);
  const flight: RescueFlight = {
    reservationId,
    throttleReservationId: NO_THROTTLE_RESERVATION,
    estimate,
    startedAt: Date.now(),
    call: callNotMade(),
  };
  try {
    await dispatchRescue(run, state, flight, clock, outcome);
  } catch (finalErr) {
    recordRescueFailure(run, finalErr, clock, flight.call.completed, outcome);
  } finally {
    outcome.billed = closePass(run, flight, flight.call, 'ask_agentic finalization');
    clock.dispose();
  }
}

/** Run the forced-finalization pass after the loop exhausted `maxIterations`. */
export async function runRescue(run: AgenticRun, state: LoopState): Promise<RescueOutcome> {
  run.emitter.emit(
    `maxIterations (${run.limits.maxIterations}) reached — running forced-finalization pass`,
  );
  const outcome: RescueOutcome = {
    text: '',
    usage: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
    thinkingSummary: null,
    attempted: false,
    errorCode: null,
    errorMessage: null,
    skipReason: null,
    billed: null,
    timeout: null,
  };
  const estimate = finalizationEstimateOf(state);
  const reservationId = reserveRescue(run, passReservationUsd(run, estimate), outcome);
  if (reservationId !== null || !run.budget.dailyBudgetEnforced) {
    await attemptRescue(run, state, reservationId, estimate, outcome);
  }
  return outcome;
}
