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
import {
  invalidateWorkspaceCache,
  isStaleCacheError,
  prepareContext,
} from '../cache/cache-manager.js';
import { resolveModel } from '../gemini/models.js';
import { scanWorkspace } from '../indexer/workspace-scanner.js';
import { estimateCostUsd, toMicrosUsd } from '../utils/cost-estimator.js';
import { logger } from '../utils/logger.js';
import { createProgressEmitter } from '../utils/progress.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';

const SYSTEM_INSTRUCTION_Q_AND_A =
  'You are a senior software engineer analysing a codebase. Be precise, reference specific file paths and line numbers, and cite evidence from the provided files rather than guessing. If the answer is not derivable from the context, say so.';

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

    // Budget cap check.
    if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
      const spentToday = ctx.manifest.todaysCostMicros(Date.now()) / 1_000_000;
      if (spentToday >= ctx.config.dailyBudgetUsd) {
        return errorResult(
          `Daily budget cap reached ($${spentToday.toFixed(4)} ≥ $${ctx.config.dailyBudgetUsd.toFixed(2)}). Calls will resume after UTC midnight, or raise \`GEMINI_DAILY_BUDGET_USD\`.`,
        );
      }
    }

    const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
    try {
      emitter.emit(`resolving model '${model}'…`);
      const resolved = await resolveModel(model, ctx.client);

      emitter.emit(`scanning workspace ${workspaceRoot}…`);
      const scan = await scanWorkspace(workspaceRoot, {
        ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
        ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
        maxFiles: ctx.config.maxFilesPerWorkspace,
        maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      });

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
      const buildConfig = (cacheId: string | null): GenerateContentConfig => ({
        systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
        ...(cacheId ? { cachedContent: cacheId } : {}),
      });
      const buildContents = (
        cacheId: string | null,
        inline: typeof ctxPrep.inlineContents,
      ): string | Content[] =>
        cacheId ? input.prompt : [...inline, { role: 'user', parts: [{ text: input.prompt }] }];

      let response: GenerateContentResponse;
      try {
        response = await ctx.client.models.generateContent({
          model: resolved.resolved,
          contents: buildContents(ctxPrep.cacheId, ctxPrep.inlineContents),
          config: buildConfig(ctxPrep.cacheId),
        });
      } catch (err) {
        // Self-heal: if Gemini rejected our cached content (evicted, expired,
        // externally deleted), invalidate locally and retry ONCE with a fresh
        // cache. Prevents users from seeing hard failures they'd otherwise need
        // to clear/reindex manually.
        if (ctxPrep.cacheId && isStaleCacheError(err)) {
          logger.warn(
            `Gemini rejected cached content ${ctxPrep.cacheId}; invalidating and retrying once.`,
          );
          await invalidateWorkspaceCache({
            client: ctx.client,
            manifest: ctx.manifest,
            workspaceRoot,
          });
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
          if (rebuilt.cacheId) {
            ctx.ttlWatcher.markHot(workspaceRoot, rebuilt.cacheId, ctx.config.cacheTtlSeconds);
          }
        } else {
          throw err;
        }
      }

      if (ctxPrep.cacheId) {
        ctx.ttlWatcher.markHot(workspaceRoot, ctxPrep.cacheId, ctx.config.cacheTtlSeconds);
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
        cacheHit: ctxPrep.reused,
        cacheRebuilt: ctxPrep.rebuilt,
        inlineOnly: ctxPrep.inlineOnly,
        filesIndexed: scan.files.length,
        filesSkippedTooLarge: scan.skippedTooLarge,
        filesUploadFailed: ctxPrep.uploaded.failedCount,
        ...(ctxPrep.uploaded.failedCount > 0
          ? { uploadFailures: ctxPrep.uploaded.failures.slice(0, 5) }
          : {}),
        workspaceTruncated: scan.truncated,
        maxFilesCap: ctx.config.maxFilesPerWorkspace,
        durationMs,
      };

      return textResult(text, metadata);
    } catch (err) {
      logger.error(`ask failed: ${String(err)}`);
      return errorResult(`ask failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      emitter.stop();
    }
  },
};
