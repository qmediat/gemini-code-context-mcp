/**
 * Approximate cost estimator for reporting (not billing authoritative).
 *
 * Rates are per million tokens and reflect public Gemini API pricing as of
 * 2026-04. Update when Google changes pricing; values can also be overridden
 * at runtime via `GEMINI_PRICING_OVERRIDES` (JSON).
 */

export interface PricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cached tokens are billed at a reduced rate. Optional — falls back to 0.25× input. */
  cachedInputPerMillion?: number;
}

const DEFAULT_PRICING: Record<string, PricingEntry> = {
  // Conservative defaults — if the actual rate is lower, users see a pleasant surprise.
  'gemini-3-pro-preview': { inputPerMillion: 3.5, outputPerMillion: 10.5 },
  'gemini-3.1-pro-preview': { inputPerMillion: 3.5, outputPerMillion: 10.5 },
  'gemini-3-flash-preview': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-3.1-flash-image-preview': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-3.1-flash-lite-preview': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-2.5-pro': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
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

function pricingFor(model: string): PricingEntry {
  const ov = loadOverrides();
  if (ov?.[model]) return ov[model];
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];
  // Fallback heuristic: pro-class if name contains 'pro', otherwise flash-class.
  if (model.includes('pro')) return { inputPerMillion: 3.5, outputPerMillion: 10.5 };
  if (model.includes('lite')) return { inputPerMillion: 0.1, outputPerMillion: 0.4 };
  return { inputPerMillion: 0.3, outputPerMillion: 2.5 };
}

export interface CostInputs {
  model: string;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
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
  return uncached + cached + output + thinking;
}

export function toMicrosUsd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
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
