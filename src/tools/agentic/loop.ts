/**
 * The `ask_agentic` iteration loop and its budgets: per iteration a daily-budget reservation, a clock (`PassClock`:
 * every phase's bound), a TPM reservation, one model call with its tool batch, the settlement, and the three guards
 * that end the loop early — the answer, the cumulative input-token budget and the no-progress detector.
 */

import type { TextToolResult } from '../registry.js';
import { isTimeoutAbort } from '../shared/abort-timeout.js';
import { type IterationOutcome, type IterationResult, runAgenticIteration } from './iteration.js';
import {
  NO_THROTTLE_RESERVATION,
  type PassCall,
  type PassReservations,
  callNotMade,
  closePass,
  reservePass,
  waitForTpm,
} from './ledger.js';
import { detectNoProgress } from './no-progress.js';
import { type PassClock, type PassTimeout, createPassClock, passTimeoutOf } from './pass-clock.js';
import {
  budgetRejected,
  inputBudgetExceeded,
  iterationTimedOut,
  noProgressDetected,
  organicAnswer,
} from './results.js';
import {
  type AgenticRun,
  type LoopState,
  PER_ITERATION_INPUT_TOKENS,
  passReservationUsd,
} from './run.js';

/** One iteration's reservations and how far it got. */
interface IterationFlight extends PassReservations {
  /** Whether this iteration's model call was sent: `apiCalls` counts the requests sent, whatever became of them. The
   * iteration timeout can fire during the TPM wait, before the call; then `apiCalls` does not count it. Set
   * immediately before runAgenticIteration, so any throw after that point counts the call. */
  dispatched: boolean;
  /** The model call: marked completed by the iteration the moment its stream ended, so every exit after that books it. */
  call: PassCall;
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
 * The TPM throttle reservation and the iteration call. The clock is created BEFORE the throttle wait (phase
 * `tpm-wait`), so `iterationTimeoutMs` bounds the wait too; each request enters its opening (`runAgenticIteration`).
 * `onThoughtChunk` mirrors the ask/code streaming UX so operators see model reasoning progress live instead of waiting
 * for the 30-120s iteration to complete.
 */
async function throttledIteration(
  run: AgenticRun,
  state: LoopState,
  clock: PassClock,
  flight: IterationFlight,
): Promise<IterationOutcome> {
  if (run.budget.tpmEnforced) {
    await waitForTpm(
      run,
      flight,
      flight.estimate,
      clock.signal,
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
    clock,
    call: flight.call,
    matchConfig: run.matchConfig,
    onThoughtChunk: (text) => {
      const trimmed = text.trim().slice(0, 80);
      if (trimmed.length > 0) run.emitter.emit(`thinking: ${trimmed}…`);
    },
  });
}

/**
 * A timed-out iteration is closed (`closePass`) — booked at what it billed when its model call had completed (the
 * bound fired in its tools phase), both reservations released when it had not — and becomes the structured TIMEOUT
 * result naming the iteration, the phase and the bound that fired, with the booked pass's billed fields.
 * `toolCallsRunning` is the work of its tools phase still running after the grace.
 */
function timedOutIteration(
  run: AgenticRun,
  state: LoopState,
  timeout: PassTimeout,
  flight: IterationFlight,
  toolCallsRunning: number,
): TextToolResult {
  const billed = closePass(run, flight, flight.call);
  const after = timeout.limitMs === null ? '' : ` after ${timeout.limitMs}ms`;
  run.emitter.emit(`ask_agentic: iteration ${state.iterations} aborted${after} (${timeout.kind})`);
  return iterationTimedOut(state.iterations, {
    timeout,
    timeoutMs: run.knobs.iterationMs,
    stallMs: run.knobs.stallMs,
    knobNames: run.knobNames,
    dispatched: flight.dispatched,
    billed,
    toolCallsRunning,
  });
}

/**
 * A failed iteration: a timeout becomes the TIMEOUT result (`timedOutIteration`); any other failure closes the pass and
 * gives `null`, for the caller to re-throw, the billed fields left in `state` for the outer catch (the 429 retry hint
 * is seeded once, by the call's own catch).
 */
function iterationFailure(
  run: AgenticRun,
  state: LoopState,
  iterErr: unknown,
  clock: PassClock,
  flight: IterationFlight,
): TextToolResult | null {
  if (isTimeoutAbort(iterErr)) {
    return timedOutIteration(run, state, passTimeoutOf(clock, iterErr), flight, 0);
  }
  state.failedPassBilled = closePass(run, flight, flight.call);
  return null;
}

/**
 * The TPM wait and the iteration call run INSIDE the same try/catch, so a bound firing during the throttle wait flows
 * through the same close/TIMEOUT path as one firing during the request or the tool batch — neither reservation leaks.
 * The clock is disposed whatever happens. Each path closes the pass once: a failure in the `catch`, a tools timeout
 * after the `try` — never inside it, where a throw of `closePass` would reach the `catch` and close the pass again.
 */
async function attemptIteration(
  run: AgenticRun,
  state: LoopState,
  clock: PassClock,
  flight: IterationFlight,
): Promise<IterationAttempt> {
  let outcome: IterationOutcome;
  try {
    outcome = await throttledIteration(run, state, clock, flight);
  } catch (iterErr) {
    const timedOut = iterationFailure(run, state, iterErr, clock, flight);
    if (timedOut === null) throw iterErr;
    return { kind: 'timed-out', result: timedOut };
  } finally {
    clock.dispose();
  }
  if (outcome.kind === 'done') return { kind: 'completed', iteration: outcome.iteration };
  const timeout = passTimeoutOf(clock, clock.signal.reason);
  return {
    kind: 'timed-out',
    result: timedOutIteration(run, state, timeout, flight, outcome.running),
  };
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
 * price change reserves at the new rate. The reservation is for a fixed `PER_ITERATION_INPUT_TOKENS`
 * input, so an iteration that sends more is settled above it (`docs/cost-model.md`). Returns the
 * result that ends the call, or `null` to go on.
 */
async function runIteration(run: AgenticRun, state: LoopState): Promise<TextToolResult | null> {
  const estimate = PER_ITERATION_INPUT_TOKENS;
  const reservation = reserveIteration(run, state, passReservationUsd(run, estimate));
  if ('refused' in reservation) return reservation.refused;
  const clock = createPassClock(run.knobs);
  const flight: IterationFlight = {
    reservationId: reservation.id,
    throttleReservationId: NO_THROTTLE_RESERVATION,
    estimate,
    dispatched: false,
    call: callNotMade(),
    startedAt: Date.now(),
  };
  const attempt = await attemptIteration(run, state, clock, flight);
  if (attempt.kind === 'timed-out') return attempt.result;
  const { iteration } = attempt;
  closePass(run, flight, flight.call);
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
