/**
 * The steps of an `ask` call before its count: the model and its tier, then the scan and the refusals over it. Nothing
 * is counted by the preflight or reserved yet.
 */

import { thinkingBudgetRefusal } from '../../gemini/long-decode.js';
import { resolveModel } from '../../gemini/models.js';
import { errorResult } from '../registry.js';
import type { StepOutcome } from '../shared/eager-call.js';
import { eagerOutputCap, estimateInput, scanForCall } from '../shared/eager-steps.js';
import { ServiceTierError, serviceTierOrRefusal } from '../shared/service-tier.js';
import { inlineRequestRefusal } from './attachments.js';
import type { AskAttached, AskCall, AskResolved, AskScanned } from './call.js';

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

/**
 * Scan the workspace, then the refusals that need the scan and cost nothing: a positive `thinkingBudget` that leaves
 * no answer reserve under the caller's own cap (`thinkingBudgetRefusal`; the budget on the wire is clamped under the
 * cap that runs later), and an inline request over Google's size limit (only with attachments). The input estimate is
 * the one the budget and the TPM reservations both hold.
 */
export async function scanAsk(call: AskAttached): Promise<StepOutcome<AskScanned>> {
  const { input, ctx, attachments } = call;
  const scan = await scanForCall(call.eager, ctx, input);
  const outputCap = eagerOutputCap(input.maxOutputTokens, ctx, call.resolved);
  const budgetRefusal = thinkingBudgetRefusal(
    input.thinkingBudget,
    input.maxOutputTokens,
    outputCap.effective,
  );
  if (budgetRefusal !== null) return { end: errorResult(`ask: ${budgetRefusal}`) };
  const estimate = estimateInput(scan, input.prompt, attachments.tokens);
  const inlineRefusal = inlineRequestRefusal(
    attachments,
    scan.files,
    input.prompt,
    call.serviceTier,
  );
  if (inlineRefusal !== undefined) return { end: inlineRefusal };
  return { next: { ...call, scan, outputCap, estimate } };
}
