/**
 * Alias resolution for model selection.
 *
 * Users pass either an alias (`latest-pro`, `latest-flash`, `latest-pro-thinking`)
 * or a literal model ID (`gemini-3-pro-preview`). We resolve to the best available
 * model for the current API key and log if we fell back because the requested
 * model isn't reachable.
 */

import type { GoogleGenAI } from '@google/genai';
import type { ResolvedModel } from '../types.js';
import { logger } from '../utils/logger.js';
import { type ModelInfo, listAvailableModels } from './model-registry.js';

const ALIASES = {
  'latest-pro': (models: ModelInfo[]): ModelInfo | undefined =>
    models.find((m) => m.id.includes('pro') && !m.id.includes('image') && !m.id.includes('tts')),
  'latest-pro-thinking': (models: ModelInfo[]): ModelInfo | undefined =>
    models.find(
      (m) =>
        m.id.includes('pro') &&
        m.supportsThinking &&
        !m.id.includes('image') &&
        !m.id.includes('tts'),
    ) ??
    models.find((m) => m.id.includes('pro') && !m.id.includes('image') && !m.id.includes('tts')),
  'latest-flash': (models: ModelInfo[]): ModelInfo | undefined =>
    models.find(
      (m) =>
        m.id.includes('flash') &&
        !m.id.includes('image') &&
        !m.id.includes('tts') &&
        !m.id.includes('lite'),
    ),
  'latest-lite': (models: ModelInfo[]): ModelInfo | undefined =>
    models.find((m) => m.id.includes('lite') && !m.id.includes('image')),
} as const;

export type Alias = keyof typeof ALIASES;

export function isAlias(value: string): value is Alias {
  return value in ALIASES;
}

export async function resolveModel(requested: string, client: GoogleGenAI): Promise<ResolvedModel> {
  const models = await listAvailableModels(client);

  if (isAlias(requested)) {
    const picked = ALIASES[requested](models);
    if (picked) {
      return {
        requested,
        resolved: picked.id,
        fallbackApplied: false,
        inputTokenLimit: picked.inputTokenLimit,
        outputTokenLimit: picked.outputTokenLimit,
      };
    }
    // Alias matched no model — fall back to first available pro/flash/lite in order.
    const fallback =
      ALIASES['latest-pro'](models) ??
      ALIASES['latest-flash'](models) ??
      ALIASES['latest-lite'](models) ??
      models[0];
    if (!fallback) {
      throw new Error(
        'No models available for the current API key. Check your tier at https://aistudio.google.com/apikey',
      );
    }
    logger.warn(`Alias '${requested}' could not be resolved — falling back to '${fallback.id}'.`);
    return {
      requested,
      resolved: fallback.id,
      fallbackApplied: true,
      inputTokenLimit: fallback.inputTokenLimit,
      outputTokenLimit: fallback.outputTokenLimit,
    };
  }

  // Literal model ID — verify availability or fall back.
  const exact = models.find((m) => m.id === requested);
  if (exact) {
    return {
      requested,
      resolved: exact.id,
      fallbackApplied: false,
      inputTokenLimit: exact.inputTokenLimit,
      outputTokenLimit: exact.outputTokenLimit,
    };
  }

  const fallback = ALIASES['latest-pro'](models) ?? models[0];
  if (!fallback) {
    throw new Error(`Model '${requested}' not available and no fallback could be chosen.`);
  }
  logger.warn(
    `Model '${requested}' not available for this API key — falling back to '${fallback.id}'.`,
  );
  return {
    requested,
    resolved: fallback.id,
    fallbackApplied: true,
    inputTokenLimit: fallback.inputTokenLimit,
    outputTokenLimit: fallback.outputTokenLimit,
  };
}

export function listAliases(): readonly Alias[] {
  return Object.keys(ALIASES) as Alias[];
}
