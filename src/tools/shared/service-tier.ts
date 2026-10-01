/** The Gemini service tier of one call: the per-call value, else the operator default. `flex` is Google's half-price
 * tier (longer latency; a request may be refused under load with 429/503, which this server does NOT retry — the
 * client retries). The tier field for `GenerateContentConfig` is empty on standard, so a standard request is unchanged.
 *
 * The Vertex AI backend does not take the tier as a request-body field (js-genai#1468: it needs request headers the
 * SDK does not send), so flex there would be billed standard while this server charged half: a per-call `flex` on
 * Vertex is refused, an operator default of `flex` on Vertex runs standard with a startup warning. */
import { type GenerateContentConfig, ServiceTier } from '@google/genai';
import { parseRetryDelayMs } from './throttle.js';

export type ServiceTierName = 'standard' | 'flex';

/** One text for both tools' `serviceTier` parameter. */
export const SERVICE_TIER_DESCRIPTION =
  "Gemini service tier for this call. `'flex'` is Google's half-price tier (longer latency; a request may be refused under load with 429 or 503, which this server does NOT retry and never re-sends — the result says RATE_LIMIT / OVERLOADED, retryable, and the client retries); `'standard'` is the default. Operator default via env `GEMINI_CODE_CONTEXT_SERVICE_TIER`. The cost estimate and the daily budget use the flex price. Not available on the Vertex AI backend (refused by name).";

export class ServiceTierError extends Error {
  readonly code = 'SERVICE_TIER_UNSUPPORTED';
  constructor(message: string) {
    super(message);
    this.name = 'ServiceTierError';
  }
}

/** The tier of a call: the per-call value wins; on Vertex a per-call `flex` is refused, a default `flex` is standard. */
export function resolveServiceTier(
  perCall: ServiceTierName | undefined,
  operatorDefault: ServiceTierName,
  vertex = false,
): ServiceTierName {
  const tier = perCall ?? operatorDefault;
  if (tier !== 'flex' || !vertex) return tier;
  if (perCall === 'flex') {
    throw new ServiceTierError(
      "serviceTier 'flex' is not available on the Vertex AI backend through this SDK (the request-body field is ignored there, js-genai#1468); use the Gemini API backend or 'standard'",
    );
  }
  return 'standard';
}

/** What goes into `GenerateContentConfig`: nothing on standard, the enum on flex. */
export function serviceTierConfig(
  tier: ServiceTierName,
): Pick<GenerateContentConfig, 'serviceTier'> {
  return tier === 'flex' ? { serviceTier: ServiceTier.FLEX } : {};
}

/** On flex every send is billed and a queued stream may outlive Node's 300 s header wait: the server never re-sends
 * a flex request — one attempt — and reports the failure as retryable for the client. */
export function networkAttempts(tier: ServiceTierName): number {
  return tier === 'flex' ? 1 : 3;
}

/** The HTTP status an SDK error carries, if any. */
export function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export interface TierErrorMeta {
  readonly errorCode: 'RATE_LIMIT' | 'OVERLOADED' | 'UNKNOWN';
  readonly retryable?: boolean;
  /** Google's retry hint on a 429, when it sent one. */
  readonly retryAfterMs?: number;
}

/** The error code of a refused request, whatever the tier: 429 (RATE_LIMIT — the spelling ask_agentic uses) with the
 * retry hint when Google sent one, 503 (OVERLOADED), both retryable by the client; anything else is unknown. */
export function tierErrorMeta(err: unknown): TierErrorMeta {
  const status = statusOf(err);
  if (status === 429) {
    const hint = err instanceof Error ? parseRetryDelayMs(err.message) : null;
    return {
      errorCode: 'RATE_LIMIT',
      retryable: true,
      ...(hint === null ? {} : { retryAfterMs: hint }),
    };
  }
  if (status === 503) return { errorCode: 'OVERLOADED', retryable: true };
  return { errorCode: 'UNKNOWN' };
}
