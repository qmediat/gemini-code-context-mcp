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

import { z } from 'zod';

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
 * HIGH and XHIGH intentionally map to `null` → call sites substitute
 * `maxOutputTokens - 1024` so the value tracks each tool's actual output
 * cap (8_192 for `ask`, 32_768 for `code`) rather than a hard-coded
 * duplicate.
 */
export const THINKING_LEVEL_RESERVE: Record<ThinkingLevelLiteral, number | null> = {
  MINIMAL: 512,
  LOW: 2_048,
  MEDIUM: 4_096,
  HIGH: null,
  XHIGH: null,
};

/**
 * A call that ended at the output cap with no answer: the model's thinking used the cap (thinking tokens count
 * against `maxOutputTokens`, and Gemini 4 Carbon / Hydrogen and the 3.x Pro models think without being asked).
 * The message names the cause and the remedy; `null` for any call that produced text or stopped for another reason.
 */
export function emptyAtOutputCap(
  response: {
    readonly text: string;
    readonly candidates?: readonly { finishReason?: unknown }[] | undefined;
  },
  thinkingTokens: number,
): string | null {
  const stopped = response.candidates?.[0]?.finishReason;
  if (response.text.trim() !== '' || stopped !== 'MAX_TOKENS') return null;
  return `the model stopped at the output cap before writing an answer (thinking used ${thinkingTokens} tokens of it; the call was billed). Raise \`maxOutputTokens\`, or bound the thinking with \`thinkingLevel: "LOW"\` / a smaller \`thinkingBudget\`.`;
}
