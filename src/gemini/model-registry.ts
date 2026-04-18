/**
 * Lightweight model registry — enumerates models available to the current API key.
 *
 * Results are cached in-process for the lifetime of the server. A manual `reindex`
 * tool call can force a refresh if the user upgrades their API tier mid-session.
 */

import type { GoogleGenAI, Model } from '@google/genai';
import { logger } from '../utils/logger.js';

export interface ModelInfo {
  /** Normalized short ID (e.g. `gemini-3-pro-preview`). */
  id: string;
  /** Full API resource name when present (`models/gemini-3-pro-preview`). */
  resourceName: string;
  displayName: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  supportsThinking: boolean;
  /** Inferred from input limit ≥ 100k — a heuristic for context-cache eligibility. */
  supportsLongContext: boolean;
}

function normalizeId(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/^models\//, '').trim();
}

function toModelInfo(model: Model): ModelInfo | null {
  const id = normalizeId(model.name);
  if (id.length === 0) return null;

  const inputLimit = typeof model.inputTokenLimit === 'number' ? model.inputTokenLimit : null;
  const outputLimit = typeof model.outputTokenLimit === 'number' ? model.outputTokenLimit : null;

  return {
    id,
    resourceName: model.name ?? `models/${id}`,
    displayName: model.displayName ?? id,
    inputTokenLimit: inputLimit,
    outputTokenLimit: outputLimit,
    supportsThinking: model.thinking === true,
    supportsLongContext: inputLimit !== null && inputLimit >= 100_000,
  };
}

let cached: ModelInfo[] | null = null;
let cachedAt = 0;
const TTL_MS = 60 * 60 * 1000;

export async function listAvailableModels(
  client: GoogleGenAI,
  { force }: { force?: boolean } = {},
): Promise<ModelInfo[]> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL_MS) return cached;

  const pager = await client.models.list();
  const out: ModelInfo[] = [];
  for await (const model of pager) {
    const info = toModelInfo(model);
    if (info) out.push(info);
  }

  // Stable ordering — pro → flash → lite → others, then version desc by name.
  out.sort((a, b) => {
    const tierRank = (id: string): number => {
      if (id.includes('pro')) return 0;
      if (id.includes('flash')) return 1;
      if (id.includes('lite')) return 2;
      return 3;
    };
    const ra = tierRank(a.id);
    const rb = tierRank(b.id);
    if (ra !== rb) return ra - rb;
    return b.id.localeCompare(a.id);
  });

  cached = out;
  cachedAt = now;
  logger.debug(`model-registry: loaded ${out.length} models`);
  return out;
}

/** Invalidate the in-process model cache — used by `reindex`. */
export function invalidateModelCache(): void {
  cached = null;
  cachedAt = 0;
}
