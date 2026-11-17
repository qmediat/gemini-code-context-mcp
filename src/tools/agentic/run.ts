/**
 * The typed state of one `ask_agentic` call: what is fixed when the loop starts (`AgenticRun` — the model, the
 * limits, the request config, the per-pass reservation inputs) and what the loop accumulates (`LoopState`).
 */

import type { Content, GenerateContentConfig, ThinkingConfig, ThinkingLevel } from '@google/genai';
import type { resolveModel } from '../../gemini/models.js';
import type { MatchConfig } from '../../indexer/globs.js';
import { estimateReservationUsd } from '../../utils/cost-estimator.js';
import type { ProgressEmitter } from '../../utils/progress.js';
import type { ToolContext } from '../registry.js';
import { resolveTotalTimeoutMs } from '../shared/abort-timeout.js';
import type { AskAgenticInput } from './input.js';
import { SYSTEM_INSTRUCTION_AGENTIC, buildFunctionDeclarations } from './instructions.js';
import type { SignatureCounts } from './no-progress.js';

export type ResolvedModel = Awaited<ReturnType<typeof resolveModel>>;

export const DEFAULT_MAX_ITERATIONS = 20;
export const DEFAULT_MAX_TOTAL_INPUT_TOKENS = 1_000_000;
export const DEFAULT_MAX_FILES_READ = 40;

/**
 * Conservative per-iteration input estimate for the pre-iteration
 * budget reservation. An agentic iter typically sends a few KB of
 * prompt + accumulated tool responses + model thinking + short output.
 * We over-estimate on purpose so `reserveBudget` atomicity catches
 * overspend early rather than silently racing past the cap. PR #24
 * review by Grok (P0: budget bypass on agentic path).
 */
export const PER_ITERATION_INPUT_TOKENS = 50_000;

/** The env var that bounds an iteration (and the finalization pass) when the call sets no `iterationTimeoutMs`. */
export const ITERATION_TIMEOUT_ENV = 'GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS';

export interface RunLimits {
  maxIterations: number;
  maxTotalInputTokens: number;
  maxFilesRead: number;
}

/** What every pass's reservation is priced from, beside the resolved model. */
export interface PassBudget {
  /** Output (and thinking) tokens a pass reserves for. */
  outputTokens: number;
  /** The longest an iteration (or the finalization pass) can run: the window each reservation covers. */
  coverMs: number | null;
  dailyBudgetEnforced: boolean;
  tpmEnforced: boolean;
}

/** One call, fixed once the loop starts. */
export interface AgenticRun {
  input: AskAgenticInput;
  ctx: ToolContext;
  emitter: ProgressEmitter;
  resolved: ResolvedModel;
  /** Canonical (symlink-resolved) workspace root every tool call resolves against. */
  workspaceRoot: string;
  /** When the call started (`Date.now()`), for `durationMs`. */
  started: number;
  limits: RunLimits;
  /** The user-glob filter, threaded through every executor invocation in the loop. */
  matchConfig: MatchConfig;
  baseConfig: GenerateContentConfig;
  budget: PassBudget;
}

/** What the loop accumulates across iterations. */
export interface LoopState {
  conversation: Content[];
  signatureCounts: SignatureCounts;
  filesReadSet: Set<string>;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeThinkingTokens: number;
  /** P5 (v1.15.0): approximate token count of the tool-response Parts
   * appended to `conversation` after the most recent iteration's
   * `generateContent` returned. Folded into the rescue's
   * `finalizationEstimate` so its TPM/budget reservation covers the data
   * the rescue actually replays. Pre-P5 the estimate omitted this delta;
   * with the parallel tool-dispatch (default 10 in v1.15.1+, was 3
   * pre-bump) reading large files, the rescue could under-reserve by
   * 100k+ tokens and 429 mid-flight. */
  lastToolResponseTokens: number;
  iterations: number;
  /** The most recent iteration's actual `promptTokenCount` (size of the
   * conversation as sent in the LAST loop iter). Used by the v1.14.2
   * forced-finalization rescue's reservation estimate — the rescue replays
   * the same accumulated history, so its real prompt size ≈ this value, not
   * the static `PER_ITERATION_INPUT_TOKENS = 50_000` that under-reserves by
   * 4–6× on a 20-iter loop with file reads. Stays 0 if the loop never
   * produced a usage record (defensive — falls back to the static estimate
   * at the use site). */
  lastIterationPromptTokens: number;
}

export function runLimitsOf(input: AskAgenticInput): RunLimits {
  return {
    maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    maxTotalInputTokens: input.maxTotalInputTokens ?? DEFAULT_MAX_TOTAL_INPUT_TOKENS,
    maxFilesRead: input.maxFilesRead ?? DEFAULT_MAX_FILES_READ,
  };
}

function thinkingConfigOf(input: AskAgenticInput): ThinkingConfig {
  if (input.thinkingLevel !== undefined) {
    return {
      thinkingLevel: input.thinkingLevel as ThinkingLevel,
      includeThoughts: true,
    };
  }
  if (input.thinkingBudget !== undefined) {
    return { thinkingBudget: input.thinkingBudget, includeThoughts: true };
  }
  return { includeThoughts: true };
}

/** The config of every loop request. */
export function baseConfigOf(input: AskAgenticInput): GenerateContentConfig {
  return {
    systemInstruction: SYSTEM_INSTRUCTION_AGENTIC,
    tools: [{ functionDeclarations: buildFunctionDeclarations() }],
    thinkingConfig: thinkingConfigOf(input),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    // One request per model call: a response that stops with `CONTINUATION` is never continued here (long decode
    // is `ask` / `code` only, `shared/continuation.ts`).
    automaticContinuation: false,
  };
}

export function passBudgetOf(input: AskAgenticInput, ctx: ToolContext): PassBudget {
  return {
    outputTokens: typeof input.maxOutputTokens === 'number' ? input.maxOutputTokens : 4096,
    coverMs: resolveTotalTimeoutMs(input.iterationTimeoutMs, ITERATION_TIMEOUT_ENV),
    dailyBudgetEnforced: Number.isFinite(ctx.config.dailyBudgetUsd),
    tpmEnforced: ctx.config.tpmThrottleLimit > 0,
  };
}

/** One pass's reservation for the resolved model, at the rates in force from now until its timeout. */
export function passReservationUsd(run: AgenticRun, inputTokens: number): number {
  const { budget } = run;
  return estimateReservationUsd(
    {
      model: run.resolved.resolved,
      uncachedInputTokens: inputTokens,
      cachedInputTokens: 0,
      outputTokens: budget.outputTokens,
      thinkingTokens: budget.outputTokens,
    },
    budget.coverMs,
  );
}

export function newLoopState(prompt: string): LoopState {
  return {
    conversation: [{ role: 'user', parts: [{ text: prompt }] }],
    signatureCounts: new Map(),
    filesReadSet: new Set<string>(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeThinkingTokens: 0,
    lastToolResponseTokens: 0,
    iterations: 0,
    lastIterationPromptTokens: 0,
  };
}
