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
  /**
   * When `true`, `ask` and `code` tools send `maxOutputTokens =
   * modelOutputLimit` on every `generateContent` call (instead of omitting
   * the field and relying on Gemini's model-default). Use this in MCP host
   * configs where you want every call to run at the model's full output
   * capacity — primary use case is code review that routinely produces
   * long OLD/NEW diff blocks. Per-call `input.maxOutputTokens` still
   * overrides (caller can cap a specific call lower). Default `false`
   * (auto — Gemini decides response length based on query complexity).
   * Controlled by `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT` env var.
   */
  forceMaxOutputTokens: boolean;
  /**
   * v1.13.0+: when `true`, every `ask` / `code` call bypasses the scan memo
   * and re-hashes every file in the workspace. The scan memo (default
   * behaviour) skips per-file SHA256 when `mtime_ms` and `size` match the
   * previously-stored values — typically ~95% of files on a warm rescan.
   * Per-call `input.forceRescan` is ORed with this flag; either one being
   * `true` forces a fresh hash. Default `false`. Controlled by env var
   * `GEMINI_CODE_CONTEXT_FORCE_RESCAN`. Use this if you've observed scan
   * results going stale after filesystem mutations outside the dev workflow.
   */
  forceRescan: boolean;
  /**
   * Client-side TPM (tokens-per-minute) throttle ceiling, per resolved model.
   * `0` disables the throttle entirely; positive integer caps how many input
   * tokens (cached + uncached) we'll let fly to Gemini inside any 60-second
   * window before delaying the next call. Default `80_000` leaves ~20%
   * headroom under Gemini's observed Tier 1 paid limit of 100_000 tokens/min
   * for Gemini 3 Pro; raise if your key is on a higher tier, lower if you
   * share a quota pool with another app. See `src/tools/shared/throttle.ts`
   * for the reservation protocol and `docs/FOLLOW-UP-PRS.md` T22 for the
   * full rationale.
   */
  tpmThrottleLimit: number;
  /**
   * Pre-flight workspace size guard — fraction of the resolved model's
   * `inputTokenLimit` that `estimatedInputTokens` (workspace bytes / 4 +
   * prompt chars / 4) may fill before the tool fail-fasts with
   * `WORKSPACE_TOO_LARGE`. Default `0.9` leaves ~10% headroom for the
   * tokeniser drift against our `bytes/4` heuristic (known to underestimate
   * on UTF-8 / CJK content — see `docs/FOLLOW-UP-PRS.md` T17).
   *
   * Clamped to `[0.5, 0.98]` defensively: a typo like `9` or `0.05` won't
   * silently disable the guard (`> 1` semantic) nor make the tool
   * effectively unusable (`≤ 0`). Operators on calm networks who trust
   * the tokeniser can push to `0.95`; those on high-variance environments
   * may drop to `0.8`.
   *
   * Empirically discovered v1.5.0 via debug-shadow trace on the a mid-size project
   * workspace (1.7M tokens vs a 1M context window): pre-fix MCP dispatched
   * the request anyway, got Gemini `400 INVALID_ARGUMENT`, subagent
   * interpreted as retryable → retry storm → `agent exhausted budget`.
   * Cheap client-side preflight prevents the entire failure class.
   *
   * Set via `GEMINI_CODE_CONTEXT_WORKSPACE_GUARD_RATIO`.
   */
  workspaceGuardRatio: number;
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

/**
 * Parse a boolean env var permissively. Accepts `true`/`1`/`yes`/`on`
 * case-insensitively as `true`; everything else (including unset) is `false`.
 * Strict equality to `'true'` (our pre-v1.4.0 pattern) surprised operators
 * who copied values like `TRUE` / `1` from other docs.
 */
function readBoolEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
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

  // TPM throttle: clamp to a non-negative integer. Negative / non-finite
  // env values (`-1`, `"foo"`) fall back to the 80k default rather than
  // silently disabling the throttle — operator intent when setting an
  // invalid value is almost certainly "use the default", not "turn it off"
  // (which has its own explicit `0` sentinel).
  const tpmThrottleRaw = readIntEnv('GEMINI_CODE_CONTEXT_TPM_THROTTLE_LIMIT', 80_000);
  const tpmThrottleLimit = tpmThrottleRaw >= 0 ? tpmThrottleRaw : 80_000;

  // Workspace guard ratio: default 0.9, clamped to [0.5, 0.98]. A typo like
  // `9` (intending 90% but missing the decimal) lands above 1.0 where it
  // would silently disable the guard — clamp prevents that. Values below
  // 0.5 would over-reject workspaces on normal models and are almost always
  // a mis-copy; clamp floors them too. Falls back to 0.9 when env is unset
  // or non-numeric.
  const guardRaw = readFloatEnv('GEMINI_CODE_CONTEXT_WORKSPACE_GUARD_RATIO', 0.9);
  const workspaceGuardRatio = Math.min(0.98, Math.max(0.5, guardRaw));

  return {
    auth,
    defaultModel,
    dailyBudgetUsd: dailyBudget,
    cacheTtlSeconds: readIntEnv('GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS', 3600),
    cacheMinTokens: readIntEnv('GEMINI_CODE_CONTEXT_CACHE_MIN_TOKENS', 1024),
    maxFilesPerWorkspace: readIntEnv('GEMINI_CODE_CONTEXT_MAX_FILES', 2000),
    maxFileSizeBytes: readIntEnv('GEMINI_CODE_CONTEXT_MAX_FILE_SIZE', 1_000_000),
    telemetryEnabled: readBoolEnv('GEMINI_CODE_CONTEXT_TELEMETRY'),
    tpmThrottleLimit,
    workspaceGuardRatio,
    forceMaxOutputTokens: readBoolEnv('GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT'),
    forceRescan: readBoolEnv('GEMINI_CODE_CONTEXT_FORCE_RESCAN'),
  };
}
