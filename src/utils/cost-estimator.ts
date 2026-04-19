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

/**
 * Conservative defaults for models we've never seen — one for each tier we
 * recognise by name, plus an "unknown premium" fallback that assumes the
 * highest rate we know of. The goal is to over-estimate cost for a brand-new
 * model so a budget-capped user gets blocked at the cap instead of silently
 * overshooting it while we wait for a pricing-table update.
 */
const UNKNOWN_PREMIUM_RATE: PricingEntry = { inputPerMillion: 10.5, outputPerMillion: 30 };
const UNKNOWN_PRO_RATE: PricingEntry = { inputPerMillion: 3.5, outputPerMillion: 10.5 };
const UNKNOWN_FLASH_RATE: PricingEntry = { inputPerMillion: 0.3, outputPerMillion: 2.5 };
const UNKNOWN_LITE_RATE: PricingEntry = { inputPerMillion: 0.1, outputPerMillion: 0.4 };

function pricingFor(model: string): PricingEntry {
  const ov = loadOverrides();
  if (ov?.[model]) return ov[model];
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];
  // Fallback heuristic — name-based classification, conservative defaults.
  // When the model name gives no useful signal we assume premium-tier rates
  // rather than flash: better to block an over-budget user than let a
  // never-seen model silently undercharge and blow past the cap.
  const lower = model.toLowerCase();
  if (lower.includes('lite')) return UNKNOWN_LITE_RATE;
  if (lower.includes('flash')) return UNKNOWN_FLASH_RATE;
  if (lower.includes('pro')) return UNKNOWN_PRO_RATE;
  return UNKNOWN_PREMIUM_RATE;
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

export interface PreCallEstimateInputs {
  model: string;
  /** Sum of file sizes in bytes — the workspace content that will be sent. */
  workspaceBytes: number;
  /** Length of the user prompt in chars — tokenised at ~4 bytes/token. */
  promptChars: number;
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
    uncachedInputTokens: workspaceTokens + promptTokens,
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
