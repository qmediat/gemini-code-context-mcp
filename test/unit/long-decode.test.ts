import { describe, expect, it } from 'vitest';
import {
  LONG_DECODE_TOTAL_TOKENS,
  continuationInputTokens,
  longDecodeTokenLimitOf,
  maxDecodeRequests,
  resolveOutputCap,
} from '../../src/gemini/long-decode.js';
import { estimateCostUsd, estimatePreCallCostUsd } from '../../src/utils/cost-estimator.js';

const GEMINI_4 = { outputTokenLimit: 65_536, longDecodeTokenLimit: LONG_DECODE_TOTAL_TOKENS };
const GEMINI_3 = { outputTokenLimit: 65_536, longDecodeTokenLimit: null };

describe('longDecodeTokenLimitOf', () => {
  it('gives the Gemini 4 text models the long-decode total', () => {
    for (const id of [
      'gemini-4-hydrogen',
      'gemini-4-argon',
      'gemini-4-carbon-preview',
      'gemini-4.1-argon',
    ]) {
      expect(longDecodeTokenLimitOf(id), id).toBe(1_048_576);
    }
  });

  it('gives no long decode to a 3.x model or to a Gemini 4 id outside the text categories', () => {
    for (const id of [
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'gemini-4-carbon-computer-use-preview',
    ]) {
      expect(longDecodeTokenLimitOf(id), id).toBeNull();
    }
  });
});

describe('resolveOutputCap', () => {
  const base = { forceMax: false, fallbackLimit: 65_536 };

  it('sends a cap above the per-request limit unclamped on a long-decode model', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4, requested: 262_144 });
    expect(cap).toEqual({ wire: 262_144, effective: 262_144, perRequest: 65_536, maxRequests: 4 });
  });

  it('clamps a long-decode cap to the long-decode total', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4, requested: 5_000_000 });
    expect(cap.wire).toBe(1_048_576);
    expect(cap.maxRequests).toBe(16);
  });

  it('clamps a 3.x model to its advertised limit: one request', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_3, requested: 262_144 });
    expect(cap).toEqual({ wire: 65_536, effective: 65_536, perRequest: 65_536, maxRequests: 1 });
  });

  it('sends nothing without a caller cap, on a long-decode model too: one request at the model default', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4, requested: undefined });
    expect(cap).toEqual({ wire: undefined, effective: 65_536, perRequest: 65_536, maxRequests: 1 });
  });

  it('forces the per-request limit, never the long-decode total, under the operator override', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4, forceMax: true, requested: undefined });
    expect(cap.wire).toBe(65_536);
    expect(cap.maxRequests).toBe(1);
  });

  it('reads an absent long-decode limit as none', () => {
    const cap = resolveOutputCap({
      ...base,
      outputTokenLimit: 65_536,
      longDecodeTokenLimit: undefined,
      requested: 100_000,
    });
    expect(cap.wire).toBe(65_536);
  });
});

describe('continuation input bound', () => {
  it('counts R = ceil(C / L) requests', () => {
    expect(maxDecodeRequests(65_536, 65_536)).toBe(1);
    expect(maxDecodeRequests(65_537, 65_536)).toBe(2);
    expect(maxDecodeRequests(196_608, 65_536)).toBe(3);
  });

  it('bills nothing again for a decode that fits one request', () => {
    expect(continuationInputTokens(100_000, 65_536, 65_536)).toBe(0);
  });

  it('bills each continuation request the prompt plus what was decoded before it', () => {
    // 3 requests: request 2 sends P + 65 536, request 3 sends P + 131 072.
    expect(continuationInputTokens(100_000, 196_608, 65_536)).toBe(2 * 100_000 + 65_536 + 131_072);
  });

  it('reserves at least what a 3-request decode costs at list price', () => {
    const prompt = 100_000;
    const perRequest = 65_536;
    const cap = 3 * perRequest;
    // The worst 3-request decode: every request decodes its whole limit, all of it thinking but 1 000 tokens.
    const billedInput = prompt + (prompt + perRequest) + (prompt + 2 * perRequest);
    const actual = estimateCostUsd({
      model: 'gemini-4-hydrogen',
      uncachedInputTokens: billedInput,
      cachedInputTokens: 0,
      outputTokens: 1_000,
      thinkingTokens: cap - 1_000,
    });
    const reserved = estimatePreCallCostUsd({
      model: 'gemini-4-hydrogen',
      workspaceBytes: (prompt - 25) * 4,
      promptChars: 100,
      expectedOutputTokens: cap,
      perRequestOutputTokens: perRequest,
      // A low thinking tier's reserve: the decode's own tokens are covered by the cap alone.
      thinkingTokens: 2_048,
      coverMs: null,
    });
    expect(reserved).toBeGreaterThanOrEqual(actual);
    // Without the continuation input the reservation would not cover it.
    const firstRequestOnly = estimatePreCallCostUsd({
      model: 'gemini-4-hydrogen',
      workspaceBytes: (prompt - 25) * 4,
      promptChars: 100,
      expectedOutputTokens: cap,
      thinkingTokens: 2_048,
      coverMs: null,
    });
    expect(firstRequestOnly).toBeLessThan(actual);
  });
});
