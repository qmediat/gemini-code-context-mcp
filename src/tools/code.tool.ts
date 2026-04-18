/**
 * `code` tool — dedicated coding delegation to Gemini.
 *
 * Uses native Gemini features:
 *   - Thinking budget (reasoning tokens before generation)
 *   - Optional Code Execution tool (Gemini runs Python in a sandbox)
 *   - Coding-optimized system prompt
 *   - Structured output parser extracts code blocks and OLD/NEW diffs
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { GenerateContentConfig, GenerateContentResponse } from '@google/genai';
import { z } from 'zod';
import { prepareContext } from '../cache/cache-manager.js';
import { resolveModel } from '../gemini/models.js';
import { scanWorkspace } from '../indexer/workspace-scanner.js';
import { estimateCostUsd, toMicrosUsd } from '../utils/cost-estimator.js';
import { logger } from '../utils/logger.js';
import { createProgressEmitter } from '../utils/progress.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';

const SYSTEM_INSTRUCTION_CODE = [
  'You are an expert software engineer. Generate production-quality, idiomatic code with proper error handling.',
  'Match the existing code style and conventions visible in the provided workspace context.',
  '',
  'When modifying existing code, output edits in this exact format so they can be applied programmatically:',
  '',
  '  **FILE: <relative/path/to/file>**',
  '  ```',
  '  OLD:',
  '  <exact existing content to replace, including all whitespace>',
  '  NEW:',
  '  <replacement content>',
  '  ```',
  '',
  'The OLD block must be a unique, exact substring of the current file (include enough surrounding',
  'lines to make it unique). For net-new code, omit the OLD block (use an empty OLD).',
  '',
  'When generating brand-new files not yet in the workspace, use a standard fenced code block with',
  'the language hint and a comment on line 1 indicating the target path.',
  '',
  'Always explain briefly WHY a change is made before the edit block.',
].join('\n');

export const codeInputSchema = z.object({
  task: z.string().min(1).describe('Describe the coding task — what to build, refactor, or fix.'),
  workspace: z.string().optional().describe('Workspace path (default: cwd).'),
  model: z
    .string()
    .optional()
    .describe(
      "Model alias or literal ID. Defaults to 'latest-pro-thinking' for strongest coding performance.",
    ),
  thinkingBudget: z
    .number()
    .int()
    .min(0)
    .max(65_536)
    .optional()
    .describe(
      'Reasoning tokens Gemini is allowed to spend before generating. Default: 16384. Higher = better quality for complex tasks, more expensive.',
    ),
  codeExecution: z
    .boolean()
    .optional()
    .describe(
      "Enable Gemini's Code Execution tool — Gemini can run Python in a sandbox to verify its output. Off by default.",
    ),
  expectEdits: z
    .boolean()
    .optional()
    .describe('Request OLD/NEW diff format in the response (default: true).'),
  includeGlobs: z.array(z.string()).optional(),
  excludeGlobs: z.array(z.string()).optional(),
});

export type CodeInput = z.infer<typeof codeInputSchema>;

interface ParsedEdit {
  file: string;
  old: string;
  new: string;
}

const EDIT_REGEX =
  /\*\*FILE: (.+?)\*\*\s*\n```[^\n]*\n(?:OLD:\s*\n([\s\S]*?)\n)?NEW:\s*\n([\s\S]*?)\n```/g;

function parseEdits(text: string): ParsedEdit[] {
  const edits: ParsedEdit[] = [];
  for (const m of text.matchAll(EDIT_REGEX)) {
    const [, file, oldBlock, newBlock] = m;
    if (!file || newBlock === undefined) continue;
    edits.push({
      file: file.trim(),
      old: (oldBlock ?? '').trimEnd(),
      new: newBlock.trimEnd(),
    });
  }
  return edits;
}

const CODE_BLOCK_REGEX = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g;

function parseCodeBlocks(text: string): Array<{ lang: string; content: string }> {
  const blocks: Array<{ lang: string; content: string }> = [];
  for (const m of text.matchAll(CODE_BLOCK_REGEX)) {
    const [full, lang, content] = m;
    if (!content) continue;
    // Skip blocks that are edit OLD/NEW format — those are handled separately.
    if (content.startsWith('OLD:') || content.startsWith('NEW:')) continue;
    // Skip empty shell preamble blocks.
    if (full.trim().length === 0) continue;
    blocks.push({ lang: lang ?? '', content });
  }
  return blocks;
}

export const codeTool: ToolDefinition<CodeInput> = {
  name: 'code',
  title: 'Delegate coding to Gemini',
  description:
    'Delegate a coding task to Gemini using its native thinking budget and (optional) code execution. Returns structured edits in OLD/NEW format that Claude Code can apply via its Edit tool, plus a brief rationale.',
  schema: codeInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    const modelRequest = input.model ?? 'latest-pro-thinking';
    const thinkingBudget = input.thinkingBudget ?? 16_384;
    const expectEdits = input.expectEdits ?? true;
    const codeExecution = input.codeExecution ?? false;

    if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
      const spentToday = ctx.manifest.todaysCostMicros(Date.now()) / 1_000_000;
      if (spentToday >= ctx.config.dailyBudgetUsd) {
        return errorResult(
          `Daily budget cap reached ($${spentToday.toFixed(4)} ≥ $${ctx.config.dailyBudgetUsd.toFixed(2)}).`,
        );
      }
    }

    const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
    try {
      emitter.emit(`resolving model '${modelRequest}'…`);
      const resolved = await resolveModel(modelRequest, ctx.client);

      emitter.emit(`scanning workspace ${workspaceRoot}…`);
      const scan = await scanWorkspace(workspaceRoot, {
        ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
        ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
        maxFiles: ctx.config.maxFilesPerWorkspace,
        maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      });

      const systemPromptHash = createHash('sha256')
        .update(SYSTEM_INSTRUCTION_CODE)
        .digest('hex')
        .slice(0, 16);

      const ctxPrep = await prepareContext({
        client: ctx.client,
        manifest: ctx.manifest,
        scan,
        model: resolved,
        systemPromptHash,
        systemInstruction: SYSTEM_INSTRUCTION_CODE,
        ttlSeconds: ctx.config.cacheTtlSeconds,
        cacheMinTokens: ctx.config.cacheMinTokens,
        emitter,
        allowCaching: scan.files.length > 0,
      });

      const userPrompt = expectEdits
        ? `${input.task}\n\nRespond with your rationale and OLD/NEW diff blocks per the system instruction.`
        : input.task;

      emitter.emit(
        codeExecution
          ? `generating with thinking=${thinkingBudget} + codeExecution…`
          : `generating with thinking=${thinkingBudget}…`,
      );

      const baseConfig: GenerateContentConfig = {
        systemInstruction: SYSTEM_INSTRUCTION_CODE,
        thinkingConfig: { thinkingBudget, includeThoughts: true },
        ...(ctxPrep.cacheId ? { cachedContent: ctxPrep.cacheId } : {}),
        ...(codeExecution ? { tools: [{ codeExecution: {} }] } : {}),
      };

      const response: GenerateContentResponse = await ctx.client.models.generateContent({
        model: resolved.resolved,
        contents: ctxPrep.cacheId
          ? userPrompt
          : [...ctxPrep.inlineFileParts, { role: 'user', parts: [{ text: userPrompt }] }],
        config: baseConfig,
      });

      if (ctxPrep.cacheId) {
        ctx.ttlWatcher.markHot(workspaceRoot, ctxPrep.cacheId, ctx.config.cacheTtlSeconds);
      }

      const text = response.text ?? '';
      const edits = expectEdits ? parseEdits(text) : [];
      const codeBlocks = parseCodeBlocks(text);

      // Extract code_execution tool artifacts + Gemini's thinking summary if present.
      const executedCode: string[] = [];
      const executionOutput: string[] = [];
      const thoughtTexts: string[] = [];
      const candidates = response.candidates ?? [];
      for (const cand of candidates) {
        const parts = cand.content?.parts ?? [];
        for (const part of parts) {
          if (part.executableCode?.code) executedCode.push(part.executableCode.code);
          if (part.codeExecutionResult?.output)
            executionOutput.push(part.codeExecutionResult.output);
          // `thinkingConfig: { includeThoughts: true }` returns thinking as parts
          // flagged with `thought: true`. Cap the summary to avoid overwhelming the MCP response.
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
        toolName: 'code',
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

      const structured: Record<string, unknown> = {
        resolvedModel: resolved.resolved,
        requestedModel: resolved.requested,
        contextWindow: resolved.inputTokenLimit,
        thinkingBudget,
        codeExecutionUsed: codeExecution,
        cacheHit: ctxPrep.reused,
        cachedTokens: cached,
        uncachedTokens: uncached,
        thinkingTokens: thinking,
        outputTokens: output,
        costEstimateUsd: Math.round(cost * 10000) / 10000,
        durationMs,
        edits: edits.map((e) => ({
          file: e.file,
          oldPreview: e.old.slice(0, 120),
          newPreview: e.new.slice(0, 120),
        })),
        editCount: edits.length,
        codeBlocks: codeBlocks.map((b) => ({ lang: b.lang, length: b.content.length })),
        workspaceTruncated: scan.truncated,
        maxFilesCap: ctx.config.maxFilesPerWorkspace,
        filesIndexed: scan.files.length,
        ...(thinkingSummary ? { thinkingSummary } : {}),
        ...(executedCode.length > 0 ? { executedCode } : {}),
        ...(executionOutput.length > 0 ? { executionOutput } : {}),
      };

      return textResult(text, structured);
    } catch (err) {
      logger.error(`code failed: ${String(err)}`);
      return errorResult(`code failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      emitter.stop();
    }
  },
};
