/**
 * Lightweight model registry — enumerates models available to the current API key.
 *
 * Results are cached in-process for the lifetime of the server. A manual `reindex`
 * tool call can force a refresh if the user upgrades their API tier mid-session.
 */

import type { GoogleGenAI, Model } from '@google/genai';
import { logger } from '../utils/logger.js';
import {
  type CapabilityFlags,
  type ModelCategory,
  categorizeModel,
  costTierOf,
} from './model-taxonomy.js';

/**
 * Google's unversioned `-latest` ids (`gemini-pro-latest`, `gemini-flash-latest`,
 * `gemini-flash-lite-latest`) are rolling aliases whose target is older than the
 * newest versioned id (`gemini-pro-latest` points at `gemini-2.5-pro`); the
 * `latest-*` aliases here must pick a versioned model, so these rank after it.
 * An id that carries a version digit is a versioned model whatever its suffix.
 */
function isRollingAlias(id: string): boolean {
  return /-latest$/i.test(id) && !/\d/.test(id);
}

/** Listing rank of each category: the text tiers first, unclassified last. */
const CATEGORY_RANK: Readonly<Record<ModelCategory, number>> = {
  'text-reasoning': 0,
  'text-fast': 1,
  'text-lite': 2,
  agent: 3,
  'image-generation': 4,
  'audio-generation': 5,
  'video-generation': 6,
  embedding: 7,
  unknown: 8,
};

/** Listing rank of each cost tier: the premium tier first, unclassified last. */
const TIER_RANK: Readonly<Record<CapabilityFlags['costTier'], number>> = {
  premium: 0,
  standard: 1,
  budget: 2,
  unknown: 3,
};

interface RankKey {
  readonly category: number;
  readonly tier: number;
  readonly rolling: number;
  /** The id without a trailing `-preview`: a GA model and its preview twin share it. */
  readonly base: string;
  readonly preview: number;
}

function rankKey(id: string): RankKey {
  const base = id.replace(/-preview$/i, '');
  return {
    category: CATEGORY_RANK[categorizeModel(id)],
    tier: TIER_RANK[costTierOf(id)],
    rolling: Number(isRollingAlias(id)),
    base,
    preview: Number(base !== id),
  };
}

/**
 * Listing order: the taxonomy's category (the text tiers first, so the `status`
 * listing leads with what `ask` / `code` can use), its cost tier (premium →
 * standard → budget → unknown), versioned ids before rolling aliases, the base id
 * descending with numeric segments compared as numbers (`3.10` above `3.9`), and a
 * GA id before its `-preview` twin. Category and tier come from the taxonomy, not
 * from a `pro` / `flash` substring, so a codename family (`gemini-4-argon`) ranks
 * with its tier.
 */
function compareListing(ka: RankKey, kb: RankKey): number {
  if (ka.category !== kb.category) return ka.category - kb.category;
  if (ka.tier !== kb.tier) return ka.tier - kb.tier;
  if (ka.rolling !== kb.rolling) return ka.rolling - kb.rolling;
  const byBase = kb.base.localeCompare(ka.base, undefined, { numeric: true });
  if (byBase !== 0) return byBase;
  return ka.preview - kb.preview;
}

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
  /**
   * The model accepts `caches.create` (`supportedActions` lists `createCachedContent`).
   * True when the API gives no action list, so a model is never refused on a missing field.
   */
  supportsCaching: boolean;
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
    supportsCaching: model.supportedActions?.includes('createCachedContent') ?? true,
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

  // Decorate once: the key runs the taxonomy's regexes, so it is built per model, not per comparison.
  const ranked = out.map((info) => ({ info, key: rankKey(info.id) }));
  ranked.sort((a, b) => compareListing(a.key, b.key));
  const sorted = ranked.map((r) => r.info);

  cached = sorted;
  cachedAt = now;
  logger.debug(`model-registry: loaded ${sorted.length} models`);
  return sorted;
}

/** Invalidate the in-process model cache — used by `reindex`. */
export function invalidateModelCache(): void {
  cached = null;
  cachedAt = 0;
}
