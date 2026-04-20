/**
 * Runtime config — environment variables + resolved auth profile.
 */

import { type ResolvedAuth, resolveAuth } from './auth/profile-loader.js';

export interface Config {
  auth: ResolvedAuth;
  defaultModel: string;
  dailyBudgetUsd: number;
  cacheTtlSeconds: number;
  /**
   * Minimum estimated workspace tokens required to attempt Context Cache creation.
   * Gemini currently enforces a floor of 1024; below that `caches.create` returns 400.
   * Exposed as a config knob so operators can adjust if Google changes the floor
   * without waiting for a patch release.
   */
  cacheMinTokens: number;
  /** Soft upper bound on files indexed per workspace. */
  maxFilesPerWorkspace: number;
  /** Skip files larger than this (bytes). */
  maxFileSizeBytes: number;
  /** Opt-in anonymous usage telemetry (count per tool, no payloads). */
  telemetryEnabled: boolean;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.length === 0) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  const auth = resolveAuth();

  // Default alias resolves to the newest Pro-class model that advertises
  // `supportsThinking: true`. This gives `ask`/`code` the strongest available
  // reasoning out of the box — users trading quality for cost can override via
  // `GEMINI_CODE_CONTEXT_DEFAULT_MODEL=latest-pro` (or a literal model ID).
  const defaultModel =
    process.env.GEMINI_CODE_CONTEXT_DEFAULT_MODEL ?? auth.defaultModel ?? 'latest-pro-thinking';

  const dailyBudget = readFloatEnv(
    'GEMINI_DAILY_BUDGET_USD',
    auth.dailyBudgetUsd ?? Number.POSITIVE_INFINITY,
  );

  return {
    auth,
    defaultModel,
    dailyBudgetUsd: dailyBudget,
    cacheTtlSeconds: readIntEnv('GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS', 3600),
    cacheMinTokens: readIntEnv('GEMINI_CODE_CONTEXT_CACHE_MIN_TOKENS', 1024),
    maxFilesPerWorkspace: readIntEnv('GEMINI_CODE_CONTEXT_MAX_FILES', 2000),
    maxFileSizeBytes: readIntEnv('GEMINI_CODE_CONTEXT_MAX_FILE_SIZE', 1_000_000),
    telemetryEnabled: process.env.GEMINI_CODE_CONTEXT_TELEMETRY === 'true',
  };
}
