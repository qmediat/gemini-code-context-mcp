/** The Gemini service tier of one call: the per-call value, else the operator default. `flex` is Google's half-price
 * tier (longer latency; a request may be refused under load with 429/503, which this server does NOT retry — the
 * client retries). The tier field for `GenerateContentConfig` is empty on standard, so a standard request is unchanged. */
import { type GenerateContentConfig, ServiceTier } from '@google/genai';

export type ServiceTierName = 'standard' | 'flex';

export function resolveServiceTier(
  perCall: ServiceTierName | undefined,
  operatorDefault: ServiceTierName,
): ServiceTierName {
  return perCall ?? operatorDefault;
}

export function serviceTierConfig(
  tier: ServiceTierName,
): Pick<GenerateContentConfig, 'serviceTier'> {
  return tier === 'flex' ? { serviceTier: ServiceTier.FLEX } : {};
}

/** The error code for a request the tier refused: a 429 or 503 is retryable by the client, nothing else is known. */
export function tierErrorCode(httpStatus: number | undefined): {
  errorCode: string;
  retryable?: boolean;
} {
  if (httpStatus === 429) return { errorCode: 'RATE_LIMITED', retryable: true };
  if (httpStatus === 503) return { errorCode: 'OVERLOADED', retryable: true };
  return { errorCode: 'UNKNOWN' };
}
