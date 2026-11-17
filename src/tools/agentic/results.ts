/**
 * The results `ask_agentic` returns once the loop has started: the answer (organic or forced), and every error that
 * ends the loop. `apiCalls` is the authoritative total `generateContent` count on every one of them.
 */

import { type TextToolResult, errorResult, textResult } from '../registry.js';
import { ABORTED_REQUEST_NOTE } from '../shared/abort-timeout.js';
import type { BilledFields } from '../shared/call-ledger.js';
import type { NoProgress } from './no-progress.js';
import type { DefaultedPhase, ExternalTimeout, KnobSource, PassTimeout } from './pass-clock.js';
import type { RescueOutcome } from './rescue.js';
import type { AgenticRun, KnobNames, LoopState } from './run.js';

/** The figures an answer reports that differ between the organic and the forced answer. */
interface AnswerTotals {
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  thinkingSummary: string | null;
}

/** Which pass produced the answer: the loop, or the forced-finalization pass (then `convergenceForced: true`). */
type AnswerSource = 'organic' | 'forced';

/** An answer's structured fields; `overBudget` says whether its input tokens passed `maxTotalInputTokens`. */
function answerFields(
  run: AgenticRun,
  state: LoopState,
  totals: AnswerTotals,
  source: AnswerSource,
) {
  const { resolved } = run;
  return {
    resolvedModel: resolved.resolved,
    requestedModel: resolved.requested,
    fallbackApplied: resolved.fallbackApplied,
    modelCategory: resolved.category,
    contextWindow: resolved.inputTokenLimit,
    iterations: state.iterations,
    apiCalls: totals.apiCalls,
    cumulativeInputTokens: totals.inputTokens,
    cumulativeOutputTokens: totals.outputTokens,
    cumulativeThinkingTokens: totals.thinkingTokens,
    filesRead: state.filesReadSet.size,
    filesReadList: [...state.filesReadSet].slice(0, 40),
    durationMs: Date.now() - run.started,
    thinkingSummary: totals.thinkingSummary,
    ...(source === 'forced' ? { convergenceForced: true } : {}),
    overBudget: totals.inputTokens > run.limits.maxTotalInputTokens,
  };
}

/** Organic final-text path: no forced-finalization pass ran, so total `generateContent` calls equals loop iterations. */
export function organicAnswer(
  run: AgenticRun,
  state: LoopState,
  finalText: string,
  thinkingSummary: string | null,
): TextToolResult {
  return textResult(
    finalText,
    answerFields(
      run,
      state,
      {
        apiCalls: state.iterations,
        inputTokens: state.cumulativeInputTokens,
        outputTokens: state.cumulativeOutputTokens,
        thinkingTokens: state.cumulativeThinkingTokens,
        thinkingSummary,
      },
      'organic',
    ),
  );
}

/**
 * The daily budget refused an iteration's reservation. BUDGET_REJECT is pre-dispatch — `iterations`
 * was incremented at the top of the loop body, but this iteration's `generateContent` never fired.
 * Subtract 1 to match the schema contract that `apiCalls` is the AUTHORITATIVE total
 * generateContent count. `Math.max(0, ...)` guards the first-iteration-rejection edge (iter 1 +
 * reject → 0 calls).
 */
export function budgetRejected(
  run: AgenticRun,
  state: LoopState,
  spentMicros: number,
  estimateUsd: number,
): TextToolResult {
  const spentUsd = spentMicros / 1_000_000;
  const { dailyBudgetUsd } = run.ctx.config;
  return errorResult(
    `Daily budget cap would be exceeded: spent $${spentUsd.toFixed(4)} + estimate $${estimateUsd.toFixed(4)} > cap $${dailyBudgetUsd.toFixed(2)}. Retry after UTC midnight, or raise GEMINI_DAILY_BUDGET_USD.`,
    {
      errorCode: 'BUDGET_REJECT',
      retryable: false,
      iterations: state.iterations,
      apiCalls: Math.max(0, state.iterations - 1),
      cumulativeInputTokens: state.cumulativeInputTokens,
    },
  );
}

/** What the message of an iteration booked before it timed out says of its cost. */
const BOOKED_ITERATION_NOTE =
  "The iteration's model call had completed: it is booked at the token and cost fields this result reports.";

/** How an iteration timed out: what fired, the knobs, and how far the pass had got. */
export interface IterationTimeout {
  timeout: PassTimeout;
  /** The configured knobs (`null` when unset), reported whichever fired. */
  timeoutMs: number | null;
  stallMs: number | null;
  /** The knob names the message gives: the caller's. */
  knobNames: KnobNames;
  dispatched: boolean;
  /** The iteration's billed fields when its model call had completed and it was booked; `null` when it was not. */
  billed: BilledFields | null;
  /** The work of its tools phase still running after the grace; 0 outside the tools phase. */
  toolCallsRunning: number;
}

type Hint = (names: KnobNames, limitMs: number) => string;

/** The default a bound reports when no knob bounded its phase, by phase (`phase-defaults.ts`); the TPM wait has none. */
const DEFAULT_HINTS: Readonly<Record<DefaultedPhase, Hint>> = {
  opening: (n, ms) =>
    `No chunk arrived within the ${ms} ms default for a request's opening. Set \`${n.totalMs}\` per call or \`${n.totalEnv}\` to bound each iteration yourself.`,
  stream: (n, ms) =>
    `The stream sent nothing for the ${ms} ms default. Set \`${n.stallMs}\` per call or \`${n.stallEnv}\` to bound a stream's silence yourself.`,
  tools: (n, ms) =>
    `The iteration's tool calls made no progress for the ${ms} ms default. Set \`${n.totalMs}\` per call or \`${n.totalEnv}\` to bound each iteration yourself.`,
  finalization: (n, ms) =>
    `A request of the forced-finalization pass ran past the ${ms} ms default. Set \`${n.totalMs}\` per call or \`${n.totalEnv}\` to bound it yourself.`,
};

/** The knob that raises a bound a caller set. */
const KNOB_HINTS: Readonly<Record<KnobSource, Hint>> = {
  iterationTimeoutMs: (n) => `Increase \`${n.totalMs}\` per call or set \`${n.totalEnv}\` higher.`,
  stallMs: (n) =>
    `Increase \`${n.stallMs}\` per call or set \`${n.stallEnv}\` higher. Stall fires when the stream goes silent — usually a dead socket or a Gemini server-side hiccup.`,
};

/** An `external` timeout names no bound of this call: it quotes the error's own message. */
const externalHint = (timeout: ExternalTimeout): string =>
  `No bound of this call fired: the request ended with a timeout of its own ("${timeout.message.slice(0, 200)}").`;

/**
 * What a timeout message tells the caller to change: the knob that fired, the default of the phase and its knob, or —
 * for an `external` timeout — that none of this call's bounds fired.
 */
export function timeoutHint(timeout: PassTimeout, names: KnobNames): string {
  if (timeout.source === 'external') return externalHint(timeout);
  const hint =
    timeout.source === 'default' ? DEFAULT_HINTS[timeout.phase] : KNOB_HINTS[timeout.source];
  return hint(names, timeout.limitMs);
}

/** "timed out (kind) after N ms", the limit left out for an `external` timeout: no bound of this call set one. */
function timedOutAfter(timeout: PassTimeout): string {
  const after = timeout.limitMs === null ? '' : ` after ${timeout.limitMs}ms`;
  return `timed out (${timeout.kind})${after}`;
}

/**
 * The whole agentic call fails on an iteration timeout — the failed iteration's function-call results never came back,
 * so the conversation is structurally incomplete.
 *
 * `timeoutMs` / `stallMs` report the configured knobs (as `ask` / `code` do); `timeoutKind` says which kind fired
 * (`stall` for a stream's gap only), `timeoutPhase` where, `timeoutSource` which bound. `dispatched` false means the
 * bound fired in the TPM wait and this iteration never reached the API: `apiCalls` leaves it out. An iteration booked
 * before it timed out (the bound fired in its tools phase) reports its billed fields and its message says so; the abort
 * note is for an iteration whose call was cancelled (`billed: null`). A TIMEOUT is retryable unless tool calls of the
 * iteration still run (`toolCallsRunning`): a retry would stack file-system work on the same thread pool.
 */
export function iterationTimedOut(iterations: number, t: IterationTimeout): TextToolResult {
  const { timeout } = t;
  const costNote = t.billed === null ? ABORTED_REQUEST_NOTE : BOOKED_ITERATION_NOTE;
  return errorResult(
    `ask_agentic: iteration ${iterations} ${timedOutAfter(timeout)}. ${timeoutHint(timeout, t.knobNames)} ${costNote}`,
    {
      errorCode: 'TIMEOUT',
      timeoutMs: t.timeoutMs,
      stallMs: t.stallMs,
      timeoutKind: timeout.kind,
      timeoutPhase: timeout.phase,
      timeoutSource: timeout.source,
      iteration: iterations,
      iterations,
      apiCalls: t.dispatched ? iterations : Math.max(0, iterations - 1),
      retryable: t.toolCallsRunning === 0,
      ...(t.toolCallsRunning > 0 ? { toolCallsRunning: t.toolCallsRunning } : {}),
      ...(t.billed ?? {}),
    },
  );
}

/** The budget guard fires AFTER the iteration's generateContent completed — the call IS counted in apiCalls. */
export function inputBudgetExceeded(run: AgenticRun, state: LoopState): TextToolResult {
  const { iterations, cumulativeInputTokens } = state;
  const { maxTotalInputTokens } = run.limits;
  return errorResult(
    `ask_agentic: cumulative input tokens (${cumulativeInputTokens.toLocaleString()}) exceeded budget (${maxTotalInputTokens.toLocaleString()}) after ${iterations} iterations. Increase maxTotalInputTokens, narrow your prompt, or lower thinkingLevel.`,
    {
      errorCode: 'UNKNOWN',
      retryable: false,
      subReason: 'AGENTIC_INPUT_BUDGET_EXCEEDED',
      iterations,
      apiCalls: iterations,
      cumulativeInputTokens,
    },
  );
}

/**
 * R2 message enrichment (v1.16.1 — /6step PARTIAL TP): some MCP consumers (notably Claude Code's
 * tool-result rendering) collapse isError responses to the message string only and don't surface
 * `structuredContent` — wire format includes both per CallToolResultSchema (independent optional
 * fields) but rendering is consumer-side. Operator-actionable fields (iterations, filesRead) are
 * mirrored into the message string so they're visible regardless of consumer rendering. Dedupe fires
 * AFTER the iteration's generateContent completed — the call IS counted in apiCalls.
 */
export function noProgressDetected(state: LoopState, stuck: NoProgress): TextToolResult {
  const { iterations } = state;
  const filesRead = state.filesReadSet.size;
  const sig = stuck.signature;
  return errorResult(
    `ask_agentic: no-progress loop detected — call '${sig.slice(0, 200)}' was repeated ${stuck.count} times without new file reads between repeats (after ${iterations} iter${iterations === 1 ? '' : 's'}, ${filesRead} file${filesRead === 1 ? '' : 's'} read). Returning partial state.`,
    {
      errorCode: 'UNKNOWN',
      retryable: false,
      subReason: 'AGENTIC_NO_PROGRESS',
      iterations,
      apiCalls: iterations,
      repeatedSignature: sig.slice(0, 500),
      cumulativeInputTokens: state.cumulativeInputTokens,
      filesRead,
    },
  );
}

/**
 * The end of a loop that exhausted `maxIterations`: the forced answer when the finalization pass
 * produced text, else `AGENTIC_MAX_ITERATIONS`.
 *
 * Token totals are after the finalization pass. When the pass succeeded at the API level its tokens
 * ARE billed even if its text came back empty, so both results report the post-pass totals.
 * `apiCalls` counts the pass from its explicit `attempted` flag (set IMMEDIATELY BEFORE the dispatch)
 * rather than from its usage — timeouts and pre-response network failures leave usageMetadata empty
 * even though the request was sent. Skipped paths
 * (daily-budget reject) leave `attempted` false so they report `apiCalls = iterations`. Operators can
 * branch on `apiCalls > iterations` to detect the forced pass without parsing `convergenceForced`.
 */
export function maxIterationsResult(
  run: AgenticRun,
  state: LoopState,
  rescue: RescueOutcome,
): TextToolResult {
  const totals: AnswerTotals = {
    apiCalls: state.iterations + (rescue.attempted ? 1 : 0),
    inputTokens: state.cumulativeInputTokens + rescue.usage.promptTokenCount,
    outputTokens: state.cumulativeOutputTokens + rescue.usage.candidatesTokenCount,
    thinkingTokens: state.cumulativeThinkingTokens + rescue.usage.thoughtsTokenCount,
    thinkingSummary: rescue.thinkingSummary,
  };
  if (rescue.text.length > 0) {
    return textResult(rescue.text, answerFields(run, state, totals, 'forced'));
  }
  return rescueFailed(run, state, rescue, totals);
}

/**
 * The message of a forced pass that produced no answer: skipped for the daily budget, or ran and failed — a timeout then
 * says what fired and the knob that raises it, as a loop iteration's does.
 */
function rescueFailureMessage(run: AgenticRun, rescue: RescueOutcome): string {
  const head = `ask_agentic: reached maxIterations (${run.limits.maxIterations}) without a final answer`;
  if (rescue.skipReason === 'daily-budget') {
    return `${head}; forced-finalization pass skipped because daily budget cap reached. Wait for daily reset (UTC midnight) or raise GEMINI_DAILY_BUDGET_USD.`;
  }
  const remedy = 'Increase maxIterations or narrow your prompt.';
  if (rescue.timeout === null) return `${head}. ${remedy}`;
  const { timeout } = rescue;
  return `${head}; the forced-finalization pass ${timedOutAfter(timeout)}. ${timeoutHint(timeout, run.knobNames)} ${remedy}`;
}

/**
 * v1.14.2 Fix 5: the error message branches on whether the rescue was skipped due to daily-budget
 * exhaustion vs ran-and-failed (empty text / network error / timeout). The generic "Increase
 * maxIterations" message would lie to operators on the daily-budget skip path — the actual
 * remediation is to wait for daily reset or raise GEMINI_DAILY_BUDGET_USD. `finalizationSkipReason`
 * is present only when set.
 *
 * P4 (v1.15.0): `rescueErrorCode` is the caller-visible rescue failure-class, present when the rescue
 * ran-but-failed; absent when it was skipped (daily budget). Wrappers can branch retry behaviour on
 * this without log scraping. P8 (v1.15.0): thinking tokens are part of the failure-path cumulative
 * telemetry too, so a rescue-attempted-but-failed call does not under-report its billing footprint.
 * A pass booked before it failed (an empty text, a response that could not be read) reports its billed
 * fields, as a failed loop iteration does. A pass that timed out reports `timeoutPhase` (`tpm-wait` | `finalization`)
 * and `timeoutSource`, read from its clock.
 */
function rescueFailed(
  run: AgenticRun,
  state: LoopState,
  rescue: RescueOutcome,
  totals: AnswerTotals,
): TextToolResult {
  return errorResult(rescueFailureMessage(run, rescue), {
    errorCode: 'UNKNOWN',
    retryable: false,
    subReason: 'AGENTIC_MAX_ITERATIONS',
    ...(rescue.skipReason !== null ? { finalizationSkipReason: rescue.skipReason } : {}),
    ...(rescue.errorCode !== null ? { rescueErrorCode: rescue.errorCode } : {}),
    ...(rescue.timeout !== null
      ? { timeoutPhase: rescue.timeout.phase, timeoutSource: rescue.timeout.source }
      : {}),
    ...(rescue.errorMessage !== null ? { rescueErrorMessage: rescue.errorMessage } : {}),
    iterations: state.iterations,
    apiCalls: totals.apiCalls,
    cumulativeInputTokens: totals.inputTokens,
    cumulativeOutputTokens: totals.outputTokens,
    cumulativeThinkingTokens: totals.thinkingTokens,
    filesRead: state.filesReadSet.size,
    ...(rescue.billed ?? {}),
  });
}
