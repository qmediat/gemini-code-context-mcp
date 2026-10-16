import { describe, expect, it, vi } from 'vitest';
import { estimateCostUsd, microsToDollars, toMicrosUsd } from '../../src/utils/cost-estimator.js';

describe('cost estimator', () => {
  it('prices pro models higher than flash', () => {
    const pro = estimateCostUsd({
      model: 'gemini-3-pro-preview',
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    const flash = estimateCostUsd({
      model: 'gemini-3-flash-preview',
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(pro).toBeGreaterThan(flash);
  });

  it('charges cached tokens at a reduced rate', () => {
    const allUncached = estimateCostUsd({
      model: 'gemini-3-pro-preview',
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    const allCached = estimateCostUsd({
      model: 'gemini-3-pro-preview',
      uncachedInputTokens: 0,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    // Cached default is 0.25× input rate, so cached should be ~25%.
    expect(allCached).toBeLessThan(allUncached);
    expect(allCached).toBeCloseTo(allUncached * 0.25, 4);
  });

  it('prices gemini-4-argon at the 2026-12-01 rate (4 / 20 / 0.2 USD per 1M), the conservative one', () => {
    const cost = estimateCostUsd({
      model: 'gemini-4-argon',
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4 + 0.2 + 20, 6);
  });

  it('converts dollars to micros and back', () => {
    expect(toMicrosUsd(1.23)).toBe(1_230_000);
    expect(microsToDollars(1_230_000)).toBe(1.23);
  });

  it('an unpriced text-reasoning model is priced at the dearest rate the table knows for its category', () => {
    // Argon's 4 / 20 input / output; the 0.875 cached rate of a 3.x pro row (0.25 x 3.5).
    for (const model of ['gemini-5-hypothetical-pro', 'gemini-4.1-argon']) {
      const cost = estimateCostUsd({
        model,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(4 + 0.875 + 20, 6);
    }
  });

  it('each rolling alias is priced as its measured target, not the 2.5 line', () => {
    // Targets measured 2026-10-16 by the response's modelVersion.
    const cost = (model: string): number =>
      estimateCostUsd({
        model,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
    const targets: ReadonlyArray<readonly [string, string, number]> = [
      ['gemini-pro-latest', 'gemini-3.1-pro-preview', 3.5 + 0.875 + 10.5],
      ['gemini-flash-latest', 'gemini-3.8-flash', 1.5 + 0.15 + 7.5],
      ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 0.3 + 0.03 + 2.5],
    ];
    for (const [alias, target, expected] of targets) {
      expect(cost(alias)).toBeCloseTo(cost(target), 9);
      expect(cost(alias)).toBeCloseTo(expected, 6);
    }
  });

  it("an override of an alias's target prices the alias too (the lower 2026 Flash rate)", async () => {
    vi.resetModules();
    vi.stubEnv(
      'GEMINI_PRICING_OVERRIDES',
      JSON.stringify({ 'gemini-3.8-flash': { inputPerMillion: 0.75, outputPerMillion: 3.75 } }),
    );
    try {
      const fresh = await import('../../src/utils/cost-estimator.js');
      const cost = fresh.estimateCostUsd({
        model: 'gemini-flash-latest',
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(0.75 + 3.75, 6);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('prices gemini-3.8-flash at the 2027-01-01 rate (1.5 / 7.5 / 0.15 USD per 1M), the conservative one', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) {
      const cost = estimateCostUsd({
        model,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(1.5 + 0.15 + 7.5, 6);
    }
  });

  it('prices the 3.x Flash-Lite GA rows from the 2026-10-16 pricing page', () => {
    const cost = (model: string): number =>
      estimateCostUsd({
        model,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
    expect(cost('gemini-3.5-flash-lite')).toBeCloseTo(0.3 + 0.03 + 2.5, 6);
    expect(cost('gemini-3.1-flash-lite')).toBeCloseTo(0.25 + 0.025 + 1.5, 6);
  });

  it('an unpriced model is priced by its taxonomy category and tier, not by a substring of its id', () => {
    // `gemini-3-pro-image` carries `pro` but is an image model: the premium default, not a text rate.
    const cost = (model: string): number =>
      estimateCostUsd({
        model,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
    // A text model takes the dearest input rate of its category's rows:
    // 0.3 for text-lite (3.5 Flash-Lite), 1.5 for text-fast (3.6–3.8 Flash).
    expect(cost('gemini-3-pro-image')).toBeCloseTo(10.5, 6);
    expect(cost('gemini-4-argon-lite')).toBeCloseTo(0.3, 6);
    expect(cost('gemini-9-flash')).toBeCloseTo(1.5, 6);
  });
});
