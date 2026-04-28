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
import type { Content, GenerateContentConfig, ThinkingConfig, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { isStaleCacheError, markCacheStale, prepareContext } from '../cache/cache-manager.js';
import { resolveModel } from '../gemini/models.js';
import { abortableSleep, withNetworkRetry } from '../gemini/retry.js';
import { type PreflightTokenResult, countForPreflight } from '../gemini/token-counter.js';
import { scanWorkspace } from '../indexer/workspace-scanner.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../indexer/workspace-validation.js';
import { estimateCostUsd, estimatePreCallCostUsd, toMicrosUsd } from '../utils/cost-estimator.js';
import { logger, safeForLog } from '../utils/logger.js';
import { createProgressEmitter } from '../utils/progress.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';
import { createTimeoutController, getTimeoutKind, isTimeoutAbort } from './shared/abort-timeout.js';
import { type CollectedResponse, collectStream } from './shared/stream-collector.js';
import { THINKING_LEVELS, THINKING_LEVEL_RESERVE } from './shared/thinking.js';
import { isGemini429, parseRetryDelayMs } from './shared/throttle.js';

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

export const codeInputSchema = z
  .object({
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
        'Explicit reasoning-token cap. Default (when both `thinkingBudget` and `thinkingLevel` are omitted): 16384 — a strong default for coding. Pass a positive integer to cap reasoning at that many tokens; `0` disables thinking (rejected by Gemini 3 Pro with 400). CAVEAT on Gemini 3 Pro: low positive values (empirically ≤256 with cached content) can cause the API to hang — use ≥4096 if you must bound it. For discrete-tier control on Gemini 3 use `thinkingLevel` instead — the two are mutually exclusive.',
      ),
    thinkingLevel: z
      .enum(THINKING_LEVELS)
      .optional()
      .describe(
        "Discrete reasoning tier for Gemini 3 family models — Google's recommended knob on those (ai.google.dev/gemini-api/docs/gemini-3). Values: `MINIMAL` (Flash-Lite only), `LOW`, `MEDIUM`, `HIGH` (Gemini 3 Pro's default). Gemini 2.5 models do NOT support this — use `thinkingBudget` instead. Mutually exclusive with `thinkingBudget`: passing both returns a validation error before we even hit Gemini (Gemini itself also rejects with 400 'cannot use both thinking_level and the legacy thinking_budget parameter').",
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
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Per-call opt-in cap on response length (tokens). OMIT for auto — Gemini uses its model-default cap (per Google docs, equal to the model's advertised `outputTokenLimit`: 65,536 for Gemini 3.x / 2.5 Pro-tier; see ai.google.dev/gemini-api/docs/models/gemini-2.5-pro). Pass a smaller value to bound a specific call (e.g. `maxOutputTokens: 16384` for a tight code-review summary). Values larger than the resolved model's limit are clamped. Operators who want EVERY call at full model capacity set `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true` at MCP-host level — that env override is still beaten by this per-call field.",
      ),
    includeGlobs: z
      .array(z.string())
      .optional()
      .describe('Additional file extensions or filenames to include.'),
    excludeGlobs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional patterns to exclude. Supports three shapes: (1) directory names or path prefixes (`node_modules`, `src/vendor`, `./dist/`, `.vercel/`), (2) literal filenames exact-match, including bare dot-prefixed names (`pr27-diff.txt`, `foo.bar.baz`, `.env`, `.map`, `.tsbuildinfo`), (3) extension globs that match via endsWith (`*.tsbuildinfo`, `*.map`). Bare dot-prefixed names like `.env` are treated as exact filename literals — write `*.env` for extension semantics. Paths are POSIX-normalised (backslashes → `/`, leading `./` and trailing `/` stripped). Case-insensitive. No mid-string `*` / `**` / `?` — split into dir + extension patterns if needed.',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .optional()
      .describe(
        'Per-call wall-clock TOTAL timeout in ms (1s–30min). The cost ceiling — aborts the in-flight `generateContent` request even if it is actively streaming. Gemini still finishes server-side and bills tokens for completed work. When omitted, falls back to env var `GEMINI_CODE_CONTEXT_CODE_TIMEOUT_MS`, then to disabled. v1.12.0 RECOMMENDATION: prefer `stallMs` for liveness — `timeoutMs` is the cost cap, `stallMs` is the heartbeat-aware liveness watchdog that does NOT fire while the model is actively thinking. Both can be set simultaneously. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "total"` on abort.',
      ),
    stallMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe(
        'Per-call HEARTBEAT-AWARE stall watchdog in ms (1s–10min, v1.12.0+). Resets on every chunk (text or thought) — fires ONLY when the stream goes silent for this long. Does NOT fire while the model is actively thinking. Recommended setting: `60_000` (60s). When omitted, falls back to env var `GEMINI_CODE_CONTEXT_CODE_STALL_MS`, then to disabled. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "stall"` on abort. Independent of `timeoutMs` — both can be set; whichever fires first wins.',
      ),
    preflightMode: z
      .enum(['heuristic', 'exact', 'auto'])
      .optional()
      .describe(
        "Token-count strategy for the WORKSPACE_TOO_LARGE preflight (v1.10.0+). `'heuristic'` = bytes/4 fast estimate (skips API call; coarse — undercounts dense Unicode by 30-50%). `'exact'` = always call Gemini's `countTokens` (free, no quota share with `generateContent`; ~hundreds of ms per call; cached per (filesHash + task + model) — `filesHash` is post-glob-filter so changing globs that resolve to different files invalidates automatically). `'auto'` (default, recommended) = heuristic when the workspace is well under 50% of the model's input limit; exact when near the cliff where accuracy matters. Use `'exact'` in CI / tests where you want predictable, accurate behaviour regardless of size.",
      ),
  })
  .refine((data) => !(data.thinkingBudget !== undefined && data.thinkingLevel !== undefined), {
    message:
      'Cannot specify both `thinkingBudget` and `thinkingLevel` — they are mutually exclusive. Gemini rejects the combination with 400. Choose one: `thinkingLevel` (recommended for Gemini 3) or `thinkingBudget` (required on Gemini 2.5).',
    // `path: []` (root-level error) reflects that the violation is the
    // RELATION between two fields, not a problem with either field
    // individually.
    path: [],
  });

export type CodeInput = z.infer<typeof codeInputSchema>;

/** @internal — exported for testing only. Not part of the public API surface. */
export interface ParsedEdit {
  file: string;
  old: string;
  new: string;
}

const EDIT_REGEX =
  /\*\*FILE: (.+?)\*\*\s*\n```[^\n]*\n(?:OLD:\s*\n([\s\S]*?)\n)?NEW:\s*\n([\s\S]*?)\n```/g;

/** @internal — exported for testing only. Not part of the public API surface. */
export function parseEdits(text: string): ParsedEdit[] {
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

/** @internal — exported for testing only. Not part of the public API surface. */
export function parseCodeBlocks(text: string): Array<{ lang: string; content: string }> {
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
    return executeCodeBody(input, ctx, workspaceRoot, started);
  },
};

async function executeCodeBody(
  input: CodeInput,
  ctx: Parameters<typeof codeTool.execute>[1],
  workspaceRoot: string,
  started: number,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const modelRequest = input.model ?? 'latest-pro-thinking';
  const expectEdits = input.expectEdits ?? true;
  const codeExecution = input.codeExecution ?? false;

  // Schema `.refine()` guarantees `thinkingBudget` and `thinkingLevel` are
  // never both set. `usingThinkingLevel` is a single source of truth for
  // the "is the caller driving reasoning via the discrete-tier knob?"
  // predicate — used by the cost estimate, the emitter message, and the
  // thinkingConfig shape below.
  const usingThinkingLevel = input.thinkingLevel !== undefined;

  // `code` keeps its pre-existing default of 16_384 for the `thinkingBudget`
  // path (strong reasoning for coding out of the box — coding tasks
  // genuinely benefit from it and callers rarely want to disable thinking).
  // When the caller uses `thinkingLevel` instead, `thinkingBudget` stays
  // undefined and we take the level branch below.
  const thinkingBudget = usingThinkingLevel ? undefined : (input.thinkingBudget ?? 16_384);

  let reservationId: number | null = null;
  // `-1` signals "no reservation held". Mirror of ask.tool.ts.
  let throttleReservationId = -1;
  // Canonical resolved-model string for retry-hint seeding (T22a).
  // See ask.tool.ts for rationale.
  let resolvedModelKey: string | null = null;
  const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
  // T19 + Phase 4 — composite controller (wall-clock + stall watchdog).
  // See ask.tool.ts for rationale; same shape here.
  const timeoutController = createTimeoutController({
    ...(input.timeoutMs !== undefined ? { totalMs: input.timeoutMs } : {}),
    totalEnvVar: 'GEMINI_CODE_CONTEXT_CODE_TIMEOUT_MS',
    ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
    stallEnvVar: 'GEMINI_CODE_CONTEXT_CODE_STALL_MS',
  });
  const abortSignal = timeoutController.signal;
  try {
    // Workspace validation inside try → reported as a regular tool error
    // (errorResult, "code failed: …") rather than an unhandled exception
    // surfaced by the server-level handler.
    try {
      validateWorkspacePath(workspaceRoot);
    } catch (err) {
      if (err instanceof WorkspaceValidationError) {
        return errorResult(`code: ${err.message}`);
      }
      throw err;
    }

    emitter.emit(`resolving model '${modelRequest}'…`);
    // `code` is strictly text-reasoning — coding tasks genuinely benefit
    // from reasoning tokens, and dispatching to fast/lite tiers would
    // degrade output quality without meaningful cost savings. Crucially:
    // this category gate prevents image-gen / audio-gen / agent models
    // (which may share `pro` tokens with text models in Google's registry)
    // from reaching `generateContent` with a code-review prompt — the
    // primary motivation for the v1.4.0 taxonomy work.
    const resolved = await resolveModel(modelRequest, ctx.client, {
      requiredCategory: ['text-reasoning'],
    });
    resolvedModelKey = resolved.resolved;

    emitter.emit(`scanning workspace ${workspaceRoot}…`);
    const scan = await scanWorkspace(workspaceRoot, {
      ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
      ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
      maxFiles: ctx.config.maxFilesPerWorkspace,
      maxFileSizeBytes: ctx.config.maxFileSizeBytes,
    });

    // Output-cap strategy (v1.4.0) — see ask.tool.ts for full rationale
    // of the three-layer precedence. Summary: input.maxOutputTokens
    // (per-call) > ctx.config.forceMaxOutputTokens (MCP-host env) >
    // auto (omit from wire; Gemini uses model-default). Code review
    // commonly produces long OLD/NEW diff blocks, so operators doing
    // heavy review work set `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true`
    // to pin every call at the model's full 65,536-token capacity.
    const CODE_MAX_OUTPUT_TOKENS_FALLBACK = 65_536;
    const modelOutputLimit =
      typeof resolved.outputTokenLimit === 'number' && resolved.outputTokenLimit > 0
        ? resolved.outputTokenLimit
        : CODE_MAX_OUTPUT_TOKENS_FALLBACK;
    const wireMaxOutputTokens: number | undefined =
      input.maxOutputTokens !== undefined
        ? Math.min(input.maxOutputTokens, modelOutputLimit)
        : ctx.config.forceMaxOutputTokens
          ? modelOutputLimit
          : undefined;
    // Effective cap for thinking-budget clamp and budget reservation.
    // When auto (neither override set), Gemini's model-default equals
    // modelOutputLimit per Google docs, so using the limit as worst-case
    // keeps the daily $ cap a true upper bound.
    const effectiveOutputCap = wireMaxOutputTokens ?? modelOutputLimit;

    // Gemini requires `thinkingBudget < maxOutputTokens` (the thinking pool
    // is carved out of the candidate-output allowance). The hard cap above
    // may clamp maxOutputTokens as low as the model's `outputTokenLimit`
    // (e.g. 8_192 on Flash-lite). Clamp the effective thinkingBudget so
    // the generateContent call never 400s on this invariant; reserve at
    // least 1_024 tokens for the actual completion.
    //
    // Only meaningful on the thinkingBudget path — when the caller uses
    // `thinkingLevel` instead, `thinkingBudget` is `undefined` and this
    // value is ignored by the thinkingConfig builder below.
    //
    // Early-reject when the caller's per-call `maxOutputTokens` can't fit
    // an explicit positive `thinkingBudget` + 1024-token answer reserve.
    // Silently clamping to 0 would make Gemini 3 Pro 400 on a
    // "thinking disabled" error and obscure the real mismatch (PR #22
    // round-3 review finding #C).
    if (
      input.thinkingBudget !== undefined &&
      input.thinkingBudget > 0 &&
      input.maxOutputTokens !== undefined &&
      effectiveOutputCap < input.thinkingBudget + 1024
    ) {
      return errorResult(
        `code: thinkingBudget (${input.thinkingBudget}) + 1024-token answer reserve exceeds maxOutputTokens (${effectiveOutputCap}). Raise \`maxOutputTokens\` to at least ${input.thinkingBudget + 1024}, or lower \`thinkingBudget\`.`,
      );
    }
    const effectiveThinkingBudget =
      thinkingBudget !== undefined && thinkingBudget > 0
        ? Math.max(0, Math.min(thinkingBudget, effectiveOutputCap - 1024))
        : 0;

    // Cost-estimate thinking-token reserve — tier-aware when the caller
    // uses `thinkingLevel`, exact-on-the-budget when they use
    // `thinkingBudget`. Mirror of `ask.tool.ts` logic; see
    // `THINKING_LEVEL_RESERVE` in `shared/thinking.ts` for the rationale
    // behind the per-tier numbers and why HIGH falls through to the
    // dynamic cap.
    //
    // Defensive clamp: tier reserves (MINIMAL=512, LOW=2048, MEDIUM=4096)
    // are fixed constants, but `maxOutputTokens` can be clamped down to a
    // resolved model's `outputTokenLimit`. A future small-cap model (say
    // `outputTokenLimit: 4000`) would let MEDIUM's 4096 exceed the
    // available headroom and over-estimate the budget reservation. Clamp
    // every tier's reserve against the dynamic headroom so the upper
    // bound stays coherent across model rollouts (PR #17 self-review F2).
    const thinkingHeadroom = Math.max(0, effectiveOutputCap - 1024);
    const thinkingTokensForEstimate =
      input.thinkingLevel !== undefined
        ? Math.min(
            THINKING_LEVEL_RESERVE[input.thinkingLevel] ?? thinkingHeadroom,
            thinkingHeadroom,
          )
        : effectiveThinkingBudget;

    // Shared input-token fingerprint for budget + TPM throttle (see
    // ask.tool.ts for the rationale — same `Math.ceil(bytes/4)` tokenisation
    // used by `estimatePreCallCostUsd`). The PREFLIGHT against
    // `inputTokenLimit` goes through the v1.10.0 two-tier `countForPreflight`
    // (heuristic for small repos; real `countTokens` near the cliff). Closes
    // T17 (`bytes/4` undercount on dense Unicode).
    const workspaceBytes = scan.files.reduce((sum, f) => sum + f.size, 0);
    const estimatedInputTokens = Math.ceil(workspaceBytes / 4) + Math.ceil(input.task.length / 4);

    // v1.5.0 preflight (rebuilt v1.10.0 atop countTokens) — mirror of
    // ask.tool.ts guard. See there for rationale. Hoisted so the
    // success-path metadata can surface preflight provenance.
    let preflight: PreflightTokenResult | undefined;
    const contextWindow = resolved.inputTokenLimit;
    if (typeof contextWindow === 'number' && contextWindow > 0) {
      preflight = await countForPreflight(ctx.client, {
        files: scan.files,
        prompt: input.task,
        model: resolved.resolved,
        // `filesHash` is post-glob-filter — no separate globsHash needed.
        filesHash: scan.filesHash,
        ...(input.preflightMode !== undefined ? { preflightMode: input.preflightMode } : {}),
        inputTokenLimit: contextWindow,
        // See ask.tool.ts for AbortSignal contract — abort propagates as
        // `AbortError` to outer catch (mapped to `errorCode: 'TIMEOUT'`).
        signal: abortSignal,
      });
      const threshold = Math.floor(contextWindow * ctx.config.workspaceGuardRatio);
      if (preflight.effectiveTokens > threshold) {
        const pctDisplay = Math.round(ctx.config.workspaceGuardRatio * 100);
        return errorResult(
          `Workspace too large for eager \`code\`: ~${preflight.effectiveTokens.toLocaleString()} input tokens (${preflight.method} count) exceeds ${threshold.toLocaleString()} (${pctDisplay}% of ${resolved.resolved}'s ${contextWindow.toLocaleString()} context window). Options: (a) pass \`excludeGlobs\` to filter large/generated files — supports \`*.ext\` patterns, filenames, and directory paths, (b) narrow with \`includeGlobs\`, (c) switch to a larger-context model, (d) split the workspace into subdirectories, or (e) use \`ask_agentic\` for Q&A-style analysis without uploading the repo (\`code\` itself still requires the eager path for its OLD/NEW edit format).`,
          {
            errorCode: 'WORKSPACE_TOO_LARGE',
            retryable: false,
            estimatedInputTokens: preflight.effectiveTokens,
            tokenCountMethod: preflight.method,
            rawTokenCount: preflight.rawTokens,
            tokenCountCacheHit: preflight.cacheHit,
            contextWindowTokens: contextWindow,
            thresholdTokens: threshold,
            guardRatio: ctx.config.workspaceGuardRatio,
            resolvedModel: resolved.resolved,
            filesIndexed: scan.files.length,
          },
        );
      }
    } else {
      logger.warn(
        `code: resolved model ${safeForLog(resolved.resolved)} has no advertised inputTokenLimit — workspace size guard skipped. Request may fail downstream if the workspace exceeds the model's context window.`,
      );
    }

    // Atomic budget reservation — see ask.tool.ts for the full rationale.
    // Estimate includes the thinking budget (billed as output tokens on Pro)
    // PLUS the candidate output cap.
    if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
      const estimateUsd = estimatePreCallCostUsd({
        model: resolved.resolved,
        workspaceBytes,
        promptChars: input.task.length,
        expectedOutputTokens: effectiveOutputCap,
        thinkingTokens: thinkingTokensForEstimate,
      });
      const reserve = ctx.manifest.reserveBudget({
        workspaceRoot,
        toolName: 'code',
        model: resolved.resolved,
        estimatedCostMicros: toMicrosUsd(estimateUsd),
        dailyBudgetMicros: toMicrosUsd(ctx.config.dailyBudgetUsd),
        nowMs: Date.now(),
      });
      if ('rejected' in reserve) {
        const spentUsd = reserve.spentMicros / 1_000_000;
        return errorResult(
          `Daily budget cap would be exceeded: spent $${spentUsd.toFixed(4)} + estimate $${estimateUsd.toFixed(4)} > cap $${ctx.config.dailyBudgetUsd.toFixed(2)}. Retry after UTC midnight, or raise \`GEMINI_DAILY_BUDGET_USD\`.`,
          { errorCode: 'BUDGET_REJECT', retryable: false },
        );
      }
      reservationId = reserve.id;
    }

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
      // codeExecution requires `tools:[{codeExecution:{}}]` on generateContent,
      // which Gemini rejects together with cachedContent. Force inline path
      // when codeExecution is requested so we have actual inline file parts
      // to embed alongside the prompt.
      allowCaching: scan.files.length > 0 && !codeExecution,
    });

    // TPM throttle — placed AFTER `prepareContext`, immediately before
    // `generateContent`, so the reservation's `tsMs` accurately reflects
    // when tokens hit Gemini's quota counter. See ask.tool.ts for the
    // full rationale and the cold-cache-timing concern it fixes.
    //
    // Extracted into a helper so the stale-cache retry branch can
    // cancel-and-re-reserve with an accurate tsMs rather than reusing a
    // stale reservation.
    const reserveForDispatch = async (): Promise<void> => {
      if (ctx.config.tpmThrottleLimit <= 0) return;
      const reservation = ctx.throttle.reserve(resolved.resolved, estimatedInputTokens);
      throttleReservationId = reservation.releaseId;
      if (reservation.delayMs > 0) {
        emitter.emit(`throttle: waiting ${Math.ceil(reservation.delayMs / 1000)}s for TPM window…`);
        // Abortable — wall-clock timeout (T19) must beat throttle delay.
        await abortableSleep(reservation.delayMs, abortSignal);
      }
    };
    await reserveForDispatch();

    const userPrompt = expectEdits
      ? `${input.task}\n\nRespond with your rationale and OLD/NEW diff blocks per the system instruction.`
      : input.task;

    const thinkingDescription = usingThinkingLevel
      ? `thinking-level=${input.thinkingLevel}`
      : `thinking=${effectiveThinkingBudget}`;
    emitter.emit(
      codeExecution
        ? `generating with ${thinkingDescription} + codeExecution…`
        : `generating with ${thinkingDescription}…`,
    );

    // Two mutually-exclusive reasoning-control paths (enforced by schema
    // `.refine()`):
    //   a) `thinkingLevel` set → cast to the SDK enum and pass through.
    //      Google's recommended path on Gemini 3. Rejected by Gemini 2.5.
    //      Cast rather than runtime enum-object lookup so a future SDK
    //      rename surfaces as a Gemini 400, not a silent `undefined`.
    //   b) `thinkingBudget` path (default 16_384, clamped above) → pass
    //      `thinkingBudget` as before.
    // `includeThoughts: true` is unconditional so `thinkingSummary`
    // extraction below always has material to find.
    const thinkingConfig: ThinkingConfig = usingThinkingLevel
      ? {
          thinkingLevel: input.thinkingLevel as ThinkingLevel,
          includeThoughts: true,
        }
      : { thinkingBudget: effectiveThinkingBudget, includeThoughts: true };

    // Gemini rejects generateContent({cachedContent, system_instruction|tools|tool_config})
    // with 400. System instruction is baked into the cache at build time; tools
    // (codeExecution) cannot be combined with a cache built without them. When
    // codeExecution is requested AND a cache is active, we can't use both — in that
    // case we bypass the cache so the user's explicit codeExecution request wins.
    const canUseCache = (cacheId: string | null): boolean => cacheId !== null && !codeExecution;
    if (ctxPrep.cacheId && codeExecution) {
      logger.warn(
        'code({ codeExecution: true }) is incompatible with an active cache; bypassing cache for this call.',
      );
    }
    const buildConfig = (cacheId: string | null): GenerateContentConfig => {
      const maxOutputField =
        wireMaxOutputTokens !== undefined ? { maxOutputTokens: wireMaxOutputTokens } : {};
      if (canUseCache(cacheId) && cacheId) {
        // With cache: system_instruction is baked in; thinkingConfig remains OK.
        // `maxOutputTokens` only emitted when the caller set it explicitly
        // or `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true` — otherwise omit
        // and Gemini uses its model-default.
        return {
          cachedContent: cacheId,
          thinkingConfig,
          ...maxOutputField,
        };
      }
      // Without cache (or cache bypassed for codeExecution): pass full config.
      return {
        systemInstruction: SYSTEM_INSTRUCTION_CODE,
        thinkingConfig,
        ...maxOutputField,
        ...(codeExecution ? { tools: [{ codeExecution: {} }] } : {}),
      };
    };
    const buildContents = (
      cacheId: string | null,
      inline: typeof ctxPrep.inlineContents,
    ): string | Content[] =>
      canUseCache(cacheId)
        ? userPrompt
        : [...inline, { role: 'user', parts: [{ text: userPrompt }] }];

    let activePrep = ctxPrep;
    let retriedOnStaleCache = false;
    let response: CollectedResponse;
    try {
      // T20 (v1.7.0) — withNetworkRetry wraps ONLY the stream opening.
      // Mid-stream failures cannot be retried (Gemini's stream API has no
      // resume) — wrapping collectStream too would discard the partial
      // response and re-open a new stream → DOUBLE BILLING. See
      // ask.tool.ts for the full rationale.
      const stream = await withNetworkRetry(
        () =>
          ctx.client.models.generateContentStream({
            model: resolved.resolved,
            contents: buildContents(activePrep.cacheId, activePrep.inlineContents),
            config: { ...buildConfig(activePrep.cacheId), abortSignal },
          }),
        {
          signal: abortSignal,
          onRetry: (attempt, retryErr) => {
            logger.warn(
              `code: retrying generateContent after transient network failure (attempt ${attempt}): ${
                retryErr instanceof Error ? retryErr.message : String(retryErr)
              }`,
            );
          },
        },
      );
      response = await collectStream(stream, {
        signal: abortSignal,
        onThoughtChunk: (text) => {
          const trimmed = text.trim().slice(0, 80);
          if (trimmed.length > 0) emitter.emit(`thinking: ${trimmed}…`);
        },
        // v1.12.0 — stall watchdog reset on every chunk.
        onChunkReceived: () => timeoutController.recordChunk(),
      });
    } catch (err) {
      if (activePrep.cacheId && isStaleCacheError(err)) {
        logger.warn(
          `Gemini rejected cached content ${activePrep.cacheId}; invalidating and retrying once.`,
        );
        try {
          // Reset cache pointer only — preserve `files` rows so the rebuild
          // reuses uploaded files via content-hash dedup instead of double-
          // uploading. The Gemini-side cache is already dead.
          markCacheStale({ manifest: ctx.manifest, workspaceRoot });
          const rebuilt = await prepareContext({
            client: ctx.client,
            manifest: ctx.manifest,
            scan,
            model: resolved,
            systemPromptHash,
            systemInstruction: SYSTEM_INSTRUCTION_CODE,
            ttlSeconds: ctx.config.cacheTtlSeconds,
            cacheMinTokens: ctx.config.cacheMinTokens,
            emitter,
            allowCaching: scan.files.length > 0 && !codeExecution,
          });
          // Cancel stale reservation (tsMs was stamped before first
          // dispatch, now seconds old after rebuild) and re-reserve so
          // the retry's tsMs matches actual dispatch time. Mirror of
          // ask.tool.ts — see rationale there.
          if (throttleReservationId !== -1) {
            ctx.throttle.cancel(throttleReservationId);
            throttleReservationId = -1;
          }
          await reserveForDispatch();
          // The stale-cache retry itself can hit a transient network failure;
          // wrap it too so the rebuild isn't wasted on a one-off blip.
          // Stale-cache retry — discard partial, open fresh stream. Same
          // retry-OPENING-only contract as the happy path above.
          const retryStream = await withNetworkRetry(
            () =>
              ctx.client.models.generateContentStream({
                model: resolved.resolved,
                contents: buildContents(rebuilt.cacheId, rebuilt.inlineContents),
                config: { ...buildConfig(rebuilt.cacheId), abortSignal },
              }),
            {
              signal: abortSignal,
              onRetry: (attempt, retryErr) => {
                logger.warn(
                  `code (stale-cache retry): retrying generateContent after transient network failure (attempt ${attempt}): ${
                    retryErr instanceof Error ? retryErr.message : String(retryErr)
                  }`,
                );
              },
            },
          );
          response = await collectStream(retryStream, {
            signal: abortSignal,
            onThoughtChunk: (text) => {
              const trimmed = text.trim().slice(0, 80);
              if (trimmed.length > 0) emitter.emit(`thinking: ${trimmed}…`);
            },
            // v1.12.0 — stall watchdog reset on retry stream.
            onChunkReceived: () => timeoutController.recordChunk(),
          });
          activePrep = rebuilt;
          retriedOnStaleCache = true;
        } catch (retryErr) {
          // Re-throw timeout directly so the outer catch's `isTimeoutAbort`
          // sees it. Wrapping with `cause: err` (the original stale-cache
          // error) would mask the timeout; outer catch would map to UNKNOWN
          // instead of TIMEOUT.
          if (isTimeoutAbort(retryErr)) throw retryErr;
          throw new Error(
            `code retry after stale cache failed: ${
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

    const text = response.text;
    const edits = expectEdits ? parseEdits(text) : [];
    const codeBlocks = parseCodeBlocks(text);

    // Extract code_execution tool artifacts. Thought summary now comes from
    // `collectStream` (T20) — `response.thoughtsSummary` is already capped
    // and matches the live progress emit. We still iterate candidates here
    // for executableCode / codeExecutionResult parts (those aren't
    // accumulated by collectStream — they're full per-chunk artefacts).
    const executedCode: string[] = [];
    const executionOutput: string[] = [];
    const candidates = response.candidates ?? [];
    for (const cand of candidates) {
      const parts = cand.content?.parts ?? [];
      for (const part of parts) {
        if (part.executableCode?.code) executedCode.push(part.executableCode.code);
        if (part.codeExecutionResult?.output) executionOutput.push(part.codeExecutionResult.output);
      }
    }
    const thinkingSummary = response.thoughtsSummary;

    const usage = response.usageMetadata;
    const cached =
      typeof usage?.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0;
    const inputTotal = typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
    const uncached = Math.max(0, inputTotal - cached);
    const output = typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
    const thinking = typeof usage?.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : 0;

    // Finalise TPM throttle reservation with actual input tokens
    // (cached + uncached — both count toward Gemini's per-minute quota).
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
      // Defensive: if `finalize` throws (disk full / lock contention), keep
      // the reservation row so we don't lose all record of this billable
      // call. Drop `reservationId` either way so the outer catch doesn't
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
          `code: finalizeBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate (${costMicros} micros). Error: ${String(finalizeErr)}`,
        );
      }
      reservationId = null;
    } else {
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
    }

    if (scan.truncated) {
      logger.warn(
        `workspace ${workspaceRoot} contains more files than GEMINI_CODE_CONTEXT_MAX_FILES (${ctx.config.maxFilesPerWorkspace}); the tail was dropped before indexing.`,
      );
    }

    const structured: Record<string, unknown> = {
      resolvedModel: resolved.resolved,
      requestedModel: resolved.requested,
      modelCategory: resolved.category,
      modelCostTier: resolved.capabilities.costTier,
      contextWindow: resolved.inputTokenLimit,
      // `thinkingBudget` echoes the clamped value actually sent on the
      // wire; it's only meaningful on the budget path. On the
      // `thinkingLevel` path nothing is sent for `thinkingBudget`, so we
      // emit `null` (not `0`) — `0` is the wire sentinel for "thinking
      // disabled" and reporting it here for a level-path call would lie
      // to downstream audit / dashboard consumers (PR #17 self-review F1,
      // 3-reviewer consensus: GPT + Copilot + Self). Matches `ask.tool.ts`.
      thinkingBudget: usingThinkingLevel ? null : effectiveThinkingBudget,
      thinkingLevel: input.thinkingLevel ?? null,
      codeExecutionUsed: codeExecution,
      cacheHit: activePrep.reused,
      cacheRebuilt: activePrep.rebuilt || retriedOnStaleCache,
      retriedOnStaleCache,
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
      filesUploadFailed: activePrep.uploaded.failedCount,
      ...(activePrep.uploaded.failedCount > 0
        ? { uploadFailures: activePrep.uploaded.failures.slice(0, 5) }
        : {}),
      inlineOnly: activePrep.inlineOnly,
      // Preflight token-count provenance — surfaces on every successful
      // call. See ask.tool.ts for the contract; same fields apply here.
      ...(preflight !== undefined
        ? {
            tokenCountMethod: preflight.method,
            rawTokenCount: preflight.rawTokens,
            tokenCountCacheHit: preflight.cacheHit,
          }
        : {}),
      ...(thinkingSummary ? { thinkingSummary } : {}),
      ...(executedCode.length > 0 ? { executedCode } : {}),
      ...(executionOutput.length > 0 ? { executionOutput } : {}),
    };

    return textResult(text, structured);
  } catch (err) {
    logger.error(`code failed: ${safeForLog(err)}`);
    // T22a + v1.3.2 — seed the throttle's retry-hint from Gemini 429
    // bodies, gated on `isGemini429` (ApiError instance + status===429)
    // to prevent hint-poisoning. Mirror of ask.tool.ts — see there for
    // full rationale.
    const retryDelayMs = isGemini429(err) ? parseRetryDelayMs(err.message) : null;
    if (retryDelayMs !== null && resolvedModelKey !== null) {
      ctx.throttle.recordRetryHint(resolvedModelKey, retryDelayMs);
    }
    if (reservationId !== null) {
      try {
        ctx.manifest.cancelBudgetReservation(reservationId);
      } catch (cancelErr) {
        logger.error(
          `code: cancelBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate. Error: ${String(cancelErr)}`,
        );
      }
      reservationId = null;
    }
    // Drop TPM reservation on failure — mirror of ask.tool.ts rationale.
    if (throttleReservationId !== -1) {
      ctx.throttle.cancel(throttleReservationId);
      throttleReservationId = -1;
    }
    // v1.12.0 — `timeoutKind` distinguishes wall-clock cap from stall watchdog.
    if (isTimeoutAbort(err)) {
      const ms = timeoutController.timeoutMs;
      const stallMs = timeoutController.stallMs;
      const kind = getTimeoutKind(err);
      const limitMs = kind === 'stall' ? stallMs : ms;
      emitter.emit(`code: aborted after ${limitMs ?? '?'}ms ${kind ?? 'timeout'}`);
      const message =
        kind === 'stall'
          ? `code timed out — no chunk received for ${stallMs ?? '?'}ms (stall watchdog). Increase \`stallMs\` per call or set \`GEMINI_CODE_CONTEXT_CODE_STALL_MS\` higher; default disabled. Stall watchdog is heartbeat-aware — it does NOT fire while the model is streaming chunks. A fired stall is usually a dead socket or a server-side hang. Note: AbortSignal is client-only — Gemini still finishes server-side and bills for completed work.`
          : `code timed out after ${ms ?? '?'}ms (total wall-clock). Increase \`timeoutMs\` per call or set \`GEMINI_CODE_CONTEXT_CODE_TIMEOUT_MS\` higher; default disabled. Consider \`stallMs\` instead — a heartbeat-aware watchdog that does NOT fire while the model is actively thinking. Note: AbortSignal is client-only — Gemini still finishes server-side and bills for completed work.`;
      return errorResult(message, {
        errorCode: 'TIMEOUT',
        timeoutKind: kind ?? 'total',
        timeoutMs: ms,
        stallMs,
        retryable: true,
      });
    }
    const httpStatus = (err as { status?: number }).status;
    return errorResult(`code failed: ${err instanceof Error ? err.message : String(err)}`, {
      errorCode: 'UNKNOWN',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    });
  } finally {
    timeoutController.dispose();
    emitter.stop();
  }
}
