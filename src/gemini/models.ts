/**
 * Alias resolution for model selection.
 *
 * Users pass either an alias (`latest-pro`, `latest-flash`, `latest-pro-thinking`,
 * `latest-lite`, `latest-vision`) or a literal model ID (`gemini-3-pro-preview`).
 * We resolve to the best available model for the current API key.
 *
 * v1.4.0: category-based filtering. Each alias declares the set of
 * taxonomy categories it accepts. The resolver picks only from models
 * whose category is in the accepted set — a pro-tier image-gen model
 * (e.g. `nano-banana-pro-preview`) is NO LONGER eligible for
 * `latest-pro-thinking` even if it shares the `pro` token with text-gen
 * models. Literal model IDs ALSO go through a category check against the
 * tool's required category — passing `model: "nano-banana-pro-preview"`
 * to `code` throws `ModelCategoryMismatchError` with an actionable message.
 *
 * See `src/gemini/model-taxonomy.ts` for the category rule set and
 * `docs/models.md` for the user-facing alias → category contract.
 */

import type { GoogleGenAI } from '@google/genai';
import type { ResolvedModel } from '../types.js';
import { logger } from '../utils/logger.js';
import { type ModelInfo, listAvailableModels } from './model-registry.js';
import {
  type CapabilityFlags,
  type ModelCategory,
  ModelCategoryMismatchError,
  categorizeModel,
  extractCapabilityFlags,
} from './model-taxonomy.js';

/**
 * Belt-and-suspenders blocklist retained from v1.2.0. The v1.4.0 taxonomy is
 * the primary mechanism (allowlist-first). If the taxonomy ever mis-classifies
 * a model as text-gen but its ID matches one of these markers, we log and
 * demote it to `unknown` — shouldn't fire in practice with the current rule
 * set but catches taxonomy bugs before they reach production calls.
 */
const NON_TEXT_GEN_MARKERS = [
  'image',
  'tts',
  'vision',
  'audio',
  'banana',
  'lyria',
  'research',
  'customtools',
] as const;

function hasNonTextGenMarker(modelId: string): boolean {
  return NON_TEXT_GEN_MARKERS.some((marker) => modelId.includes(marker));
}

/**
 * User-facing alias contract. Each alias:
 *   - Accepts a set of categories (must be non-empty; tools using this
 *     alias get ONE of these categories back).
 *   - Applies a per-alias capability filter (e.g. thinking).
 *   - Sorts the filtered list to pick the "latest" or "best" for the alias.
 *
 * Aliases do NOT cross category boundaries. `latest-pro` will never return
 * an image-gen model even if the text-reasoning list is empty for the
 * current API key — the resolver throws instead, forcing a clear error.
 */
interface AliasSpec {
  readonly acceptedCategories: readonly ModelCategory[];
  /** Extra per-alias filter (e.g. supportsThinking). Applied AFTER category filter. */
  readonly capabilityFilter?: (flags: CapabilityFlags) => boolean;
  /** Human-readable description for error messages. */
  readonly description: string;
}

const ALIASES = {
  'latest-pro': {
    acceptedCategories: ['text-reasoning'],
    description: 'latest pro-tier text-reasoning model',
  },
  'latest-pro-thinking': {
    acceptedCategories: ['text-reasoning'],
    capabilityFilter: (flags: CapabilityFlags) => flags.supportsThinking,
    description: 'latest pro-tier text-reasoning model with thinking support',
  },
  'latest-flash': {
    acceptedCategories: ['text-fast'],
    description: 'latest flash-tier (fast text-gen) model',
  },
  'latest-lite': {
    acceptedCategories: ['text-lite'],
    description: 'latest lite-tier (budget text-gen) model',
  },
  'latest-vision': {
    acceptedCategories: ['text-reasoning', 'text-fast'],
    capabilityFilter: (flags: CapabilityFlags) => flags.supportsVision,
    description: 'latest vision-capable text-gen model (prefers pro tier)',
  },
} as const satisfies Record<string, AliasSpec>;

export type Alias = keyof typeof ALIASES;

export function isAlias(value: string): value is Alias {
  return value in ALIASES;
}

interface ClassifiedModel extends ModelInfo {
  readonly category: ModelCategory;
  readonly capabilities: CapabilityFlags;
}

function classify(model: ModelInfo): ClassifiedModel {
  let category = categorizeModel(model.id);
  // Belt-and-suspenders: if taxonomy says text-* but the ID contains a
  // known non-text-gen marker, log warning + demote to unknown. Shouldn't
  // fire with current rule set; catches future taxonomy regressions.
  if (
    (category === 'text-reasoning' || category === 'text-fast' || category === 'text-lite') &&
    hasNonTextGenMarker(model.id)
  ) {
    logger.warn(
      `Taxonomy categorised '${model.id}' as '${category}' but its ID contains a non-text-gen marker. Demoting to 'unknown' defensively.`,
    );
    category = 'unknown';
  }
  const capabilities = extractCapabilityFlags(model.id, {
    supportsThinking: model.supportsThinking,
  });
  return { ...model, category, capabilities };
}

function pickForAlias(models: ClassifiedModel[], spec: AliasSpec): ClassifiedModel | undefined {
  return models.find(
    (m) =>
      spec.acceptedCategories.includes(m.category) &&
      (spec.capabilityFilter === undefined || spec.capabilityFilter(m.capabilities)),
  );
}

/**
 * Options for `resolveModel`. Tools pass `requiredCategory` to assert the
 * tool's category contract — the resolver throws `ModelCategoryMismatchError`
 * if the resolved model doesn't satisfy it (even when the user passed a
 * literal model ID). Omit to skip the category check (e.g. internal utility
 * callers).
 */
export interface ResolveModelOptions {
  /**
   * Tool's accepted category set. The resolved model's `category` MUST be
   * in this list. When unset, any category is accepted (back-compat with
   * callers that don't enforce a contract).
   */
  readonly requiredCategory?: readonly ModelCategory[];
}

export async function resolveModel(
  requested: string,
  client: GoogleGenAI,
  options: ResolveModelOptions = {},
): Promise<ResolvedModel> {
  const models = await listAvailableModels(client);
  const classified = models.map(classify);

  const buildResolved = (picked: ClassifiedModel, fallbackApplied: boolean): ResolvedModel => ({
    requested,
    resolved: picked.id,
    fallbackApplied,
    inputTokenLimit: picked.inputTokenLimit,
    outputTokenLimit: picked.outputTokenLimit,
    category: picked.category,
    capabilities: picked.capabilities,
  });

  const enforceCategory = (picked: ClassifiedModel): void => {
    if (
      options.requiredCategory !== undefined &&
      !options.requiredCategory.includes(picked.category)
    ) {
      throw new ModelCategoryMismatchError({
        modelId: picked.id,
        actualCategory: picked.category,
        requiredCategory: options.requiredCategory,
      });
    }
  };

  // === Alias path ===
  if (isAlias(requested)) {
    const spec = ALIASES[requested];
    const picked = pickForAlias(classified, spec);
    if (picked) {
      enforceCategory(picked);
      return buildResolved(picked, false);
    }
    // Alias returned nothing — the API key has no model in the accepted
    // categories for this alias. This is a fail-fast: we do NOT silently
    // fall back to a different alias's category, because that's exactly
    // how image-gen models snuck into code-review calls pre-v1.4.0.
    throw new Error(
      `Alias '${requested}' (${spec.description}) could not be resolved — no model in category [${spec.acceptedCategories.join(' | ')}] is available for this API key. Available categories: ${summariseAvailableCategories(classified)}. Either upgrade your Gemini API tier (https://aistudio.google.com/apikey) or pass a literal model ID matching the tool's required category (see docs/models.md).`,
    );
  }

  // === Literal model ID path ===
  const exact = classified.find((m) => m.id === requested);
  if (exact) {
    enforceCategory(exact);
    return buildResolved(exact, false);
  }

  // Requested literal ID isn't in the registry. Do NOT silently fall back —
  // pre-v1.4.0 this path swapped in `latest-pro` which could resolve to an
  // image-gen model. Throw with an actionable message.
  throw new Error(
    `Model '${requested}' is not available for this API key. Pass an alias (${listAliases().join(', ')}) or a literal ID available on your tier (https://aistudio.google.com/apikey). See docs/models.md for the current lineup.`,
  );
}

function summariseAvailableCategories(models: readonly ClassifiedModel[]): string {
  const counts = new Map<ModelCategory, number>();
  for (const m of models) {
    counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  }
  const entries = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat} (${n})`);
  return entries.length > 0 ? entries.join(', ') : '(none)';
}

export function listAliases(): readonly Alias[] {
  return Object.keys(ALIASES) as Alias[];
}

/**
 * Alias contract for documentation / diagnostics. Stable public API —
 * `docs/models.md` is generated from this surface. Returning a fresh copy
 * per call so consumers can't mutate module state.
 */
export function describeAlias(alias: Alias): {
  readonly acceptedCategories: readonly ModelCategory[];
  readonly description: string;
  readonly requiresThinking: boolean;
  readonly requiresVision: boolean;
} {
  const spec = ALIASES[alias];
  return {
    acceptedCategories: spec.acceptedCategories,
    description: spec.description,
    requiresThinking: alias === 'latest-pro-thinking',
    requiresVision: alias === 'latest-vision',
  };
}
