/** `ask`'s model and its tier: the first step of a call, before anything is read, counted or reserved. */

import { resolveModel } from '../../gemini/models.js';
import { errorResult } from '../registry.js';
import { ServiceTierError, serviceTierOrRefusal } from '../shared/service-tier.js';
import type { AskCall, AskResolved, StepOutcome } from './call.js';

/**
 * Resolve the model asked for and the call's tier. `ask` accepts all three text-generation tiers — the caller picks
 * through an alias (`latest-pro` / `latest-flash` / `latest-lite` / `latest-vision`) or a literal model id; the
 * resolver refuses a category outside them, so an image, audio or agent model never reaches `generateContent`. A tier
 * the backend refuses ends the call (`SERVICE_TIER_UNSUPPORTED`). The model goes into the call's trail at once: from
 * here a failure seeds a 429's retry hint and reports the resolved tier.
 */
export async function resolveAsk(call: AskCall): Promise<StepOutcome<AskResolved>> {
  const { input, ctx, eager } = call;
  eager.emitter.emit(`resolving model '${call.model}'…`);
  const resolved = await resolveModel(call.model, ctx.client, {
    requiredCategory: ['text-reasoning', 'text-fast', 'text-lite'],
  });
  const serviceTier = serviceTierOrRefusal(input.serviceTier, ctx.config);
  if (serviceTier instanceof ServiceTierError) {
    return {
      end: errorResult(`ask: ${serviceTier.message}`, {
        errorCode: serviceTier.code,
        retryable: false,
        serviceTier: 'flex',
        resolvedModel: resolved.resolved,
      }),
    };
  }
  eager.trail.model = { resolvedModel: resolved.resolved, serviceTier };
  return { next: { ...call, resolved, serviceTier } };
}
