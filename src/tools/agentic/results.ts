/**
 * The results `ask_agentic` returns once the loop has started: the answer (organic or forced), and every error that
 * ends the loop. `apiCalls` is the authoritative total `generateContent` count on every one of them.
 */

import { type TextToolResult, errorResult, textResult } from '../registry.js';
import type { TimeoutController, TimeoutKind } from '../shared/abort-timeout.js';
import type { NoProgress } from './no-progress.js';
import type { RescueOutcome } from './rescue.js';
import type { AgenticRun, LoopState } from './run.js';

/** The figures an answer reports that differ between the organic and the forced answer. */
interface AnswerTotals {
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  thinkingSummary: string | null;
  convergenceForced: boolean;
}

/** An answer's structured fields; `overBudget` says whether its input tokens passed `maxTotalInputTokens`. */
function answerFields(run: AgenticRun, state: LoopState, totals: AnswerTotals) {
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
    ...(totals.convergenceForced ? { convergenceForced: true } : {}),
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
    answerFields(run, state, {
      apiCalls: state.iterations,
      inputTokens: state.cumulativeInputTokens,
      outputTokens: state.cumulativeOutputTokens,
      thinkingTokens: state.cumulativeThinkingTokens,
      thinkingSummary,
      convergenceForced: false,
    }),
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

/** How an iteration timed out: the controller that fired, which of its limits, and whether the call was dispatched. */
export interface IterationTimeout {
  controller: TimeoutController;
  kind: TimeoutKind;
  /** The limit that fired, in ms (`null` when not configured). */
  limitMs: number | null;
  dispatched: boolean;
}

/**
 * The whole agentic call fails on an iteration timeout — the failed iteration's function-call results
 * never came back, so the conversation is structurally incomplete.
 *
 * The structuredContent payload mirrors `ask.tool.ts` exactly: `timeoutMs` always reports the
 * configured TOTAL wall-clock cap (or null if disabled), `stallMs` reports the configured stall
 * watchdog. The `timeoutKind` field is the discriminator. Pre-fix (v1.16.2 PR-Round-1) this collapsed
 * to "the limit that fired" — diverged from ask/code; flagged by gemini Round-1 as a contract
 * regression. Reverted to ask/code parity.
 *
 * H2 fix: `dispatched` distinguishes timeout-during-throttle-wait (no dispatch) from
 * timeout-during-generateContent (dispatch happened). If it is false, the timeout fired during
 * abortableSleep and this iter never reached the API: subtract 1 to keep apiCalls authoritative.
 */
export function iterationTimedOut(iterations: number, timeout: IterationTimeout): TextToolResult {
  const { controller, kind, limitMs } = timeout;
  const knobHint =
    kind === 'stall'
      ? 'Increase `stallMs` per call or set `GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS` higher; default disabled. Stall fires when the stream goes silent — usually a dead socket or a Gemini server-side hiccup.'
      : 'Increase `iterationTimeoutMs` per call or set `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS` higher; default disabled.';
  return errorResult(
    `ask_agentic: iteration ${iterations} timed out (${kind}) after ${limitMs ?? '?'}ms. ${knobHint} Note: AbortSignal is client-only — Gemini may still finish server-side and bill tokens for completed work.`,
    {
      errorCode: 'TIMEOUT',
      timeoutMs: controller.timeoutMs,
      stallMs: controller.stallMs,
      timeoutKind: kind,
      iteration: iterations,
      iterations,
      apiCalls: timeout.dispatched ? iterations : Math.max(0, iterations - 1),
      retryable: true,
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
 * even though the API attempt happened (and may have been billed server-side). Skipped paths
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
    convergenceForced: true,
  };
  if (rescue.text.length > 0) {
    return textResult(rescue.text, answerFields(run, state, totals));
  }
  return rescueFailed(run, state, rescue, totals);
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
 */
function rescueFailed(
  run: AgenticRun,
  state: LoopState,
  rescue: RescueOutcome,
  totals: AnswerTotals,
): TextToolResult {
  const { maxIterations } = run.limits;
  const errorMessage =
    rescue.skipReason === 'daily-budget'
      ? `ask_agentic: reached maxIterations (${maxIterations}) without a final answer; forced-finalization pass skipped because daily budget cap reached. Wait for daily reset (UTC midnight) or raise GEMINI_DAILY_BUDGET_USD.`
      : `ask_agentic: reached maxIterations (${maxIterations}) without a final answer. Increase maxIterations or narrow your prompt.`;
  return errorResult(errorMessage, {
    errorCode: 'UNKNOWN',
    retryable: false,
    subReason: 'AGENTIC_MAX_ITERATIONS',
    ...(rescue.skipReason !== null ? { finalizationSkipReason: rescue.skipReason } : {}),
    ...(rescue.errorCode !== null ? { rescueErrorCode: rescue.errorCode } : {}),
    ...(rescue.errorMessage !== null ? { rescueErrorMessage: rescue.errorMessage } : {}),
    iterations: state.iterations,
    apiCalls: totals.apiCalls,
    cumulativeInputTokens: totals.inputTokens,
    cumulativeOutputTokens: totals.outputTokens,
    cumulativeThinkingTokens: totals.thinkingTokens,
    filesRead: state.filesReadSet.size,
  });
}
