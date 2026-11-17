/**
 * Cross-tool constants for Gemini's thinking-mode configuration.
 *
 * Both `ask` and `code` tools expose the same two knobs (`thinkingBudget`
 * and `thinkingLevel`) with identical semantics and identical mutual-exclusion
 * rules. Keeping the schema literal list and cost-estimate reserve table
 * here avoids drift between the tools — when Google publishes per-tier
 * token budgets or ships a new level, one edit here propagates to both
 * call sites (and any future reasoning-capable tool we add).
 */

import type { ThinkingConfig, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { ANSWER_RESERVE_TOKENS, type InputWindowCut } from '../../gemini/long-decode.js';

/**
 * Accepted values for `thinkingLevel` on both `ask` and `code`. Uppercased
 * to match `ThinkingLevel` enum members in `@google/genai` — we pass the
 * literal string through to Gemini as `ThinkingLevel` via a type cast
 * (no runtime enum lookup, so SDK member renames surface as Gemini 400s
 * rather than silent `undefined`).
 *
 * `THINKING_LEVEL_UNSPECIFIED` is deliberately excluded: it's the SDK's
 * "no value set" sentinel, and passing it is semantically equivalent to
 * omitting the field. Callers who want model-native behaviour should just
 * omit `thinkingLevel` entirely.
 *
 * Per Google's Gemini 3 guide (ai.google.dev/gemini-api/docs/gemini-3):
 *   - Gemini 3 Pro supports LOW / MEDIUM / HIGH (not MINIMAL); default HIGH.
 *   - Gemini 3 Flash supports all four; Flash-Lite defaults to MINIMAL.
 *   - Gemini 2.5 family does NOT support `thinkingLevel` — use `thinkingBudget`.
 *   - Gemini 4 Hydrogen adds XHIGH above HIGH (changelog 2026-11-12: low,
 *     medium, high — its default — and xhigh).
 * Every tool accepts all five values at the schema boundary and lets Gemini
 * reject unsupported combinations at request time, so the MCP surface stays
 * stable across model rollouts.
 */
export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'] as const;

/** The one description of `thinkingLevel` (`THINKING_LEVEL_FIELD` carries it). */
const THINKING_LEVEL_DESCRIPTION =
  "Discrete reasoning tier for Gemini 3 and Gemini 4 models — Google's recommended knob on those (ai.google.dev/gemini-api/docs/gemini-3). Values: `MINIMAL` (Flash-Lite only), `LOW`, `MEDIUM`, `HIGH` (Gemini 3 Pro's default), `XHIGH` (Gemini 4 Hydrogen only — a fast-tier model, which `ask` and `ask_agentic` can run and `code` cannot; Gemini 4 Argon and Carbon answer it with a 400). Gemini 2.5 models do NOT support this — use `thinkingBudget` instead. Mutually exclusive with `thinkingBudget`: passing both returns a validation error before we even hit Gemini (Gemini itself also rejects with 400 'cannot use both thinking_level and the legacy thinking_budget parameter').";

/** The `thinkingLevel` argument of every tool that takes one (`ask`, `code`, `ask_agentic`): one schema, one text. */
export const THINKING_LEVEL_FIELD = z
  .enum(THINKING_LEVELS)
  .optional()
  .describe(THINKING_LEVEL_DESCRIPTION);

/**
 * Literal-union type matching the schema's accepted `thinkingLevel` values.
 * Sourced from `THINKING_LEVELS` so adding a new level means editing exactly
 * one place.
 */
export type ThinkingLevelLiteral = (typeof THINKING_LEVELS)[number];

/**
 * The `thinkingConfig` of a request driven by a `thinkingLevel` (`ask`, `code`, `ask_agentic`). The level is cast to
 * `ThinkingLevel` rather than looked up in the runtime enum object: for a string enum the value IS the member name, so
 * the cast is the same at runtime — and after an SDK rename the literal reaches Gemini, which answers 400 with a clear
 * message, instead of silently becoming `undefined` at the lookup. `includeThoughts: true` always, so the answer
 * carries Gemini's reasoning digest.
 */
export function levelThinkingConfig(level: ThinkingLevelLiteral): ThinkingConfig {
  return { thinkingLevel: level as ThinkingLevel, includeThoughts: true };
}

/**
 * Conservative per-tier thinking-token reservations for cost estimation.
 *
 * Google does not publish the exact per-tier token budgets Gemini consumes
 * for each `thinkingLevel`. These numbers are heuristic upper bounds based
 * on Google's documented "MINIMAL ≈ near-zero", "HIGH ≈ up to model's
 * thinking limit" guidance (ai.google.dev/gemini-api/docs/thinking). Using
 * tier-aware values (rather than always-worst-case) prevents
 * `GEMINI_DAILY_BUDGET_USD` from false-rejecting a long sequence of
 * `MINIMAL` calls where the real spend is ≤1% of a worst-case reservation.
 *
 * If Gemini actually consumes MORE than we reserved, the tool's
 * `finalizeBudgetReservation` writes the measured cost over the estimate —
 * the cap remains a true upper bound across *completed* calls; tiered
 * reservations only affect preflight acceptance. A call that genuinely
 * exceeds the tier's reserve will succeed (Gemini honours whatever it
 * decides to spend); a subsequent call will see the larger measured cost
 * in the budget ledger.
 *
 * HIGH and XHIGH intentionally map to `null` → `thinkingReserve`
 * substitutes the cap that runs minus the answer reserve, so the value
 * tracks each call's actual output cap rather than a hard-coded duplicate.
 */
export const THINKING_LEVEL_RESERVE: Record<ThinkingLevelLiteral, number | null> = {
  MINIMAL: 512,
  LOW: 2_048,
  MEDIUM: 4_096,
  HIGH: null,
  XHIGH: null,
};

/** A positive `thinkingBudget` clamped below the cap that runs, keeping the answer reserve beside it. */
export function thinkingBudgetUnder(cap: CapThatRan, budget: number): number {
  return Math.max(0, Math.min(budget, cap.effective - ANSWER_RESERVE_TOKENS));
}

/** The `errorCode` of a call that ended at the output cap with no answer. */
export const OUTPUT_CAP_ERROR_CODE = 'OUTPUT_CAP';

/** The finish reasons of a call that ended at the output cap: one request's cap, or a long decode cut at its limits. */
const AT_OUTPUT_CAP: ReadonlySet<unknown> = new Set(['MAX_TOKENS', 'CONTINUATION']);

/** The part of a decoded response these checks read. */
interface FinishedResponse {
  readonly text: string;
  readonly candidates?: readonly { finishReason?: unknown }[] | undefined;
}

/** The output cap that ran (`OutputCap`): its value, the model's per-request limit and the most a caller may ask. */
export interface CapThatRan {
  readonly effective: number;
  readonly perRequest: number;
  readonly ceiling: number;
}

/**
 * The thinking tokens a budget reservation counts for a call whose output runs under `cap` (the cap that runs, after
 * the input window's cut, so a cut call reserves no more than it can decode): a `thinkingLevel`'s tier reserve, all
 * the cap leaves beside the answer reserve for a dynamic or model-default budget (`-1` / `null`: Gemini 3 Pro and the
 * Gemini 4 models think without being asked), else the budget itself. A tier reserve is clamped to that headroom, so a
 * small-cap model never reserves more thinking than it can decode.
 */
export function thinkingReserve(
  level: ThinkingLevelLiteral | undefined,
  budget: number | null,
  cap: CapThatRan,
): number {
  const headroom = Math.max(0, cap.effective - ANSWER_RESERVE_TOKENS);
  if (level !== undefined) return Math.min(THINKING_LEVEL_RESERVE[level] ?? headroom, headroom);
  if (budget === null || budget === -1) return headroom;
  return budget;
}

/** How a call's answer ended: the last request's finish reason and whether the text was cut at the output cap. */
export interface AnswerFinish {
  readonly finishReason: string | null;
  /** The answer has text and stopped at the cap (`MAX_TOKENS`, or a long decode ended at its limits on `CONTINUATION`). */
  readonly truncated: boolean;
}

export function answerFinish(response: FinishedResponse): AnswerFinish {
  const stopped = response.candidates?.[0]?.finishReason;
  return {
    finishReason: typeof stopped === 'string' ? stopped : null,
    truncated: response.text.trim() !== '' && AT_OUTPUT_CAP.has(stopped),
  };
}

const LOWER_THE_THINKING =
  'lower the thinking: `thinkingLevel: "LOW"` / a smaller `thinkingBudget`';

const tokenCount = (n: number): string => n.toLocaleString('en-US');

/**
 * What the caller can change after a stop at `cap`: raise the cap where the model allows more, else the thinking — and,
 * under a cap the input window cut, the size of the prompt, which decides what that window leaves.
 */
function capRemedy(cap: CapThatRan, cut: InputWindowCut | null): string {
  if (cut !== null) {
    return `The model's ${tokenCount(cut.inputTokenLimit)}-token input window left ${tokenCount(cut.to)} output tokens for this prompt (the cap was cut from ${tokenCount(cut.from)}): ${LOWER_THE_THINKING}, or send a smaller workspace.`;
  }
  if (cap.effective < cap.perRequest) {
    return `Raise \`maxOutputTokens\` (it was ${tokenCount(cap.effective)}; the model allows ${tokenCount(cap.perRequest)} per request), or ${LOWER_THE_THINKING}.`;
  }
  if (cap.effective >= cap.ceiling) {
    return `The cap is the most this model allows (${tokenCount(cap.ceiling)}): ${LOWER_THE_THINKING}.`;
  }
  if (cap.effective === cap.perRequest) {
    return `Ask for \`maxOutputTokens\` above ${tokenCount(cap.perRequest)} (up to ${tokenCount(cap.ceiling)}): on this model the decode then continues in further requests. Or ${LOWER_THE_THINKING}.`;
  }
  return `Raise \`maxOutputTokens\` above ${tokenCount(cap.effective)} (up to ${tokenCount(cap.ceiling)}), or ${LOWER_THE_THINKING}.`;
}

/**
 * A call that ended at the output cap with no answer: the model's thinking used the cap (thinking tokens count
 * against `maxOutputTokens`, and Gemini 4 Carbon / Hydrogen and the 3.x Pro models think without being asked), in
 * one request (`MAX_TOKENS`) or over a long decode stopped at its limits (`CONTINUATION`). The message names the
 * cause and the remedy that fits the cap that ran and the cut the input window made to it (`null`: none); `null` for
 * any call that produced text or stopped for another reason.
 */
export function emptyAtOutputCap(
  response: FinishedResponse,
  thinkingTokens: number,
  cap: CapThatRan,
  cut: InputWindowCut | null,
): string | null {
  const stopped = response.candidates?.[0]?.finishReason;
  if (response.text.trim() !== '' || !AT_OUTPUT_CAP.has(stopped)) return null;
  return `the model stopped at the output cap before writing an answer (thinking used ${tokenCount(thinkingTokens)} tokens of it; the call was billed). ${capRemedy(cap, cut)}`;
}
