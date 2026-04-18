/**
 * Runtime config — environment variables + resolved auth profile.
 */

import { type ResolvedAuth, resolveAuth } from './auth/profile-loader.js';

export interface Config {
  auth: ResolvedAuth;
  defaultModel: string;
  dailyBudgetUsd: number;
  cacheTtlSeconds: number;
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

  const defaultModel =
    process.env.GEMINI_CODE_CONTEXT_DEFAULT_MODEL ?? auth.defaultModel ?? 'latest-pro';

  const dailyBudget = readFloatEnv(
    'GEMINI_DAILY_BUDGET_USD',
    auth.dailyBudgetUsd ?? Number.POSITIVE_INFINITY,
  );

  return {
    auth,
    defaultModel,
    dailyBudgetUsd: dailyBudget,
    cacheTtlSeconds: readIntEnv('GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS', 3600),
    maxFilesPerWorkspace: readIntEnv('GEMINI_CODE_CONTEXT_MAX_FILES', 2000),
    maxFileSizeBytes: readIntEnv('GEMINI_CODE_CONTEXT_MAX_FILE_SIZE', 1_000_000),
    telemetryEnabled: process.env.GEMINI_CODE_CONTEXT_TELEMETRY === 'true',
  };
}
