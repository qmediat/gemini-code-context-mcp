/**
 * `ask` tool — Q&A / long-context analysis against a workspace.
 *
 * Sends the scanned workspace with the question. Implicit caching by default
 * (inline content, Gemini's automatic prefix cache); `cachingMode: 'explicit'`
 * uploads the workspace once and builds a persistent Context Cache (measured
 * 2026-04-22 on a 670 k-token workspace: first call ~125 s, repeats ~14 s).
 */

import { resolve } from 'node:path';
import { capThatRuns, thinkingBudgetRefusal } from '../gemini/long-decode.js';
import { fallBackToAgentic } from './ask-agentic-fallback.js';
import { attachAsk, attachmentMetadata, inlineRequestRefusal } from './ask/attachments.js';
import type { StepOutcome } from './ask/call.js';
import { type AskInput, askInputSchema } from './ask/input.js';
import { SYSTEM_INSTRUCTION_Q_AND_A } from './ask/instruction.js';
import { askRequest } from './ask/request.js';
import { resolveAsk } from './ask/setup.js';
import { askThinking, generatingLine, thinkingBudgetField } from './ask/thinking.js';
import { type TextToolResult, type ToolDefinition, errorResult, textResult } from './registry.js';
import {
  decodeEagerCall,
  prepareCallContext,
  scanFields,
  settleDecoded,
  warnTruncatedScan,
} from './shared/eager-answer.js';
import {
  type FailedEagerCall,
  type ModelReached,
  closeEagerCall,
  openEagerCall,
  settleFailedEager,
} from './shared/eager-call.js';
import {
  countPreflight,
  eagerOutputCap,
  estimateInput,
  reserveCallBudget,
  scanForCall,
  workspaceRefusal,
} from './shared/eager-steps.js';
import { thinkingReserve } from './shared/thinking.js';

export { askInputSchema, type AskInput };

export const askTool: ToolDefinition<AskInput> = {
  name: 'ask',
  title: 'Ask Gemini',
  description:
    'Primary tool for codebase Q&A on workspaces that fit the model input-token limit (~1M tokens for Gemini Pro — covers most repos). Eager: the scanned workspace goes with the question (implicit caching by default; `cachingMode: "explicit"` builds a persistent Context Cache — measured ~8× faster and ~4× cheaper on repeat queries than sending the codebase inline). Falls back to `ask_agentic` automatically when the workspace exceeds the limit (set `onWorkspaceTooLarge: "fallback-to-agentic"`). For repos that genuinely exceed 1M tokens or when only a handful of files matter, call `ask_agentic` directly.',
  schema: askInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    const model = input.model ?? ctx.config.defaultModel;
    return executeAskBody(input, ctx, workspaceRoot, model, started);
  },
};

async function executeAskBody(
  input: AskInput,
  ctx: Parameters<typeof askTool.execute>[1],
  workspaceRoot: string,
  model: string,
  started: number,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const eager = openEagerCall<ModelReached>(
    {
      tool: 'ask',
      knobs: input,
      requestedTier: input.serviceTier ?? ctx.config.serviceTier,
      workspaceRoot,
      started,
    },
    ctx,
  );
  const { emitter } = eager;
  const timeoutController = eager.timeout;
  try {
    const refusal = workspaceRefusal('ask', workspaceRoot);
    if (refusal !== null) return refusal;

    const resolvedStep = await resolveAsk({ input, ctx, model, eager });
    if (!('next' in resolvedStep)) return endOf(resolvedStep);
    const attachedStep = await attachAsk(resolvedStep.next);
    if (!('next' in attachedStep)) return endOf(attachedStep);
    const { resolved, serviceTier, attachments } = attachedStep.next;
    const attachmentTokens = attachments.tokens;

    const scan = await scanForCall(eager, ctx, {
      includeGlobs: input.includeGlobs,
      excludeGlobs: input.excludeGlobs,
      forceRescan: input.forceRescan,
    });
    const outputCap = eagerOutputCap(input.maxOutputTokens, ctx, resolved);

    // A positive `thinkingBudget` that leaves no answer reserve under the caller's own cap is refused
    // (`thinkingBudgetRefusal`); below, the budget on the wire is clamped under the cap that runs.
    const budgetRefusal = thinkingBudgetRefusal(
      input.thinkingBudget,
      input.maxOutputTokens,
      outputCap.effective,
    );
    if (budgetRefusal !== null) return errorResult(`ask: ${budgetRefusal}`);

    const estimate = estimateInput(scan, input.prompt, attachmentTokens);
    const inlineRefusal = inlineRequestRefusal(attachments, scan.files, input.prompt, serviceTier);
    if (inlineRefusal !== undefined) return inlineRefusal;

    // The preflight refuses a workspace the model's window cannot hold (`WORKSPACE_TOO_LARGE`, not retryable): sent,
    // Gemini would answer 400 "exceeds maximum", which a caller cannot tell from a transient error.
    const count = await countPreflight(eager, ctx, {
      scan,
      prompt: input.prompt,
      resolved,
      mode: input.preflightMode,
      cap: outputCap,
      extraTokens: attachmentTokens,
    });
    const preflight = count?.preflight;
    if (count !== null && count.preflight.effectiveTokens > count.threshold) {
      const { threshold, contextWindow } = count;
      const counted = count.preflight;
      const pctDisplay = Math.round(ctx.config.workspaceGuardRatio * 100);

      // v1.11.0 — opt-in transparent fallback to `ask_agentic` when the
      // caller explicitly asked for it via `onWorkspaceTooLarge:
      // 'fallback-to-agentic'`. Default stays `'error'` so pre-v1.11.0
      // callers see identical behaviour. The fallback re-uses this
      // tool's resolved inputs (model / globs / thinking config /
      // workspace) and forwards its resolved `timeoutMs` as `iterationTimeoutMs`
      // (per-iteration cap; total wall-clock can be N × that) and `stallMs` as
      // `stallMs` (`ask-agentic-fallback.ts`). Cost + timing shape genuinely
      // changes — opt-in is the right default.
      if (input.onWorkspaceTooLarge === 'fallback-to-agentic' && attachments.attached.length > 0) {
        return errorResult(
          'ask: the workspace is too large for the eager path and `attachments` cannot follow the ask_agentic fallback (it sends no inline parts); drop the attachments or narrow the workspace',
          {
            errorCode: 'WORKSPACE_TOO_LARGE',
            retryable: false,
            serviceTier,
            ...attachmentMetadata(attachments),
          },
        );
      }
      if (input.onWorkspaceTooLarge === 'fallback-to-agentic') {
        return fallBackToAgentic({
          input,
          ctx,
          emitter,
          serviceTier,
          preflight: counted,
          threshold,
          timeout: timeoutController,
        });
      }

      const attachmentsNote =
        attachments.attached.length > 0
          ? ' — it carries no attachments: drop them, or narrow the workspace and ask again'
          : '';

      return errorResult(
        `Workspace too large: ~${counted.effectiveTokens.toLocaleString()} input tokens (${counted.method} count) exceeds ${threshold.toLocaleString()} (${pctDisplay}% of ${resolved.resolved}'s ${contextWindow.toLocaleString()} context window). Best option: use \`mcp__gemini-code-context__ask_agentic\` — same model, but it reads only the files it needs via sandboxed tool calls (no eager repo upload)${attachmentsNote}. Or set \`onWorkspaceTooLarge: 'fallback-to-agentic'\` on \`ask\` to have the server route automatically. Other options: (a) pass \`excludeGlobs\` to filter large/generated files — supports \`*.ext\` patterns, filenames, and directory paths, (b) narrow with \`includeGlobs\`, (c) switch to a larger-context model, or (d) split the workspace into subdirectories.`,
        {
          errorCode: 'WORKSPACE_TOO_LARGE',
          serviceTier,
          ...attachmentMetadata(attachments),
          retryable: false,
          estimatedInputTokens: counted.effectiveTokens,
          tokenCountMethod: counted.method,
          rawTokenCount: counted.rawTokens,
          tokenCountCacheHit: counted.cacheHit,
          contextWindowTokens: contextWindow,
          thresholdTokens: threshold,
          guardRatio: ctx.config.workspaceGuardRatio,
          resolvedModel: resolved.resolved,
          filesIndexed: scan.files.length,
        },
      );
    }

    const bounded = capThatRuns({
      tool: 'ask',
      cap: outputCap,
      promptTokens: preflight?.effectiveTokens,
      inputTokenLimit: resolved.inputTokenLimit,
      emit: (message) => emitter.emit(message),
    });
    const runCap = bounded.cap;

    const thinking = askThinking(input, runCap);
    // The thinking the budget reservation counts, from the cap that runs.
    const thinkingTokensForEstimate = thinkingReserve(
      input.thinkingLevel,
      thinkingBudgetField(thinking),
      runCap,
    );

    const reservation = reserveCallBudget(eager, ctx, {
      resolved,
      serviceTier,
      estimate,
      promptChars: input.prompt.length,
      extraInputTokens: attachmentTokens,
      cap: runCap,
      countedInputTokens: preflight?.effectiveTokens,
      thinkingTokens: thinkingTokensForEstimate,
    });
    if (reservation.kind === 'rejected') {
      return errorResult(reservation.message, {
        errorCode: 'BUDGET_REJECT',
        retryable: false,
        serviceTier,
      });
    }

    const context = await prepareCallContext(eager, ctx, {
      scan,
      resolved,
      systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
      allowCaching: !input.noCache && scan.files.length > 0,
      requestedMode: input.cachingMode ?? ctx.config.cachingMode,
    });
    const { caching } = context;

    emitter.emit(generatingLine(thinking));

    const decoded = await decodeEagerCall(
      eager,
      ctx,
      {
        resolved,
        serviceTier,
        request: askRequest(input, attachments, thinking, runCap, serviceTier),
        cap: runCap,
        estimate,
        countedInputTokens: preflight?.effectiveTokens,
      },
      context,
    );
    const { response, prep: activePrep, retriedOnStaleCache } = decoded;

    const text = response.text;

    // `collectStream` already aggregated thought-flagged parts and capped
    // the joined summary at 1200 chars (T20). Reuse directly — re-iterating
    // `response.candidates` would risk drift between in-flight thought
    // emit (live progress) and post-call summary.
    const thinkingSummary = response.thoughtsSummary;

    const { settled, ran, durationMs } = settleDecoded(eager, ctx, decoded, {
      resolved,
      serviceTier,
      caching,
      bounded,
    });
    const effectiveCachingMode = ran.mode;
    const finish = settled.finish;

    // Settled and billed above; an empty answer at the cap is a failure the caller can act on, never a success.
    if (settled.outputCapStop !== null) {
      return errorResult(`ask: ${settled.outputCapStop.message}`, settled.outputCapStop.fields);
    }

    warnTruncatedScan(eager, ctx, scan);

    const metadata: Record<string, unknown> = {
      resolvedModel: resolved.resolved,
      requestedModel: resolved.requested,
      serviceTier,
      ...attachmentMetadata(attachments),
      fallbackApplied: resolved.fallbackApplied,
      modelCategory: resolved.category,
      modelCostTier: resolved.capabilities.costTier,
      contextWindow: resolved.inputTokenLimit,
      thinkingBudget: thinkingBudgetField(thinking),
      thinkingLevel: input.thinkingLevel ?? null,
      ...settled.usage,
      ...settled.cutFields,
      // `truncated`: the answer stopped at the output cap (MAX_TOKENS, or a long decode at its limits) — it is cut
      finishReason: finish.finishReason,
      truncated: finish.truncated,
      cacheHit: activePrep.reused,
      cacheRebuilt: activePrep.rebuilt || retriedOnStaleCache,
      retriedOnStaleCache,
      inlineOnly: activePrep.inlineOnly,
      cachingMode: effectiveCachingMode,
      ...(ran.note !== null ? { cachingModeNote: ran.note } : {}),
      filesIndexed: scan.files.length,
      filesSkippedTooLarge: scan.skippedTooLarge,
      ...scanFields(scan, activePrep),
      workspaceTruncated: scan.truncated,
      maxFilesCap: ctx.config.maxFilesPerWorkspace,
      // Preflight token-count provenance — surfaces on every successful
      // call so orchestrators / observability layers can see which path
      // produced the count (`'heuristic'`, `'exact'`, `'fallback'`),
      // whether the LRU saved an API round-trip, and the raw count
      // before `SYSTEM_INSTRUCTION_RESERVE` was applied. Omitted when
      // the resolved model had no `inputTokenLimit` (preflight skipped).
      ...(preflight !== undefined
        ? {
            tokenCountMethod: preflight.method,
            rawTokenCount: preflight.rawTokens,
            tokenCountCacheHit: preflight.cacheHit,
          }
        : {}),
      durationMs,
      ...(thinkingSummary ? { thinkingSummary } : {}),
    };

    return textResult(text, metadata);
  } catch (err) {
    return askFailedResult(settleFailedEager(eager, ctx, err));
  } finally {
    closeEagerCall(eager);
  }
}

/**
 * What ends the call before its answer: a refusal, or the `ask_agentic` fallback still pending — returned unawaited
 * from inside the call's `try`, so the `finally` runs while the fallback runs and a rejection of the fallback never
 * reaches the call's failure path.
 */
function endOf(
  outcome: Exclude<StepOutcome<unknown>, { readonly next: unknown }>,
): TextToolResult | Promise<TextToolResult> {
  return 'end' in outcome ? outcome.end : outcome.handOff;
}

/** `ask`'s result of a failed call: the resolved tier, else the one requested. */
function askFailedResult(failure: FailedEagerCall<ModelReached>): TextToolResult {
  const serviceTier = failure.model?.serviceTier ?? failure.requestedTier;
  // Timeout-driven abort gets a dedicated errorCode so callers can
  // distinguish "Gemini was slow" from "schema invalid" / "auth failed".
  // `timeoutKind` ('total' | 'stall') distinguishes the
  // wall-clock cap from the heartbeat-aware stall watchdog so callers
  // can apply different policies (e.g. retry on stall but not on total).
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
