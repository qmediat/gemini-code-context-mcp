/**
 * `ask` tool — Q&A / long-context analysis against a workspace.
 *
 * Uses the Persistent Context Cache when available, reducing repeat-query cost
 * and latency. First call on a workspace: ~30–45 s (upload + build). Subsequent
 * calls with unchanged files: ~2–3 s.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Content, GenerateContentConfig, ThinkingConfig, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { isStaleCacheError, markCacheStale, prepareContext } from '../cache/cache-manager.js';
import { resolveModel } from '../gemini/models.js';
import { abortableSleep, withNetworkRetry } from '../gemini/retry.js';
import { type PreflightTokenResult, countForPreflight } from '../gemini/token-counter.js';
import { buildScanMemo, scanWorkspace } from '../indexer/workspace-scanner.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../indexer/workspace-validation.js';
import { estimateCostUsd, estimatePreCallCostUsd, toMicrosUsd } from '../utils/cost-estimator.js';
import { logger, safeForLog } from '../utils/logger.js';
import { createProgressEmitter } from '../utils/progress.js';
import { type AskAgenticInput, askAgenticTool } from './ask-agentic.tool.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';
import { createTimeoutController, getTimeoutKind, isTimeoutAbort } from './shared/abort-timeout.js';
import { type CollectedResponse, collectStream } from './shared/stream-collector.js';
import { THINKING_LEVELS, THINKING_LEVEL_RESERVE } from './shared/thinking.js';
import { isGemini429, parseRetryDelayMs } from './shared/throttle.js';

const SYSTEM_INSTRUCTION_Q_AND_A =
  'You are a senior software engineer analysing a codebase. Be precise, reference specific file paths and line numbers, and cite evidence from the provided files rather than guessing. If the answer is not derivable from the context, say so.';

/**
 * Fallback output cap used only when the resolved model doesn't advertise
 * an `outputTokenLimit` via `models.list()`. Set generously at the current
 * Gemini pro-tier ceiling so the default behaviour is "let the model use
 * its full trained capacity" — per v1.4.0 user feedback, arbitrary
 * internal caps below the model's advertised limit are unhelpful
 * self-limiting. Callers who want tighter caps for specific calls pass
 * `maxOutputTokens` explicitly in the tool input.
 */
const ASK_MAX_OUTPUT_TOKENS_FALLBACK = 65_536;

/**
 * Sentinel value in our internal normalisation for "user did not pass
 * thinkingBudget". We translate this into an OMITTED `thinkingBudget`
 * field on the wire — Gemini then uses each model's native default, which
 * per Google's Gemini 3 guide (https://ai.google.dev/gemini-api/docs/gemini-3)
 * is HIGH-dynamic on Gemini 3 Pro. Google flags explicit `thinkingBudget`
 * as the "legacy" path on Gemini 3 ("may result in unexpected performance"),
 * and we empirically observed Gemini 3 Pro hanging on low positive budgets
 * with cached content active (see docs/KNOWN-DEFICITS.md). Omitting the
 * field sidesteps both issues while still letting power users opt into
 * explicit budgets on Gemini 2.5 or for cost-bounded deep-dives.
 */
const THINKING_BUDGET_MODEL_DEFAULT = null;

// `THINKING_LEVELS` + `THINKING_LEVEL_RESERVE` live in `./shared/thinking.ts`
// so both `ask` and `code` share a single source of truth — when Google
// publishes per-tier token budgets, one edit propagates to both tools.

export const askInputSchema = z
  .object({
    prompt: z.string().min(1).describe('The question or analysis request.'),
    workspace: z
      .string()
      .optional()
      .describe('Absolute or cwd-relative path to the workspace. Defaults to process.cwd().'),
    model: z
      .string()
      .optional()
      .describe(
        "Model alias ('latest-pro', 'latest-pro-thinking', 'latest-flash', 'latest-lite', 'latest-vision') or literal model ID. Defaults to the configured default.",
      ),
    includeGlobs: z
      .array(z.string())
      .optional()
      .describe('Additional file extensions or filenames to include.'),
    excludeGlobs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional patterns to exclude. Supports three shapes: (1) directory names or path prefixes (`node_modules`, `src/vendor`, `./dist/`, `.vercel/`), (2) literal filenames exact-match, including bare dot-prefixed names (`pr27-diff.txt`, `foo.bar.baz`, `.env`, `.map`, `.tsbuildinfo`), (3) extension globs that match via endsWith (`*.tsbuildinfo`, `*.map`). Bare dot-prefixed names like `.env` are treated as exact filename literals — write `*.env` for extension semantics. Paths are POSIX-normalised (backslashes → `/`, leading `./` and trailing `/` stripped). Case-insensitive. No mid-string `*` / `**` / `?` — split into dir + extension patterns if needed.',
      ),
    noCache: z
      .boolean()
      .optional()
      .describe('Skip the context cache and embed files inline (slower, more expensive).'),
    thinkingBudget: z
      .number()
      .int()
      .min(-1)
      .max(65_536)
      .optional()
      .describe(
        "Explicit reasoning-token cap. OMIT to use each model's native default — recommended on Gemini 3 (Google flags explicit `thinkingBudget` as 'legacy'). Pass a value only when you need a specific cap: `-1` = legacy dynamic, `0` = disable thinking (rejected by Gemini 3 Pro), positive integer = fixed cap. CAVEAT on Gemini 3 Pro: low positive values (empirically ≤256 with cached content) can cause the API to hang — use `-1` or ≥4096 if you must bound it there. For discrete-tier control on Gemini 3 use `thinkingLevel` instead — the two are mutually exclusive.",
      ),
    thinkingLevel: z
      .enum(THINKING_LEVELS)
      .optional()
      .describe(
        "Discrete reasoning tier for Gemini 3 family models — Google's recommended knob on those (ai.google.dev/gemini-api/docs/gemini-3). Values: `MINIMAL` (Flash-Lite only), `LOW`, `MEDIUM`, `HIGH` (Gemini 3 Pro's default). Gemini 2.5 models do NOT support this — use `thinkingBudget` instead. Mutually exclusive with `thinkingBudget`: passing both returns a validation error before we even hit Gemini (Gemini itself also rejects with 400 'cannot use both thinking_level and the legacy thinking_budget parameter').",
      ),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Per-call opt-in cap on response length (tokens). OMIT for the default 'auto' behaviour — Gemini uses its model-default cap (per Google docs, equal to the model's advertised `outputTokenLimit`: 65,536 for Gemini 3.x / 2.5 Pro-tier; see ai.google.dev/gemini-api/docs/models/gemini-2.5-pro). Pass a smaller value when you want a bounded response (e.g. strict summary length, tighter budget per call). Values larger than the resolved model's limit are clamped down. Budget reservation always uses the effective cap (explicit OR model limit) as worst-case, so `GEMINI_DAILY_BUDGET_USD` stays a true upper bound.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .optional()
      .describe(
        'Per-call wall-clock TOTAL timeout in ms (1s–30min). The cost ceiling — aborts the in-flight `generateContent` request even if it is actively streaming. Gemini still finishes server-side and bills tokens for completed work. When omitted, falls back to env var `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`, then to disabled. v1.12.0 RECOMMENDATION: prefer `stallMs` for liveness — `timeoutMs` is the cost cap, `stallMs` is the heartbeat-aware liveness watchdog that does NOT fire while the model is actively thinking. Both can be set simultaneously. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "total"` on abort.',
      ),
    stallMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe(
        'Per-call HEARTBEAT-AWARE stall watchdog in ms (1s–10min, v1.12.0+). Resets on every chunk (text or thought) — fires ONLY when the stream goes silent for this long. Does NOT fire while the model is actively thinking — the streaming heartbeat (every ~1500ms via `onThoughtChunk`) keeps the watchdog reset. This is the right knob for "kill dead sockets quickly without penalising deep reasoning." Recommended setting: `60_000` (60s) — Gemini Pro can pause 15-30s mid-reasoning between thought chunks under heavy thinking; 60s absorbs jitter while still killing truly dead sockets ~30× faster than the wall-clock alternative. When omitted, falls back to env var `GEMINI_CODE_CONTEXT_ASK_STALL_MS`, then to disabled. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "stall"` on abort. Independent of `timeoutMs` — both can be set; whichever fires first wins.',
      ),
    preflightMode: z
      .enum(['heuristic', 'exact', 'auto'])
      .optional()
      .describe(
        "Token-count strategy for the WORKSPACE_TOO_LARGE preflight (v1.10.0+). `'heuristic'` = bytes/4 fast estimate (skips API call; coarse — undercounts dense Unicode by 30-50%). `'exact'` = always call Gemini's `countTokens` (free, no quota share with `generateContent`; ~hundreds of ms per call; cached per (filesHash + prompt + model) — `filesHash` is post-glob-filter so changing globs that resolve to different files invalidates automatically). `'auto'` (default, recommended) = heuristic when the workspace is well under 50% of the model's input limit; exact when near the cliff where accuracy matters. Use `'exact'` in CI / tests where you want predictable, accurate behaviour regardless of size.",
      ),
    cachingMode: z
      .enum(['explicit', 'implicit'])
      .optional()
      .describe(
        "Cache strategy for the workspace context (v1.13.0+). `'explicit'` (default) builds a Gemini Context Cache via `caches.create` — guaranteed ~75% discount on cached input tokens, but pays a 60–180 s rebuild cost whenever any file changes. `'implicit'` skips the explicit cache entirely; file content is sent inline every call and Gemini 2.5+/3 Pro applies its automatic implicit caching on the repeated workspace prefix when prefix matches across calls. **Best fit for review→edit→review workflows** (no rebuild wait when files change between queries) at the cost of probabilistic rather than guaranteed savings — Gemini's docs note 'no cost saving guarantee' for implicit caching. Hit rate is observable via `status.structuredContent.caching.implicitHitRate`. The default may flip to `'implicit'` in v1.14.0 pending dogfood telemetry.",
      ),
    forceRescan: z
      .boolean()
      .optional()
      .describe(
        'Bypass the v1.13.0 scan memo and re-hash every file in the workspace (default `false`). The scan memo skips per-file SHA256 when `mtime_ms` and `size` match the previously-stored values — typically ~95% of files on a warm rescan, cutting scan wall-clock by ≥10× on large workspaces. Set this when you suspect the manifest is stale (e.g. files mutated outside the dev workflow, NTP clock-skew, or you ran `git checkout` on a directory tree). Equivalent to setting env `GEMINI_CODE_CONTEXT_FORCE_RESCAN=true` for a single call.',
      ),
    onWorkspaceTooLarge: z
      .enum(['error', 'fallback-to-agentic'])
      .optional()
      .describe(
        "Behaviour when the v1.5.0 preflight detects the workspace exceeds the model's `inputTokenLimit × workspaceGuardRatio` (v1.11.0+). `'error'` (default — preserves v1.5.0 behaviour) returns a structured `errorCode: 'WORKSPACE_TOO_LARGE'` and lets the caller decide how to recover. `'fallback-to-agentic'` opt-in: the server transparently re-routes through `ask_agentic` (sandboxed file-access loop — no eager upload, scales to arbitrarily large repos), wraps the agentic result, and surfaces `fallbackApplied: 'ask_agentic'` in `structuredContent` so callers can audit the swap. **Semantic divergence:** `ask_agentic` runs as a multi-iteration loop, so `timeoutMs` (ask's wall-clock cap) translates to `iterationTimeoutMs` (per-iteration cap); total wall-clock can be N × timeoutMs. Cost shape also changes (multiple smaller calls vs one big eager call). Recommended setting for orchestrators that prioritise getting an answer over a single round-trip; default stays `'error'` so existing callers see no behaviour change. **`code` does NOT support this field** — `code`'s OLD/NEW edit format is load-bearing for Claude's Edit pipeline, and `ask_agentic` returns prose only.",
      ),
  })
  .refine((data) => !(data.thinkingBudget !== undefined && data.thinkingLevel !== undefined), {
    message:
      'Cannot specify both `thinkingBudget` and `thinkingLevel` — they are mutually exclusive. Gemini rejects the combination with 400. Choose one: `thinkingLevel` (recommended for Gemini 3) or `thinkingBudget` (required on Gemini 2.5).',
    // `path: []` (root-level error) reflects that the violation is the
    // RELATION between two fields, not a problem with either field
    // individually. MCP clients that render per-field errors won't
    // misattribute the issue to `thinkingLevel` alone.
    path: [],
  });

export type AskInput = z.infer<typeof askInputSchema>;

export const askTool: ToolDefinition<AskInput> = {
  name: 'ask',
  title: 'Ask Gemini',
  description:
    'Ask Gemini a question in the context of your workspace. Uses persistent Context Caching so repeat queries are ~20× faster and cheaper than re-sending the codebase each time.',
  schema: askInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    const model = input.model ?? ctx.config.defaultModel;
    return executeAskBody(input, ctx, workspaceRoot, model, started);
  },
};

async function executeAskBody(
  input: AskInput,
  ctx: Parameters<typeof askTool.execute>[1],
  workspaceRoot: string,
  model: string,
  started: number,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  let reservationId: number | null = null;
  // `-1` signals "no reservation held" (distinct from 0 which is a valid
  // releaseId). Mirrors the pattern used by `reservationId`.
  let throttleReservationId = -1;
  // Canonical resolved-model string, captured once after `resolveModel`
  // so the outer catch can feed retry hints into the same throttle bucket
  // `reserve` used. `model` at the top of execute is the request alias
  // ("latest-pro-thinking") — different key, different bucket.
  let resolvedModelKey: string | null = null;
  const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
  // Composite timeout controller — wall-clock-bound (`timeoutMs`) AND/OR
  // heartbeat-aware stall watchdog (`stallMs`, v1.12.0). Set up before any
  // await so a `timeoutMs: 1000` against a slow scan still fires. The
  // unified signal threads into both `withNetworkRetry({signal})` and the
  // SDK's `config.abortSignal` — whichever timer fires first aborts both
  // layers cleanly. `recordChunk()` is wired into `collectStream` to reset
  // the stall watchdog on every chunk arrival.
  const timeoutController = createTimeoutController({
    ...(input.timeoutMs !== undefined ? { totalMs: input.timeoutMs } : {}),
    totalEnvVar: 'GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS',
    ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
    stallEnvVar: 'GEMINI_CODE_CONTEXT_ASK_STALL_MS',
  });
  const abortSignal = timeoutController.signal;
  try {
    // Workspace path validation lives INSIDE the try so a
    // `WorkspaceValidationError` is reported as a regular tool error
    // (errorResult, "ask failed: …") rather than an unhandled tool
    // exception logged by the server-level handler. Both arrive at the
    // user as text, but only the inside-try path keeps logs tidy and the
    // user-facing prefix consistent with other validation failures.
    try {
      validateWorkspacePath(workspaceRoot);
    } catch (err) {
      if (err instanceof WorkspaceValidationError) {
        return errorResult(`ask: ${err.message}`);
      }
      throw err;
    }

    emitter.emit(`resolving model '${model}'…`);
    // `ask` accepts all three text-gen tiers — caller picks via alias
    // (`latest-pro` / `latest-flash` / `latest-lite` / `latest-vision`)
    // or literal model ID. Resolver refuses to dispatch to a category
    // outside this set — protects against an image/audio/agent model
    // slipping in (e.g. `nano-banana-pro-preview` pre-v1.4.0).
    const resolved = await resolveModel(model, ctx.client, {
      requiredCategory: ['text-reasoning', 'text-fast', 'text-lite'],
    });
    resolvedModelKey = resolved.resolved;

    emitter.emit(`scanning workspace ${workspaceRoot}…`);
    // v1.13.0 — build the scan memo from previously-stored file rows so the
    // scanner can skip re-hashing files whose mtime+size haven't changed.
    // First-run on a new workspace produces an empty map (= every file
    // hashes), which matches pre-v1.13 behaviour.
    const scanMemo = buildScanMemo(ctx.manifest.getFiles(workspaceRoot));
    const scan = await scanWorkspace(workspaceRoot, {
      ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
      ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
      maxFiles: ctx.config.maxFilesPerWorkspace,
      maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      manifestMemo: scanMemo,
      forceRescan: input.forceRescan === true || ctx.config.forceRescan === true,
    });

    // Output-cap strategy (v1.4.0): three-layer precedence.
    //
    //   1. `input.maxOutputTokens` (per-call, strongest) — user explicitly
    //      caps this one call. Clamped to `modelOutputLimit`.
    //   2. `ctx.config.forceMaxOutputTokens` (env override) — when the
    //      MCP host sets `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true`,
    //      every call sends `maxOutputTokens = modelOutputLimit` so
    //      code-review workloads always run at the model's full capacity
    //      (65,536 tokens for Gemini 3.x / 2.5 Pro per Google docs).
    //   3. Default (no overrides) — omit `maxOutputTokens` from the
    //      `generateContent` config. Gemini uses its model-default cap
    //      (documented as the model's advertised `outputTokenLimit`),
    //      letting the model size the response to the query's complexity
    //      rather than reserving full capacity on short Q&A.
    //
    // `modelOutputLimit` is the model's advertised ceiling from
    // `models.list()` (or a fallback if the SDK doesn't report one).
    // Used as the clamp target and as the budget-reservation worst-case.
    const modelOutputLimit =
      typeof resolved.outputTokenLimit === 'number' && resolved.outputTokenLimit > 0
        ? resolved.outputTokenLimit
        : ASK_MAX_OUTPUT_TOKENS_FALLBACK;
    const wireMaxOutputTokens: number | undefined =
      input.maxOutputTokens !== undefined
        ? Math.min(input.maxOutputTokens, modelOutputLimit)
        : ctx.config.forceMaxOutputTokens
          ? modelOutputLimit
          : undefined;
    // Effective cap used for thinking-budget clamp and budget reservation.
    // When neither override is set, the model's internal default equals
    // `modelOutputLimit` per Google docs — so using the limit as
    // worst-case keeps `GEMINI_DAILY_BUDGET_USD` a true upper bound.
    const effectiveOutputCap = wireMaxOutputTokens ?? modelOutputLimit;

    // Single source of truth for "is the caller driving reasoning via the
    // discrete-tier knob?". Three downstream call sites branch on this
    // (cost estimate, emitter, thinkingConfig build) — extracting to a
    // named const keeps them in lockstep and makes future additions hard
    // to forget.
    const usingThinkingLevel = input.thinkingLevel !== undefined;

    // Gemini requires `thinkingBudget < maxOutputTokens` (the thinking pool
    // is carved out of the candidate-output allowance). Reject the call
    // early when the caller's `maxOutputTokens` leaves no headroom for a
    // positive `thinkingBudget`, rather than silently clamping to 0 —
    // clamp-to-0 would make Gemini 3 Pro 400 ("thinking disabled"
    // rejected) and mislead the caller about the actual cause (PR #22
    // round-3 review finding #C). Minimum answer reserve: 1024 tokens.
    if (
      input.thinkingBudget !== undefined &&
      input.thinkingBudget > 0 &&
      input.maxOutputTokens !== undefined &&
      effectiveOutputCap < input.thinkingBudget + 1024
    ) {
      return errorResult(
        `ask: thinkingBudget (${input.thinkingBudget}) + 1024-token answer reserve exceeds maxOutputTokens (${effectiveOutputCap}). Raise \`maxOutputTokens\` to at least ${input.thinkingBudget + 1024}, or lower \`thinkingBudget\`.`,
      );
    }

    // Normalise thinkingBudget:
    //   undefined → null (model-default path — `thinkingBudget` OMITTED on wire)
    //   -1        → -1  (explicit legacy dynamic; kept for Gemini 2.5 and
    //                    power-users who want to force the legacy path)
    //    0        →  0  (thinking disabled; Gemini 3 Pro will 400 here)
    //    N > 0    → clamp to [0, maxOutputTokens - 1024] — the thinking
    //              pool is carved out of the candidate-output allowance,
    //              so reserving ≥1024 tokens for the answer prevents 400s
    //              when a caller passes N ≥ maxOutputTokens.
    //
    // Schema `.refine()` guarantees `thinkingBudget` and `thinkingLevel`
    // are never both set, so we handle them in two mutually-exclusive
    // branches below.
    const rawThinkingBudget = input.thinkingBudget;
    const effectiveThinkingBudget: number | null =
      rawThinkingBudget === undefined
        ? THINKING_BUDGET_MODEL_DEFAULT
        : rawThinkingBudget === -1
          ? -1
          : rawThinkingBudget > 0
            ? Math.max(0, Math.min(rawThinkingBudget, effectiveOutputCap - 1024))
            : 0;

    // Cost-estimate thinking-token reserve — tier-aware when the caller
    // uses `thinkingLevel`, worst-case when they use `thinkingBudget: -1`
    // or omit both fields (Gemini 3 Pro always spends thinking tokens per
    // Google's docs, so we reserve dynamic-thinking headroom there too).
    // When the caller passes an explicit positive `thinkingBudget`, we
    // reserve only that much. Keeps `GEMINI_DAILY_BUDGET_USD` a TRUE
    // upper bound on completed spend without false-rejecting callers
    // who legitimately use a low tier (see `THINKING_LEVEL_RESERVE`
    // rationale above).
    //
    // We dereference `input.thinkingLevel` directly (rather than via
    // `usingThinkingLevel`) so TypeScript narrows the type inside the
    // ternary — `THINKING_LEVEL_RESERVE[undefined]` would be a compile
    // error. The `?? worst-case` fallback handles the HIGH tier (which
    // maps to `null` in the reserve table to mean "use the dynamic cap").
    const thinkingTokensForEstimate =
      input.thinkingLevel !== undefined
        ? (THINKING_LEVEL_RESERVE[input.thinkingLevel] ?? Math.max(0, effectiveOutputCap - 1024))
        : effectiveThinkingBudget === null || effectiveThinkingBudget === -1
          ? Math.max(0, effectiveOutputCap - 1024)
          : effectiveThinkingBudget;

    // Estimated input-token count drives both the daily-budget reservation
    // (dollars) and the TPM throttle reservation (rate). Hoisted here so
    // both consumers share one fingerprint — no drift between what the $
    // ledger thinks we'll spend and what the rate-limiter thinks we'll
    // send to Gemini. Budget reservation still uses the bytes/4 heuristic
    // (cheap; `estimatePreCallCostUsd` already takes raw bytes), but the
    // PREFLIGHT against `inputTokenLimit` now goes through the v1.10.0
    // two-tier `countForPreflight` (Tier 1 = heuristic for small repos;
    // Tier 2 = real `countTokens` call when near the cliff). Closes T17
    // (`bytes/4` undercount on dense Unicode). See `src/gemini/token-counter.ts`.
    const workspaceBytes = scan.files.reduce((sum, f) => sum + f.size, 0);
    const estimatedInputTokens = Math.ceil(workspaceBytes / 4) + Math.ceil(input.prompt.length / 4);

    // v1.5.0 preflight (rebuilt in v1.10.0 on top of `countTokens`) — refuse
    // immediately if the estimated input doesn't fit under the model's
    // advertised `inputTokenLimit * workspaceGuardRatio`. Before this
    // guard we would dispatch the request, Gemini would reject with
    // `400 INVALID_ARGUMENT "exceeds maximum ..."`, and the calling
    // sub-agent would interpret the 400 as retryable (the error body is
    // indistinguishable from transient quota errors at the string level)
    // → unbounded retry storm. Cheap pre-flight with a structured
    // `WORKSPACE_TOO_LARGE` errorCode + `retryable: false` signals to the
    // orchestrator that this is not recoverable without user action.
    //
    // `inputTokenLimit` can be `null` when `models.list()` didn't advertise
    // it (typically happens only on internal / preview model IDs we've never
    // seen). In that case we fall through without blocking but warn —
    // better to let the request hit the API and fail noisily than to
    // block a legitimate call on missing metadata.
    // Hoisted past the `if (contextWindow > 0)` block so the success-path
    // metadata (lines below) can surface `tokenCountMethod` /
    // `rawTokenCount` / `tokenCountCacheHit` regardless of whether the
    // preflight actually ran. Stays `undefined` only when the resolved
    // model has no advertised `inputTokenLimit`.
    let preflight: PreflightTokenResult | undefined;
    const contextWindow = resolved.inputTokenLimit;
    if (typeof contextWindow === 'number' && contextWindow > 0) {
      preflight = await countForPreflight(ctx.client, {
        files: scan.files,
        prompt: input.prompt,
        model: resolved.resolved,
        // `filesHash` is post-glob-filter (see `scanWorkspace`), so it
        // already encodes user-supplied includeGlobs/excludeGlobs — no
        // separate globsHash axis needed in the cache key.
        filesHash: scan.filesHash,
        ...(input.preflightMode !== undefined ? { preflightMode: input.preflightMode } : {}),
        inputTokenLimit: contextWindow,
        // Thread the user's `timeoutMs` AbortSignal so a hung countTokens
        // call doesn't bleed past the user's stated wall-clock budget. The
        // SDK's `CountTokensConfig` accepts `abortSignal`; on cancellation
        // the SDK throws `AbortError`, which `countForPreflight` re-throws
        // (rather than swallowing as a fallback) so this outer try/catch
        // maps it to `errorCode: 'TIMEOUT'` immediately.
        signal: abortSignal,
      });
      const threshold = Math.floor(contextWindow * ctx.config.workspaceGuardRatio);
      if (preflight.effectiveTokens > threshold) {
        const pctDisplay = Math.round(ctx.config.workspaceGuardRatio * 100);

        // v1.11.0 — opt-in transparent fallback to `ask_agentic` when the
        // caller explicitly asked for it via `onWorkspaceTooLarge:
        // 'fallback-to-agentic'`. Default stays `'error'` so pre-v1.11.0
        // callers see identical behaviour. The fallback re-uses this
        // tool's resolved inputs (model / globs / thinking config /
        // workspace) and re-translates `timeoutMs` to `iterationTimeoutMs`
        // (per-iteration cap; total wall-clock can be N × that). Cost +
        // timing shape genuinely changes — opt-in is the right default.
        if (input.onWorkspaceTooLarge === 'fallback-to-agentic') {
          logger.warn(
            `ask: WORKSPACE_TOO_LARGE (${preflight.effectiveTokens} > ${threshold}); falling back to ask_agentic per onWorkspaceTooLarge='fallback-to-agentic'`,
          );
          // Translate `timeoutMs` AND `stallMs` to the agentic per-iteration
          // wall-clock cap (`iterationTimeoutMs`). Pre-v1.12.1 only `timeoutMs`
          // was forwarded — a user who set `stallMs: 60000` (the v1.12.0
          // recommended liveness watchdog) saw it silently dropped on the
          // fallback path. The agentic loop uses non-streaming
          // `generateContent`, so there's no chunk stream to reset on; we
          // collapse both knobs onto the per-iteration cap and use the
          // TIGHTER of the two as the bound. The CHANGELOG documents the
          // semantic divergence on `timeoutMs` (total → per-iteration).
          //
          // v1.12.2 — `iterTimeoutSource` is surfaced in metadata AND emitted
          // in the warn-log so users can see WHICH knob bound their call
          // (one of: 'timeoutMs', 'stallMs', or 'min(timeoutMs,stallMs)').
          // Pre-v1.12.2 the log only fired when stallMs was set alone; the
          // both-set case had no signal explaining the pick.
          const iterTimeoutPick = ((): {
            cap: number | undefined;
            source: 'timeoutMs' | 'stallMs' | 'min(timeoutMs,stallMs)' | 'none';
          } => {
            const a = input.timeoutMs;
            const b = input.stallMs;
            if (a !== undefined && b !== undefined) {
              const cap = Math.min(a, b);
              return { cap, source: 'min(timeoutMs,stallMs)' };
            }
            if (a !== undefined) return { cap: a, source: 'timeoutMs' };
            if (b !== undefined) return { cap: b, source: 'stallMs' };
            return { cap: undefined, source: 'none' };
          })();
          const tightestPerIterCap = iterTimeoutPick.cap;
          if (iterTimeoutPick.source !== 'none') {
            logger.warn(
              `ask: fallback to ask_agentic — \`iterationTimeoutMs\` set to ${tightestPerIterCap}ms (source: ${iterTimeoutPick.source}). The agentic loop uses non-streaming \`generateContent\` so there's no chunk stream to reset on; \`stallMs\` (when set) is treated as a per-iteration wall-clock cap, the same way \`timeoutMs\` is. Total wall-clock for the agentic call can reach \`maxIterations × iterationTimeoutMs\`.`,
            );
          }
          const agenticInput: AskAgenticInput = {
            prompt: input.prompt,
            ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.includeGlobs !== undefined ? { includeGlobs: input.includeGlobs } : {}),
            ...(input.excludeGlobs !== undefined ? { excludeGlobs: input.excludeGlobs } : {}),
            ...(input.thinkingBudget !== undefined ? { thinkingBudget: input.thinkingBudget } : {}),
            ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
            ...(input.maxOutputTokens !== undefined
              ? { maxOutputTokens: input.maxOutputTokens }
              : {}),
            // `timeoutMs` (ask wall-clock cap) → `iterationTimeoutMs`
            // (ask_agentic per-iteration cap). Total wall-clock for the
            // agentic call can be `maxIterations × iterationTimeoutMs`.
            // v1.12.1 fix: also collapses `stallMs` onto this cap (using
            // the TIGHTER of the two when both are set), so the fallback
            // path doesn't silently drop the user's stall watchdog.
            ...(tightestPerIterCap !== undefined ? { iterationTimeoutMs: tightestPerIterCap } : {}),
          };
          const agenticResult = await askAgenticTool.execute(agenticInput, ctx);

          // Wrap the agentic result so callers can audit the swap.
          // The text content (`content[0].text`) is the agentic prose
          // verbatim — same shape any direct `ask_agentic` caller would
          // see. The structuredContent is enriched with fallback-trail
          // metadata so orchestrators can distinguish a fallback-served
          // response from a direct one.
          //
          // Two load-bearing contracts the wrapper must preserve:
          //   1. `structuredContent.responseText` — the T23 wire-format
          //      invariant (`textResult` / `errorResult` always write it
          //      LAST; sub-agent orchestrators extract from this key
          //      ONLY). We pull it from the agentic result's
          //      `structuredContent.responseText` (or the prose text from
          //      `content[0].text` as a fallback) and write it LAST so
          //      it can't be clobbered.
          //   2. Top-level `errorCode` / `retryable` — orchestrator retry
          //      policies switch on these. When the agentic call itself
          //      fails (e.g. iteration budget exhausted), the failure
          //      code lives in `agenticResult.structuredContent.errorCode`;
          //      we lift it to the top level of `wrappedStructured` so
          //      consumer policies see it without descending into nested
          //      `agenticResult.errorCode` (which they wouldn't know
          //      about pre-v1.11.0).
          const agenticStructured =
            (agenticResult.structuredContent as Record<string, unknown> | undefined) ?? {};
          const promptResponseText =
            typeof agenticStructured.responseText === 'string'
              ? agenticStructured.responseText
              : agenticResult.content?.[0]?.type === 'text'
                ? agenticResult.content[0].text
                : '';

          const wrappedStructured: Record<string, unknown> = {
            fallbackApplied: 'ask_agentic',
            fallbackReason: 'WORKSPACE_TOO_LARGE',
            preflightEstimate: {
              tokens: preflight.effectiveTokens,
              threshold,
              source: preflight.method,
              cacheHit: preflight.cacheHit,
              rawTokens: preflight.rawTokens,
            },
            // v1.12.2 — surface the per-iteration cap selection so callers
            // can audit which knob bound the fallback call. Useful when the
            // user passed both `timeoutMs` and `stallMs` (we use the tighter
            // of the two — `iterTimeoutSource: 'min(timeoutMs,stallMs)'`).
            // Omitted when neither knob was set (`source: 'none'`).
            ...(iterTimeoutPick.source !== 'none'
              ? {
                  iterTimeoutMs: tightestPerIterCap,
                  iterTimeoutSource: iterTimeoutPick.source,
                }
              : {}),
            // Lift top-level error metadata from the agentic call's
            // structuredContent so orchestrator policies (e.g. retry on
            // BUDGET_EXHAUSTED, retry on stall but not total) keep working
            // without descending into `.agenticResult.errorCode`. v1.12.1
            // adds `timeoutKind` to the lift set — Phase 4 introduced
            // `timeoutKind` as a top-level field on direct-path TIMEOUT
            // errors; the fallback wrapper now mirrors that on the
            // fallback-served TIMEOUT path so the contract is uniform.
            ...(agenticResult.isError && typeof agenticStructured.errorCode === 'string'
              ? { errorCode: agenticStructured.errorCode }
              : {}),
            ...(agenticResult.isError && typeof agenticStructured.retryable === 'boolean'
              ? { retryable: agenticStructured.retryable }
              : {}),
            ...(agenticResult.isError &&
            (agenticStructured.timeoutKind === 'total' || agenticStructured.timeoutKind === 'stall')
              ? { timeoutKind: agenticStructured.timeoutKind }
              : {}),
            ...(Object.keys(agenticStructured).length > 0
              ? { agenticResult: agenticStructured }
              : {}),
            // T23 wire-format invariant — `responseText` is written LAST
            // so any caller-supplied / nested key with the same name is
            // intentionally clobbered by the canonical value. Sub-agent
            // orchestrators read the prose from this exact key.
            responseText: promptResponseText,
          };

          // `isError` lives at the ROOT of the MCP CallToolResult per spec
          // (sibling to `structuredContent`, not nested inside it). The
          // spread on the return statement carries the agentic root-level
          // `isError` automatically — no need to mirror it inside
          // `structuredContent`.
          return {
            ...agenticResult,
            structuredContent: wrappedStructured,
          };
        }

        return errorResult(
          `Workspace too large: ~${preflight.effectiveTokens.toLocaleString()} input tokens (${preflight.method} count) exceeds ${threshold.toLocaleString()} (${pctDisplay}% of ${resolved.resolved}'s ${contextWindow.toLocaleString()} context window). Best option: use \`mcp__gemini-code-context__ask_agentic\` — same model, but it reads only the files it needs via sandboxed tool calls (no eager repo upload). Or set \`onWorkspaceTooLarge: 'fallback-to-agentic'\` on \`ask\` to have the server route automatically. Other options: (a) pass \`excludeGlobs\` to filter large/generated files — supports \`*.ext\` patterns, filenames, and directory paths, (b) narrow with \`includeGlobs\`, (c) switch to a larger-context model, or (d) split the workspace into subdirectories.`,
          {
            errorCode: 'WORKSPACE_TOO_LARGE',
            retryable: false,
            estimatedInputTokens: preflight.effectiveTokens,
            tokenCountMethod: preflight.method,
            rawTokenCount: preflight.rawTokens,
            tokenCountCacheHit: preflight.cacheHit,
            contextWindowTokens: contextWindow,
            thresholdTokens: threshold,
            guardRatio: ctx.config.workspaceGuardRatio,
            resolvedModel: resolved.resolved,
            filesIndexed: scan.files.length,
          },
        );
      }
    } else {
      logger.warn(
        `ask: resolved model ${safeForLog(resolved.resolved)} has no advertised inputTokenLimit — workspace size guard skipped. Request may fail downstream if the workspace exceeds the model's context window.`,
      );
    }

    // Atomic budget reservation. Happens AFTER scan (so the estimate is
    // accurate) but BEFORE any billable upload or generateContent call.
    // Concurrent tool calls cannot all pass a pre-check and then
    // collectively overshoot the cap: `reserveBudget` uses a
    // `BEGIN IMMEDIATE` SQLite transaction that serialises check-and-insert.
    if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
      const estimateUsd = estimatePreCallCostUsd({
        model: resolved.resolved,
        workspaceBytes,
        promptChars: input.prompt.length,
        // Budget reservation uses the effective cap (explicit-user-cap
        // OR model's full limit) as `expectedOutputTokens` — a TRUE
        // upper bound, since Gemini's default stops at the model's
        // advertised `outputTokenLimit`.
        expectedOutputTokens: effectiveOutputCap,
        thinkingTokens: thinkingTokensForEstimate,
      });
      const reserve = ctx.manifest.reserveBudget({
        workspaceRoot,
        toolName: 'ask',
        model: resolved.resolved,
        estimatedCostMicros: toMicrosUsd(estimateUsd),
        dailyBudgetMicros: toMicrosUsd(ctx.config.dailyBudgetUsd),
        nowMs: Date.now(),
      });
      if ('rejected' in reserve) {
        const spentUsd = reserve.spentMicros / 1_000_000;
        return errorResult(
          `Daily budget cap would be exceeded: spent $${spentUsd.toFixed(4)} + estimate $${estimateUsd.toFixed(4)} > cap $${ctx.config.dailyBudgetUsd.toFixed(2)}. Retry after UTC midnight, or raise \`GEMINI_DAILY_BUDGET_USD\`.`,
          { errorCode: 'BUDGET_REJECT', retryable: false },
        );
      }
      reservationId = reserve.id;
    }

    const systemPromptHash = createHash('sha256')
      .update(SYSTEM_INSTRUCTION_Q_AND_A)
      .digest('hex')
      .slice(0, 16);

    // v1.13.0 — record the resolved caching mode for telemetry. Defaults to
    // `'explicit'` so pre-1.13 behaviour is unchanged. The status tool's
    // `cacheStatsLast24h` aggregation reads this column to compute
    // implicit-cache hit rate, dominant mode, and rebuild count.
    const effectiveCachingMode: 'explicit' | 'implicit' = input.cachingMode ?? 'explicit';

    const ctxPrep = await prepareContext({
      client: ctx.client,
      manifest: ctx.manifest,
      scan,
      model: resolved,
      systemPromptHash,
      systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
      ttlSeconds: ctx.config.cacheTtlSeconds,
      cacheMinTokens: ctx.config.cacheMinTokens,
      emitter,
      allowCaching: !input.noCache && scan.files.length > 0,
      // v1.12.1 — let `timeoutMs` interrupt the upload phase too.
      signal: abortSignal,
      // v1.13.0 — opt-in implicit caching path (skip caches.create).
      ...(input.cachingMode !== undefined ? { cachingMode: input.cachingMode } : {}),
    });

    // TPM throttle reservation — placed HERE (after `prepareContext`,
    // immediately before `generateContent`) so the reservation's `tsMs`
    // accurately reflects when tokens hit Gemini's quota counter. An
    // earlier reserve (before `prepareContext`) would stamp `tsMs`
    // minutes before actual dispatch on cold-cache calls; our window
    // would then expire before Gemini's, leaving a gap where we admit
    // concurrent calls that bust Gemini's per-minute quota. Trade-off:
    // two concurrent cold-cache callers will both complete
    // `prepareContext` before one backs off at `reserve` — mostly
    // idempotent via file-hash dedup, minor upload duplication.
    //
    // Extracted into a helper so the stale-cache retry branch can
    // cancel-and-re-reserve with an accurate tsMs rather than reusing a
    // stale reservation stamped before the first (failed) dispatch.
    const reserveForDispatch = async (): Promise<void> => {
      if (ctx.config.tpmThrottleLimit <= 0) return;
      const reservation = ctx.throttle.reserve(resolved.resolved, estimatedInputTokens);
      throttleReservationId = reservation.releaseId;
      if (reservation.delayMs > 0) {
        emitter.emit(`throttle: waiting ${Math.ceil(reservation.delayMs / 1000)}s for TPM window…`);
        // Abortable sleep — without this a 60s TPM throttle wait would block
        // a 10s wall-clock timeout, defeating T19's whole-dispatch contract.
        await abortableSleep(reservation.delayMs, abortSignal);
      }
    };
    await reserveForDispatch();

    emitter.emit(
      usingThinkingLevel
        ? `generating response (thinking-level=${input.thinkingLevel})…`
        : effectiveThinkingBudget === null
          ? 'generating response (thinking=model-default)…'
          : effectiveThinkingBudget === -1
            ? 'generating response (thinking=dynamic)…'
            : `generating response (thinking=${effectiveThinkingBudget})…`,
    );
    // Gemini rejects `generateContent({cachedContent, systemInstruction})` with 400:
    // "CachedContent can not be used with GenerateContent request setting
    //  system_instruction, tools or tool_config. Move those values to CachedContent."
    // The system instruction was already baked into the cache at build time
    // (see cache-manager.ts:322 `cacheConfig.systemInstruction`), so we must
    // OMIT it on the generate call when a cached context is active.
    // `thinkingConfig` is NOT one of the forbidden fields — it is a
    // per-request reasoning control and travels with every call regardless
    // of cache state. We always set `includeThoughts: true` so callers see
    // Gemini's reasoning digest in the response.
    //
    // Three mutually-exclusive reasoning-control paths (enforced by
    // schema `.refine()`):
    //   a) `thinkingLevel` set → pass it through to the SDK enum. Google's
    //      recommended path on Gemini 3. Rejected by Gemini 2.5 family.
    //   b) `thinkingBudget` set (non-null after normalisation) → legacy
    //      budget path. Required on Gemini 2.5; flagged as "legacy" on
    //      Gemini 3 but still supported.
    //   c) neither set → omit both fields, keep only `includeThoughts`.
    //      Model uses its native default (HIGH-dynamic on Gemini 3 Pro).
    //
    // `maxOutputTokens` is only passed on the wire when the caller set
    // `input.maxOutputTokens` — otherwise we omit it and Gemini uses
    // its model-default cap (per docs, = the model's advertised
    // `outputTokenLimit`, currently 65,536 for pro-tier 3.x/2.5). Budget
    // reservation always uses `effectiveOutputCap` (= explicit cap OR
    // model limit) as worst-case upper bound, so the daily cap stays a
    // true ceiling regardless.
    // Cast to `ThinkingLevel` rather than indexing the runtime enum object
    // (`ThinkingLevel[input.thinkingLevel]`). For string enums the value
    // IS the member name, so passing `"HIGH"` as `ThinkingLevel` is
    // semantically identical at runtime — but it survives SDK renames:
    // if a future `@google/genai` release renames a member, the literal
    // string reaches Gemini's wire, which 400s with a clear message
    // instead of silently becoming `undefined` at the indexing step.
    const thinkingConfig: ThinkingConfig = usingThinkingLevel
      ? {
          thinkingLevel: input.thinkingLevel as ThinkingLevel,
          includeThoughts: true,
        }
      : effectiveThinkingBudget === null
        ? { includeThoughts: true }
        : { thinkingBudget: effectiveThinkingBudget, includeThoughts: true };
    const buildConfig = (cacheId: string | null): GenerateContentConfig => {
      const maxOutputField =
        wireMaxOutputTokens !== undefined ? { maxOutputTokens: wireMaxOutputTokens } : {};
      return cacheId
        ? { cachedContent: cacheId, thinkingConfig, ...maxOutputField }
        : {
            systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
            thinkingConfig,
            ...maxOutputField,
          };
    };
    const buildContents = (
      cacheId: string | null,
      inline: typeof ctxPrep.inlineContents,
    ): string | Content[] =>
      cacheId ? input.prompt : [...inline, { role: 'user', parts: [{ text: input.prompt }] }];

    // Track the prepared-context used for the FINAL successful call. Starts
    // pointing at the initial ctxPrep; retry branch below reassigns to the
    // rebuilt PreparedContext so post-call markHot + metadata reflect reality.
    let activePrep = ctxPrep;
    let retriedOnStaleCache = false;
    let response: CollectedResponse;
    try {
      // T20 (v1.7.0) — CRITICAL: withNetworkRetry wraps ONLY the stream
      // opening, NOT collectStream itself. If collectStream were inside the
      // retry closure, a mid-stream `TypeError: fetch failed` would discard
      // the partial response and re-issue a brand-new generateContentStream
      // — duplicating the model's billable work and emitting double
      // "thinking: …" progress lines. Mid-stream failure CANNOT be retried
      // (Gemini's generateContentStream doesn't support resume), so it must
      // propagate verbatim to the caller.
      const stream = await withNetworkRetry(
        () =>
          ctx.client.models.generateContentStream({
            model: resolved.resolved,
            contents: buildContents(activePrep.cacheId, activePrep.inlineContents),
            config: { ...buildConfig(activePrep.cacheId), abortSignal },
          }),
        {
          signal: abortSignal,
          onRetry: (attempt, retryErr) => {
            logger.warn(
              `ask: retrying generateContent after transient network failure (attempt ${attempt}): ${
                retryErr instanceof Error ? retryErr.message : String(retryErr)
              }`,
            );
          },
        },
      );
      response = await collectStream(stream, {
        signal: abortSignal,
        onThoughtChunk: (text) => {
          // Surface the model's reasoning live as it arrives. Throttled
          // to ~1.5s by collectStream so the MCP host's progress channel
          // doesn't get flooded on long thinking bursts.
          const trimmed = text.trim().slice(0, 80);
          if (trimmed.length > 0) emitter.emit(`thinking: ${trimmed}…`);
        },
        // v1.12.0 — reset the stall watchdog on every chunk (text or
        // thought). Both prove the stream is alive. No-op when stall
        // is disabled (env + per-call both unset).
        onChunkReceived: () => timeoutController.recordChunk(),
      });
    } catch (err) {
      // Self-heal: if Gemini rejected our cached content (evicted, expired,
      // externally deleted), invalidate locally and retry ONCE with a fresh
      // cache. Prevents users from seeing hard failures they'd otherwise need
      // to clear/reindex manually. Budget: one retry; a second stale-cache
      // error propagates with both errors chained via Error.cause.
      if (activePrep.cacheId && isStaleCacheError(err)) {
        logger.warn(
          `Gemini rejected cached content ${activePrep.cacheId}; invalidating and retrying once.`,
        );
        try {
          // Reset the cache pointer only — keep `files` rows so the rebuild
          // can reuse uploaded files via content-hash dedup instead of
          // re-uploading. The Gemini-side cache is already dead (that's
          // what triggered this branch), so no `caches.delete` needed.
          markCacheStale({ manifest: ctx.manifest, workspaceRoot });
          const rebuilt = await prepareContext({
            client: ctx.client,
            manifest: ctx.manifest,
            scan,
            model: resolved,
            systemPromptHash,
            systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
            ttlSeconds: ctx.config.cacheTtlSeconds,
            cacheMinTokens: ctx.config.cacheMinTokens,
            emitter,
            allowCaching: !input.noCache && scan.files.length > 0,
            // v1.12.1 — propagate signal into stale-cache rebuild too.
            signal: abortSignal,
            // v1.13.0 — keep cachingMode consistent across happy + retry paths.
            ...(input.cachingMode !== undefined ? { cachingMode: input.cachingMode } : {}),
          });
          // Cancel the original throttle reservation — its `tsMs` was
          // stamped at first-dispatch time, which is now seconds in the
          // past (the rebuild took real time). Re-reserve fresh so the
          // retry's tsMs reflects when the retry call actually hits
          // Gemini's quota counter. Without this, our window would expire
          // locally before Gemini's, leaving a gap where concurrent
          // callers bust the per-minute limit (PR #19 round-2 GPT review).
          if (throttleReservationId !== -1) {
            ctx.throttle.cancel(throttleReservationId);
            throttleReservationId = -1;
          }
          await reserveForDispatch();
          // The stale-cache retry itself can hit a transient network failure;
          // wrap it too so the rebuild isn't wasted on a one-off blip.
          // Stale-cache retry: discard partial response, open a brand-new
          // stream with the rebuilt cache. Gemini's stream API doesn't
          // support resume, so this is the only correct semantics.
          // Same retry-OPENING-only contract as the happy path — see above.
          const retryStream = await withNetworkRetry(
            () =>
              ctx.client.models.generateContentStream({
                model: resolved.resolved,
                contents: buildContents(rebuilt.cacheId, rebuilt.inlineContents),
                config: { ...buildConfig(rebuilt.cacheId), abortSignal },
              }),
            {
              signal: abortSignal,
              onRetry: (attempt, retryErr) => {
                logger.warn(
                  `ask (stale-cache retry): retrying generateContent after transient network failure (attempt ${attempt}): ${
                    retryErr instanceof Error ? retryErr.message : String(retryErr)
                  }`,
                );
              },
            },
          );
          response = await collectStream(retryStream, {
            signal: abortSignal,
            onThoughtChunk: (text) => {
              const trimmed = text.trim().slice(0, 80);
              if (trimmed.length > 0) emitter.emit(`thinking: ${trimmed}…`);
            },
            // v1.12.0 — stall watchdog reset on retry stream too.
            onChunkReceived: () => timeoutController.recordChunk(),
          });
          activePrep = rebuilt;
          retriedOnStaleCache = true;
        } catch (retryErr) {
          // Re-throw the retry's TimeoutError directly so the outer catch's
          // `isTimeoutAbort` check sees it on the cause chain. Without this,
          // wrapping with `cause: err` (the original stale-cache error)
          // would mask the timeout — outer catch maps to UNKNOWN instead of
          // TIMEOUT, breaking the contract on stale-cache+timeout paths.
          if (isTimeoutAbort(retryErr)) throw retryErr;
          // Otherwise preserve the ORIGINAL stale-cache error as `cause` so
          // ops can root-cause diagnostics across both the first 404 and any
          // rebuild-time failure.
          throw new Error(
            `ask retry after stale cache failed: ${
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`,
            { cause: err },
          );
        }
      } else {
        throw err;
      }
    }

    if (activePrep.cacheId) {
      ctx.ttlWatcher.markHot(workspaceRoot, activePrep.cacheId, ctx.config.cacheTtlSeconds);
    }

    const text = response.text;

    // `collectStream` already aggregated thought-flagged parts and capped
    // the joined summary at 1200 chars (T20). Reuse directly — re-iterating
    // `response.candidates` would risk drift between in-flight thought
    // emit (live progress) and post-call summary.
    const thinkingSummary = response.thoughtsSummary;

    const usage = response.usageMetadata;
    const cached =
      typeof usage?.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0;
    const inputTotal = typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
    const uncached = Math.max(0, inputTotal - cached);
    const output = typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
    const thinking = typeof usage?.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : 0;

    // Finalise the throttle reservation with Gemini's actual
    // `promptTokenCount` — includes cached tokens, which DO count against
    // the per-minute quota (empirically confirmed 2026-04-20). If actual
    // < estimate, subsequent reserves see the freed headroom; if >, they
    // back off accordingly.
    if (throttleReservationId !== -1) {
      ctx.throttle.release(throttleReservationId, inputTotal);
      throttleReservationId = -1;
    }

    const cost = estimateCostUsd({
      model: resolved.resolved,
      uncachedInputTokens: uncached,
      cachedInputTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
    });
    const costMicros = toMicrosUsd(cost);

    const durationMs = Date.now() - started;
    if (reservationId !== null) {
      // The finalize UPDATE on a row we just inserted should be infallible
      // in practice, but a disk-full / lock-contention edge could throw.
      // If it does, we'd rather keep the reservation row (estimate stays
      // billed, slight overcharge) than let the outer catch CANCEL it
      // — cancelling would erase any record of this billable, completed
      // call. Either way, drop `reservationId` so the outer catch doesn't
      // touch it.
      try {
        ctx.manifest.finalizeBudgetReservation(reservationId, {
          cachedTokens: cached,
          uncachedTokens: uncached,
          costUsdMicro: costMicros,
          durationMs,
          cachingMode: effectiveCachingMode,
          cachedContentTokenCount: cached,
        });
      } catch (finalizeErr) {
        logger.error(
          `ask: finalizeBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate (${costMicros} micros). Error: ${String(finalizeErr)}`,
        );
      }
      reservationId = null;
    } else {
      ctx.manifest.insertUsageMetric({
        workspaceRoot,
        toolName: 'ask',
        model: resolved.resolved,
        cachedTokens: cached,
        uncachedTokens: uncached,
        costUsdMicro: costMicros,
        durationMs,
        occurredAt: Date.now(),
        cachingMode: effectiveCachingMode,
        cachedContentTokenCount: cached,
      });
    }

    if (scan.truncated) {
      logger.warn(
        `workspace ${workspaceRoot} contains more files than GEMINI_CODE_CONTEXT_MAX_FILES (${ctx.config.maxFilesPerWorkspace}); the tail was dropped before indexing.`,
      );
    }

    const metadata: Record<string, unknown> = {
      resolvedModel: resolved.resolved,
      requestedModel: resolved.requested,
      fallbackApplied: resolved.fallbackApplied,
      modelCategory: resolved.category,
      modelCostTier: resolved.capabilities.costTier,
      contextWindow: resolved.inputTokenLimit,
      thinkingBudget: effectiveThinkingBudget,
      thinkingLevel: input.thinkingLevel ?? null,
      cachedTokens: cached,
      uncachedTokens: uncached,
      outputTokens: output,
      thinkingTokens: thinking,
      costEstimateUsd: Math.round(cost * 10000) / 10000,
      cacheHit: activePrep.reused,
      cacheRebuilt: activePrep.rebuilt || retriedOnStaleCache,
      retriedOnStaleCache,
      inlineOnly: activePrep.inlineOnly,
      filesIndexed: scan.files.length,
      filesSkippedTooLarge: scan.skippedTooLarge,
      filesUploadFailed: activePrep.uploaded.failedCount,
      ...(activePrep.uploaded.failedCount > 0
        ? { uploadFailures: activePrep.uploaded.failures.slice(0, 5) }
        : {}),
      workspaceTruncated: scan.truncated,
      maxFilesCap: ctx.config.maxFilesPerWorkspace,
      // Preflight token-count provenance — surfaces on every successful
      // call so orchestrators / observability layers can see which path
      // produced the count (`'heuristic'`, `'exact'`, `'fallback'`),
      // whether the LRU saved an API round-trip, and the raw count
      // before `SYSTEM_INSTRUCTION_RESERVE` was applied. Omitted when
      // the resolved model had no `inputTokenLimit` (preflight skipped).
      ...(preflight !== undefined
        ? {
            tokenCountMethod: preflight.method,
            rawTokenCount: preflight.rawTokens,
            tokenCountCacheHit: preflight.cacheHit,
          }
        : {}),
      durationMs,
      ...(thinkingSummary ? { thinkingSummary } : {}),
    };

    return textResult(text, metadata);
  } catch (err) {
    logger.error(`ask failed: ${safeForLog(err)}`);
    // T22a — extract Gemini's `retryInfo.retryDelay` from 429 bodies and
    // seed the throttle's per-model hint before we release the
    // reservation. Google's hint is typically shorter (2-16s) than our
    // pure-window math would compute (up to 60s+) so honouring it
    // shortens the next caller's wait.
    //
    // Gated on `isGemini429` BEFORE parsing. The predicate requires BOTH
    // `err instanceof ApiError` (SDK-provenance marker — user-controlled
    // content can't forge an ApiError prototype) AND `err.status === 429`
    // (typed field from the HTTP response). The earlier v1.3.2 draft had
    // a `RESOURCE_EXHAUSTED` substring fallback; GPT + Grok round-2
    // review (PR #21) showed that path was user-influenceable — echoed
    // prompt content re-opened the hint-poisoning class the gate was
    // meant to close. Removing the fallback drops hint extraction for
    // errors that lose the ApiError shape in transit, but production
    // 429s always arrive as real ApiError instances.
    const retryDelayMs = isGemini429(err) ? parseRetryDelayMs(err.message) : null;
    if (retryDelayMs !== null && resolvedModelKey !== null) {
      ctx.throttle.recordRetryHint(resolvedModelKey, retryDelayMs);
    }
    // Release any unconsumed budget reservation so the failed call's
    // estimate doesn't eat into future headroom for today. Wrap in its
    // own try/catch — better-sqlite3 can throw SQLITE_BUSY or I/O errors
    // and we must not let a rollback-time DB failure replace the real
    // tool error the user is waiting on.
    if (reservationId !== null) {
      try {
        ctx.manifest.cancelBudgetReservation(reservationId);
      } catch (cancelErr) {
        logger.error(
          `ask: cancelBudgetReservation failed for id=${reservationId}; reservation row keeps the estimate. Error: ${String(cancelErr)}`,
        );
      }
      reservationId = null;
    }
    // Drop the TPM reservation on any failure path. If Gemini actually
    // consumed quota server-side before failing, the hint path above
    // (T22a) compensates via `recordRetryHint` before we cancel. For
    // non-429 errors (validation, transport), we under-count slightly
    // but bounded — accepted trade-off documented in PR #19 round-2.
    if (throttleReservationId !== -1) {
      ctx.throttle.cancel(throttleReservationId);
      throttleReservationId = -1;
    }
    // Timeout-driven abort gets a dedicated errorCode so callers can
    // distinguish "Gemini was slow" from "schema invalid" / "auth failed".
    // v1.12.0 — `timeoutKind` ('total' | 'stall') distinguishes the
    // wall-clock cap from the heartbeat-aware stall watchdog so callers
    // can apply different policies (e.g. retry on stall but not on total).
    if (isTimeoutAbort(err)) {
      const ms = timeoutController.timeoutMs;
      const stallMs = timeoutController.stallMs;
      const kind = getTimeoutKind(err);
      const limitMs = kind === 'stall' ? stallMs : ms;
      emitter.emit(`ask: aborted after ${limitMs ?? '?'}ms ${kind ?? 'timeout'}`);
      const message =
        kind === 'stall'
          ? `ask timed out — no chunk received for ${stallMs ?? '?'}ms (stall watchdog). Increase \`stallMs\` per call or set \`GEMINI_CODE_CONTEXT_ASK_STALL_MS\` higher; default disabled. Stall watchdog is heartbeat-aware — it does NOT fire while the model is streaming chunks. A fired stall is usually a dead socket or a server-side hang. Note: AbortSignal is client-only — Gemini still finishes server-side and bills for completed work.`
          : `ask timed out after ${ms ?? '?'}ms (total wall-clock). Increase \`timeoutMs\` per call or set \`GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS\` higher; default disabled. Consider \`stallMs\` instead — a heartbeat-aware watchdog that does NOT fire while the model is actively thinking. Note: AbortSignal is client-only — Gemini still finishes server-side and bills for completed work.`;
      return errorResult(message, {
        errorCode: 'TIMEOUT',
        timeoutKind: kind ?? 'total',
        timeoutMs: ms,
        stallMs,
        retryable: true,
      });
    }
    const httpStatus = (err as { status?: number }).status;
    return errorResult(`ask failed: ${err instanceof Error ? err.message : String(err)}`, {
      errorCode: 'UNKNOWN',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    });
  } finally {
    timeoutController.dispose();
    emitter.stop();
  }
}
