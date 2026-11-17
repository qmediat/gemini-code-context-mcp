import { describe, expect, it } from 'vitest';
import { answerFinish, emptyAtOutputCap } from '../../src/tools/shared/thinking.js';

/** A response that stopped at the cap with no answer. */
const starved = (finishReason: string) => ({ text: '  ', candidates: [{ finishReason }] });

/** The caps that ran: a Gemini 4 model (per-request 65 536, long decode to 1 048 576) and a 3.x model. */
const GEMINI_4 = { perRequest: 65_536, ceiling: 1_048_576 };
const GEMINI_3 = { perRequest: 65_536, ceiling: 65_536 };

describe('emptyAtOutputCap', () => {
  it('below the per-request limit: raise maxOutputTokens, naming the cap that ran and the limit', () => {
    const message = emptyAtOutputCap(starved('MAX_TOKENS'), 4_000, {
      ...GEMINI_3,
      effective: 4_096,
    });
    expect(message).toContain('thinking used 4,000 tokens');
    expect(message).toContain(
      'Raise `maxOutputTokens` (it was 4,096; the model allows 65,536 per request)',
    );
    expect(message).toContain('thinkingLevel: "LOW"');
  });

  it('at the per-request limit of a long-decode model: ask above it, the decode continues', () => {
    const message = emptyAtOutputCap(starved('MAX_TOKENS'), 65_533, {
      ...GEMINI_4,
      effective: 65_536,
    });
    expect(message).toContain('Ask for `maxOutputTokens` above 65,536 (up to 1,048,576)');
    expect(message).toContain('continues in further requests');
  });

  it('after a long decode cut at the caller cap: raise it above the cap that ran', () => {
    const message = emptyAtOutputCap(starved('CONTINUATION'), 131_066, {
      ...GEMINI_4,
      effective: 131_072,
    });
    expect(message).toContain('thinking used 131,066 tokens');
    expect(message).toContain('Raise `maxOutputTokens` above 131,072 (up to 1,048,576)');
    expect(message).not.toContain('above 65,536');
  });

  it('at the most the model allows: only the thinking can change', () => {
    for (const cap of [
      { ...GEMINI_3, effective: 65_536 },
      { ...GEMINI_4, effective: 1_048_576 },
    ]) {
      const message = emptyAtOutputCap(starved('MAX_TOKENS'), 60_000, cap);
      expect(message, String(cap.effective)).toContain('The cap is the most this model allows');
      expect(message, String(cap.effective)).not.toContain('Raise');
    }
  });

  it('is null for an answer cut at the cap, a normal stop, and a response without candidates', () => {
    const cap = { ...GEMINI_4, effective: 65_536 };
    expect(
      emptyAtOutputCap({ text: 'partial', candidates: [{ finishReason: 'MAX_TOKENS' }] }, 10, cap),
    ).toBeNull();
    expect(
      emptyAtOutputCap({ text: '', candidates: [{ finishReason: 'STOP' }] }, 0, cap),
    ).toBeNull();
    expect(emptyAtOutputCap({ text: '', candidates: undefined }, 0, cap)).toBeNull();
  });
});

describe('answerFinish', () => {
  it('flags an answer cut at the cap: MAX_TOKENS, or a long decode ended on CONTINUATION', () => {
    for (const reason of ['MAX_TOKENS', 'CONTINUATION']) {
      expect(answerFinish({ text: 'part of it', candidates: [{ finishReason: reason }] })).toEqual({
        finishReason: reason,
        truncated: true,
      });
    }
  });

  it('a whole answer and an empty one are not truncated', () => {
    expect(answerFinish({ text: 'done', candidates: [{ finishReason: 'STOP' }] })).toEqual({
      finishReason: 'STOP',
      truncated: false,
    });
    // Empty at the cap is OUTPUT_CAP's case, never a cut answer.
    expect(answerFinish({ text: '', candidates: [{ finishReason: 'MAX_TOKENS' }] }).truncated).toBe(
      false,
    );
    expect(answerFinish({ text: 'x', candidates: undefined })).toEqual({
      finishReason: null,
      truncated: false,
    });
  });
});
