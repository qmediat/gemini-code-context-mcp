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
 *   - No-progress detection (a call signature repeated with no new file read → partial answer)
 *   - Parallel tool execution with concurrency cap
 *   - Recoverable-error via `functionResponse.error`; hard-fail for
 *     security / budget / timeouts
 *   - `notifications/progress` per iteration for UX
 */

import { resolve } from 'node:path';
import { thinkingBudgetRefusal } from '../gemini/long-decode.js';
import { resolveModel } from '../gemini/models.js';
import { defaultMatchConfig } from '../indexer/globs.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../indexer/workspace-validation.js';
import { logger, safeForLog } from '../utils/logger.js';
import { type ProgressEmitter, createProgressEmitter } from '../utils/progress.js';
import { type AskAgenticInput, askAgenticInputSchema } from './agentic/input.js';
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
import { seedRetryHint } from './shared/throttle.js';

export { resolveToolExecutionConcurrency } from './agentic/dispatch.js';
export { type AskAgenticInput, askAgenticInputSchema } from './agentic/input.js';

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
): { run: AgenticRun } | { refused: TextToolResult } {
  const { input, ctx, emitter } = call;
  const limits = runLimitsOf(input);
  const matchConfig = defaultMatchConfig({
    ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
    ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
  });
  const refusal = thinkingRefusal(input);
  if (refusal !== null) return { refused: refusal };
  const baseConfig = baseConfigOf(input);
  emitter.emit('starting agentic loop…');
  const budget = passBudgetOf(input, ctx);
  const { started } = call;
  return {
    run: {
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
    },
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
  const start = startRun(call, resolved, workspace.root);
  if ('refused' in start) return start.refused;
  const { run } = start;
  const state = newLoopState(call.input.prompt);
  const ended = await runLoop(run, state);
  if (ended !== null) return ended;
  const rescue = await runRescue(run, state);
  return maxIterationsResult(run, state, rescue);
}

/**
 * Any failure the loop did not shape. A 429 thrown POST-resolution seeds the throttle hint for the
 * resolved model unless an inner catch already seeded it (`seedRetryHint` records each 429 once — an
 * iteration's 429 is re-thrown to here). PRE-RESOLUTION 429s (Google rate-limiting `models.list()` during the very first call after
 * API-key rotation or quota reset) still DISCARD the hint: recording it against the unresolved alias
 * (e.g. 'latest-pro-thinking') would key the throttle hint to a string that future calls won't match
 * — they'd resolve to a literal model id, miss the alias-keyed hint, retry too soon. (Pinned by the
 * `outer-catch 429 from PRE-resolution path... does NOT seed hint` test.)
 */
function failedCall(err: unknown, ctx: ToolContext, resolved: ResolvedModel | undefined) {
  logger.error(`ask_agentic failed: ${safeForLog(err)}`);
  const httpStatus = (err as { status?: number }).status;
  if (typeof resolved?.resolved === 'string') {
    seedRetryHint(ctx.throttle, resolved.resolved, err);
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
