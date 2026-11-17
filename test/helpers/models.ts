/**
 * Resolved-model fixtures of the Gemini 4 family (what `resolveModel` returns for them): the per-request output
 * limit and the long-decode total the server reads.
 */

import type { ResolvedModel } from '../../src/types.js';

/** Gemini 4 Hydrogen: the fast tier, the model long decode is measured on. */
export const GEMINI_4_HYDROGEN: ResolvedModel = {
  requested: 'gemini-4-hydrogen',
  resolved: 'gemini-4-hydrogen',
  inputTokenLimit: 1_048_576,
  outputTokenLimit: 65_536,
  longDecodeTokenLimit: 1_048_576,
  fallbackApplied: false,
  category: 'text-fast',
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
    supportsCodeExecution: true,
    costTier: 'standard',
  },
  supportsCaching: true,
};

/**
 * Gemini 4 Argon: the reasoning tier, the one `code` runs. `models.list` advertises 32 768 output tokens a request
 * for it (read again by the integration smoke), half of what one streaming request decodes.
 */
export const GEMINI_4_ARGON: ResolvedModel = {
  ...GEMINI_4_HYDROGEN,
  requested: 'gemini-4-argon',
  resolved: 'gemini-4-argon',
  outputTokenLimit: 32_768,
  category: 'text-reasoning',
  capabilities: { ...GEMINI_4_HYDROGEN.capabilities, costTier: 'premium' },
};
