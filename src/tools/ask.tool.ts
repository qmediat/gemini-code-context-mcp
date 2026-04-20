/**
 * `ask` tool — Q&A / long-context analysis against a workspace.
 *
 * Uses the Persistent Context Cache when available, reducing repeat-query cost
 * and latency. First call on a workspace: ~30–45 s (upload + build). Subsequent
 * calls with unchanged files: ~2–3 s.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponse,
  ThinkingConfig,
  ThinkingLevel,
} from '@google/genai';
import { z } from 'zod';
import { isStaleCacheError, markCacheStale, prepareContext } from '../cache/cache-manager.js';
import { resolveModel } from '../gemini/models.js';
import { scanWorkspace } from '../indexer/workspace-scanner.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../indexer/workspace-validation.js';
import { estimateCostUsd, estimatePreCallCostUsd, toMicrosUsd } from '../utils/cost-estimator.js';
import { logger } from '../utils/logger.js';
import { createProgressEmitter } from '../utils/progress.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';
import { THINKING_LEVELS, THINKING_LEVEL_RESERVE } from './shared/thinking.js';
import { isGemini429, parseRetryDelayMs } from './shared/throttle.js';

const SYSTEM_INSTRUCTION_Q_AND_A =
  'You are a senior software engineer analysing a codebase. Be precise, reference specific file paths and line numbers, and cite evidence from the provided files rather than guessing. If the answer is not derivable from the context, say so.';

/**
 * Fallback output cap used only when the resolved model doesn't advertise
 * an `outputTokenLimit` via `models.list()`. Set generously at the current
 * Gemini pro-tier ceiling so the default behaviour is "let the model use
 * its full trained capacity" — per v1.4.0 user feedback, arbitrary
 * internal caps below the model's advertised limit are unhelpful
 * self-limiting. Callers who want tighter caps for specific calls pass
 * `maxOutputTokens` explicitly in the tool input.
 */
const ASK_MAX_OUTPUT_TOKENS_FALLBACK = 65_536;

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

export const askInputSchema = z
  .object({
    prompt: z.string().min(1).describe('The question or analysis request.'),
    workspace: z
      .string()
      .optional()
      .describe('Absolute or cwd-relative path to the workspace. Defaults to process.cwd().'),
    model: z
      .string()
      .optional()
      .describe(
        "Model alias ('latest-pro', 'latest-flash', 'latest-lite') or literal model ID. Defaults to the configured default.",
      ),
    includeGlobs: z
      .array(z.string())
      .optional()
      .describe('Additional file extensions or filenames to include.'),
    excludeGlobs: z.array(z.string()).optional().describe('Additional directory names to exclude.'),
    noCache: z
      .boolean()
      .optional()
      .describe('Skip the context cache and embed files inline (slower, more expensive).'),
    thinkingBudget: z
      .number()
      .int()
      .min(-1)
      .max(65_536)
      .optional()
      .describe(
        "Explicit reasoning-token cap. OMIT to use each model's native default — recommended on Gemini 3 (Google flags explicit `thinkingBudget` as 'legacy'). Pass a value only when you need a specific cap: `-1` = legacy dynamic, `0` = disable thinking (rejected by Gemini 3 Pro), positive integer = fixed cap. CAVEAT on Gemini 3 Pro: low positive values (empirically ≤256 with cached content) can cause the API to hang — use `-1` or ≥4096 if you must bound it there. For discrete-tier control on Gemini 3 use `thinkingLevel` instead — the two are mutually exclusive.",
      ),
    thinkingLevel: z
      .enum(THINKING_LEVELS)
      .optional()
      .describe(
        "Discrete reasoning tier for Gemini 3 family models — Google's recommended knob on those (ai.google.dev/gemini-api/docs/gemini-3). Values: `MINIMAL` (Flash-Lite only), `LOW`, `MEDIUM`, `HIGH` (Gemini 3 Pro's default). Gemini 2.5 models do NOT support this — use `thinkingBudget` instead. Mutually exclusive with `thinkingBudget`: passing both returns a validation error before we even hit Gemini (Gemini itself also rejects with 400 'cannot use both thinking_level and the legacy thinking_budget parameter').",
      ),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Per-call opt-in cap on response length (tokens). OMIT for the default 'auto' behaviour — Gemini uses its model-default cap (per Google docs, equal to the model's advertised `outputTokenLimit`: 65,536 for Gemini 3.x / 2.5 Pro-tier; see ai.google.dev/gemini-api/docs/models/gemini-2.5-pro). Pass a smaller value when you want a bounded response (e.g. strict summary length, tighter budget per call). Values larger than the resolved model's limit are clamped down. Budget reservation always uses the effective cap (explicit OR model limit) as worst-case, so `GEMINI_DAILY_BUDGET_USD` stays a true upper bound.",
      ),
  })
  .refine((data) => !(data.thinkingBudget !== undefined && data.thinkingLevel !== undefined), {
    message:
      'Cannot specify both `thinkingBudget` and `thinkingLevel` — they are mutually exclusive. Gemini rejects the combination with 400. Choose one: `thinkingLevel` (recommended for Gemini 3) or `thinkingBudget` (required on Gemini 2.5).',
    // `path: []` (root-level error) reflects that the violation is the
    // RELATION between two fields, not a problem with either field
    // individually. MCP clients that render per-field errors won't
    // misattribute the issue to `thinkingLevel` alone.
    path: [],
  });

export type AskInput = z.infer<typeof askInputSchema>;

export const askTool: ToolDefinition<AskInput> = {
  name: 'ask',
  title: 'Ask Gemini',
  description:
    'Ask Gemini a question in the context of your workspace. Uses persistent Context Caching so repeat queries are ~20× faster and cheaper than re-sending the codebase each time.',
  schema: askInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    const model = input.model ?? ctx.config.defaultModel;

    let reservationId: number | null = null;
    // `-1` signals "no reservation held" (distinct from 0 which is a valid
    // releaseId). Mirrors the pattern used by `reservationId`.
    let throttleReservationId = -1;
    // Canonical resolved-model string, captured once after `resolveModel`
    // so the outer catch can feed retry hints into the same throttle bucket
    // `reserve` used. `model` at the top of execute is the request alias
    // ("latest-pro-thinking") — different key, different bucket.
    let resolvedModelKey: string | null = null;
    const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
    try {
      // Workspace path validation lives INSIDE the try so a
      // `WorkspaceValidationError` is reported as a regular tool error
      // (errorResult, "ask failed: …") rather than an unhandled tool
      // exception logged by the server-level handler. Both arrive at the
      // user as text, but only the inside-try path keeps logs tidy and the
      // user-facing prefix consistent with other validation failures.
      try {
        validateWorkspacePath(workspaceRoot);
      } catch (err) {
        if (err instanceof WorkspaceValidationError) {
          return errorResult(`ask: ${err.message}`);
        }
        throw err;
      }

      emitter.emit(`resolving model '${model}'…`);
      // `ask` accepts all three text-gen tiers — caller picks via alias
      // (`latest-pro` / `latest-flash` / `latest-lite` / `latest-vision`)
      // or literal model ID. Resolver refuses to dispatch to a category
      // outside this set — protects against an image/audio/agent model
      // slipping in (e.g. `nano-banana-pro-preview` pre-v1.4.0).
      const resolved = await resolveModel(model, ctx.client, {
        requiredCategory: ['text-reasoning', 'text-fast', 'text-lite'],
      });
      resolvedModelKey = resolved.resolved;

      emitter.emit(`scanning workspace ${workspaceRoot}…`);
      const scan = await scanWorkspace(workspaceRoot, {
        ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
        ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
        maxFiles: ctx.config.maxFilesPerWorkspace,
        maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      });

      // Output-cap strategy (v1.4.0): three-layer precedence.
      //
      //   1. `input.maxOutputTokens` (per-call, strongest) — user explicitly
      //      caps this one call. Clamped to `modelOutputLimit`.
      //   2. `ctx.config.forceMaxOutputTokens` (env override) — when the
      //      MCP host sets `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true`,
      //      every call sends `maxOutputTokens = modelOutputLimit` so
      //      code-review workloads always run at the model's full capacity
      //      (65,536 tokens for Gemini 3.x / 2.5 Pro per Google docs).
      //   3. Default (no overrides) — omit `maxOutputTokens` from the
      //      `generateContent` config. Gemini uses its model-default cap
      //      (documented as the model's advertised `outputTokenLimit`),
      //      letting the model size the response to the query's complexity
      //      rather than reserving full capacity on short Q&A.
      //
      // `modelOutputLimit` is the model's advertised ceiling from
      // `models.list()` (or a fallback if the SDK doesn't report one).
      // Used as the clamp target and as the budget-reservation worst-case.
      const modelOutputLimit =
        typeof resolved.outputTokenLimit === 'number' && resolved.outputTokenLimit > 0
          ? resolved.outputTokenLimit
          : ASK_MAX_OUTPUT_TOKENS_FALLBACK;
      const wireMaxOutputTokens: number | undefined =
        input.maxOutputTokens !== undefined
          ? Math.min(input.maxOutputTokens, modelOutputLimit)
          : ctx.config.forceMaxOutputTokens
            ? modelOutputLimit
            : undefined;
      // Effective cap used for thinking-budget clamp and budget reservation.
      // When neither override is set, the model's internal default equals
      // `modelOutputLimit` per Google docs — so using the limit as
      // worst-case keeps `GEMINI_DAILY_BUDGET_USD` a true upper bound.
      const effectiveOutputCap = wireMaxOutputTokens ?? modelOutputLimit;

      // Single source of truth for "is the caller driving reasoning via the
      // discrete-tier knob?". Three downstream call sites branch on this
      // (cost estimate, emitter, thinkingConfig build) — extracting to a
      // named const keeps them in lockstep and makes future additions hard
      // to forget.
      const usingThinkingLevel = input.thinkingLevel !== undefined;

      // Normalise thinkingBudget:
      //   undefined → null (model-default path — `thinkingBudget` OMITTED on wire)
      //   -1        → -1  (explicit legacy dynamic; kept for Gemini 2.5 and
      //                    power-users who want to force the legacy path)
      //    0        →  0  (thinking disabled; Gemini 3 Pro will 400 here)
      //    N > 0    → clamp to [0, maxOutputTokens - 1024] — the thinking
      //              pool is carved out of the candidate-output allowance,
      //              so reserving ≥1024 tokens for the answer prevents 400s
      //              when a caller passes N ≥ maxOutputTokens.
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
              ? Math.max(0, Math.min(rawThinkingBudget, effectiveOutputCap - 1024))
              : 0;

      // Cost-estimate thinking-token reserve — tier-aware when the caller
      // uses `thinkingLevel`, worst-case when they use `thinkingBudget: -1`
      // or omit both fields (Gemini 3 Pro always spends thinking tokens per
      // Google's docs, so we reserve dynamic-thinking headroom there too).
      // When the caller passes an explicit positive `thinkingBudget`, we
      // reserve only that much. Keeps `GEMINI_DAILY_BUDGET_USD` a TRUE
      // upper bound on completed spend without false-rejecting callers
      // who legitimately use a low tier (see `THINKING_LEVEL_RESERVE`
      // rationale above).
      //
      // We dereference `input.thinkingLevel` directly (rather than via
      // `usingThinkingLevel`) so TypeScript narrows the type inside the
      // ternary — `THINKING_LEVEL_RESERVE[undefined]` would be a compile
      // error. The `?? worst-case` fallback handles the HIGH tier (which
      // maps to `null` in the reserve table to mean "use the dynamic cap").
      const thinkingTokensForEstimate =
        input.thinkingLevel !== undefined
          ? (THINKING_LEVEL_RESERVE[input.thinkingLevel] ?? Math.max(0, effectiveOutputCap - 1024))
          : effectiveThinkingBudget === null || effectiveThinkingBudget === -1
            ? Math.max(0, effectiveOutputCap - 1024)
            : effectiveThinkingBudget;

      // Estimated input-token count drives both the daily-budget reservation
      // (dollars) and the TPM throttle reservation (rate). Hoisted here so
      // both consumers share one fingerprint — no drift between what the $
      // ledger thinks we'll spend and what the rate-limiter thinks we'll
      // send to Gemini. Matches `estimatePreCallCostUsd`'s `Math.ceil(bytes/4)`
      // tokenisation on purpose; see `docs/FOLLOW-UP-PRS.md` T17 for the
      // known UTF-8 / CJK undercount.
      const workspaceBytes = scan.files.reduce((sum, f) => sum + f.size, 0);
      const estimatedInputTokens =
        Math.ceil(workspaceBytes / 4) + Math.ceil(input.prompt.length / 4);

      // Atomic budget reservation. Happens AFTER scan (so the estimate is
      // accurate) but BEFORE any billable upload or generateContent call.
      // Concurrent tool calls cannot all pass a pre-check and then
      // collectively overshoot the cap: `reserveBudget` uses a
      // `BEGIN IMMEDIATE` SQLite transaction that serialises check-and-insert.
      if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
        const estimateUsd = estimatePreCallCostUsd({
          model: resolved.resolved,
          workspaceBytes,
          promptChars: input.prompt.length,
          // Budget reservation uses the effective cap (explicit-user-cap
          // OR model's full limit) as `expectedOutputTokens` — a TRUE
          // upper bound, since Gemini's default stops at the model's
          // advertised `outputTokenLimit`.
          expectedOutputTokens: effectiveOutputCap,
          thinkingTokens: thinkingTokensForEstimate,
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
          );
        }
        reservationId = reserve.id;
      }

      const systemPromptHash = createHash('sha256')
        .update(SYSTEM_INSTRUCTION_Q_AND_A)
        .digest('hex')
        .slice(0, 16);

      const ctxPrep = await prepareContext({
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
      });

      // TPM throttle reservation — placed HERE (after `prepareContext`,
      // immediately before `generateContent`) so the reservation's `tsMs`
      // accurately reflects when tokens hit Gemini's quota counter. An
      // earlier reserve (before `prepareContext`) would stamp `tsMs`
      // minutes before actual dispatch on cold-cache calls; our window
      // would then expire before Gemini's, leaving a gap where we admit
      // concurrent calls that bust Gemini's per-minute quota. Trade-off:
      // two concurrent cold-cache callers will both complete
      // `prepareContext` before one backs off at `reserve` — mostly
      // idempotent via file-hash dedup, minor upload duplication.
      //
      // Extracted into a helper so the stale-cache retry branch can
      // cancel-and-re-reserve with an accurate tsMs rather than reusing a
      // stale reservation stamped before the first (failed) dispatch.
      const reserveForDispatch = async (): Promise<void> => {
        if (ctx.config.tpmThrottleLimit <= 0) return;
        const reservation = ctx.throttle.reserve(resolved.resolved, estimatedInputTokens);
        throttleReservationId = reservation.releaseId;
        if (reservation.delayMs > 0) {
          emitter.emit(
            `throttle: waiting ${Math.ceil(reservation.delayMs / 1000)}s for TPM window…`,
          );
          await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, reservation.delayMs));
        }
      };
      await reserveForDispatch();

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
      // reservation always uses `effectiveOutputCap` (= explicit cap OR
      // model limit) as worst-case upper bound, so the daily cap stays a
      // true ceiling regardless.
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
      const buildConfig = (cacheId: string | null): GenerateContentConfig => {
        const maxOutputField =
          wireMaxOutputTokens !== undefined ? { maxOutputTokens: wireMaxOutputTokens } : {};
        return cacheId
          ? { cachedContent: cacheId, thinkingConfig, ...maxOutputField }
          : {
              systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
              thinkingConfig,
              ...maxOutputField,
            };
      };
      const buildContents = (
        cacheId: string | null,
        inline: typeof ctxPrep.inlineContents,
      ): string | Content[] =>
        cacheId ? input.prompt : [...inline, { role: 'user', parts: [{ text: input.prompt }] }];

      // Track the prepared-context used for the FINAL successful call. Starts
      // pointing at the initial ctxPrep; retry branch below reassigns to the
      // rebuilt PreparedContext so post-call markHot + metadata reflect reality.
      let activePrep = ctxPrep;
      let retriedOnStaleCache = false;
      let response: GenerateContentResponse;
      try {
        response = await ctx.client.models.generateContent({
          model: resolved.resolved,
          contents: buildContents(activePrep.cacheId, activePrep.inlineContents),
          config: buildConfig(activePrep.cacheId),
        });
      } catch (err) {
        // Self-heal: if Gemini rejected our cached content (evicted, expired,
        // externally deleted), invalidate locally and retry ONCE with a fresh
        // cache. Prevents users from seeing hard failures they'd otherwise need
        // to clear/reindex manually. Budget: one retry; a second stale-cache
        // error propagates with both errors chained via Error.cause.
        if (activePrep.cacheId && isStaleCacheError(err)) {
          logger.warn(
            `Gemini rejected cached content ${activePrep.cacheId}; invalidating and retrying once.`,
          );
          try {
            // Reset the cache pointer only — keep `files` rows so the rebuild
            // can reuse uploaded files via content-hash dedup instead of
            // re-uploading. The Gemini-side cache is already dead (that's
            // what triggered this branch), so no `caches.delete` needed.
            markCacheStale({ manifest: ctx.manifest, workspaceRoot });
            const rebuilt = await prepareContext({
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
            });
            // Cancel the original throttle reservation — its `tsMs` was
            // stamped at first-dispatch time, which is now seconds in the
            // past (the rebuild took real time). Re-reserve fresh so the
            // retry's tsMs reflects when the retry call actually hits
            // Gemini's quota counter. Without this, our window would expire
            // locally before Gemini's, leaving a gap where concurrent
            // callers bust the per-minute limit (PR #19 round-2 GPT review).
            if (throttleReservationId !== -1) {
              ctx.throttle.cancel(throttleReservationId);
              throttleReservationId = -1;
            }
            await reserveForDispatch();
            response = await ctx.client.models.generateContent({
              model: resolved.resolved,
              contents: buildContents(rebuilt.cacheId, rebuilt.inlineContents),
              config: buildConfig(rebuilt.cacheId),
            });
            activePrep = rebuilt;
            retriedOnStaleCache = true;
          } catch (retryErr) {
            // Preserve the ORIGINAL stale-cache error as `cause` so ops can
            // root-cause diagnostics across both the first 404 and any
            // rebuild-time failure.
            throw new Error(
              `ask retry after stale cache failed: ${
                retryErr instanceof Error ? retryErr.message : String(retryErr)
              }`,
              { cause: err },
            );
          }
        } else {
          throw err;
        }
      }

      if (activePrep.cacheId) {
        ctx.ttlWatcher.markHot(workspaceRoot, activePrep.cacheId, ctx.config.cacheTtlSeconds);
      }

      const text = response.text ?? '';

      // Extract Gemini's thinking summary when `includeThoughts: true` is set.
      // Parts flagged `thought: true` carry the model's internal reasoning
      // digest — useful for the caller to see *why* an answer was given.
      // We cap the joined summary at 1200 chars so it never dominates the
      // MCP response payload (matches `code.tool.ts` behaviour).
      const thoughtTexts: string[] = [];
      for (const cand of response.candidates ?? []) {
        for (const part of cand.content?.parts ?? []) {
          if (part.thought === true && typeof part.text === 'string') {
            thoughtTexts.push(part.text);
          }
        }
      }
      const thinkingSummary =
        thoughtTexts.length > 0 ? thoughtTexts.join('\n').slice(0, 1200) : null;

      const usage = response.usageMetadata;
      const cached =
        typeof usage?.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0;
      const inputTotal = typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
      const uncached = Math.max(0, inputTotal - cached);
      const output =
        typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
      const thinking = typeof usage?.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : 0;

      // Finalise the throttle reservation with Gemini's actual
      // `promptTokenCount` — includes cached tokens, which DO count against
      // the per-minute quota (empirically confirmed 2026-04-20). If actual
      // < estimate, subsequent reserves see the freed headroom; if >, they
      // back off accordingly.
      if (throttleReservationId !== -1) {
        ctx.throttle.release(throttleReservationId, inputTotal);
        throttleReservationId = -1;
      }

      const cost = estimateCostUsd({
        model: resolved.resolved,
        uncachedInputTokens: uncached,
        cachedInputTokens: cached,
        outputTokens: output,
        thinkingTokens: thinking,
      });
      const costMicros = toMicrosUsd(cost);

      const durationMs = Date.now() - started;
      if (reservationId !== null) {
        // The finalize UPDATE on a row we just inserted should be infallible
        // in practice, but a disk-full / lock-contention edge could throw.
        // If it does, we'd rather keep the reservation row (estimate stays
        // billed, slight overcharge) than let the outer catch CANCEL it
        // — cancelling would erase any record of this billable, completed
        // call. Either way, drop `reservationId` so the outer catch doesn't
        // touch it.
        try {
          ctx.manifest.finalizeBudgetReservation(reservationId, {
            cachedTokens: cached,
            uncachedTokens: uncached,
            costUsdMicro: costMicros,
            durationMs,
          });
        } catch (finalizeErr) {
          logger.error(
            `ask: finalizeBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate (${costMicros} micros). Error: ${String(finalizeErr)}`,
          );
        }
        reservationId = null;
      } else {
        ctx.manifest.insertUsageMetric({
          workspaceRoot,
          toolName: 'ask',
          model: resolved.resolved,
          cachedTokens: cached,
          uncachedTokens: uncached,
          costUsdMicro: costMicros,
          durationMs,
          occurredAt: Date.now(),
        });
      }

      if (scan.truncated) {
        logger.warn(
          `workspace ${workspaceRoot} contains more files than GEMINI_CODE_CONTEXT_MAX_FILES (${ctx.config.maxFilesPerWorkspace}); the tail was dropped before indexing.`,
        );
      }

      const metadata: Record<string, unknown> = {
        resolvedModel: resolved.resolved,
        requestedModel: resolved.requested,
        fallbackApplied: resolved.fallbackApplied,
        modelCategory: resolved.category,
        modelCostTier: resolved.capabilities.costTier,
        contextWindow: resolved.inputTokenLimit,
        thinkingBudget: effectiveThinkingBudget,
        thinkingLevel: input.thinkingLevel ?? null,
        cachedTokens: cached,
        uncachedTokens: uncached,
        outputTokens: output,
        thinkingTokens: thinking,
        costEstimateUsd: Math.round(cost * 10000) / 10000,
        cacheHit: activePrep.reused,
        cacheRebuilt: activePrep.rebuilt || retriedOnStaleCache,
        retriedOnStaleCache,
        inlineOnly: activePrep.inlineOnly,
        filesIndexed: scan.files.length,
        filesSkippedTooLarge: scan.skippedTooLarge,
        filesUploadFailed: activePrep.uploaded.failedCount,
        ...(activePrep.uploaded.failedCount > 0
          ? { uploadFailures: activePrep.uploaded.failures.slice(0, 5) }
          : {}),
        workspaceTruncated: scan.truncated,
        maxFilesCap: ctx.config.maxFilesPerWorkspace,
        durationMs,
        ...(thinkingSummary ? { thinkingSummary } : {}),
      };

      return textResult(text, metadata);
    } catch (err) {
      logger.error(`ask failed: ${String(err)}`);
      // T22a — extract Gemini's `retryInfo.retryDelay` from 429 bodies and
      // seed the throttle's per-model hint before we release the
      // reservation. Google's hint is typically shorter (2-16s) than our
      // pure-window math would compute (up to 60s+) so honouring it
      // shortens the next caller's wait.
      //
      // Gated on `isGemini429` BEFORE parsing. The predicate requires BOTH
      // `err instanceof ApiError` (SDK-provenance marker — user-controlled
      // content can't forge an ApiError prototype) AND `err.status === 429`
      // (typed field from the HTTP response). The earlier v1.3.2 draft had
      // a `RESOURCE_EXHAUSTED` substring fallback; GPT + Grok round-2
      // review (PR #21) showed that path was user-influenceable — echoed
      // prompt content re-opened the hint-poisoning class the gate was
      // meant to close. Removing the fallback drops hint extraction for
      // errors that lose the ApiError shape in transit, but production
      // 429s always arrive as real ApiError instances.
      const retryDelayMs = isGemini429(err) ? parseRetryDelayMs(err.message) : null;
      if (retryDelayMs !== null && resolvedModelKey !== null) {
        ctx.throttle.recordRetryHint(resolvedModelKey, retryDelayMs);
      }
      // Release any unconsumed budget reservation so the failed call's
      // estimate doesn't eat into future headroom for today. Wrap in its
      // own try/catch — better-sqlite3 can throw SQLITE_BUSY or I/O errors
      // and we must not let a rollback-time DB failure replace the real
      // tool error the user is waiting on.
      if (reservationId !== null) {
        try {
          ctx.manifest.cancelBudgetReservation(reservationId);
        } catch (cancelErr) {
          logger.error(
            `ask: cancelBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate. Error: ${String(cancelErr)}`,
          );
        }
        reservationId = null;
      }
      // Drop the TPM reservation on any failure path. If Gemini actually
      // consumed quota server-side before failing, the hint path above
      // (T22a) compensates via `recordRetryHint` before we cancel. For
      // non-429 errors (validation, transport), we under-count slightly
      // but bounded — accepted trade-off documented in PR #19 round-2.
      if (throttleReservationId !== -1) {
        ctx.throttle.cancel(throttleReservationId);
        throttleReservationId = -1;
      }
      return errorResult(`ask failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      emitter.stop();
    }
  },
};
