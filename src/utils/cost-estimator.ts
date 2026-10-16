/**
 * Approximate cost estimator for reporting (not billing authoritative).
 *
 * Rates are per million tokens, Standard tier, the rates of Google's pricing page
 * (https://ai.google.dev/gemini-api/docs/pricing, read 2026-10-16) with the dates
 * they take effect. Where the page has a prompt-size tier (≤ 200k / > 200k tokens)
 * the dearer tier is the row: the estimator does not see the prompt's size, so the
 * row stays an upper bound. An unpriced id takes the dearest row of its category.
 * `GEMINI_PRICING_OVERRIDES` (JSON, keyed by model id) replaces a row at run time.
 */

import type { CapabilityFlags, ModelCategory } from '../gemini/model-taxonomy.js';
import { categorizeModel, costTierOf, isTextGenCategory } from '../gemini/model-taxonomy.js';
import { parsePricingOverrides } from './pricing-overrides.js';

/** One set of rates, USD per 1M tokens. */
export interface Rates {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cached tokens are billed at a reduced rate. Optional — falls back to 0.25× input. */
  cachedInputPerMillion?: number;
}

/** Rates that replace a row's from a UTC date on (`YYYY-MM-DD`, inclusive). */
export interface NextRates extends Required<Rates> {
  from: string;
}

export interface PricingEntry extends Rates {
  /** A price change Google has announced: in force from `next.from`. */
  next?: NextRates;
}

const FLASH_3X: PricingEntry = {
  inputPerMillion: 0.75,
  outputPerMillion: 3.75,
  cachedInputPerMillion: 0.075,
  next: {
    from: '2027-01-01',
    inputPerMillion: 1.5,
    outputPerMillion: 7.5,
    cachedInputPerMillion: 0.15,
  },
};

/** The > 200k-token tier of the 3.x Pro previews (≤ 200k: 2 / 12 / 0.2). */
const PRO_3X_PREVIEW: PricingEntry = {
  inputPerMillion: 4,
  outputPerMillion: 18,
  cachedInputPerMillion: 0.4,
};

/** The 3.1 Flash-Lite rates; the page prices the model once, GA and preview ids alike. */
const FLASH_LITE_31: PricingEntry = {
  inputPerMillion: 0.25,
  outputPerMillion: 1.5,
  cachedInputPerMillion: 0.025,
};

const DEFAULT_PRICING: Readonly<Record<string, PricingEntry>> = {
  'gemini-4-argon': {
    inputPerMillion: 2,
    outputPerMillion: 10,
    cachedInputPerMillion: 0.1,
    next: {
      from: '2026-12-01',
      inputPerMillion: 4,
      outputPerMillion: 20,
      cachedInputPerMillion: 0.2,
    },
  },
  'gemini-3-pro-preview': PRO_3X_PREVIEW,
  'gemini-3.1-pro-preview': PRO_3X_PREVIEW,
  'gemini-3.8-flash': FLASH_3X,
  'gemini-3.7-flash': FLASH_3X,
  'gemini-3.6-flash': FLASH_3X,
  'gemini-3-flash-preview': {
    inputPerMillion: 0.5,
    outputPerMillion: 3,
    cachedInputPerMillion: 0.05,
  },
  // The page lists it as `gemini-3.1-flash-image` (text input / text and thinking output).
  'gemini-3.1-flash-image-preview': { inputPerMillion: 0.5, outputPerMillion: 3 },
  'gemini-3.5-flash-lite': {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cachedInputPerMillion: 0.03,
  },
  'gemini-3.1-flash-lite': FLASH_LITE_31,
  'gemini-3.1-flash-lite-preview': FLASH_LITE_31,
  // The > 200k-token tier (≤ 200k: 1.25 / 10 / 0.125).
  'gemini-2.5-pro': { inputPerMillion: 2.5, outputPerMillion: 15, cachedInputPerMillion: 0.25 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5, cachedInputPerMillion: 0.03 },
  'gemini-2.5-flash-lite': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cachedInputPerMillion: 0.01,
  },
};

/**
 * Google's rolling aliases and the versioned id each served on 2026-10-16 (measured
 * by the response's `modelVersion`; re-measure when Google moves them). The target
 * only names the category: Google can move an alias to a dearer model between two
 * measurements, so an alias prices at the dearest rate of its target's category.
 */
// Exported for the tests, which check every target is a priced id.
export const ALIAS_TARGET: Readonly<Record<string, string>> = {
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
  'gemini-flash-latest': 'gemini-3.8-flash',
  'gemini-flash-lite-latest': 'gemini-3.5-flash-lite',
};

/** `record[key]` when `key` is the record's own (never a prototype member such as `constructor`). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The ids the table prices (an alias is never one of them). Exported for the tests. */
export function isPricedId(id: string): boolean {
  return own(DEFAULT_PRICING, id) !== undefined;
}

/**
 * Conservative defaults for models we've never seen — one for each cost tier
 * the taxonomy assigns, plus an "unknown premium" fallback that assumes the
 * highest rate we know of. The goal is to over-estimate cost for a brand-new
 * model so a budget-capped user gets blocked at the cap instead of silently
 * overshooting it while we wait for a pricing-table update.
 */
const UNKNOWN_PREMIUM_RATE: Rates = { inputPerMillion: 10.5, outputPerMillion: 30 };
const UNKNOWN_FLASH_RATE: Rates = { inputPerMillion: 0.3, outputPerMillion: 2.5 };
const UNKNOWN_LITE_RATE: Rates = { inputPerMillion: 0.1, outputPerMillion: 0.4 };

/**
 * The conservative rate per cost tier, for a model outside the text categories
 * (image, audio, video, agent, unknown): the table prices no such family it could
 * stand for, so a `premium` one gets the highest rate we know of.
 */
const UNKNOWN_RATE_BY_TIER: Readonly<Record<CapabilityFlags['costTier'], Rates>> = {
  premium: UNKNOWN_PREMIUM_RATE,
  standard: UNKNOWN_FLASH_RATE,
  budget: UNKNOWN_LITE_RATE,
  unknown: UNKNOWN_PREMIUM_RATE,
};

/** The cached-input rate a row bills: its own, else the 0.25× input default. */
function cachedRate(row: Rates): number {
  return row.cachedInputPerMillion ?? row.inputPerMillion * 0.25;
}

/** The UTC calendar date of `at`, `YYYY-MM-DD`. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The rates of `entry` in force at `at`: its `next` rates from their UTC date on. */
function ratesAt(entry: PricingEntry, at: Date): Rates {
  const next = entry.next;
  if (next === undefined || utcDate(at) < next.from) return entry;
  return next;
}

/**
 * The dearest rate `rows` have in force at `at` for a text category, per component
 * (the highest input, output and cached rate of its rows): an upper bound for an
 * unpriced model or an alias of that category, or `undefined` for a category no
 * text row prices.
 */
function dearestTextRate(
  category: ModelCategory,
  at: Date,
  rows: Readonly<Record<string, PricingEntry>>,
): Rates | undefined {
  if (!isTextGenCategory(category)) return undefined;
  let held: Rates | undefined;
  for (const [id, entry] of Object.entries(rows)) {
    if (categorizeModel(id) !== category) continue;
    const row = ratesAt(entry, at);
    held = {
      inputPerMillion: Math.max(held?.inputPerMillion ?? 0, row.inputPerMillion),
      outputPerMillion: Math.max(held?.outputPerMillion ?? 0, row.outputPerMillion),
      cachedInputPerMillion: Math.max(held ? cachedRate(held) : 0, cachedRate(row)),
    };
  }
  return held;
}

/**
 * Where a model's price can come from, in the order `pricedRow` reads them.
 * Exported with `pricedRow` for the tests.
 */
export interface PricingSources {
  overrides: Readonly<Record<string, PricingEntry>>;
  aliasTarget: Readonly<Record<string, string>>;
  rows: Readonly<Record<string, PricingEntry>>;
}

/**
 * The row that prices `model`, or `undefined` when its category's bound applies:
 * an override of the id itself; for an alias, its target's override (an alias never
 * prices as a row — neither its own nor its target's); else the id's row.
 */
export function pricedRow(model: string, src: PricingSources): PricingEntry | undefined {
  const override = own(src.overrides, model);
  if (override !== undefined) return override;
  const target = own(src.aliasTarget, model);
  if (target !== undefined) return own(src.overrides, target);
  return own(src.rows, model);
}

/** The pricing sources, and the rows the category bound reads: the table with the overrides on top. */
interface LoadedPricing {
  sources: PricingSources;
  boundRows: Readonly<Record<string, PricingEntry>>;
}

let loaded: LoadedPricing | null = null;

function loadPricing(): LoadedPricing {
  if (loaded !== null) return loaded;
  const overrides = parsePricingOverrides(process.env.GEMINI_PRICING_OVERRIDES);
  const boundRows: Record<string, PricingEntry> = { ...DEFAULT_PRICING };
  for (const [id, entry] of Object.entries(overrides)) {
    // An alias never prices as a row, so its override never sets a category's bound.
    if (own(ALIAS_TARGET, id) === undefined) boundRows[id] = entry;
  }
  loaded = { sources: { overrides, aliasTarget: ALIAS_TARGET, rows: DEFAULT_PRICING }, boundRows };
  return loaded;
}

function pricingFor(model: string, at: Date): Rates {
  const { sources, boundRows } = loadPricing();
  const row = pricedRow(model, sources);
  if (row) return ratesAt(row, at);
  // An alias or an unpriced text model: the dearest rate of its category (an alias's
  // is its measured target's). Anything else: the conservative rate of its cost tier —
  // a model the taxonomy cannot place gets the premium rate rather than flash: better
  // to block an over-budget user than let a never-seen model undercharge past the cap.
  const categoryId = own(sources.aliasTarget, model) ?? model;
  const bound = dearestTextRate(categorizeModel(categoryId), at, boundRows);
  return bound ?? UNKNOWN_RATE_BY_TIER[costTierOf(categoryId)];
}

export interface CostInputs {
  /** The service tier the call runs on; flex halves the price. */
  serviceTier?: 'standard' | 'flex' | undefined;
  model: string;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  /**
   * The moment whose rates apply. Defaults to now: a settled call is priced at the
   * rates in force when it settles; a reservation goes through
   * `estimateReservationUsd`, which covers the call's whole window.
   */
  at?: Date | undefined;
}

/** Google's flex tier is billed at half the standard price for the same model. */
export const FLEX_PRICE_FACTOR = 0.5;

function tierFactor(tier: 'standard' | 'flex' | undefined): number {
  return tier === 'flex' ? FLEX_PRICE_FACTOR : 1;
}

/** Estimated cost in USD (float). Multiply by 1e6 for micros before storing. */
export function estimateCostUsd(input: CostInputs): number {
  const p = pricingFor(input.model, input.at ?? new Date());
  const uncached = (input.uncachedInputTokens / 1_000_000) * p.inputPerMillion;
  const cached = (input.cachedInputTokens / 1_000_000) * cachedRate(p);
  const output = (input.outputTokens / 1_000_000) * p.outputPerMillion;
  // Thinking tokens are currently billed as output tokens on Gemini Pro family.
  const thinking = input.thinkingTokens
    ? (input.thinkingTokens / 1_000_000) * p.outputPerMillion
    : 0;
  return (uncached + cached + output + thinking) * tierFactor(input.serviceTier);
}

/** A date after every announced price change: where a call without a timeout may still be running. */
const OPEN_END = new Date('9999-12-31T00:00:00Z');

/**
 * A reservation for a call that may run up to `coverMs` (its timeout; `null`: none):
 * the dearer of the cost at the rates in force at its start and at the end of that
 * window, so a call that crosses a price change settles at or under what it reserved.
 * A call without a timeout reserves at every rate announced.
 */
export function estimateReservationUsd(input: CostInputs, coverMs: number | null): number {
  const start = input.at ?? new Date();
  const end = coverMs === null ? OPEN_END : new Date(start.getTime() + coverMs);
  return Math.max(estimateCostUsd({ ...input, at: start }), estimateCostUsd({ ...input, at: end }));
}

export function toMicrosUsd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

export interface PreCallEstimateInputs {
  serviceTier?: 'standard' | 'flex' | undefined;
  model: string;
  /** Sum of file sizes in bytes — the workspace content that will be sent. */
  workspaceBytes: number;
  /** Length of the user prompt in chars — tokenised at ~4 bytes/token. */
  promptChars: number;
  /** Input tokens beyond the workspace and the prompt (the attachments), counted by Gemini. */
  extraInputTokens?: number | undefined;
  /** Upper bound on output tokens (tool-specific default). */
  expectedOutputTokens: number;
  /** Thinking budget, passed through as extra output tokens. */
  thinkingTokens?: number;
  /** The call's timeout in ms (`null`: none): the reservation covers the rates of that window. */
  coverMs: number | null;
  /** When the reservation is made. Defaults to now. */
  at?: Date | undefined;
}

/**
 * Pre-call cost estimate used by the budget-reservation path. Charges
 * the workspace content at the UNCACHED rate on purpose — on the first
 * call a cache doesn't exist yet and the reservation must cover that
 * cost; on subsequent calls the cache makes the ACTUAL cost cheaper and
 * the `finalizeBudgetReservation` pass records the lower real value.
 * Over-estimating here = user sees a clear "budget would be exceeded"
 * message instead of a silent cap overshoot.
 */
export function estimatePreCallCostUsd(input: PreCallEstimateInputs): number {
  const workspaceTokens = Math.ceil(Math.max(0, input.workspaceBytes) / 4);
  const promptTokens = Math.ceil(Math.max(0, input.promptChars) / 4);
  const call: CostInputs = {
    model: input.model,
    serviceTier: input.serviceTier,
    uncachedInputTokens: workspaceTokens + promptTokens + Math.max(0, input.extraInputTokens ?? 0),
    cachedInputTokens: 0,
    outputTokens: Math.max(0, input.expectedOutputTokens),
    at: input.at,
    ...(input.thinkingTokens !== undefined ? { thinkingTokens: input.thinkingTokens } : {}),
  };
  return estimateReservationUsd(call, input.coverMs);
}

/**
 * Raw conversion: `micros → dollars` as a full-precision float. Sub-cent values
 * survive, so `usageMetrics` tracking of e.g. $0.0043 calls remains visible.
 * Use `formatDollarsToCents` when you want 2-decimal presentation.
 */
export function microsToDollars(micros: number): number {
  return micros / 1_000_000;
}

/** Round a dollar amount to cents. Presentation helper. */
export function formatDollarsToCents(dollars: number): number {
  return Math.round(dollars * 100) / 100;
}
