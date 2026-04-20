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
 * Both tools accept all four values at the schema boundary and let Gemini
 * reject unsupported combinations at request time, so the MCP surface stays
 * stable across model rollouts.
 */
export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;

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
 * HIGH intentionally maps to `null` → call sites substitute
 * `maxOutputTokens - 1024` so the value tracks each tool's actual output
 * cap (8_192 for `ask`, 32_768 for `code`) rather than a hard-coded
 * duplicate.
 */
export const THINKING_LEVEL_RESERVE: Record<ThinkingLevelLiteral, number | null> = {
  MINIMAL: 512,
  LOW: 2_048,
  MEDIUM: 4_096,
  HIGH: null,
};
