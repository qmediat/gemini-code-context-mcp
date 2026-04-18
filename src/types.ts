/**
 * Shared domain types for @qmediat.io/gemini-code-context-mcp.
 */

/** Auth strategies for the Gemini API. */
export type AuthProfile =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'vertex'; project: string; location: string }
  | { kind: 'adc' };

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
