/**
 * Shared domain types for @qmediat.io/gemini-code-context-mcp.
 */

/** Auth strategies for the Gemini API. */
export type AuthProfile =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'vertex'; project: string; location: string };

/** Resolved model info returned from the registry. */
export interface ResolvedModel {
  /** Alias the user requested (e.g. `latest-pro`) or literal ID. */
  requested: string;
  /** Actual model ID to send to Gemini API. */
  resolved: string;
  /** True if we had to fall back because the requested model was unavailable. */
  fallbackApplied: boolean;
  /** Input token limit advertised by the model. */
  inputTokenLimit: number | null;
  /** Output token limit advertised by the model. */
  outputTokenLimit: number | null;
  /**
   * Functional taxonomy classification of the resolved model. Tools bind
   * to a required category via `resolveModel(..., { requiredCategory })`
   * and the resolver refuses to return models outside that category.
   * See `docs/models.md` for the category table and guidance on picking
   * aliases by tool.
   */
  category: import('./gemini/model-taxonomy.js').ModelCategory;
  /**
   * Orthogonal capability flags (thinking / vision / code execution /
   * cost tier). Multiple can apply to a single model.
   */
  capabilities: import('./gemini/model-taxonomy.js').CapabilityFlags;
}

/** Canonical workspace row stored in the manifest DB. */
export interface WorkspaceRow {
  workspaceRoot: string;
  filesHash: string;
  model: string;
  systemPromptHash: string;
  cacheId: string | null;
  cacheExpiresAt: number | null;
  fileIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Per-file row stored in the manifest DB. */
export interface FileRow {
  workspaceRoot: string;
  relpath: string;
  contentHash: string;
  fileId: string | null;
  uploadedAt: number | null;
  expiresAt: number | null;
  /**
   * File mtime in ms (v1.13.0+). Used by the scan memo to skip re-hashing
   * when both `mtime_ms` and `size` match the previously-stored values.
   * `null` for rows written before v1.13.0 — those rows always re-hash on
   * the next scan.
   */
  mtimeMs?: number | null;
  /**
   * File size in bytes (v1.13.0+). Used alongside `mtimeMs` as a second
   * gate for the scan memo — guards the (rare) case where two edits within
   * a 1-second `mtime` resolution window leave the same `mtime` but different
   * content.
   */
  size?: number | null;
}

/** Usage metric row for cost reporting. */
export interface UsageMetricRow {
  workspaceRoot: string;
  toolName: string;
  model: string | null;
  cachedTokens: number | null;
  uncachedTokens: number | null;
  costUsdMicro: number | null;
  durationMs: number;
  occurredAt: number;
  /**
   * Caching mode used for this call (v1.13.0+).
   * - `'explicit'`: Gemini Context Cache built/reused via `caches.create`.
   * - `'implicit'`: skipped explicit cache; content sent inline; relies on
   *   Gemini 2.5+/3 Pro's automatic implicit caching.
   * - `'inline'`: forced-inline path — caller requested explicit but
   *   `prepareContext` couldn't honour it (e.g. `code({ codeExecution: true })`
   *   forbids `cachedContent` + `tools` simultaneously, or the workspace was
   *   below `cacheMinTokens`). Recorded distinctly so the implicit-cache
   *   adoption telemetry (FN2 fix in v1.13.0 round-2) doesn't double-count
   *   forced-inline calls as `'explicit'`.
   * - `null`: rows written before v1.13.0 (no caching-mode column) — treated
   *   as `'explicit'` for backwards-compat aggregations.
   */
  cachingMode?: 'explicit' | 'implicit' | 'inline' | null;
  /**
   * Tokens served from Gemini's cache (explicit OR implicit) on this call,
   * as reported by `usage_metadata.cachedContentTokenCount` (v1.13.0+).
   * Used by the `status` tool to compute cache-hit rate. `null` for rows
   * written before v1.13.0.
   */
  cachedContentTokenCount?: number | null;
}

/** Metadata attached to tool responses so Claude Code can show stats. */
export interface CallMetadata {
  resolvedModel: string;
  contextWindow: number | null;
  cachedTokens: number;
  uncachedTokens: number;
  costEstimateUsd: number;
  cacheHit: boolean;
  durationMs: number;
}
