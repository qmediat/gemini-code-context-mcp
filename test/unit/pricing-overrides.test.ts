import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';
import { parsePricingOverrides } from '../../src/utils/pricing-overrides.js';

const RATES = { inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.1 };
const NEXT = {
  from: '2026-12-01',
  inputPerMillion: 4,
  outputPerMillion: 20,
  cachedInputPerMillion: 0.2,
};

/** The rows `overrides` parses to, and the warnings it printed. */
function parse(overrides: unknown): {
  rows: ReturnType<typeof parsePricingOverrides>;
  warnings: string[];
} {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const rows = parsePricingOverrides(JSON.stringify(overrides));
  return { rows, warnings: warn.mock.calls.map((call) => String(call[0])) };
}

describe('GEMINI_PRICING_OVERRIDES', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a valid row with its dated next rates', () => {
    const { rows, warnings } = parse({ m: { ...RATES, next: NEXT } });
    expect(rows.m).toEqual({ ...RATES, next: NEXT });
    expect(warnings).toEqual([]);
  });

  it('drops a row whose next has no from, and says so', () => {
    const { from: _from, ...noFrom } = NEXT;
    const { rows, warnings } = parse({ m: { ...RATES, next: noFrom } });
    expect(rows).toEqual({});
    expect(warnings).toEqual([
      expect.stringContaining('"m" dropped (next.from is not a YYYY-MM-DD calendar date)'),
    ]);
  });

  it('drops a row whose next.from is not a real calendar day, and says so', () => {
    for (const from of ['2026-13-01', '2026-02-30']) {
      const { rows, warnings } = parse({ m: { ...RATES, next: { ...NEXT, from } } });
      expect(rows).toEqual({});
      expect(warnings).toEqual([
        expect.stringContaining('next.from is not a YYYY-MM-DD calendar date'),
      ]);
      vi.restoreAllMocks();
    }
  });

  it('drops a row keyed __proto__ with a warning, never silently, and keeps the others', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = `{"__proto__": ${JSON.stringify(RATES)}, "good": ${JSON.stringify(RATES)}}`;
    const rows = parsePricingOverrides(raw);
    expect(Object.keys(rows)).toEqual(['good']);
    expect(Object.getPrototypeOf(rows)).toBe(null);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"__proto__" dropped (not a model id)'),
    );
  });

  it('drops a row whose next names only some rates, and says so', () => {
    const { rows, warnings } = parse({
      m: { ...RATES, next: { from: '2026-12-01', inputPerMillion: 4 } },
    });
    expect(rows).toEqual({});
    expect(warnings).toEqual([
      expect.stringContaining('next.outputPerMillion is not a finite rate >= 0'),
    ]);
  });

  it('drops a row with a negative or non-numeric rate and keeps the valid ones', () => {
    const { rows, warnings } = parse({
      bad: { inputPerMillion: -1, outputPerMillion: 1 },
      text: { inputPerMillion: '1', outputPerMillion: 1 },
      good: RATES,
    });
    expect(Object.keys(rows)).toEqual(['good']);
    expect(warnings).toHaveLength(2);
  });

  it('ignores a value that is not a JSON object of rows, and says so', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(parsePricingOverrides('not json')).toEqual({});
    expect(parsePricingOverrides('[1]')).toEqual({});
    expect(parsePricingOverrides(undefined)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
