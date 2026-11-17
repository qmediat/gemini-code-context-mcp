/**
 * `ask`'s thinking: the caller's `thinkingLevel` or `thinkingBudget` normalised under the cap that runs, the wire
 * config it becomes, the budget the result reports and the progress line that opens the decode. The thinking the budget
 * reservation counts is `thinkingReserve`'s (`../shared/thinking.ts`), called with the level and `thinkingBudgetField`.
 */

import type { ThinkingConfig } from '@google/genai';
import type { OutputCap } from '../../gemini/long-decode.js';
import {
  type ThinkingLevelLiteral,
  levelThinkingConfig,
  thinkingBudgetUnder,
} from '../shared/thinking.js';
import type { AskInput } from './input.js';

/**
 * How the call drives the model's reasoning, one of three on the wire:
 *   - `level`: the caller's `thinkingLevel`, Google's recommended path on Gemini 3 (rejected by the Gemini 2.5 family).
 *     The schema's `.refine()` refuses a `thinkingBudget` beside it; a call that reaches `execute` with both anyway
 *     sends the level alone and reports the budget normalised as on the budget path (`reportedBudget`);
 *   - `model-default`: neither knob set — nothing goes on the wire but `includeThoughts`, and Gemini uses each model's
 *     native default, which per Google's Gemini 3 guide (https://ai.google.dev/gemini-api/docs/gemini-3) is
 *     HIGH-dynamic on Gemini 3 Pro. Google flags an explicit `thinkingBudget` as the "legacy" path on Gemini 3 ("may
 *     result in unexpected performance"), and Gemini 3 Pro was observed hanging on low positive budgets with cached
 *     content active (docs/KNOWN-DEFICITS.md): omitting the field sidesteps both, while power users can still opt
 *     into an explicit budget on Gemini 2.5 or for a cost-bounded deep-dive;
 *   - `budget`: `-1` (the explicit legacy dynamic budget), `0` (thinking disabled; Gemini 3 Pro answers 400), or a
 *     positive budget clamped under the cap that runs.
 */
export type AskThinking =
  | {
      readonly kind: 'level';
      readonly level: ThinkingLevelLiteral;
      /** The caller's `thinkingBudget` normalised under the cap, never sent: the result reports it. */
      readonly reportedBudget: number | null;
    }
  | { readonly kind: 'model-default' }
  | { readonly kind: 'budget'; readonly budget: number };

/**
 * Normalise the caller's thinking under `cap`, the cap that runs. A positive budget is clamped to
 * [0, cap − 1024]: the thinking pool is carved out of the candidate-output allowance, so reserving ≥ 1024 tokens for
 * the answer prevents 400s when a caller passes a budget ≥ `maxOutputTokens`, and under a cap the input window cut to
 * one request (its value on the wire) the budget stays below it.
 */
export function askThinking(input: AskInput, cap: OutputCap): AskThinking {
  const budget = normalisedBudget(input.thinkingBudget, cap);
  if (input.thinkingLevel !== undefined) {
    return { kind: 'level', level: input.thinkingLevel, reportedBudget: budget };
  }
  return budget === null ? { kind: 'model-default' } : { kind: 'budget', budget };
}

/** The caller's `thinkingBudget` under `cap`: `null` unset, `-1` and `0` as they are, a positive one clamped. */
function normalisedBudget(raw: number | undefined, cap: OutputCap): number | null {
  if (raw === undefined) return null;
  if (raw === -1) return -1;
  return raw > 0 ? thinkingBudgetUnder(cap, raw) : 0;
}

/**
 * The `thinkingConfig` of every request, with a cache too (`RequestBuilder`, `../shared/eager-answer.ts`).
 * `includeThoughts: true` is always set so the caller sees Gemini's reasoning digest.
 */
export function thinkingConfigOf(thinking: AskThinking): ThinkingConfig {
  switch (thinking.kind) {
    case 'level':
      return levelThinkingConfig(thinking.level);
    case 'model-default':
      return { includeThoughts: true };
    case 'budget':
      return { thinkingBudget: thinking.budget, includeThoughts: true };
  }
}

/**
 * The budget the result reports and the reservation counts: the one sent on the budget path, the one normalised but
 * not sent on the level path (the reservation then counts the level's tier), `null` when the caller set none.
 */
export function thinkingBudgetField(thinking: AskThinking): number | null {
  switch (thinking.kind) {
    case 'level':
      return thinking.reportedBudget;
    case 'model-default':
      return null;
    case 'budget':
      return thinking.budget;
  }
}

/** The progress line that opens the decode. */
export function generatingLine(thinking: AskThinking): string {
  switch (thinking.kind) {
    case 'level':
      return `generating response (thinking-level=${thinking.level})…`;
    case 'model-default':
      return 'generating response (thinking=model-default)…';
    case 'budget':
      return thinking.budget === -1
        ? 'generating response (thinking=dynamic)…'
        : `generating response (thinking=${thinking.budget})…`;
  }
}
