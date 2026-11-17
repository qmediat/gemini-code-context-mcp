/**
 * The results an `ask` call returns from its budget reservation on: the refusal over the daily budget, the stop at the
 * output cap, the answer, and the result of a failed call. Each keeps `ask`'s own fields and their order.
 */

import type { PreparedContext } from '../../cache/cache-manager.js';
import { type TextToolResult, errorResult, textResult } from '../registry.js';
import type { ContextDecode } from '../shared/context-decode.js';
import { type SettledDecode, scanFields } from '../shared/eager-answer.js';
import type { FailedEagerCall, ModelReached } from '../shared/eager-call.js';
import { preflightFields } from '../shared/eager-steps.js';
import type { OutputCapStop } from '../shared/settle-call.js';
import { attachmentMetadata } from './attachments.js';
import type { AskSized } from './call.js';
import { thinkingBudgetField } from './thinking.js';

/** The daily budget would be exceeded: nothing was reserved. */
export function budgetRejectResult(call: AskSized, message: string): TextToolResult {
  return errorResult(message, {
    errorCode: 'BUDGET_REJECT',
    retryable: false,
    serviceTier: call.serviceTier,
  });
}

/** Settled and billed: an empty answer at the output cap is a failure the caller can act on, never a success. */
export function outputCapResult(stop: OutputCapStop): TextToolResult {
  return errorResult(`ask: ${stop.message}`, stop.fields);
}

/** The answer, its text and what the call ran on, billed and decoded. */
export function answerResult(
  call: AskSized,
  decoded: ContextDecode,
  settledDecode: SettledDecode,
): TextToolResult {
  const { response } = decoded;
  // `collectStream` aggregated the thought-flagged parts and capped the joined summary at 1200 chars: reused as it
  // is, so the summary never drifts from the thoughts emitted live.
  const thinkingSummary = response.thoughtsSummary;
  return textResult(response.text, {
    ...modelFields(call),
    ...decodeFields(decoded, settledDecode),
    ...workspaceFields(call, decoded.prep),
    ...preflightFields(call.count),
    durationMs: settledDecode.durationMs,
    ...(thinkingSummary ? { thinkingSummary } : {}),
  });
}

/** The model, the tier, the attachments and the thinking the call ran with. */
function modelFields(call: AskSized): Record<string, unknown> {
  const { resolved } = call;
  return {
    resolvedModel: resolved.resolved,
    requestedModel: resolved.requested,
    serviceTier: call.serviceTier,
    ...attachmentMetadata(call.attachments),
    fallbackApplied: resolved.fallbackApplied,
    modelCategory: resolved.category,
    modelCostTier: resolved.capabilities.costTier,
    contextWindow: resolved.inputTokenLimit,
    thinkingBudget: thinkingBudgetField(call.thinking),
    thinkingLevel: call.input.thinkingLevel ?? null,
  };
}

/** What the decode billed, how it ended and the context it ran on. */
function decodeFields(
  decoded: ContextDecode,
  settledDecode: SettledDecode,
): Record<string, unknown> {
  const { prep: activePrep, retriedOnStaleCache } = decoded;
  const { settled, ran } = settledDecode;
  return {
    ...settled.usage,
    ...settled.cutFields,
    // `truncated`: the answer stopped at the output cap (MAX_TOKENS, or a long decode at its limits) — it is cut
    finishReason: settled.finish.finishReason,
    truncated: settled.finish.truncated,
    cacheHit: activePrep.reused,
    cacheRebuilt: activePrep.rebuilt || retriedOnStaleCache,
    retriedOnStaleCache,
    inlineOnly: activePrep.inlineOnly,
    cachingMode: ran.mode,
    ...(ran.note !== null ? { cachingModeNote: ran.note } : {}),
  };
}

/** What the scan indexed, skipped and dropped, and what the upload could not send. */
function workspaceFields(call: AskSized, prep: PreparedContext): Record<string, unknown> {
  const { scan } = call;
  return {
    filesIndexed: scan.files.length,
    filesSkippedTooLarge: scan.skippedTooLarge,
    ...scanFields(scan, prep),
    workspaceTruncated: scan.truncated,
    maxFilesCap: call.ctx.config.maxFilesPerWorkspace,
  };
}

/**
 * `ask`'s result of a failed call: the resolved tier, else the one requested. A timeout has its own `errorCode` so a
 * caller can tell "Gemini was slow" from a refusal, and `timeoutKind` (`total` / `stall`) tells the wall-clock cap
 * from the heartbeat-aware stall watchdog (a caller may retry on a stall and not on the total).
 */
export function failedResult(failure: FailedEagerCall<ModelReached>): TextToolResult {
  const serviceTier = failure.model?.serviceTier ?? failure.requestedTier;
  if (failure.kind === 'timeout') {
    return errorResult(failure.timedOut.message, {
      errorCode: 'TIMEOUT',
      timeoutKind: failure.timedOut.kind,
      timeoutMs: failure.timeoutMs,
      stallMs: failure.stallMs,
      retryable: true,
      serviceTier,
      ...failure.usage,
    });
  }
  return errorResult(failure.message, {
    ...failure.tierMeta,
    serviceTier,
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    ...failure.usage,
  });
}
