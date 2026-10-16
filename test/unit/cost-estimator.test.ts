import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIAS_TARGET,
  type PricingEntry,
  estimateCostUsd,
  estimatePreCallCostUsd,
  isPricedId,
  microsToDollars,
  pricedRow,
  toMicrosUsd,
} from '../../src/utils/cost-estimator.js';

/** 2026-10-16, the day the table was read from Google's pricing page. */
const READ_DAY = new Date('2026-10-16T12:00:00Z');

interface CostOptions {
  cached?: number;
  output?: number;
  at?: Date;
  estimate?: typeof estimateCostUsd;
}

/** USD for 1M uncached input tokens plus the cached and output tokens given (1M each by default). */
function cost(model: string, options: CostOptions = {}): number {
  const estimate = options.estimate ?? estimateCostUsd;
  return estimate({
    model,
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: options.cached ?? 1_000_000,
    outputTokens: options.output ?? 1_000_000,
    at: options.at ?? READ_DAY,
  });
}

/** The input rate alone (1M uncached input tokens, nothing else). */
function inputRate(model: string, at: Date = READ_DAY, estimate = estimateCostUsd): number {
  return cost(model, { cached: 0, output: 0, at, estimate });
}

/** The output rate alone (1M output tokens minus the input rate). */
function outputRate(model: string, at: Date = READ_DAY): number {
  return cost(model, { cached: 0, at }) - inputRate(model, at);
}

type Estimator = typeof import('../../src/utils/cost-estimator.js');

/** The estimator loaded afresh with `overrides` as GEMINI_PRICING_OVERRIDES. */
async function estimatorWith(overrides: unknown): Promise<Estimator> {
  vi.resetModules();
  vi.stubEnv('GEMINI_PRICING_OVERRIDES', JSON.stringify(overrides));
  return import('../../src/utils/cost-estimator.js');
}

describe('cost estimator', () => {
  // A developer's own overrides must not change what these tests price.
  beforeEach(() => {
    vi.stubEnv('GEMINI_PRICING_OVERRIDES', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prices pro models higher than flash', () => {
    expect(inputRate('gemini-3-pro-preview')).toBeGreaterThan(inputRate('gemini-3-flash-preview'));
  });

  it('charges cached tokens at the row cached rate, or 0.25x input when the row names none', () => {
    expect(
      cost('gemini-3-pro-preview', { output: 0 }) - inputRate('gemini-3-pro-preview'),
    ).toBeCloseTo(0.4, 9);
    // The image row names no cached rate: 0.25 x 0.5.
    const image = 'gemini-3.1-flash-image-preview';
    expect(cost(image, { output: 0 }) - inputRate(image)).toBeCloseTo(0.125, 9);
  });

  it('converts dollars to micros and back', () => {
    expect(toMicrosUsd(1.23)).toBe(1_230_000);
    expect(microsToDollars(1_230_000)).toBe(1.23);
  });

  describe('dated rates: the rate in force on the UTC day of the call', () => {
    it('gemini-4-argon bills 2 / 10 / 0.1 through 2026-11-30 and 4 / 20 / 0.2 from 2026-12-01', () => {
      expect(cost('gemini-4-argon', { at: new Date('2026-11-30T23:59:59Z') })).toBeCloseTo(
        2 + 0.1 + 10,
        9,
      );
      expect(cost('gemini-4-argon', { at: new Date('2026-12-01T00:00:00Z') })).toBeCloseTo(
        4 + 0.2 + 20,
        9,
      );
    });

    it('the 3.6-3.8 Flash rows bill 0.75 / 3.75 / 0.075 through 2026-12-31 and 1.5 / 7.5 / 0.15 from 2027-01-01', () => {
      for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) {
        expect(cost(model, { at: new Date('2026-12-31T23:59:59Z') })).toBeCloseTo(
          0.75 + 0.075 + 3.75,
          9,
        );
        expect(cost(model, { at: new Date('2027-01-01T00:00:00Z') })).toBeCloseTo(
          1.5 + 0.15 + 7.5,
          9,
        );
      }
    });

    it('an estimate without `at` prices at the current date', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
        const now = estimateCostUsd({
          model: 'gemini-4-argon',
          uncachedInputTokens: 1_000_000,
          cachedInputTokens: 0,
          outputTokens: 0,
        });
        expect(now).toBeCloseTo(4, 9);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('rows from the pricing page read 2026-10-16', () => {
    const rows: ReadonlyArray<readonly [string, number]> = [
      // The > 200k-token tier where the page has one: 4 / 18 / 0.4 and 2.5 / 15 / 0.25.
      ['gemini-3.1-pro-preview', 4 + 0.4 + 18],
      ['gemini-3-pro-preview', 4 + 0.4 + 18],
      ['gemini-2.5-pro', 2.5 + 0.25 + 15],
      ['gemini-3-flash-preview', 0.5 + 0.05 + 3],
      ['gemini-3.5-flash-lite', 0.3 + 0.03 + 2.5],
      ['gemini-3.1-flash-lite', 0.25 + 0.025 + 1.5],
      ['gemini-3.1-flash-lite-preview', 0.25 + 0.025 + 1.5],
      ['gemini-2.5-flash', 0.3 + 0.03 + 2.5],
      ['gemini-2.5-flash-lite', 0.1 + 0.01 + 0.4],
    ];
    for (const [model, expected] of rows) {
      it(`${model} costs ${expected.toFixed(3)} for 1M input + 1M cached + 1M output`, () => {
        expect(cost(model)).toBeCloseTo(expected, 9);
      });
    }
  });

  describe('rolling aliases: the dearest rate of the measured target category', () => {
    it('every alias target is a priced id, and no alias is', () => {
      for (const [alias, target] of Object.entries(ALIAS_TARGET)) {
        expect(isPricedId(target)).toBe(true);
        expect(isPricedId(alias)).toBe(false);
      }
    });

    it('gemini-pro-latest prices at the text-reasoning bound, dearer than its target once Argon moves', () => {
      expect(cost('gemini-pro-latest')).toBeCloseTo(4 + 0.4 + 18, 9);
      const december = new Date('2026-12-01T00:00:00Z');
      // Argon's 4 / 20 with the 3.x Pro previews' 0.4 cached: not the target row's 18.
      expect(cost('gemini-pro-latest', { at: december })).toBeCloseTo(4 + 0.4 + 20, 9);
      expect(cost('gemini-3.1-pro-preview', { at: december })).toBeCloseTo(4 + 0.4 + 18, 9);
    });

    it('gemini-flash-latest and gemini-flash-lite-latest price at their categories bounds, not the 2.5 line', () => {
      expect(cost('gemini-flash-latest')).toBeCloseTo(0.75 + 0.075 + 3.75, 9);
      expect(cost('gemini-flash-latest', { at: new Date('2027-01-01T00:00:00Z') })).toBeCloseTo(
        1.5 + 0.15 + 7.5,
        9,
      );
      expect(cost('gemini-flash-lite-latest')).toBeCloseTo(0.3 + 0.03 + 2.5, 9);
    });

    it("an override of an alias's target prices the alias (all three values named)", async () => {
      const lower = { inputPerMillion: 0.5, outputPerMillion: 2, cachedInputPerMillion: 0.05 };
      const fresh = await estimatorWith({ 'gemini-3.8-flash': lower });
      expect(cost('gemini-flash-latest', { estimate: fresh.estimateCostUsd })).toBeCloseTo(
        0.5 + 0.05 + 2,
        9,
      );
    });

    it('an override of a dearer model lifts the bound an alias and an unpriced id of its category take', async () => {
      const dearer = { inputPerMillion: 6, outputPerMillion: 30, cachedInputPerMillion: 0.6 };
      const fresh = await estimatorWith({ 'gemini-5-pro': dearer });
      for (const model of ['gemini-pro-latest', 'gemini-6-hypothetical-pro']) {
        expect(cost(model, { estimate: fresh.estimateCostUsd })).toBeCloseTo(6 + 0.6 + 30, 9);
      }
    });
  });

  describe('a reservation covers every rate the call can settle under', () => {
    /** The reserved input rate: 1M input tokens (4 bytes a token), nothing else. */
    function reservedInputRate(at: string, coverMs: number | null): number {
      return estimatePreCallCostUsd({
        model: 'gemini-4-argon',
        workspaceBytes: 4_000_000,
        promptChars: 0,
        expectedOutputTokens: 0,
        coverMs,
        at: new Date(at),
      });
    }

    it('a call reserved at 23:30 UTC on 2026-11-30 with a 60-min timeout reserves at the 2026-12-01 rate', () => {
      expect(reservedInputRate('2026-11-30T23:30:00Z', 60 * 60_000)).toBeCloseTo(4, 9);
    });

    it('a call reserved at 22:00 UTC on 2026-11-30 with a 60-min timeout reserves at the 2026-11-30 rate', () => {
      expect(reservedInputRate('2026-11-30T22:00:00Z', 60 * 60_000)).toBeCloseTo(2, 9);
    });

    it('a call without a timeout reserves at every rate announced', () => {
      expect(reservedInputRate('2026-10-16T12:00:00Z', null)).toBeCloseTo(4, 9);
    });

    it('an untimed reservation takes each component at its dearest from now on, overrides included', async () => {
      // 3 Flash preview's output drops 20 -> 2.5 on 2027-02-01 while 3.8 Flash's input
      // doubles on 2027-01-01: a call reserved in December may settle in January.
      const flash3 = { inputPerMillion: 0.5, outputPerMillion: 20, cachedInputPerMillion: 0.05 };
      const fresh = await estimatorWith({
        'gemini-3-flash-preview': {
          ...flash3,
          next: { ...flash3, from: '2027-02-01', outputPerMillion: 2.5 },
        },
      });
      const reserve = (at: string): number =>
        fresh.estimatePreCallCostUsd({
          model: 'gemini-flash-latest',
          workspaceBytes: 4_000_000,
          promptChars: 0,
          expectedOutputTokens: 1_000_000,
          coverMs: null,
          at: new Date(at),
        });
      const january = reserve('2027-01-15T12:00:00Z');
      expect(january).toBeCloseTo(1.5 + 20, 9);
      expect(reserve('2026-12-15T12:00:00Z')).toBeGreaterThanOrEqual(january);
    });

    it('a settled call is priced at the rate in force when it settles', () => {
      expect(inputRate('gemini-4-argon', new Date('2026-11-30T23:30:00Z'))).toBeCloseTo(2, 9);
    });
  });

  describe('pricedRow: which row prices an id', () => {
    const target: PricingEntry = { inputPerMillion: 1, outputPerMillion: 2 };
    const own: PricingEntry = { inputPerMillion: 9, outputPerMillion: 9 };
    const ov: PricingEntry = { inputPerMillion: 3, outputPerMillion: 4 };

    it('an alias never prices as a row: neither one under its own id nor its target row', () => {
      const src = { overrides: {}, aliasTarget: { alias: 'target' }, rows: { alias: own, target } };
      expect(pricedRow('alias', src)).toBe(undefined);
    });

    it("an override keyed by the alias id wins over the target's override", async () => {
      const fresh = await estimatorWith({ 'gemini-flash-latest': own, 'gemini-3.8-flash': ov });
      expect(inputRate('gemini-flash-latest', READ_DAY, fresh.estimateCostUsd)).toBeCloseTo(9, 9);
    });

    it('a target that is itself an alias is not followed', () => {
      const loop = { overrides: {}, aliasTarget: { a: 'b', b: 'a' }, rows: { a: own, b: own } };
      expect(pricedRow('a', loop)).toBe(undefined);
    });
  });

  describe('an unpriced id: the dearest rate its category has in force', () => {
    it('an unpriced text-reasoning model takes Argon 4 / 20 from 2026-12-01 and the previews 0.4 cached', () => {
      const december = new Date('2026-12-01T00:00:00Z');
      for (const model of ['gemini-5-hypothetical-pro', 'gemini-4.1-argon']) {
        expect(cost(model, { at: december })).toBeCloseTo(4 + 0.4 + 20, 9);
      }
    });

    it('text-fast and text-lite bounds: input and output both, read from the rows in force', () => {
      const y2027 = new Date('2027-01-01T00:00:00Z');
      expect(inputRate('gemini-9-flash', y2027)).toBeCloseTo(1.5, 9);
      expect(outputRate('gemini-9-flash', y2027)).toBeCloseTo(7.5, 9);
      expect(inputRate('gemini-3.5-flash')).toBeCloseTo(0.75, 9);
      expect(outputRate('gemini-3.5-flash')).toBeCloseTo(3.75, 9);
      expect(inputRate('gemini-4-argon-lite')).toBeCloseTo(0.3, 9);
      expect(outputRate('gemini-4-argon-lite')).toBeCloseTo(2.5, 9);
    });

    it('an id named like an Object prototype member is priced by the fallback, never NaN', () => {
      for (const model of ['constructor', 'toString', 'hasOwnProperty']) {
        expect(inputRate(model)).toBeCloseTo(10.5, 9);
      }
    });

    it('a non-text model takes the conservative rate of its tier, not a substring of its id', () => {
      // `gemini-3-pro-image` carries `pro` but is an image model: the premium default.
      expect(inputRate('gemini-3-pro-image')).toBeCloseTo(10.5, 9);
    });
  });
});
