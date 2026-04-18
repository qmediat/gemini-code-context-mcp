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

  it('converts dollars to micros and back', () => {
    expect(toMicrosUsd(1.23)).toBe(1_230_000);
    expect(microsToDollars(1_230_000)).toBe(1.23);
  });

  it('falls back to pro pricing for unknown pro-class models', () => {
    const cost = estimateCostUsd({
      model: 'gemini-5-hypothetical-pro',
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    // Non-zero and at pro rate ($3.50 / 1M).
    expect(cost).toBeCloseTo(3.5, 2);
  });
});
