/**
 * `ask` tool — Q&A / long-context analysis against a workspace.
 *
 * Uses the Persistent Context Cache when available, reducing repeat-query cost
 * and latency. First call on a workspace: ~30–45 s (upload + build). Subsequent
 * calls with unchanged files: ~2–3 s.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Content, GenerateContentConfig, GenerateContentResponse } from '@google/genai';
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

const SYSTEM_INSTRUCTION_Q_AND_A =
  'You are a senior software engineer analysing a codebase. Be precise, reference specific file paths and line numbers, and cite evidence from the provided files rather than guessing. If the answer is not derivable from the context, say so.';

/**
 * Hard cap on Gemini's response size for `ask`. Used both as the
 * `maxOutputTokens` field on the generateContent config (so the model
 * actually stops there) and as the `expectedOutputTokens` value passed to
 * `estimatePreCallCostUsd` for the budget reservation. Coupling them is
 * the point: the reservation becomes a true upper bound, not a guess that
 * can be exceeded silently. Q&A answers rarely need more than ~8k tokens;
 * if the resolved model advertises a smaller limit, we use that instead.
 */
const ASK_MAX_OUTPUT_TOKENS_DEFAULT = 8192;

export const askInputSchema = z.object({
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
      const resolved = await resolveModel(model, ctx.client);

      emitter.emit(`scanning workspace ${workspaceRoot}…`);
      const scan = await scanWorkspace(workspaceRoot, {
        ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
        ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
        maxFiles: ctx.config.maxFilesPerWorkspace,
        maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      });

      // Hard cap on output tokens: bound the reservation estimate and the
      // actual generateContent request to the same value, so the budget
      // reservation is a TRUE upper bound (Copilot review C6). If the
      // resolved model's advertised limit is smaller than our default,
      // honour that — Gemini would clamp it anyway.
      const maxOutputTokens =
        typeof resolved.outputTokenLimit === 'number' && resolved.outputTokenLimit > 0
          ? Math.min(ASK_MAX_OUTPUT_TOKENS_DEFAULT, resolved.outputTokenLimit)
          : ASK_MAX_OUTPUT_TOKENS_DEFAULT;

      // Atomic budget reservation. Happens AFTER scan (so the estimate is
      // accurate) but BEFORE any billable upload or generateContent call.
      // Concurrent tool calls cannot all pass a pre-check and then
      // collectively overshoot the cap: `reserveBudget` uses a
      // `BEGIN IMMEDIATE` SQLite transaction that serialises check-and-insert.
      if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
        const workspaceBytes = scan.files.reduce((sum, f) => sum + f.size, 0);
        const estimateUsd = estimatePreCallCostUsd({
          model: resolved.resolved,
          workspaceBytes,
          promptChars: input.prompt.length,
          expectedOutputTokens: maxOutputTokens,
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

      emitter.emit('generating response…');
      // Gemini rejects `generateContent({cachedContent, systemInstruction})` with 400:
      // "CachedContent can not be used with GenerateContent request setting
      //  system_instruction, tools or tool_config. Move those values to CachedContent."
      // The system instruction was already baked into the cache at build time
      // (see cache-manager.ts:322 `cacheConfig.systemInstruction`), so we must
      // OMIT it on the generate call when a cached context is active.
      // `maxOutputTokens` is set on every generateContent call so the budget
      // reservation's `expectedOutputTokens` (derived from the same value) is
      // a true upper bound — without this cap, a runaway response could
      // exceed the reserved estimate and silently overshoot `dailyBudgetUsd`.
      const buildConfig = (cacheId: string | null): GenerateContentConfig =>
        cacheId
          ? { cachedContent: cacheId, maxOutputTokens }
          : { systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A, maxOutputTokens };
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
      const usage = response.usageMetadata;
      const cached =
        typeof usage?.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0;
      const inputTotal = typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
      const uncached = Math.max(0, inputTotal - cached);
      const output =
        typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
      const thinking = typeof usage?.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : 0;

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

      const metadata = {
        resolvedModel: resolved.resolved,
        requestedModel: resolved.requested,
        fallbackApplied: resolved.fallbackApplied,
        contextWindow: resolved.inputTokenLimit,
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
      };

      return textResult(text, metadata);
    } catch (err) {
      logger.error(`ask failed: ${String(err)}`);
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
      return errorResult(`ask failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      emitter.stop();
    }
  },
};
