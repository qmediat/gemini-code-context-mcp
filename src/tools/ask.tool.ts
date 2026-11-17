/**
 * `ask` tool — Q&A / long-context analysis against a workspace.
 *
 * Sends the scanned workspace with the question. Implicit caching by default
 * (inline content, Gemini's automatic prefix cache); `cachingMode: 'explicit'`
 * uploads the workspace once and builds a persistent Context Cache (measured
 * 2026-04-22 on a 670 k-token workspace: first call ~125 s, repeats ~14 s).
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Content, GenerateContentConfig, ThinkingConfig, ThinkingLevel } from '@google/genai';
import { prepareContext } from '../cache/cache-manager.js';
import { cachingModeFor, cachingRan } from '../cache/caching-mode.js';
import { capThatRuns, thinkingBudgetRefusal } from '../gemini/long-decode.js';
import { resolveModel } from '../gemini/models.js';
import { estimatePreCallCostUsd, toMicrosUsd } from '../utils/cost-estimator.js';
import { logger } from '../utils/logger.js';
import { fallBackToAgentic } from './ask-agentic-fallback.js';
import {
  attachmentMetadata,
  attachmentsOrRefusal,
  inlineRequestRefusal,
} from './ask/attachments.js';
import { type AskInput, askInputSchema } from './ask/input.js';
import { SYSTEM_INSTRUCTION_Q_AND_A } from './ask/instruction.js';
import { type TextToolResult, type ToolDefinition, errorResult, textResult } from './registry.js';
import { decodeOnContext } from './shared/context-decode.js';
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
  scanForCall,
  workspaceRefusal,
} from './shared/eager-steps.js';
import {
  ServiceTierError,
  networkAttempts,
  resolveServiceTier,
  serviceTierConfig,
} from './shared/service-tier.js';
import { settleAnswer } from './shared/settle-call.js';
import { thinkingBudgetUnder, thinkingReserve } from './shared/thinking.js';

/**
 * Sentinel value in our internal normalisation for "user did not pass
 * thinkingBudget". We translate this into an OMITTED `thinkingBudget`
 * field on the wire — Gemini then uses each model's native default, which
 * per Google's Gemini 3 guide (https://ai.google.dev/gemini-api/docs/gemini-3)
 * is HIGH-dynamic on Gemini 3 Pro. Google flags explicit `thinkingBudget`
 * as the "legacy" path on Gemini 3 ("may result in unexpected performance"),
 * and we empirically observed Gemini 3 Pro hanging on low positive budgets
 * with cached content active (see docs/KNOWN-DEFICITS.md). Omitting the
 * field sidesteps both issues while still letting power users opt into
 * explicit budgets on Gemini 2.5 or for cost-bounded deep-dives.
 */
const THINKING_BUDGET_MODEL_DEFAULT = null;

// `THINKING_LEVELS` + `THINKING_LEVEL_RESERVE` live in `./shared/thinking.ts`
// so both `ask` and `code` share a single source of truth — when Google
// publishes per-tier token budgets, one edit propagates to both tools.

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
  const call = openEagerCall<ModelReached>(
    {
      tool: 'ask',
      knobs: input,
      requestedTier: input.serviceTier ?? ctx.config.serviceTier,
      workspaceRoot,
      started,
    },
    ctx,
  );
  const { emitter, completed, tracking, dispatch } = call;
  const timeoutController = call.timeout;
  const abortSignal = timeoutController.signal;
  try {
    const refusal = workspaceRefusal('ask', workspaceRoot);
    if (refusal !== null) return refusal;

    emitter.emit(`resolving model '${model}'…`);
    // `ask` accepts all three text-gen tiers — caller picks via alias
    // (`latest-pro` / `latest-flash` / `latest-lite` / `latest-vision`)
    // or literal model ID. Resolver refuses to dispatch to a category
    // outside this set — protects against an image/audio/agent model
    // slipping in (e.g. `nano-banana-pro-preview` pre-v1.4.0).
    const resolved = await resolveModel(model, ctx.client, {
      requiredCategory: ['text-reasoning', 'text-fast', 'text-lite'],
    });
    let serviceTier: 'standard' | 'flex';
    try {
      serviceTier = resolveServiceTier(
        input.serviceTier,
        ctx.config.serviceTier,
        ctx.config.vertex,
      );
    } catch (err) {
      if (!(err instanceof ServiceTierError)) throw err;
      return errorResult(`ask: ${err.message}`, {
        errorCode: err.code,
        retryable: false,
        serviceTier: 'flex',
        resolvedModel: resolved.resolved,
      });
    }
    call.trail.model = { resolvedModel: resolved.resolved, serviceTier };

    // Attachments ride with the prompt as inline parts. Inspected, read and counted here — before the scan, the
    // preflight, the budget reservation and the throttle: a bad file costs nothing.
    const attachmentsOutcome = await attachmentsOrRefusal(
      ctx.client,
      input.attachments ?? [],
      resolved,
      serviceTier,
      workspaceRoot,
      abortSignal,
    );
    if ('refusal' in attachmentsOutcome) return attachmentsOutcome.refusal;
    const attachments = attachmentsOutcome.prepared;
    const attachmentTokens = attachments.tokens;

    const scan = await scanForCall(call, ctx, {
      includeGlobs: input.includeGlobs,
      excludeGlobs: input.excludeGlobs,
      forceRescan: input.forceRescan,
    });
    const outputCap = eagerOutputCap(input.maxOutputTokens, ctx, resolved);

    // Single source of truth for "is the caller driving reasoning via the
    // discrete-tier knob?". Three downstream call sites branch on this
    // (cost estimate, emitter, thinkingConfig build) — extracting to a
    // named const keeps them in lockstep and makes future additions hard
    // to forget.
    const usingThinkingLevel = input.thinkingLevel !== undefined;

    // A positive `thinkingBudget` that leaves no answer reserve under the caller's own cap is refused
    // (`thinkingBudgetRefusal`); below, the budget on the wire is clamped under the cap that runs.
    const budgetRefusal = thinkingBudgetRefusal(
      input.thinkingBudget,
      input.maxOutputTokens,
      outputCap.effective,
    );
    if (budgetRefusal !== null) return errorResult(`ask: ${budgetRefusal}`);

    const { workspaceBytes, tokens: estimatedInputTokens } = estimateInput(
      scan,
      input.prompt,
      attachmentTokens,
    );
    const inlineRefusal = inlineRequestRefusal(attachments, scan.files, input.prompt, serviceTier);
    if (inlineRefusal !== undefined) return inlineRefusal;

    // The preflight refuses a workspace the model's window cannot hold (`WORKSPACE_TOO_LARGE`, not retryable): sent,
    // Gemini would answer 400 "exceeds maximum", which a caller cannot tell from a transient error.
    const count = await countPreflight(call, ctx, {
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

    const { cap: runCap, cut: inputWindowCut } = capThatRuns({
      tool: 'ask',
      cap: outputCap,
      promptTokens: preflight?.effectiveTokens,
      inputTokenLimit: resolved.inputTokenLimit,
      emit: (message) => emitter.emit(message),
    });

    // Normalise thinkingBudget:
    //   undefined → null (model-default path — `thinkingBudget` OMITTED on wire)
    //   -1        → -1  (explicit legacy dynamic; kept for Gemini 2.5 and
    //                    power-users who want to force the legacy path)
    //    0        →  0  (thinking disabled; Gemini 3 Pro will 400 here)
    //    N > 0    → clamp to [0, cap that runs - 1024] — the thinking
    //              pool is carved out of the candidate-output allowance,
    //              so reserving ≥1024 tokens for the answer prevents 400s
    //              when a caller passes N ≥ maxOutputTokens, and under a
    //              cap the input window cut to one request (its value on
    //              the wire) the budget stays below it.
    //
    // Schema `.refine()` guarantees `thinkingBudget` and `thinkingLevel`
    // are never both set, so we handle them in two mutually-exclusive
    // branches below.
    const rawThinkingBudget = input.thinkingBudget;
    const effectiveThinkingBudget: number | null =
      rawThinkingBudget === undefined
        ? THINKING_BUDGET_MODEL_DEFAULT
        : rawThinkingBudget === -1
          ? -1
          : rawThinkingBudget > 0
            ? thinkingBudgetUnder(runCap, rawThinkingBudget)
            : 0;
    // The thinking the budget reservation counts, from the cap that runs.
    const thinkingTokensForEstimate = thinkingReserve(
      input.thinkingLevel,
      effectiveThinkingBudget,
      runCap,
    );

    // Atomic budget reservation. Happens AFTER scan (so the estimate is
    // accurate) but BEFORE any billable upload or generateContent call.
    // Concurrent tool calls cannot all pass a pre-check and then
    // collectively overshoot the cap: `reserveBudget` uses a
    // `BEGIN IMMEDIATE` SQLite transaction that serialises check-and-insert.
    if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
      const estimateUsd = estimatePreCallCostUsd({
        model: resolved.resolved,
        serviceTier,
        extraInputTokens: attachmentTokens,
        workspaceBytes,
        promptChars: input.prompt.length,
        // Budget reservation uses the effective cap (explicit-user-cap
        // OR model's full limit) as `expectedOutputTokens` — a TRUE
        // upper bound, since Gemini's default stops at the model's
        // advertised `outputTokenLimit`.
        expectedOutputTokens: runCap.effective,
        // A cap above the per-request limit (long decode) adds the input every continuation request bills again.
        perRequestOutputTokens: runCap.perRequest,
        // The preflight's count, when it ran: the reservation takes the larger of it and the bytes/4 heuristic.
        countedInputTokens: preflight?.effectiveTokens,
        thinkingTokens: thinkingTokensForEstimate,
        coverMs: timeoutController.timeoutMs,
      });
      const reserve = ctx.manifest.reserveBudget({
        workspaceRoot,
        toolName: 'ask',
        model: resolved.resolved,
        estimatedCostMicros: toMicrosUsd(estimateUsd),
        dailyBudgetMicros: toMicrosUsd(ctx.config.dailyBudgetUsd),
        nowMs: Date.now(),
      });
      if ('rejected' in reserve) {
        const spentUsd = reserve.spentMicros / 1_000_000;
        return errorResult(
          `Daily budget cap would be exceeded: spent $${spentUsd.toFixed(4)} + estimate $${estimateUsd.toFixed(4)} > cap $${ctx.config.dailyBudgetUsd.toFixed(2)}. Retry after UTC midnight, or raise \`GEMINI_DAILY_BUDGET_USD\`.`,
          { errorCode: 'BUDGET_REJECT', retryable: false, serviceTier },
        );
      }
      call.trail.reservationId = reserve.id;
    }

    const systemPromptHash = createHash('sha256')
      .update(SYSTEM_INSTRUCTION_Q_AND_A)
      .digest('hex')
      .slice(0, 16);

    // v1.14.0 — `cachingMode` default flipped to `'implicit'`: Gemini 2.5+/3
    // Pro applies its automatic implicit caching to repeated workspace prefixes,
    // eliminating the 60–180 s `caches.create` rebuild wait on the
    // review→edit→review path. Per-call `input.cachingMode` always wins;
    // env-level override `GEMINI_CODE_CONTEXT_CACHING_MODE` lets operators force
    // `'explicit'` when they need predictable per-call billing more than
    // warm-path speed. Telemetry on the actual mode (vs requested) is computed
    // AFTER `prepareContext` returns from `activePrep.inlineOnly` — see FN2 fix.
    const caching = cachingModeFor(input.cachingMode ?? ctx.config.cachingMode, resolved, emitter);
    const requestedCachingMode = caching.mode;

    // The context of the call: built here, and again by the stale-cache retry on a fresh cache.
    const prepare = () =>
      prepareContext({
        client: ctx.client,
        manifest: ctx.manifest,
        scan,
        model: resolved,
        systemPromptHash,
        systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
        ttlSeconds: ctx.config.cacheTtlSeconds,
        cacheMinTokens: ctx.config.cacheMinTokens,
        emitter,
        allowCaching: !input.noCache && scan.files.length > 0,
        // v1.12.1 — let `timeoutMs` interrupt the upload phase too.
        signal: abortSignal,
        // v1.13.0 — opt-in implicit caching path (skip caches.create).
        cachingMode: requestedCachingMode,
      });
    const ctxPrep = await prepare();

    emitter.emit(
      usingThinkingLevel
        ? `generating response (thinking-level=${input.thinkingLevel})…`
        : effectiveThinkingBudget === null
          ? 'generating response (thinking=model-default)…'
          : effectiveThinkingBudget === -1
            ? 'generating response (thinking=dynamic)…'
            : `generating response (thinking=${effectiveThinkingBudget})…`,
    );
    // Gemini rejects `generateContent({cachedContent, systemInstruction})` with 400:
    // "CachedContent can not be used with GenerateContent request setting
    //  system_instruction, tools or tool_config. Move those values to CachedContent."
    // The system instruction was already baked into the cache at build time
    // (see cache-manager.ts:322 `cacheConfig.systemInstruction`), so we must
    // OMIT it on the generate call when a cached context is active.
    // `thinkingConfig` is NOT one of the forbidden fields — it is a
    // per-request reasoning control and travels with every call regardless
    // of cache state. We always set `includeThoughts: true` so callers see
    // Gemini's reasoning digest in the response.
    //
    // Three mutually-exclusive reasoning-control paths (enforced by
    // schema `.refine()`):
    //   a) `thinkingLevel` set → pass it through to the SDK enum. Google's
    //      recommended path on Gemini 3. Rejected by Gemini 2.5 family.
    //   b) `thinkingBudget` set (non-null after normalisation) → legacy
    //      budget path. Required on Gemini 2.5; flagged as "legacy" on
    //      Gemini 3 but still supported.
    //   c) neither set → omit both fields, keep only `includeThoughts`.
    //      Model uses its native default (HIGH-dynamic on Gemini 3 Pro).
    //
    // `maxOutputTokens` is only passed on the wire when the caller set
    // `input.maxOutputTokens` — otherwise we omit it and Gemini uses
    // its model-default cap (per docs, = the model's advertised
    // `outputTokenLimit`, currently 65,536 for pro-tier 3.x/2.5). Budget
    // reservation always uses the cap the decode runs under (explicit cap
    // OR model limit, cut by the input window on a long decode) as the
    // worst-case upper bound of what a completed request bills.
    // Cast to `ThinkingLevel` rather than indexing the runtime enum object
    // (`ThinkingLevel[input.thinkingLevel]`). For string enums the value
    // IS the member name, so passing `"HIGH"` as `ThinkingLevel` is
    // semantically identical at runtime — but it survives SDK renames:
    // if a future `@google/genai` release renames a member, the literal
    // string reaches Gemini's wire, which 400s with a clear message
    // instead of silently becoming `undefined` at the indexing step.
    const thinkingConfig: ThinkingConfig = usingThinkingLevel
      ? {
          thinkingLevel: input.thinkingLevel as ThinkingLevel,
          includeThoughts: true,
        }
      : effectiveThinkingBudget === null
        ? { includeThoughts: true }
        : { thinkingBudget: effectiveThinkingBudget, includeThoughts: true };
    const tierField = serviceTierConfig(serviceTier);
    const buildConfig = (cacheId: string | null): GenerateContentConfig => {
      const maxOutputField = runCap.wire !== undefined ? { maxOutputTokens: runCap.wire } : {};
      return cacheId
        ? { cachedContent: cacheId, thinkingConfig, ...maxOutputField, ...tierField }
        : {
            systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
            thinkingConfig,
            ...maxOutputField,
            ...tierField,
          };
    };
    // The user turn: the attachments first, the question last; with a cache the turn still carries the parts.
    const userTurn: Content = {
      role: 'user',
      parts: [...attachments.parts, { text: input.prompt }],
    };
    const buildContents = (
      cacheId: string | null,
      inline: typeof ctxPrep.inlineContents,
    ): string | Content[] => {
      if (cacheId) return attachments.parts.length === 0 ? input.prompt : [userTurn];
      return [...inline, userTurn];
    };

    // The decode — and, on a stale cache before any request completed, its one retry on a rebuilt cache. The TPM
    // reservation is taken here, after `prepareContext` and immediately before the first request, so its timestamp
    // is when the tokens reach Gemini's quota counter; only the OPENING of a request is retried (a mid-stream
    // failure re-sent would bill the work again).
    const decoded = await decodeOnContext(
      {
        client: ctx.client,
        booking: { workspaceRoot, toolName: 'ask', model: resolved.resolved, serviceTier },
        cachingMode: (prep) => cachingRan(prep, caching).mode,
        request: (prep) => ({
          contents: buildContents(prep.cacheId, prep.inlineContents),
          config: buildConfig(prep.cacheId),
        }),
        cache: {
          ttlWatcher: ctx.ttlWatcher,
          manifest: ctx.manifest,
          ttlSeconds: ctx.config.cacheTtlSeconds,
          prepare,
        },
        openAttempts: networkAttempts(serviceTier), // a flex request is never re-sent
        limits: { maxRequests: runCap.maxRequests, cap: runCap.effective },
        timeout: timeoutController,
        emit: (message) => emitter.emit(message),
        completed,
        tracking,
        throttle: dispatch,
        inputTokens: { estimated: estimatedInputTokens, counted: preflight?.effectiveTokens },
      },
      ctxPrep,
    );
    const { response, prep: activePrep, retriedOnStaleCache } = decoded;

    const text = response.text;

    // `collectStream` already aggregated thought-flagged parts and capped
    // the joined summary at 1200 chars (T20). Reuse directly — re-iterating
    // `response.candidates` would risk drift between in-flight thought
    // emit (live progress) and post-call summary.
    const thinkingSummary = response.thoughtsSummary;

    // Telemetry and the response record the mode that ran, not the one asked for.
    const ran = cachingRan(activePrep, caching);
    const effectiveCachingMode = ran.mode;

    const durationMs = Date.now() - started;
    // Settled here, once: the outer catch then neither releases the reservation nor books the call again. What the
    // API billed is every request that completed, over a long decode and a stale-cache retry alike.
    const settledReservation = call.trail.reservationId;
    call.trail.reservationId = null;
    tracking.ledgerEntry = null;
    const settled = settleAnswer({
      manifest: ctx.manifest,
      reservationId: settledReservation,
      entry: {
        workspaceRoot,
        toolName: 'ask',
        model: resolved.resolved,
        serviceTier,
        cachingMode: effectiveCachingMode,
      },
      completed,
      response,
      cap: runCap,
      cut: inputWindowCut,
      durationMs,
    });
    const finish = settled.finish;

    // Settled and billed above; an empty answer at the cap is a failure the caller can act on, never a success.
    if (settled.outputCapStop !== null) {
      return errorResult(`ask: ${settled.outputCapStop.message}`, settled.outputCapStop.fields);
    }

    if (scan.truncated) {
      logger.warn(
        `workspace ${workspaceRoot} contains more files than GEMINI_CODE_CONTEXT_MAX_FILES (${ctx.config.maxFilesPerWorkspace}); the tail was dropped before indexing.`,
      );
    }

    const metadata: Record<string, unknown> = {
      resolvedModel: resolved.resolved,
      requestedModel: resolved.requested,
      serviceTier,
      ...attachmentMetadata(attachments),
      fallbackApplied: resolved.fallbackApplied,
      modelCategory: resolved.category,
      modelCostTier: resolved.capabilities.costTier,
      contextWindow: resolved.inputTokenLimit,
      thinkingBudget: effectiveThinkingBudget,
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
      // v1.21.0+: what the scan left out — the excluded directories it met and the files that are neither source by
      // extension nor a `#!` script — so a caller can tell "not in the workspace" from "not indexed".
      excludedDirs: scan.excludedDirs,
      excludedDirsTotal: scan.excludedDirsTotal,
      filesSkippedNonSource: scan.skippedNonSource,
      filesUploadFailed: activePrep.uploaded.failedCount,
      ...(activePrep.uploaded.failedCount > 0
        ? { uploadFailures: activePrep.uploaded.failures.slice(0, 5) }
        : {}),
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
    return askFailedResult(settleFailedEager(call, ctx, err));
  } finally {
    closeEagerCall(call);
  }
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
