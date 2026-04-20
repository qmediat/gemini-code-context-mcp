/**
 * Model taxonomy — maps Gemini model IDs to functional categories and
 * capability flags, so the resolver can refuse to dispatch (e.g.) a code
 * review to an image-generation model that happens to share the `pro` token
 * with text-gen models.
 *
 * Design principle: **allowlist-first**. Each category has an explicit list
 * of regex patterns. Unrecognised model IDs fall back to `unknown` — the
 * resolver then refuses to bind them to any alias. This is the inverse of
 * the v1.2.0 approach (blocklist of substrings like `banana`, `lyria`,
 * `research`), which required reactive maintenance whenever Google shipped
 * a new non-text-gen family under a `pro`/`flash` token. Allowlist forces
 * a conscious addition of new families rather than silently admitting them.
 *
 * When Google ships a new model family:
 *   1. Update `CATEGORY_RULES` with the canonical pattern → category entry.
 *   2. Update `docs/models.md` with the new row.
 *   3. Ship a patch release — users who haven't upgraded get the `unknown`
 *      path (aliases fail with actionable error, explicit IDs still work
 *      via direct-pass).
 *
 * The blocklist from v1.2.0 (`NON_TEXT_GEN_MARKERS`) is retained in
 * `models.ts` as belt-and-suspenders defence-in-depth — runs AFTER
 * categorisation to catch any bugs that would let a mis-categorised model
 * through. Shouldn't fire in practice.
 */

/**
 * Functional category a model belongs to. Tools bind to required categories
 * (e.g. `code` needs `text-reasoning`); the resolver refuses to return
 * models outside the required set. Unknown category = no alias picks it.
 */
export type ModelCategory =
  | 'text-reasoning'
  | 'text-fast'
  | 'text-lite'
  | 'image-generation'
  | 'audio-generation'
  | 'video-generation'
  | 'embedding'
  | 'agent'
  | 'unknown';

/**
 * Orthogonal capability flags. Multiple can apply to a single model. Used
 * by the resolver to filter WITHIN a category (e.g. `latest-pro-thinking`
 * needs `text-reasoning` + `supportsThinking: true`).
 */
export interface CapabilityFlags {
  readonly supportsThinking: boolean;
  readonly supportsVision: boolean;
  readonly supportsCodeExecution: boolean;
  /** `premium` (pro-tier), `standard` (flash), `budget` (lite). */
  readonly costTier: 'premium' | 'standard' | 'budget' | 'unknown';
}

/**
 * Rule entry: first match wins. Ordered so more-specific patterns run before
 * more-general ones (e.g. `gemini-3-pro-image` must match `image-generation`
 * before the general `gemini-.*-pro` rule classifies it as `text-reasoning`).
 *
 * Patterns are anchored with `^` where reasonable to avoid substring false
 * positives. Case-insensitive matching catches occasional display-name drift.
 */
interface CategoryRule {
  readonly pattern: RegExp;
  readonly category: ModelCategory;
  readonly costTier: CapabilityFlags['costTier'];
}

const CATEGORY_RULES: readonly CategoryRule[] = [
  // === Image generation — MUST come before pro/flash text rules ===
  // `nano-banana-*` is Google's image-gen family (pro/flash tiers), IDs
  // like `nano-banana-pro-preview`. Shares the `pro` token with text models
  // but bills at the image tier (~10× text rates).
  { pattern: /^nano-banana/i, category: 'image-generation', costTier: 'premium' },
  // `*-image` suffix (e.g. `gemini-3-pro-image`) identifies Gemini's native
  // image-output variants.
  { pattern: /-image(?:-|$)/i, category: 'image-generation', costTier: 'premium' },
  // Google's Imagen family — dedicated image generation.
  { pattern: /^imagen-/i, category: 'image-generation', costTier: 'premium' },

  // === Audio generation ===
  // Lyria = Google's music generation family (`lyria-3-pro-preview` etc.).
  { pattern: /^lyria-/i, category: 'audio-generation', costTier: 'premium' },
  // TTS variants — any model with `-tts` suffix or `text-to-speech` in ID.
  { pattern: /-tts(?:-|$)/i, category: 'audio-generation', costTier: 'standard' },
  { pattern: /text-to-speech/i, category: 'audio-generation', costTier: 'standard' },
  // Native-audio variants (`gemini-2.5-flash-native-audio-preview-*`) —
  // dialog-native audio generation. Shares `flash` token with text-gen
  // models; must classify before the flash rule.
  { pattern: /native-audio/i, category: 'audio-generation', costTier: 'standard' },

  // === Video generation ===
  // Veo = Google's video generation family (`veo-3`, `veo-3.1` etc.).
  { pattern: /^veo-/i, category: 'video-generation', costTier: 'premium' },

  // === Embeddings ===
  { pattern: /embedding/i, category: 'embedding', costTier: 'budget' },
  { pattern: /^text-embedding/i, category: 'embedding', costTier: 'budget' },

  // === Agents (not drop-in replaceable) ===
  // Deep Research — a specialised research agent, not a conversational model.
  { pattern: /deep-research/i, category: 'agent', costTier: 'premium' },
  { pattern: /-research(?:-|$)/i, category: 'agent', costTier: 'premium' },
  // `customtools` variants require a `tools` param on every call; mis-used
  // as a conversational model returns errors.
  { pattern: /customtools/i, category: 'agent', costTier: 'premium' },

  // === Text tiers — AFTER all specialisations above ===
  // Lite (budget / smallest). Matches `gemini-3-flash-lite`, `gemini-flash-lite`.
  { pattern: /-lite(?:-|$)/i, category: 'text-lite', costTier: 'budget' },
  { pattern: /flash-lite/i, category: 'text-lite', costTier: 'budget' },
  // Flash (standard speed tier).
  { pattern: /^gemini-.*-flash/i, category: 'text-fast', costTier: 'standard' },
  { pattern: /-flash(?:-|$)/i, category: 'text-fast', costTier: 'standard' },
  // Pro (reasoning / premium tier). Only reaches here if no specialisation
  // above claimed the model.
  { pattern: /^gemini-.*-pro/i, category: 'text-reasoning', costTier: 'premium' },
  { pattern: /-pro(?:-|$)/i, category: 'text-reasoning', costTier: 'premium' },
  { pattern: /^gemini-pro/i, category: 'text-reasoning', costTier: 'premium' },
];

/**
 * Classify a model by ID. Returns `unknown` for any ID that doesn't match
 * an explicit rule — the resolver then refuses to bind this model to any
 * text-* alias, forcing either a patch release (to extend the rules) or
 * an explicit model ID pass-through from the caller.
 */
export function categorizeModel(modelId: string): ModelCategory {
  if (typeof modelId !== 'string' || modelId.length === 0) return 'unknown';
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(modelId)) return rule.category;
  }
  return 'unknown';
}

/**
 * Derive the cost tier from the model ID via the same rule set. When no
 * rule matches, tier is `unknown` — the resolver treats this as
 * ineligible for tiered aliases (`latest-pro`, `latest-flash`, `latest-lite`).
 */
export function costTierOf(modelId: string): CapabilityFlags['costTier'] {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(modelId)) return rule.costTier;
  }
  return 'unknown';
}

/**
 * Extract capability flags from the model ID plus any metadata already
 * available (supportsThinking is surfaced by `@google/genai`'s `models.list`,
 * vision / code-execution are inferred from ID patterns since the SDK
 * doesn't advertise them consistently).
 */
export function extractCapabilityFlags(
  modelId: string,
  sdkMetadata: { readonly supportsThinking: boolean },
): CapabilityFlags {
  return {
    supportsThinking: sdkMetadata.supportsThinking,
    // Most current Gemini text models accept image input (multimodal by
    // default). Only *-lite variants and embedding models don't. Heuristic
    // matches Google's documented vision support table as of 2026-04.
    supportsVision:
      categorizeModel(modelId) !== 'embedding' &&
      categorizeModel(modelId) !== 'audio-generation' &&
      categorizeModel(modelId) !== 'video-generation' &&
      !/-lite(?:-|$)/i.test(modelId),
    // Code execution is an explicit tool flag on generateContent; all
    // current Gemini 2.5+/3.x text models support it. Exclude image /
    // audio / video variants and embeddings.
    supportsCodeExecution:
      categorizeModel(modelId) === 'text-reasoning' ||
      categorizeModel(modelId) === 'text-fast' ||
      categorizeModel(modelId) === 'text-lite',
    costTier: costTierOf(modelId),
  };
}

/**
 * True iff `category` is one of the three text-gen tiers — the categories
 * that `ask` / `code` tools accept for their resolver calls. Used by the
 * resolver to validate `requiredCategory` against our tool surface.
 */
export function isTextGenCategory(category: ModelCategory): boolean {
  return category === 'text-reasoning' || category === 'text-fast' || category === 'text-lite';
}

/**
 * Error thrown when a resolver call requests a category that the resolved
 * model does NOT satisfy. Actionable message: tells the caller what the
 * resolved model's category actually is and which categories the tool
 * accepts, so they can either pick a different model or file an issue if
 * they believe the taxonomy is wrong.
 */
export class ModelCategoryMismatchError extends Error {
  readonly modelId: string;
  readonly actualCategory: ModelCategory;
  readonly requiredCategory: readonly ModelCategory[];

  constructor(options: {
    modelId: string;
    actualCategory: ModelCategory;
    requiredCategory: readonly ModelCategory[];
  }) {
    const required = options.requiredCategory.join(' | ');
    super(
      `Model '${options.modelId}' is in category '${options.actualCategory}', but this tool requires: ${required}. Pass a model with a compatible category (e.g. 'latest-pro' or a literal model ID from docs/models.md). If you believe '${options.modelId}' is mis-categorised, file an issue at https://github.com/qmediat/gemini-code-context-mcp/issues.`,
    );
    this.name = 'ModelCategoryMismatchError';
    this.modelId = options.modelId;
    this.actualCategory = options.actualCategory;
    this.requiredCategory = options.requiredCategory;
    Object.setPrototypeOf(this, ModelCategoryMismatchError.prototype);
  }
}
