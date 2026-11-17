import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_REQUEST_OVERHEAD_TOKENS,
  LONG_DECODE_TOTAL_TOKENS,
  continuationInputTokens,
  decodedTokensBound,
  longDecodeTokenLimitOf,
  maxDecodeRequests,
  preflightModeFor,
  resolveOutputCap,
} from '../../src/gemini/long-decode.js';
import { estimateCostUsd, estimatePreCallCostUsd } from '../../src/utils/cost-estimator.js';

const GEMINI_4 = { outputTokenLimit: 65_536, longDecodeTokenLimit: LONG_DECODE_TOTAL_TOKENS };
const GEMINI_3 = { outputTokenLimit: 65_536, longDecodeTokenLimit: null };
/** A Gemini 4 model that advertises 32 768 output tokens a request (Argon on `models.list`). */
const GEMINI_4_AT_32K = {
  outputTokenLimit: 32_768,
  longDecodeTokenLimit: LONG_DECODE_TOTAL_TOKENS,
};
const O = CONTINUATION_REQUEST_OVERHEAD_TOKENS;

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

  it('gives no long decode to a Vertex resource name: the cap is clamped there (a named limit)', () => {
    expect(longDecodeTokenLimitOf('publishers/google/models/gemini-4-hydrogen')).toBeNull();
    const cap = resolveOutputCap({
      requested: 262_144,
      forceMax: false,
      fallbackLimit: 65_536,
      outputTokenLimit: 65_536,
      longDecodeTokenLimit: longDecodeTokenLimitOf('publishers/google/models/gemini-4-hydrogen'),
    });
    expect(cap).toMatchObject({ wire: 65_536, maxRequests: 1 });
  });
});

describe('resolveOutputCap', () => {
  const base = { forceMax: false, fallbackLimit: 65_536 };

  it('sends a cap above the per-request limit unclamped on a long-decode model', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4, requested: 262_144 });
    expect(cap).toEqual({
      wire: 262_144,
      effective: 262_144,
      perRequest: 65_536,
      ceiling: 1_048_576,
      maxRequests: 4,
    });
  });

  it('clamps a long-decode cap to the long-decode total', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4, requested: 5_000_000 });
    expect(cap.wire).toBe(1_048_576);
    expect(cap.maxRequests).toBe(16);
  });

  it('clamps a 3.x model to its advertised limit: one request', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_3, requested: 262_144 });
    expect(cap).toEqual({
      wire: 65_536,
      effective: 65_536,
      perRequest: 65_536,
      ceiling: 65_536,
      maxRequests: 1,
    });
  });

  it('sends nothing without a caller cap, on a long-decode model too: one request at the model default', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4, requested: undefined });
    expect(cap).toEqual({
      wire: undefined,
      effective: 65_536,
      perRequest: 65_536,
      ceiling: 1_048_576,
      maxRequests: 1,
    });
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

  it('counts the requests by the advertised limit on a model at 32 768 a request', () => {
    const cap = resolveOutputCap({ ...base, ...GEMINI_4_AT_32K, requested: 131_072 });
    expect(cap).toEqual({
      wire: 131_072,
      effective: 131_072,
      perRequest: 32_768,
      ceiling: 1_048_576,
      maxRequests: 4,
    });
    expect(
      resolveOutputCap({ ...base, ...GEMINI_4_AT_32K, requested: 1_048_576 }).maxRequests,
    ).toBe(32);
  });
});

describe('preflightModeFor', () => {
  const cap = (maxRequests: number) => ({
    wire: undefined,
    effective: 65_536,
    perRequest: 65_536,
    ceiling: 1_048_576,
    maxRequests,
  });

  it('takes the exact count for a decode that may take more than one request, whatever was asked', () => {
    for (const asked of [undefined, 'heuristic', 'auto', 'exact'] as const) {
      expect(preflightModeFor(asked, cap(4)), String(asked)).toBe('exact');
    }
  });

  it("keeps the caller's mode for a one-request call", () => {
    expect(preflightModeFor(undefined, cap(1))).toBeUndefined();
    expect(preflightModeFor('heuristic', cap(1))).toBe('heuristic');
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
    expect(continuationInputTokens(100_000, 196_608, 65_536)).toBe(
      2 * 100_000 + 65_536 + 131_072 + 2 * O,
    );
  });

  it('on a model at 32 768 a request, bounds what each request decoded by the streaming limit, not by 32 768', () => {
    // R = ceil(131 072 / 32 768) = 4; a streaming request decodes up to M = 65 536, so the decode before request k
    // is at most min(k · 65 536, 131 072).
    expect(continuationInputTokens(100_000, 131_072, 32_768)).toBe(
      3 * 100_000 + 65_536 + 131_072 + 131_072 + 3 * O,
    );
  });

  it('bounds the decoded tokens: the cap for one request, one request past it at most over several', () => {
    expect(decodedTokensBound(65_536, 65_536)).toBe(65_536);
    expect(decodedTokensBound(40_000, 65_536)).toBe(40_000);
    // a multiple of the limit: R requests of M reach the cap exactly
    expect(decodedTokensBound(262_144, 65_536)).toBe(262_144);
    expect(decodedTokensBound(1_048_576, 65_536)).toBe(1_048_576);
    // the last request may run past a cap that is not a multiple: at most C + M − 1, at most R · M
    expect(decodedTokensBound(200_000, 65_536)).toBe(262_144);
    expect(decodedTokensBound(131_072, 32_768)).toBe(131_072 + 65_536 - 1);
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

  it('covers the measured bill: each continuation request billed 89–125 tokens above prompt + decode', () => {
    // No thinking reserve, the whole cap decoded over 16 requests, each continuation billing 125 tokens more than
    // the prompt and the decode before it (the larger of the two measurements).
    const prompt = 500_000;
    let billedInput = 0;
    for (let k = 0; k < 16; k++) billedInput += prompt + k * 65_536 + (k > 0 ? 125 : 0);
    const actual = estimateCostUsd({
      model: 'gemini-4-hydrogen',
      uncachedInputTokens: billedInput,
      cachedInputTokens: 0,
      outputTokens: 1_048_576,
    });
    const reserved = estimatePreCallCostUsd({
      model: 'gemini-4-hydrogen',
      workspaceBytes: prompt * 4,
      promptChars: 0,
      expectedOutputTokens: 1_048_576,
      perRequestOutputTokens: 65_536,
      thinkingTokens: 0,
      coverMs: null,
    });
    expect(reserved).toBeGreaterThanOrEqual(actual);
  });

  it("reserves on the preflight's count when the bytes/4 heuristic undercounts the prompt", () => {
    // The prompt is 300 000 tokens; bytes/4 says 240 000 (a 20 % undercount). Four requests decode the whole cap.
    const prompt = 300_000;
    const cap = 262_144;
    let billedInput = 0;
    for (let k = 0; k < 4; k++) billedInput += prompt + k * 65_536 + (k > 0 ? 125 : 0);
    const actual = estimateCostUsd({
      model: 'gemini-4-hydrogen',
      uncachedInputTokens: billedInput,
      cachedInputTokens: 0,
      outputTokens: 1_000,
      thinkingTokens: cap - 1_000,
    });
    const estimate = (countedInputTokens: number | undefined) =>
      estimatePreCallCostUsd({
        model: 'gemini-4-hydrogen',
        workspaceBytes: 240_000 * 4,
        promptChars: 0,
        countedInputTokens,
        expectedOutputTokens: cap,
        perRequestOutputTokens: 65_536,
        thinkingTokens: 2_048,
        coverMs: null,
      });
    expect(estimate(undefined)).toBeLessThan(actual);
    expect(estimate(prompt)).toBeGreaterThanOrEqual(actual);
    // a count below the heuristic never lowers the reservation
    expect(estimate(1_000)).toBe(estimate(undefined));
  });
});
