/**
 * `GEMINI_PRICING_OVERRIDES`: the operator's price rows, validated at load. An entry
 * the estimator could not price with (a rate that is not a finite number ≥ 0, a
 * `next` without a `YYYY-MM-DD` `from` or without all three rates) is dropped with
 * one warning naming the model and the reason; the table's row for it stays.
 */

import type { PricingEntry, Rates } from './cost-estimator.js';
import { logger } from './logger.js';

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RATE_KEYS = ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion'] as const;

type Fields = Readonly<Record<string, unknown>>;

function asFields(value: unknown): Fields | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Fields;
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Why `value` cannot be a row's `next`, or `null` when it can. */
function nextProblem(value: unknown): string | null {
  const next = asFields(value);
  if (next === null) return 'next is not an object';
  if (typeof next.from !== 'string' || !UTC_DAY.test(next.from)) {
    return 'next.from is not a YYYY-MM-DD date';
  }
  const missing = RATE_KEYS.find((key) => !isRate(next[key]));
  return missing === undefined ? null : `next.${missing} is not a finite rate >= 0`;
}

/** Why `fields` cannot be a price row, or `null` when it can. */
function entryProblem(fields: Fields): string | null {
  if (!isRate(fields.inputPerMillion)) return 'inputPerMillion is not a finite rate >= 0';
  if (!isRate(fields.outputPerMillion)) return 'outputPerMillion is not a finite rate >= 0';
  const cached = fields.cachedInputPerMillion;
  if (cached !== undefined && !isRate(cached))
    return 'cachedInputPerMillion is not a finite rate >= 0';
  return fields.next === undefined ? null : nextProblem(fields.next);
}

/** A typed copy of a row `entryProblem` accepted. */
function toEntry(fields: Fields): PricingEntry {
  const rates: Rates = {
    inputPerMillion: fields.inputPerMillion as number,
    outputPerMillion: fields.outputPerMillion as number,
  };
  if (fields.cachedInputPerMillion !== undefined) {
    rates.cachedInputPerMillion = fields.cachedInputPerMillion as number;
  }
  const next = asFields(fields.next);
  if (next === null) return rates;
  return {
    ...rates,
    next: {
      from: next.from as string,
      inputPerMillion: next.inputPerMillion as number,
      outputPerMillion: next.outputPerMillion as number,
      cachedInputPerMillion: next.cachedInputPerMillion as number,
    },
  };
}

/** The valid rows of `raw` (the variable's JSON) by model id; nothing when unset. */
export function parsePricingOverrides(raw: string | undefined): Record<string, PricingEntry> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`GEMINI_PRICING_OVERRIDES is not JSON and is ignored: ${String(err)}`);
    return {};
  }
  const map = asFields(parsed);
  if (map === null) {
    logger.warn('GEMINI_PRICING_OVERRIDES is not a JSON object of model rows and is ignored');
    return {};
  }
  const rows: Record<string, PricingEntry> = {};
  for (const [model, value] of Object.entries(map)) {
    const fields = asFields(value);
    const problem = fields === null ? 'not an object' : entryProblem(fields);
    if (fields === null || problem !== null) {
      logger.warn(
        `GEMINI_PRICING_OVERRIDES: ${JSON.stringify(model)} dropped (${problem}); the table row stays`,
      );
      continue;
    }
    rows[model] = toEntry(fields);
  }
  return rows;
}
