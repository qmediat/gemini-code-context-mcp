/**
 * What `ask_agentic` reads from a model response, the same way for a loop iteration and for the forced-finalization
 * pass: the token counts (0 where the response reported none) and the thought summary.
 */

import type { GenerateContentResponse, Part } from '@google/genai';

/** The token counts of one model call. */
export interface UsageCounts {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
}

/** The longest thought summary a result carries. */
const THINKING_SUMMARY_MAX_CHARS = 1200;

const countOf = (value: number | undefined): number => (typeof value === 'number' ? value : 0);

/** A response's token counts, each 0 when its `usageMetadata` does not carry it as a number. */
export function usageCounts(usage: GenerateContentResponse['usageMetadata']): UsageCounts {
  return {
    promptTokenCount: countOf(usage?.promptTokenCount),
    candidatesTokenCount: countOf(usage?.candidatesTokenCount),
    thoughtsTokenCount: countOf(usage?.thoughtsTokenCount),
  };
}

/** The thought parts' text joined by newlines and cut to 1200 characters, or `null` when there is none. */
export function thinkingSummaryOf(parts: Part[]): string | null {
  const thoughtTexts = parts
    .filter((p) => p.thought === true && typeof p.text === 'string')
    .map((p) => p.text as string);
  return thoughtTexts.length > 0
    ? thoughtTexts.join('\n').slice(0, THINKING_SUMMARY_MAX_CHARS)
    : null;
}
