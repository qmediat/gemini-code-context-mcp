/**
 * `ask`'s thinking: the caller's `thinkingLevel` or `thinkingBudget` normalised under the cap that runs, the wire
 * config it becomes, the budget the result reports and the progress line that opens the decode. The thinking the budget
 * reservation counts is `thinkingReserve`'s (`../shared/thinking.ts`), called with the level and `thinkingBudgetField`.
 */

import type { ThinkingConfig, ThinkingLevel } from '@google/genai';
import type { OutputCap } from '../../gemini/long-decode.js';
import { type ThinkingLevelLiteral, thinkingBudgetUnder } from '../shared/thinking.js';
import type { AskInput } from './input.js';

/**
 * How the call drives the model's reasoning. Schema `.refine()` guarantees `thinkingBudget` and `thinkingLevel` are
 * never both set, so the three are mutually exclusive:
 *   - `level`: the caller's `thinkingLevel`, Google's recommended path on Gemini 3 (rejected by the Gemini 2.5 family);
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
  | { readonly kind: 'level'; readonly level: ThinkingLevelLiteral }
  | { readonly kind: 'model-default' }
  | { readonly kind: 'budget'; readonly budget: number };

/**
 * Normalise the caller's thinking under `cap`, the cap that runs. A positive budget is clamped to
 * [0, cap − 1024]: the thinking pool is carved out of the candidate-output allowance, so reserving ≥ 1024 tokens for
 * the answer prevents 400s when a caller passes a budget ≥ `maxOutputTokens`, and under a cap the input window cut to
 * one request (its value on the wire) the budget stays below it.
 */
export function askThinking(input: AskInput, cap: OutputCap): AskThinking {
  if (input.thinkingLevel !== undefined) return { kind: 'level', level: input.thinkingLevel };
  const raw = input.thinkingBudget;
  if (raw === undefined) return { kind: 'model-default' };
  if (raw === -1) return { kind: 'budget', budget: -1 };
  return { kind: 'budget', budget: raw > 0 ? thinkingBudgetUnder(cap, raw) : 0 };
}

/**
 * The `thinkingConfig` of every request. `thinkingConfig` is a per-request reasoning control, not one of the fields a
 * cached context forbids, so it travels with every request whatever the cache's state; `includeThoughts: true` is
 * always set so the caller sees Gemini's reasoning digest. The level is cast to `ThinkingLevel` rather than indexing
 * the runtime enum object: for a string enum the value IS the member name, so the cast is the same at runtime — and
 * it survives an SDK rename, where the literal reaches Gemini, which answers 400 with a clear message, instead of
 * silently becoming `undefined` at the indexing step.
 */
export function thinkingConfigOf(thinking: AskThinking): ThinkingConfig {
  switch (thinking.kind) {
    case 'level':
      return { thinkingLevel: thinking.level as ThinkingLevel, includeThoughts: true };
    case 'model-default':
      return { includeThoughts: true };
    case 'budget':
      return { thinkingBudget: thinking.budget, includeThoughts: true };
  }
}

/** The budget sent on the wire, as the result reports it and the reservation counts it; `null` when none is sent. */
export function thinkingBudgetField(thinking: AskThinking): number | null {
  return thinking.kind === 'budget' ? thinking.budget : null;
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
