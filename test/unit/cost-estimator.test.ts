import { describe, expect, it } from 'vitest';
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

  it('an unpriced premium-tier model falls to the premium default (10.5 / 30 USD per 1M)', () => {
    for (const model of ['gemini-5-hypothetical-pro', 'gemini-4.1-argon']) {
      const cost = estimateCostUsd({
        model,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(10.5 + 30, 6);
    }
  });

  it('an unpriced model is priced by its taxonomy tier, not by a substring of its id', () => {
    // `gemini-3-pro-image` carries `pro` but is an image model: the premium default, not a text rate.
    const cost = (model: string): number =>
      estimateCostUsd({
        model,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
    expect(cost('gemini-3-pro-image')).toBeCloseTo(10.5, 6);
    expect(cost('gemini-4-argon-lite')).toBeCloseTo(0.1, 6);
    expect(cost('gemini-9-flash')).toBeCloseTo(0.3, 6);
  });
});
