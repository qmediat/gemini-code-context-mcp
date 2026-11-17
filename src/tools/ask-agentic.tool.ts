/**
 * `ask_agentic` tool — answers workspace questions without eager repo upload.
 *
 * Design — contrast with the eager `ask` tool:
 *   - `ask`      : uploads workspace → Context Cache → single generateContent.
 *                  Great for repeat queries on a cached repo; fails when
 *                  the workspace tokens exceed `inputTokenLimit * guardRatio`.
 *   - `ask_agentic` : sends only the user's prompt + function-call tool
 *                     declarations. Gemini decides which files to read via
 *                     `list_directory` / `find_files` / `read_file` / `grep`.
 *                     Loop runs until the model emits a text-only response
 *                     (no more function calls), or until a guard trips
 *                     (max iterations, token budget, no-progress loop).
 *
 * This path scales to any repo size — the model reads only what it needs
 * for the specific question. Cost profile is different from `ask`: more
 * API round trips, but total tokens usually much smaller on big repos
 * (because you never upload files the question doesn't need).
 *
 * Codex PR consultation (gpt-5.3-codex, 2026-04-21) fed into the design:
 *   - Hard byte limits on tool responses (executors enforce)
 *   - `realpath` + root jail (sandbox module)
 *   - Prompt-injection defence in `systemInstruction`
 *   - No-progress detection (same call signature 3× → partial answer)
 *   - Parallel tool execution with concurrency cap
 *   - Recoverable-error via `functionResponse.error`; hard-fail for
 *     security / budget / timeouts
 *   - `notifications/progress` per iteration for UX
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { thinkingBudgetRefusal } from '../gemini/long-decode.js';
import { resolveModel } from '../gemini/models.js';
import { defaultMatchConfig } from '../indexer/globs.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../indexer/workspace-validation.js';
import { logger, safeForLog } from '../utils/logger.js';
import { type ProgressEmitter, createProgressEmitter } from '../utils/progress.js';
import { runLoop } from './agentic/loop.js';
import { runRescue } from './agentic/rescue.js';
import { maxIterationsResult } from './agentic/results.js';
import {
  type AgenticRun,
  type ResolvedModel,
  baseConfigOf,
  newLoopState,
  passBudgetOf,
  runLimitsOf,
} from './agentic/run.js';
import { resolveWorkspaceRoot } from './agentic/sandbox.js';
import {
  type TextToolResult,
  type ToolContext,
  type ToolDefinition,
  errorResult,
} from './registry.js';
import { THINKING_LEVEL_FIELD } from './shared/thinking.js';
import { isGemini429, parseRetryDelayMs } from './shared/throttle.js';

export { resolveToolExecutionConcurrency } from './agentic/dispatch.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const askAgenticInputSchema = z
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
        "Model alias ('latest-pro', 'latest-pro-thinking', 'latest-flash') or literal model ID. Defaults to the configured default (GEMINI_CODE_CONTEXT_DEFAULT_MODEL, then the credentials profile, then `latest-pro-thinking`).",
      ),
    includeGlobs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional file extensions or filenames to include. Honoured by the four agentic tools (`list_directory`, `find_files`, `read_file`, `grep`) — the model never sees paths outside these globs. Mirrors the `ask` / `code` semantics so callers (or `ask` → `ask_agentic` fallback in v1.9.0+) get consistent filtering.',
      ),
    excludeGlobs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional patterns to exclude. Same three shapes as `ask` / `code`: (1) directory names or path prefixes (`node_modules`, `src/vendor`, `./dist/`, `.vercel/`), (2) literal filenames exact-match including bare dot-prefixed names (`pr27-diff.txt`, `foo.bar.baz`, `.env`, `.tsbuildinfo`), (3) extension globs that match via endsWith (`*.tsbuildinfo`, `*.map`). Bare dot-prefixed names like `.env` are treated as exact filename literals — write `*.env` for extension semantics. Paths are POSIX-normalised. Case-insensitive. No mid-string `*` / `**` / `?`. **Privacy-relevant:** when `ask` falls back to `ask_agentic` on `WORKSPACE_TOO_LARGE`, the user-supplied excludes here are honoured by every executor: `read_file` rejects with `EXCLUDED_FILE` (generic message — does NOT echo the excluded path, so the error string cannot be used as a path-existence oracle); `list_directory` and `grep` reject the requested directory / `pathPrefix` itself with `EXCLUDED_DIR` when it matches an exclude (top-level gate, not just child filtering); `find_files` skips the dir during walk; child entries inside an unexcluded parent are still hidden when they themselves match an exclude.',
      ),
    thinkingBudget: z.number().int().min(-1).max(65_536).optional(),
    thinkingLevel: THINKING_LEVEL_FIELD,
    maxOutputTokens: z.number().int().min(1).optional(),
    maxIterations: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Hard cap on agentic LOOP iterations (each iteration = one Gemini generateContent + possible tool calls). Default 20. When the loop exhausts this cap without producing final-text, ONE additional non-tool `generateContent` (forced-finalization rescue) runs to synthesise an answer from gathered tool responses. **`structuredContent.apiCalls` is the authoritative total `generateContent` count** (loop iterations + 1 if the rescue dispatched, regardless of outcome). `convergenceForced: true` indicates ONLY that the rescue produced text successfully — an attempted-but-failed rescue increments `apiCalls` without setting `convergenceForced`. Rescue is bounded by `dailyBudgetUsd` and `iterationTimeoutMs`; see `maxTotalInputTokens` for the cap-overshoot contract. **v1.15.0:** rescue-attempted-but-failed paths additionally surface `structuredContent.rescueErrorCode` (`'TIMEOUT' | 'RATE_LIMIT' | 'INTERNAL' | 'API_ERROR' | 'NETWORK' | 'EMPTY_TEXT'`) + `rescueErrorMessage` (truncated to 500 chars) so wrappers can branch retry behaviour without log scraping. Retry policy: TIMEOUT → raise iterationTimeoutMs; RATE_LIMIT → wait retry-hint window; INTERNAL → investigate code (don't retry blindly); API_ERROR → check status (don't retry 4xx); NETWORK → safe to retry; EMPTY_TEXT → narrow prompt.",
      ),
    maxTotalInputTokens: z
      .number()
      .int()
      .min(10_000)
      .optional()
      .describe(
        "Cumulative input-token budget across all iterations. Default 1_000_000. Loop iterations HARD-STOP past this cap (subReason: 'AGENTIC_INPUT_BUDGET_EXCEEDED'). The post-loop forced-finalization rescue is NOT gated on this cap — it may push cumulative tokens past by one call's worth, signalled via `overBudget: true` on the result. Rescue cost remains bounded by `dailyBudgetUsd`; wall-clock by `iterationTimeoutMs`.",
      ),
    maxFilesRead: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Cap on distinct files opened via `read_file` during this agentic call. Default 40.',
      ),
    iterationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .optional()
      .describe(
        "Per-iteration wall-clock timeout in ms (1s–30min). Each agentic iteration (one generateContent + possible tool calls + per-iteration TPM throttle wait) is bounded by this. **A single iteration that times out FAILS THE WHOLE agentic call** with `errorCode: 'TIMEOUT'` (the failed iteration's function-call results never came back, leaving the conversation structurally incomplete — continuing with partial state would 400 on the next turn). The post-loop forced-finalization rescue pass is ALSO bounded by this timeout, but its timeout behaviour DIFFERS: rescue timeouts are caught best-effort and fall through to the original `subReason: 'AGENTIC_MAX_ITERATIONS'` shape with `errorCode: 'UNKNOWN'` (NOT `'TIMEOUT'`) — the rescue is the documented exit path, and surfacing TIMEOUT for it would obscure the underlying maxIterations exhaustion. Operators detect rescue-attempted-but-failed via `apiCalls > iterations` and `convergenceForced` absent. Whole-loop budget is also bounded by `maxIterations` × `maxTotalInputTokens`. When omitted, falls back to env var `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS`, then to disabled.",
      ),
    stallMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe(
        'Per-iteration HEARTBEAT-AWARE stall watchdog in ms (1s–10min). Resets on every chunk yielded by `generateContentStream` (text or thought) — fires ONLY when the stream goes silent for this long. Does NOT fire while the model is actively thinking. Right knob for "kill dead sockets quickly without penalising deep reasoning." Recommended: `60_000` (60s). Falls back to env var `GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS`, then disabled. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "stall"` on abort. Independent of `iterationTimeoutMs` — both can be set; whichever fires first wins. **Loop iterations only — the post-loop forced-finalization rescue pass keeps the v1.15.0 `apiCallSucceeded` non-streaming contract.**',
      ),
  })
  .refine((data) => !(data.thinkingBudget !== undefined && data.thinkingLevel !== undefined), {
    message:
      'Cannot specify both `thinkingBudget` and `thinkingLevel` — mutually exclusive (Gemini rejects).',
    path: [],
  });

export type AskAgenticInput = z.infer<typeof askAgenticInputSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const askAgenticTool: ToolDefinition<AskAgenticInput> = {
  name: 'ask_agentic',
  title: 'Ask Gemini (agentic)',
  description:
    "Surgical fallback for repos that exceed `ask`'s model input-token limit (~1M tokens for Gemini Pro), OR when you only need a handful of files (cheaper than eager-uploading a large repo). Gemini uses sandboxed file-access tools (`list_directory`, `find_files`, `read_file`, `grep`) to read only what it needs across multiple iterations (default 20). Cost profile: more API round trips than `ask`, but total tokens usually much smaller on big repos. **Wall-clock is structurally slower than `ask`** — each iteration pays ~30-60s of HIGH-thinking latency, so a 20-iter call can take 10-20 minutes. For the fast path, use `ask`. For oversize repos or focused investigation, use `ask_agentic`.",
  schema: askAgenticInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    const model = input.model ?? ctx.config.defaultModel ?? 'latest-pro-thinking';
    return executeAskAgenticBody(input, ctx, workspaceRoot, model, started);
  },
};

/** One `ask_agentic` call as `execute` received it. */
interface AgenticCall {
  input: AskAgenticInput;
  ctx: ToolContext;
  rawWorkspaceRoot: string;
  model: string;
  started: number;
  emitter: ProgressEmitter;
}

/** The model once resolved — read by the outer catch to key a 429's retry hint (`undefined` before resolution). */
interface Resolution {
  resolved: ResolvedModel | undefined;
}

/**
 * Validate the workspace and canonicalise its root (symlink-resolved) so every tool call resolves
 * against the same canonical path; the downstream sandbox compares against this root.
 */
async function openWorkspace(
  rawWorkspaceRoot: string,
): Promise<{ root: string } | { refused: TextToolResult }> {
  try {
    validateWorkspacePath(rawWorkspaceRoot);
  } catch (err) {
    if (err instanceof WorkspaceValidationError) {
      return { refused: errorResult(`ask_agentic: ${err.message}`) };
    }
    throw err;
  }
  try {
    return { root: await resolveWorkspaceRoot(rawWorkspaceRoot) };
  } catch (err) {
    return {
      refused: errorResult(
        `ask_agentic: workspace not accessible: ${err instanceof Error ? err.message : String(err)}`,
        { errorCode: 'UNKNOWN', retryable: false },
      ),
    };
  }
}

/** A thinking budget the output cap cannot hold is refused locally, so the model never answers a 400
 * "thinking exceeds output budget". */
function thinkingRefusal(input: AskAgenticInput): TextToolResult | null {
  const budgetRefusal = thinkingBudgetRefusal(
    input.thinkingBudget,
    input.maxOutputTokens,
    input.maxOutputTokens ?? 0,
  );
  if (budgetRefusal === null) return null;
  return errorResult(`ask_agentic: ${budgetRefusal}`, {
    errorCode: 'UNKNOWN',
    retryable: false,
    subReason: 'INVALID_THINKING_OUTPUT_COMBO',
  });
}

/**
 * Build the user-glob filter once at entry — the same `MatchConfig` gets threaded through every
 * executor invocation in the loop. v1.9.0+ Phase 1 closes the privacy gap that previously dropped
 * user-supplied `excludeGlobs` whenever a caller (or an `ask` → `ask_agentic` fallback) targeted the
 * agentic loop. Returns the run, or the refusal of a thinking budget the output cap cannot hold.
 */
function startRun(
  call: AgenticCall,
  resolved: ResolvedModel,
  workspaceRoot: string,
): AgenticRun | TextToolResult {
  const { input, ctx, emitter } = call;
  const limits = runLimitsOf(input);
  const matchConfig = defaultMatchConfig({
    ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
    ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
  });
  const refusal = thinkingRefusal(input);
  if (refusal !== null) return refusal;
  const baseConfig = baseConfigOf(input);
  emitter.emit('starting agentic loop…');
  const budget = passBudgetOf(input, ctx, resolved.resolved);
  const { started } = call;
  return {
    input,
    ctx,
    emitter,
    resolved,
    workspaceRoot,
    started,
    limits,
    matchConfig,
    baseConfig,
    budget,
  };
}

/**
 * The call after the workspace is open: resolve the model, run the loop, and — when it exhausted
 * `maxIterations` without an answer — the forced-finalization pass. `resolveModel` either returns a
 * ResolvedModel or throws; the `undefined` check only narrows the type.
 */
async function answerAgentic(call: AgenticCall, resolution: Resolution): Promise<TextToolResult> {
  const workspace = await openWorkspace(call.rawWorkspaceRoot);
  if ('refused' in workspace) return workspace.refused;
  call.emitter.emit(`resolving model '${call.model}'…`);
  resolution.resolved = await resolveModel(call.model, call.ctx.client, {
    requiredCategory: ['text-reasoning', 'text-fast', 'text-lite'],
  });
  const resolved = resolution.resolved;
  if (!resolved) throw new Error('ask_agentic: resolveModel returned undefined (unreachable)');
  const run = startRun(call, resolved, workspace.root);
  if (!('budget' in run)) return run;
  const state = newLoopState(call.input.prompt);
  const ended = await runLoop(run, state);
  if (ended !== null) return ended;
  const rescue = await runRescue(run, state);
  return maxIterationsResult(run, state, rescue);
}

/**
 * Any failure the loop did not shape. v1.14.3 (Phase4-F1 follow-up): a 429 thrown POST-resolution
 * that bypassed the inner iteration / finalization catches seeds the throttle hint for the resolved
 * model. PRE-RESOLUTION 429s (Google rate-limiting `models.list()` during the very first call after
 * API-key rotation or quota reset) still DISCARD the hint: recording it against the unresolved alias
 * (e.g. 'latest-pro-thinking') would key the throttle hint to a string that future calls won't match
 * — they'd resolve to a literal model id, miss the alias-keyed hint, retry too soon. (Pinned by the
 * `outer-catch 429 from PRE-resolution path... does NOT seed hint` test.)
 */
function failedCall(err: unknown, ctx: ToolContext, resolved: ResolvedModel | undefined) {
  logger.error(`ask_agentic failed: ${safeForLog(err)}`);
  const httpStatus = (err as { status?: number }).status;
  if (typeof resolved?.resolved === 'string') {
    const outerRetryDelayMs = isGemini429(err) ? parseRetryDelayMs(err.message) : null;
    if (outerRetryDelayMs !== null) {
      ctx.throttle.recordRetryHint(resolved.resolved, outerRetryDelayMs);
    }
  }
  return errorResult(`ask_agentic failed: ${err instanceof Error ? err.message : String(err)}`, {
    errorCode: 'UNKNOWN',
    retryable: false,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  });
}

async function executeAskAgenticBody(
  input: AskAgenticInput,
  ctx: ToolContext,
  rawWorkspaceRoot: string,
  model: string,
  started: number,
): Promise<TextToolResult> {
  const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
  const resolution: Resolution = { resolved: undefined };
  try {
    return await answerAgentic(
      { input, ctx, rawWorkspaceRoot, model, started, emitter },
      resolution,
    );
  } catch (err) {
    return failedCall(err, ctx, resolution.resolved);
  } finally {
    emitter.stop();
  }
}
