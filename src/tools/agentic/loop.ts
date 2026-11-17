/**
 * The `ask_agentic` iteration loop and its budgets: per iteration a daily-budget reservation, a timeout (wall-clock
 * and stall), a TPM reservation, one model call with its tool batch, the settlement, and the three guards that end the
 * loop early — the answer, the cumulative input-token budget and the no-progress detector.
 */

import type { TextToolResult } from '../registry.js';
import {
  type TimeoutController,
  createTimeoutController,
  getTimeoutKind,
  isTimeoutAbort,
} from '../shared/abort-timeout.js';
import { type IterationResult, runAgenticIteration } from './iteration.js';
import {
  NO_THROTTLE_RESERVATION,
  cancelPass,
  reservePass,
  seedRetryHint,
  settleIteration,
  waitForTpm,
} from './ledger.js';
import { detectNoProgress } from './no-progress.js';
import {
  budgetRejected,
  inputBudgetExceeded,
  iterationTimedOut,
  noProgressDetected,
  organicAnswer,
} from './results.js';
import {
  type AgenticRun,
  ITERATION_TIMEOUT_ENV,
  type LoopState,
  PER_ITERATION_INPUT_TOKENS,
  passReservationUsd,
} from './run.js';

/** One iteration's reservations and how far it got. */
interface IterationFlight {
  reservationId: number | null;
  throttleReservationId: number;
  /** H2 fix: whether this iteration's `generateContent` was actually dispatched. The iter timeout can
   * fire DURING `abortableSleep` (TPM throttle wait, BEFORE runAgenticIteration is called) — in that
   * case no API call happened for this iter and `apiCalls` must subtract it. Set true immediately
   * before runAgenticIteration so any throw after that point counts the dispatched call (Gemini may
   * bill server-side even on aborted-mid-flight calls). */
  dispatched: boolean;
  startedAt: number;
}

type IterationAttempt =
  | { kind: 'completed'; iteration: IterationResult }
  | { kind: 'timed-out'; result: TextToolResult };

/**
 * Per-iteration budget reservation (mirrors ask.tool.ts): the reservation id (`null` when the daily
 * budget is not enforced), or the BUDGET_REJECT result.
 */
function reserveIteration(
  run: AgenticRun,
  state: LoopState,
  costUsd: number,
): { id: number | null } | { refused: TextToolResult } {
  if (!run.budget.dailyBudgetEnforced) return { id: null };
  const reserve = reservePass(run, costUsd);
  if ('rejected' in reserve) {
    return { refused: budgetRejected(run, state, reserve.spentMicros, costUsd) };
  }
  return { id: reserve.id };
}

/**
 * Per-iteration timeout — created BEFORE the throttle wait so the wait itself is bounded by the
 * iteration timeout. (If iterTimeout is created after the wait, a 60s throttle delay can blow past a
 * 10s iterationTimeoutMs without ever firing.) v1.16.2 (T33 TRIM): the loop streams, so `recordChunk()`
 * resets the stall watchdog on every text/thought chunk. The TPM throttle wait has no chunks to
 * record — `stallMs` only governs the stream itself; the wall-clock `totalMs` still bounds the
 * throttle wait. The composite signal fires on whichever cap hits first.
 */
function iterationTimeoutOf(run: AgenticRun): TimeoutController {
  const { input } = run;
  return createTimeoutController({
    ...(input.iterationTimeoutMs !== undefined ? { totalMs: input.iterationTimeoutMs } : {}),
    totalEnvVar: ITERATION_TIMEOUT_ENV,
    ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
    stallEnvVar: 'GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS',
  });
}

/**
 * The TPM throttle reservation and the iteration call. `onThoughtChunk` mirrors the ask/code
 * streaming UX so operators see model reasoning progress live instead of waiting for the 30-120s
 * iteration to complete.
 */
async function throttledIteration(
  run: AgenticRun,
  state: LoopState,
  iterTimeout: TimeoutController,
  flight: IterationFlight,
): Promise<IterationResult> {
  if (run.budget.tpmEnforced) {
    await waitForTpm(
      run,
      flight,
      PER_ITERATION_INPUT_TOKENS,
      iterTimeout.signal,
      (seconds) => `throttle: waiting ${seconds}s for TPM window…`,
    );
  }
  flight.dispatched = true;
  return runAgenticIteration({
    ctx: run.ctx,
    resolvedModel: run.resolved.resolved,
    conversation: state.conversation,
    baseConfig: run.baseConfig,
    workspaceRoot: run.workspaceRoot,
    filesReadSet: state.filesReadSet,
    maxFilesRead: run.limits.maxFilesRead,
    abortSignal: iterTimeout.signal,
    matchConfig: run.matchConfig,
    recordChunk: () => iterTimeout.recordChunk(),
    onThoughtChunk: (text) => {
      const trimmed = text.trim().slice(0, 80);
      if (trimmed.length > 0) run.emitter.emit(`thinking: ${trimmed}…`);
    },
  });
}

/**
 * A failed iteration: both reservations are released and a Gemini 429's retry hint seeds the throttle.
 * A timeout becomes the structured TIMEOUT result naming the iteration (`timeoutKind` says whether the
 * stall or the total cap fired); any other failure gives `null`, for the caller to re-throw.
 */
function iterationFailure(
  run: AgenticRun,
  state: LoopState,
  iterErr: unknown,
  iterTimeout: TimeoutController,
  flight: IterationFlight,
): TextToolResult | null {
  cancelPass(run.ctx, flight.reservationId, flight.throttleReservationId, 'ask_agentic');
  seedRetryHint(run.ctx, run.resolved.resolved, iterErr);
  if (!isTimeoutAbort(iterErr)) return null;
  const kind = getTimeoutKind(iterErr) ?? 'total';
  const limitMs = kind === 'stall' ? iterTimeout.stallMs : iterTimeout.timeoutMs;
  run.emitter.emit(
    `ask_agentic: iteration ${state.iterations} aborted after ${limitMs ?? '?'}ms (${kind})`,
  );
  return iterationTimedOut(state.iterations, {
    controller: iterTimeout,
    kind,
    limitMs,
    dispatched: flight.dispatched,
  });
}

/**
 * The TPM wait and the iteration call run INSIDE the same try/catch, so a timeout firing during the
 * throttle wait flows through the same cancel/TIMEOUT path as a timeout firing during the SDK call —
 * neither reservation leaks. The iteration timeout is disposed whatever happens.
 */
async function attemptIteration(
  run: AgenticRun,
  state: LoopState,
  iterTimeout: TimeoutController,
  flight: IterationFlight,
): Promise<IterationAttempt> {
  try {
    const iteration = await throttledIteration(run, state, iterTimeout, flight);
    return { kind: 'completed', iteration };
  } catch (iterErr) {
    const timedOut = iterationFailure(run, state, iterErr, iterTimeout, flight);
    if (timedOut === null) throw iterErr;
    return { kind: 'timed-out', result: timedOut };
  } finally {
    iterTimeout.dispose();
  }
}

function absorbIteration(state: LoopState, iteration: IterationResult): void {
  state.cumulativeInputTokens += iteration.usage.promptTokenCount;
  state.cumulativeOutputTokens += iteration.usage.candidatesTokenCount;
  state.cumulativeThinkingTokens += iteration.usage.thoughtsTokenCount;
  state.lastIterationPromptTokens = iteration.usage.promptTokenCount;
  state.lastToolResponseTokens = iteration.toolResponseTokens;
}

/**
 * Final-text first, budget second: if the iteration produced an answer, return it even if the
 * cumulative-token count ticked over `maxTotalInputTokens`. Operators already paid for those tokens;
 * discarding a successful answer just because this iteration nudged the meter over is punitive UX.
 * The budget guard still blocks FUTURE iterations from spending beyond the cap: if we're past the
 * answer check, the model is still asking for tool calls, and another round is refused. Reported in
 * PR #24 review by Gemini. The no-progress detector runs last, on the iteration-end file count.
 */
function endOfIteration(
  run: AgenticRun,
  state: LoopState,
  iteration: IterationResult,
): TextToolResult | null {
  if (iteration.finalText !== null) {
    return organicAnswer(run, state, iteration.finalText, iteration.thinkingSummary);
  }
  if (state.cumulativeInputTokens > run.limits.maxTotalInputTokens) {
    return inputBudgetExceeded(run, state);
  }
  const stuck = detectNoProgress(
    iteration.signatures,
    state.signatureCounts,
    state.filesReadSet.size,
  );
  return stuck === null ? null : noProgressDetected(state, stuck);
}

/**
 * One iteration, priced per iteration at the rates in force until its timeout: a loop that crosses a
 * price change reserves at the new rate, so each reservation stays an upper bound of what its
 * settlement books. Returns the result that ends the call, or `null` to go on.
 */
async function runIteration(run: AgenticRun, state: LoopState): Promise<TextToolResult | null> {
  const perIterationCostUsd = passReservationUsd(run, PER_ITERATION_INPUT_TOKENS);
  const reservation = reserveIteration(run, state, perIterationCostUsd);
  if ('refused' in reservation) return reservation.refused;
  const iterTimeout = iterationTimeoutOf(run);
  const flight: IterationFlight = {
    reservationId: reservation.id,
    throttleReservationId: NO_THROTTLE_RESERVATION,
    dispatched: false,
    startedAt: Date.now(),
  };
  const attempt = await attemptIteration(run, state, iterTimeout, flight);
  if (attempt.kind === 'timed-out') return attempt.result;
  const { iteration } = attempt;
  const iterDurationMs = Date.now() - flight.startedAt;
  settleIteration(
    run,
    flight.reservationId,
    flight.throttleReservationId,
    iteration.usage,
    iterDurationMs,
  );
  absorbIteration(state, iteration);
  run.emitter.emit(
    `iter ${state.iterations}/${run.limits.maxIterations}: ${iteration.functionCallCount} tool calls, ${state.cumulativeInputTokens} in-tokens so far`,
  );
  return endOfIteration(run, state, iteration);
}

/** Run the loop until a result ends the call, or `null` once `maxIterations` is exhausted. */
export async function runLoop(run: AgenticRun, state: LoopState): Promise<TextToolResult | null> {
  while (state.iterations < run.limits.maxIterations) {
    state.iterations += 1;
    const ended = await runIteration(run, state);
    if (ended !== null) return ended;
  }
  return null;
}
