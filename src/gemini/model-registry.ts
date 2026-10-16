/**
 * Lightweight model registry — enumerates models available to the current API key.
 *
 * Results are cached in-process for the lifetime of the server. A manual `reindex`
 * tool call can force a refresh if the user upgrades their API tier mid-session.
 */

import type { GoogleGenAI, Model } from '@google/genai';
import { logger } from '../utils/logger.js';
import { type CapabilityFlags, costTierOf } from './model-taxonomy.js';

/**
 * Google's `gemini-*-latest` ids are rolling aliases whose target is older than
 * the newest versioned id (`gemini-pro-latest` points at `gemini-2.5-pro`); the
 * `latest-*` aliases here must pick a versioned model, so these rank after it.
 */
function isRollingAlias(id: string): boolean {
  return /-latest$/i.test(id);
}

/** Listing rank of each cost tier: the premium tier first, unclassified last. */
const TIER_RANK: Readonly<Record<CapabilityFlags['costTier'], number>> = {
  premium: 0,
  standard: 1,
  budget: 2,
  unknown: 3,
};

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

  // Stable ordering — the taxonomy's cost tier (premium → standard → budget →
  // unknown), then versioned ids before rolling `-latest` aliases, then version
  // desc by name. The tier comes from the taxonomy, not from a `pro` / `flash`
  // substring, so a codename family (`gemini-4-argon`) ranks with the tier it
  // belongs to and `latest-*` picks it by its version.
  out.sort((a, b) => {
    const ra = TIER_RANK[costTierOf(a.id)];
    const rb = TIER_RANK[costTierOf(b.id)];
    if (ra !== rb) return ra - rb;
    const aa = Number(isRollingAlias(a.id));
    const ab = Number(isRollingAlias(b.id));
    if (aa !== ab) return aa - ab;
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
