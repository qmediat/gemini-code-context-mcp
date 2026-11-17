/**
 * `ask`'s thinking (`src/tools/ask/thinking.ts`): what goes on the wire and what the result reports when a call that
 * reaches `execute` directly carries both knobs the schema keeps apart.
 */

import { describe, expect, it } from 'vitest';
import { resolveOutputCap } from '../../src/gemini/long-decode.js';
import type { AskInput } from '../../src/tools/ask.tool.js';
import {
  askThinking,
  thinkingBudgetField,
  thinkingConfigOf,
} from '../../src/tools/ask/thinking.js';

/** A cap of 8,192 tokens a request: a budget of 10,000 is clamped to 8,192 − 1,024. */
const CAP = resolveOutputCap({
  requested: 8_192,
  forceMax: false,
  outputTokenLimit: 65_536,
  longDecodeTokenLimit: null,
  fallbackLimit: 65_536,
});

const BOTH: AskInput = { prompt: 'q', thinkingLevel: 'HIGH', thinkingBudget: 10_000 };

describe('ask thinking: a level and a budget both given', () => {
  it('sends the level alone', () => {
    expect(thinkingConfigOf(askThinking(BOTH, CAP))).toEqual({
      thinkingLevel: 'HIGH',
      includeThoughts: true,
    });
  });

  it('reports the budget clamped under the cap, as the budget path would', () => {
    expect(thinkingBudgetField(askThinking(BOTH, CAP))).toBe(8_192 - 1_024);
  });
});
