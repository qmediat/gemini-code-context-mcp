import { describe, expect, it } from 'vitest';
import { emptyAtOutputCap } from '../../src/tools/shared/thinking.js';

describe('emptyAtOutputCap', () => {
  it('names the cause when the call stopped at the cap with no answer', () => {
    const message = emptyAtOutputCap(
      { text: '  ', candidates: [{ finishReason: 'MAX_TOKENS' }] },
      697,
    );
    expect(message).toContain('thinking used 697 tokens');
    expect(message).toContain('maxOutputTokens');
  });

  it('names the long-decode remedy for a decode that stopped at the caller cap with CONTINUATION', () => {
    const message = emptyAtOutputCap(
      { text: '', candidates: [{ finishReason: 'CONTINUATION' }] },
      131_066,
    );
    expect(message).toContain('thinking used 131066 tokens');
    expect(message).toContain('long decode');
  });

  it('is null for an answer cut at the cap, a normal stop, and a response without candidates', () => {
    expect(
      emptyAtOutputCap({ text: 'partial', candidates: [{ finishReason: 'MAX_TOKENS' }] }, 10),
    ).toBeNull();
    expect(emptyAtOutputCap({ text: '', candidates: [{ finishReason: 'STOP' }] }, 0)).toBeNull();
    expect(emptyAtOutputCap({ text: '', candidates: undefined }, 0)).toBeNull();
  });
});
