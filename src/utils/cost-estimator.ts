/**
 * Approximate cost estimator for reporting (not billing authoritative).
 *
 * Rates are per million tokens, Standard tier, from public Gemini API pricing
 * (https://ai.google.dev/gemini-api/docs/pricing). Update when Google changes
 * pricing; values can also be overridden at runtime via `GEMINI_PRICING_OVERRIDES` (JSON).
 */

import type { CapabilityFlags, ModelCategory } from '../gemini/model-taxonomy.js';
import { categorizeModel, costTierOf, isTextGenCategory } from '../gemini/model-taxonomy.js';

export interface PricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cached tokens are billed at a reduced rate. Optional — falls back to 0.25× input. */
  cachedInputPerMillion?: number;
}

const DEFAULT_PRICING: Record<string, PricingEntry> = {
  // Conservative defaults — if the actual rate is lower, users see a pleasant surprise.
  // Google's rate from 2026-12-01. Through 2026-11-30 it bills 2 / 10 / 0.1, so
  // until then this over-estimates by 2× — the conservative side this table keeps,
  // so a budget stays an upper bound. The exact figure now, all three values named
  // (an override without `cachedInputPerMillion` bills cached input at 0.25× input):
  //   GEMINI_PRICING_OVERRIDES='{"gemini-4-argon":{"inputPerMillion":2,"outputPerMillion":10,"cachedInputPerMillion":0.1}}'
  'gemini-4-argon': { inputPerMillion: 4, outputPerMillion: 20, cachedInputPerMillion: 0.2 },
  'gemini-3-pro-preview': { inputPerMillion: 3.5, outputPerMillion: 10.5 },
  'gemini-3.1-pro-preview': { inputPerMillion: 3.5, outputPerMillion: 10.5 },
  // The 3.6–3.8 Flash, 3.5 Flash-Lite and 3.1 Flash-Lite rows: the pricing page read
  // 2026-10-16. The three Flash rows carry Google's rate from 2027-01-01; through
  // 2026-12-31 they bill 0.75 / 3.75 / 0.075, so until then the estimate is 2× high —
  // the conservative side, as for Argon. The exact figure now, per id, all three values:
  //   GEMINI_PRICING_OVERRIDES='{"gemini-3.8-flash":{"inputPerMillion":0.75,"outputPerMillion":3.75,"cachedInputPerMillion":0.075}}'
  'gemini-3.8-flash': { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.15 },
  'gemini-3.7-flash': { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.15 },
  'gemini-3.6-flash': { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.15 },
  'gemini-3-flash-preview': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-3.1-flash-image-preview': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-3.5-flash-lite': {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cachedInputPerMillion: 0.03,
  },
  'gemini-3.1-flash-lite': {
    inputPerMillion: 0.25,
    outputPerMillion: 1.5,
    cachedInputPerMillion: 0.025,
  },
  // The same model as the GA row: the page prices it once.
  'gemini-3.1-flash-lite-preview': {
    inputPerMillion: 0.25,
    outputPerMillion: 1.5,
    cachedInputPerMillion: 0.025,
  },
  'gemini-2.5-pro': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

/**
 * Google's rolling aliases and the versioned id each serves, measured 2026-10-16
 * by the response's `modelVersion`; re-measure when Google moves them. An alias
 * prices as its target (the target's override, then its row), never as a row of its
 * own; a target that is itself an alias or has no row gets the fallback.
 */
const ALIAS_TARGET: Readonly<Record<string, string>> = {
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
  'gemini-flash-latest': 'gemini-3.8-flash',
  'gemini-flash-lite-latest': 'gemini-3.5-flash-lite',
};

let overrides: Record<string, PricingEntry> | null = null;

function loadOverrides(): Record<string, PricingEntry> | null {
  if (overrides !== null) return overrides;
  const raw = process.env.GEMINI_PRICING_OVERRIDES;
  if (!raw) {
    overrides = {};
    return overrides;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      overrides = parsed as Record<string, PricingEntry>;
    } else {
      overrides = {};
    }
  } catch {
    overrides = {};
  }
  return overrides;
}

/**
 * Conservative defaults for models we've never seen — one for each cost tier
 * the taxonomy assigns, plus an "unknown premium" fallback that assumes the
 * highest rate we know of. The goal is to over-estimate cost for a brand-new
 * model so a budget-capped user gets blocked at the cap instead of silently
 * overshooting it while we wait for a pricing-table update.
 */
const UNKNOWN_PREMIUM_RATE: PricingEntry = { inputPerMillion: 10.5, outputPerMillion: 30 };
const UNKNOWN_FLASH_RATE: PricingEntry = { inputPerMillion: 0.3, outputPerMillion: 2.5 };
const UNKNOWN_LITE_RATE: PricingEntry = { inputPerMillion: 0.1, outputPerMillion: 0.4 };

/**
 * The conservative rate per cost tier, for a model outside the text categories
 * (image, audio, video, agent, unknown): the table prices no such family it could
 * stand for, so a `premium` one gets the highest rate we know of.
 */
const UNKNOWN_RATE_BY_TIER: Readonly<Record<CapabilityFlags['costTier'], PricingEntry>> = {
  premium: UNKNOWN_PREMIUM_RATE,
  standard: UNKNOWN_FLASH_RATE,
  budget: UNKNOWN_LITE_RATE,
  unknown: UNKNOWN_PREMIUM_RATE,
};

/** The cached-input rate a row bills: its own, else the 0.25× input default. */
function cachedRate(row: PricingEntry): number {
  return row.cachedInputPerMillion ?? row.inputPerMillion * 0.25;
}

/**
 * The dearest rate the table knows for each text category, per component (the
 * highest input, output and cached rate of its priced rows): an upper bound for an
 * unpriced model of that category, read from the table instead of a fixed number.
 */
function dearestTextRates(): ReadonlyMap<ModelCategory, PricingEntry> {
  const out = new Map<ModelCategory, PricingEntry>();
  for (const [id, row] of Object.entries(DEFAULT_PRICING)) {
    const category = categorizeModel(id);
    if (!isTextGenCategory(category)) continue;
    const held = out.get(category) ?? row;
    out.set(category, {
      inputPerMillion: Math.max(held.inputPerMillion, row.inputPerMillion),
      outputPerMillion: Math.max(held.outputPerMillion, row.outputPerMillion),
      cachedInputPerMillion: Math.max(cachedRate(held), cachedRate(row)),
    });
  }
  return out;
}

const DEAREST_TEXT_RATES = dearestTextRates();

/** Where a model's price can come from, in the order `pricedRow` reads them. */
export interface PricingSources {
  overrides: Readonly<Record<string, PricingEntry>>;
  aliasTarget: Readonly<Record<string, string>>;
  rows: Readonly<Record<string, PricingEntry>>;
}

/**
 * The priced row for `model`, or `undefined` when the caller's fallback applies:
 * an override of the id itself, then — for an alias — its target's override or row
 * (one hop, no recursion: a target that is an alias prices nothing), else the id's row.
 */
export function pricedRow(model: string, src: PricingSources): PricingEntry | undefined {
  if (src.overrides[model]) return src.overrides[model];
  const target = src.aliasTarget[model];
  if (target === undefined) return src.rows[model];
  if (src.aliasTarget[target] !== undefined) return undefined;
  return src.overrides[target] ?? src.rows[target];
}

function pricingFor(model: string): PricingEntry {
  const sources = {
    overrides: loadOverrides() ?? {},
    aliasTarget: ALIAS_TARGET,
    rows: DEFAULT_PRICING,
  };
  const row = pricedRow(model, sources);
  if (row) return row;
  // An unpriced text model: the dearest rate of its category. Anything else: the
  // conservative rate of its cost tier — a model the taxonomy cannot place gets the
  // premium rate rather than flash: better to block an over-budget user than let a
  // never-seen model silently undercharge and blow past the cap.
  return DEAREST_TEXT_RATES.get(categorizeModel(model)) ?? UNKNOWN_RATE_BY_TIER[costTierOf(model)];
}

export interface CostInputs {
  /** The service tier the call runs on; flex halves the price. */
  serviceTier?: 'standard' | 'flex' | undefined;
  model: string;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
}

/** Google's flex tier is billed at half the standard price for the same model. */
export const FLEX_PRICE_FACTOR = 0.5;

function tierFactor(tier: 'standard' | 'flex' | undefined): number {
  return tier === 'flex' ? FLEX_PRICE_FACTOR : 1;
}

/** Estimated cost in USD (float). Multiply by 1e6 for micros before storing. */
export function estimateCostUsd(input: CostInputs): number {
  const p = pricingFor(input.model);
  const cachedRate = p.cachedInputPerMillion ?? p.inputPerMillion * 0.25;
  const uncached = (input.uncachedInputTokens / 1_000_000) * p.inputPerMillion;
  const cached = (input.cachedInputTokens / 1_000_000) * cachedRate;
  const output = (input.outputTokens / 1_000_000) * p.outputPerMillion;
  // Thinking tokens are currently billed as output tokens on Gemini Pro family.
  const thinking = input.thinkingTokens
    ? (input.thinkingTokens / 1_000_000) * p.outputPerMillion
    : 0;
  return (uncached + cached + output + thinking) * tierFactor(input.serviceTier);
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
  return estimateCostUsd({
    model: input.model,
    serviceTier: input.serviceTier,
    uncachedInputTokens: workspaceTokens + promptTokens + Math.max(0, input.extraInputTokens ?? 0),
    cachedInputTokens: 0,
    outputTokens: Math.max(0, input.expectedOutputTokens),
    ...(input.thinkingTokens !== undefined ? { thinkingTokens: input.thinkingTokens } : {}),
  });
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
