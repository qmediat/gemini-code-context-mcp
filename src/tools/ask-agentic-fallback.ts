/**
 * `ask`'s fallback to `ask_agentic` (`onWorkspaceTooLarge: 'fallback-to-agentic'`): the workspace exceeds the eager
 * path's window, so the question goes to the agentic loop and its result is wrapped for `ask`'s caller.
 *
 * The knobs (`docs/DESIGN-agentic-time-bounds.md`, "Target, `ask` fallback"): `ask` resolved its own once — per call,
 * else `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS` / `_STALL_MS`, the values its controller holds — and forwards them:
 * `timeoutMs` → `iterationTimeoutMs` (a per-iteration cap: the agentic call can run `maxIterations × timeoutMs`), and
 * `stallMs` → `stallMs` (the same heartbeat watchdog on the loop's streams). `ask`'s own controller is disposed at the
 * hand-off; the agentic call keeps its own clocks, and its timeout messages name `ask`'s knobs.
 */

import type { PreflightTokenResult } from '../gemini/token-counter.js';
import { logger } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';
import type { KnobNames } from './agentic/run.js';
import { type AskAgenticInput, runAskAgentic } from './ask-agentic.tool.js';
import type { AskInput } from './ask/input.js';
import type { TextToolResult, ToolContext } from './registry.js';
import { TOOL_TIMEOUT_ENV, type TimeoutController } from './shared/abort-timeout.js';

/** The knobs a fallback's timeout message names: `ask`'s, which became the agentic call's. */
export const ASK_KNOB_NAMES: KnobNames = Object.freeze({
  totalMs: 'timeoutMs',
  totalEnv: TOOL_TIMEOUT_ENV.ask.totalEnvVar,
  stallMs: 'stallMs',
  stallEnv: TOOL_TIMEOUT_ENV.ask.stallEnvVar,
});

/** What `ask` hands over when it falls back. */
export interface AgenticFallback {
  readonly input: AskInput;
  readonly ctx: ToolContext;
  readonly emitter: ProgressEmitter;
  /** The tier the eager path resolved; a `flex` request is reported downgraded (the agentic loop has no tier). */
  readonly serviceTier: 'standard' | 'flex' | undefined;
  readonly preflight: PreflightTokenResult;
  readonly threshold: number;
  /** `ask`'s own controller: its resolved knobs are forwarded, then it is disposed. */
  readonly timeout: TimeoutController;
}

/** The agentic input: the question, its filters and thinking config, and `ask`'s resolved knobs. */
function agenticInputOf(input: AskInput, timeout: TimeoutController): AskAgenticInput {
  return {
    prompt: input.prompt,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
    ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
    ...(input.thinkingBudget !== undefined ? { thinkingBudget: input.thinkingBudget } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(timeout.timeoutMs !== null ? { iterationTimeoutMs: timeout.timeoutMs } : {}),
    ...(timeout.stallMs !== null ? { stallMs: timeout.stallMs } : {}),
  };
}

/** The knobs the fallback forwarded, as its result reports them; nothing when `ask` had none. */
function forwardedKnobs(timeout: TimeoutController): Record<string, unknown> {
  return {
    ...(timeout.timeoutMs !== null
      ? { iterTimeoutMs: timeout.timeoutMs, iterTimeoutSource: 'timeoutMs' }
      : {}),
    ...(timeout.stallMs !== null ? { stallMs: timeout.stallMs } : {}),
  };
}

/** A timeout's kind as the agentic result reports it, when it is one a caller knows (`total` | `stall`). */
const isTimeoutKind = (value: unknown): boolean => value === 'total' || value === 'stall';

/**
 * The agentic error's fields `ask`'s caller reads at the top level: `errorCode` and `retryable` (retry policies switch
 * on them), and a timeout's `timeoutKind`, `timeoutPhase`, `timeoutSource`. Nothing when the agentic call answered.
 */
function liftedError(isError: boolean, agentic: Record<string, unknown>): Record<string, unknown> {
  if (!isError) return {};
  const pick = (key: string, keep: (value: unknown) => boolean) =>
    keep(agentic[key]) ? { [key]: agentic[key] } : {};
  const isString = (value: unknown) => typeof value === 'string';
  return {
    ...pick('errorCode', isString),
    ...pick('retryable', (value) => typeof value === 'boolean'),
    ...pick('timeoutKind', isTimeoutKind),
    ...pick('timeoutPhase', isString),
    ...pick('timeoutSource', isString),
  };
}

/** The prose the agentic call returned: its `responseText`, else its first text content. */
function responseTextOf(result: TextToolResult, agentic: Record<string, unknown>): string {
  if (typeof agentic.responseText === 'string') return agentic.responseText;
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text : '';
}

/**
 * The wrapped result: the agentic prose verbatim, `structuredContent` enriched with the fallback's trail (why, the
 * preflight's estimate, the forwarded knobs), the lifted error fields, the agentic result whole under
 * `agenticResult`, and `responseText` written LAST so no nested key of that name clobbers it. `isError` stays at the
 * root of the result, as MCP has it.
 */
function wrappedResult(fallback: AgenticFallback, result: TextToolResult): TextToolResult {
  const agentic = (result.structuredContent as Record<string, unknown> | undefined) ?? {};
  const { preflight } = fallback;
  const structured: Record<string, unknown> = {
    fallbackApplied: 'ask_agentic',
    serviceTier: 'standard', // ask_agentic has no tier: the fallback runs standard whatever was asked
    ...(fallback.serviceTier === 'flex' ? { serviceTierDowngraded: 'flex' } : {}),
    fallbackReason: 'WORKSPACE_TOO_LARGE',
    preflightEstimate: {
      tokens: preflight.effectiveTokens,
      threshold: fallback.threshold,
      source: preflight.method,
      cacheHit: preflight.cacheHit,
      rawTokens: preflight.rawTokens,
    },
    ...forwardedKnobs(fallback.timeout),
    ...liftedError(result.isError === true, agentic),
    ...(Object.keys(agentic).length > 0 ? { agenticResult: agentic } : {}),
    responseText: responseTextOf(result, agentic),
  };
  return { ...result, structuredContent: structured };
}

/** Run the question through `ask_agentic` with `ask`'s knobs and wrap the result. */
export async function fallBackToAgentic(fallback: AgenticFallback): Promise<TextToolResult> {
  const { input, emitter, timeout } = fallback;
  if (fallback.serviceTier === 'flex') {
    const note =
      'ask: the ask_agentic fallback has no service tier — this call runs standard, not flex';
    emitter.emit(note);
    logger.warn(note);
  }
  logger.warn(
    `ask: WORKSPACE_TOO_LARGE (${fallback.preflight.effectiveTokens} > ${fallback.threshold}); falling back to ask_agentic per onWorkspaceTooLarge='fallback-to-agentic' (iterationTimeoutMs ${timeout.timeoutMs ?? 'unset'}, stallMs ${timeout.stallMs ?? 'unset'})`,
  );
  const agenticInput = agenticInputOf(input, timeout);
  timeout.dispose();
  const result = await runAskAgentic(agenticInput, fallback.ctx, ASK_KNOB_NAMES);
  return wrappedResult(fallback, result);
}
