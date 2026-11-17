/**
 * `ask` tool — Q&A / long-context analysis against a workspace.
 *
 * Sends the scanned workspace with the question. Implicit caching by default
 * (inline content, Gemini's automatic prefix cache); `cachingMode: 'explicit'`
 * uploads the workspace once and builds a persistent Context Cache (measured
 * 2026-04-22 on a 670 k-token workspace: first call ~125 s, repeats ~14 s).
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  Content,
  GenerateContentConfig,
  Part,
  ThinkingConfig,
  ThinkingLevel,
} from '@google/genai';
import {
  type Attachment,
  AttachmentError,
  AttachmentTokensUncountedError,
  INLINE_REQUEST_LIMIT_BYTES,
  countAttachmentTokens,
  inlineRequestBytes,
  inspectAttachments,
  readAttachments,
} from '../attachments.js';
import { prepareContext } from '../cache/cache-manager.js';
import { cachingModeFor, cachingRan } from '../cache/caching-mode.js';
import {
  capThatRuns,
  preflightModeFor,
  resolveOutputCap,
  thinkingBudgetRefusal,
} from '../gemini/long-decode.js';
import { resolveModel } from '../gemini/models.js';
import { type PreflightTokenResult, countForPreflight } from '../gemini/token-counter.js';
import { buildScanMemo, scanWorkspace } from '../indexer/workspace-scanner.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../indexer/workspace-validation.js';
import { estimatePreCallCostUsd, toMicrosUsd } from '../utils/cost-estimator.js';
import { logger, safeForLog } from '../utils/logger.js';
import { createProgressEmitter } from '../utils/progress.js';
import { fallBackToAgentic } from './ask-agentic-fallback.js';
import { type AskInput, askInputSchema } from './ask/input.js';
import { SYSTEM_INSTRUCTION_Q_AND_A } from './ask/instruction.js';
import { type TextToolResult, type ToolDefinition, errorResult, textResult } from './registry.js';
import { isTimeoutAbort, timedOutCall, toolTimeoutController } from './shared/abort-timeout.js';
import { type DecodeTracking, decodeOnContext } from './shared/context-decode.js';
import { CompletedRequests } from './shared/continuation.js';
import { DispatchThrottle } from './shared/dispatch-throttle.js';
import {
  ServiceTierError,
  networkAttempts,
  resolveServiceTier,
  serviceTierConfig,
  statusOf,
  tierErrorMeta,
} from './shared/service-tier.js';
import { settleAnswer, settleFailure } from './shared/settle-call.js';
import { thinkingBudgetUnder, thinkingReserve } from './shared/thinking.js';

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

export { askInputSchema, type AskInput };

export const askTool: ToolDefinition<AskInput> = {
  name: 'ask',
  title: 'Ask Gemini',
  description:
    'Primary tool for codebase Q&A on workspaces that fit the model input-token limit (~1M tokens for Gemini Pro — covers most repos). Eager: the scanned workspace goes with the question (implicit caching by default; `cachingMode: "explicit"` builds a persistent Context Cache — measured ~8× faster and ~4× cheaper on repeat queries than sending the codebase inline). Falls back to `ask_agentic` automatically when the workspace exceeds the limit (set `onWorkspaceTooLarge: "fallback-to-agentic"`). For repos that genuinely exceed 1M tokens or when only a handful of files matter, call `ask_agentic` directly.',
  schema: askInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    const model = input.model ?? ctx.config.defaultModel;
    return executeAskBody(input, ctx, workspaceRoot, model, started);
  },
};

interface PreparedAttachments {
  readonly attached: Attachment[];
  readonly parts: Part[];
  /** Raw bytes read. */
  readonly bytes: number;
  /** What Gemini counted for the parts. */
  readonly tokens: number;
}

/** The attachments of one call: inspected, read and counted by Gemini, in that order — a refused file is never read,
 * a file that fails to read is never counted, and nothing has been reserved yet. */
async function prepareAttachments(
  client: Parameters<typeof countAttachmentTokens>[0],
  paths: readonly string[],
  workspaceRoot: string,
  model: string,
  signal: AbortSignal,
): Promise<PreparedAttachments> {
  const attached = await inspectAttachments(paths, workspaceRoot);
  const { parts, bytes } = await readAttachments(attached, signal);
  const tokens = await countAttachmentTokens(client, model, parts, signal);
  return { attached, parts, bytes, tokens };
}

type ResolvedAskModel = Awaited<ReturnType<typeof resolveModel>>;

/** The attachments of one call, or the refusal that ends it: a model without vision, a bad file (never retryable),
 * a count Gemini could not give. Nothing has been scanned or reserved yet. */
async function attachmentsOrRefusal(
  client: Parameters<typeof countAttachmentTokens>[0],
  paths: readonly string[],
  resolved: ResolvedAskModel,
  serviceTier: 'standard' | 'flex',
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<{ prepared: PreparedAttachments } | { refusal: TextToolResult }> {
  const meta = { serviceTier, resolvedModel: resolved.resolved };
  if (paths.length > 0 && !resolved.capabilities.supportsVision) {
    return {
      refusal: errorResult(
        `ask: ${paths.length} attachment(s) given, but ${safeForLog(resolved.resolved)} does not support vision — use \`latest-vision\` or a model that lists it`,
        { errorCode: 'ATTACHMENTS_UNSUPPORTED', retryable: false, ...meta },
      ),
    };
  }
  try {
    return {
      prepared: await prepareAttachments(client, paths, workspaceRoot, resolved.resolved, signal),
    };
  } catch (err) {
    if (!(err instanceof AttachmentError) && !(err instanceof AttachmentTokensUncountedError))
      throw err;
    return {
      refusal: errorResult(`ask: ${err.message}`, {
        errorCode: err.code,
        retryable: err.retryable,
        ...meta,
      }),
    };
  }
}

/** The bytes of one workspace file as the request carries it: its body and its `--- FILE: <relpath> ---` marker. */
const FILE_MARKER_BYTES = '\n\n--- FILE:  ---\n\n'.length;
function inlineFileBytes(files: readonly { relpath: string; size: number }[]): number {
  return files.reduce(
    (sum, f) => sum + f.size + Buffer.byteLength(f.relpath, 'utf8') + FILE_MARKER_BYTES,
    0,
  );
}

/** Google's inline request limit holds whatever the caching mode (an explicit cache may not be built and the call
 * then runs inline): the refusal, before any reservation, when a conservative size of the request — the attachments
 * encoded, the workspace bodies with their markers, the prompt, the system instruction, the JSON framing — crosses
 * it; nothing otherwise. */
function inlineRequestRefusal(
  prepared: PreparedAttachments,
  files: readonly { relpath: string; size: number }[],
  prompt: string,
  serviceTier: 'standard' | 'flex',
): TextToolResult | undefined {
  if (prepared.attached.length === 0) return undefined;
  const textBytes =
    inlineFileBytes(files) +
    Buffer.byteLength(prompt, 'utf8') +
    Buffer.byteLength(SYSTEM_INSTRUCTION_Q_AND_A, 'utf8');
  const requestBytes = inlineRequestBytes(
    prepared.attached.map((a) => a.bytes),
    textBytes,
    files.length + 2, // the prompt and the system instruction
  );
  if (requestBytes <= INLINE_REQUEST_LIMIT_BYTES) return undefined;
  return errorResult(
    `ask: the inline request would carry ${requestBytes} bytes (the attachments base64-encoded, the workspace with its file markers, the prompt, the system instruction and the JSON framing), above Google's ${INLINE_REQUEST_LIMIT_BYTES}-byte limit for inline data; use fewer or smaller attachments, or narrow the workspace with includeGlobs / excludeGlobs`,
    {
      errorCode: 'REQUEST_TOO_LARGE',
      retryable: false,
      serviceTier,
      ...attachmentMetadata(prepared),
    },
  );
}

/** `structuredContent` fields of a call with attachments; nothing on a call without. */
function attachmentMetadata(prepared: PreparedAttachments): Record<string, unknown> {
  if (prepared.attached.length === 0) return {};
  return {
    attachments: prepared.attached.map((a) => ({
      path: a.path,
      mimeType: a.mimeType,
      bytes: a.bytes,
    })),
    attachmentTokens: prepared.tokens,
  };
}

async function executeAskBody(
  input: AskInput,
  ctx: Parameters<typeof askTool.execute>[1],
  workspaceRoot: string,
  model: string,
  started: number,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  let reservationId: number | null = null;
  // Canonical resolved-model string, captured once after `resolveModel`
  // so the outer catch can feed retry hints into the same throttle bucket
  // `reserve` used. `model` at the top of execute is the request alias
  // ("latest-pro-thinking") — different key, different bucket.
  let resolvedModelKey: string | null = null;
  // every request that completed is billed: the ledger settles from these, on an answer and on a failure alike
  const completed = new CompletedRequests();
  // the running decode's booking and whether a stream opened (a later failure is then billed work, not re-sent)
  const tracking: DecodeTracking = { ledgerEntry: null, streamOpened: false };
  // the tier this call runs on once resolved (Vertex may force standard); before that, the requested one is reported
  let serviceTier: 'standard' | 'flex' | undefined;
  const reportedTier = (): 'standard' | 'flex' =>
    serviceTier ?? input.serviceTier ?? ctx.config.serviceTier;
  const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
  // Composite timeout controller — wall-clock-bound (`timeoutMs`) AND/OR
  // heartbeat-aware stall watchdog (`stallMs`, v1.12.0). Set up before any
  // await so a `timeoutMs: 1000` against a slow scan still fires. The
  // unified signal threads into both `withNetworkRetry({signal})` and the
  // SDK's `config.abortSignal` — whichever timer fires first aborts both
  // layers cleanly. `recordChunk()` is wired into `collectStream` to reset
  // the stall watchdog on every chunk arrival.
  const timeoutController = toolTimeoutController('ask', input);
  const abortSignal = timeoutController.signal;
  // Each request of the decode holds its own TPM reservation; a failure drops the one held.
  const dispatch = new DispatchThrottle({
    throttle: ctx.throttle,
    enabled: ctx.config.tpmThrottleLimit > 0,
    signal: abortSignal,
    emit: (message) => emitter.emit(message),
  });
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
    try {
      serviceTier = resolveServiceTier(
        input.serviceTier,
        ctx.config.serviceTier,
        ctx.config.vertex,
      );
    } catch (err) {
      if (!(err instanceof ServiceTierError)) throw err;
      return errorResult(`ask: ${err.message}`, {
        errorCode: err.code,
        retryable: false,
        serviceTier: 'flex',
        resolvedModel: resolved.resolved,
      });
    }

    // Attachments ride with the prompt as inline parts. Inspected, read and counted here — before the scan, the
    // preflight, the budget reservation and the throttle: a bad file costs nothing.
    const attachmentsOutcome = await attachmentsOrRefusal(
      ctx.client,
      input.attachments ?? [],
      resolved,
      serviceTier,
      workspaceRoot,
      abortSignal,
    );
    if ('refusal' in attachmentsOutcome) return attachmentsOutcome.refusal;
    const attachments = attachmentsOutcome.prepared;
    const attachmentTokens = attachments.tokens;

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

    // Output cap, three layers (`resolveOutputCap`):
    //
    //   1. `input.maxOutputTokens` (per-call, strongest) — clamped to the
    //      model's per-request limit, or on a model with long decode
    //      (Gemini 4) to its long-decode total: a cap above the per-request
    //      limit continues the decode in further requests.
    //   2. `ctx.config.forceMaxOutputTokens` (env override) — every call
    //      sends the model's per-request limit.
    //   3. Default — `maxOutputTokens` is omitted: one request, the model's
    //      own default (its advertised `outputTokenLimit`), letting the model
    //      size the response to the query rather than reserving full capacity.
    //
    // The caller's `thinkingBudget` is checked against `outputCap`; the
    // clamp and the reservation use the cap that runs (`runCap`).
    const outputCap = resolveOutputCap({
      requested: input.maxOutputTokens,
      forceMax: ctx.config.forceMaxOutputTokens,
      outputTokenLimit: resolved.outputTokenLimit,
      longDecodeTokenLimit: resolved.longDecodeTokenLimit,
      fallbackLimit: ASK_MAX_OUTPUT_TOKENS_FALLBACK,
    });

    // Single source of truth for "is the caller driving reasoning via the
    // discrete-tier knob?". Three downstream call sites branch on this
    // (cost estimate, emitter, thinkingConfig build) — extracting to a
    // named const keeps them in lockstep and makes future additions hard
    // to forget.
    const usingThinkingLevel = input.thinkingLevel !== undefined;

    // A positive `thinkingBudget` that leaves no answer reserve under the caller's own cap is refused
    // (`thinkingBudgetRefusal`); below, the budget on the wire is clamped under the cap that runs.
    const budgetRefusal = thinkingBudgetRefusal(
      input.thinkingBudget,
      input.maxOutputTokens,
      outputCap.effective,
    );
    if (budgetRefusal !== null) return errorResult(`ask: ${budgetRefusal}`);

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
    const estimatedInputTokens =
      Math.ceil(workspaceBytes / 4) + Math.ceil(input.prompt.length / 4) + attachmentTokens;
    const inlineRefusal = inlineRequestRefusal(attachments, scan.files, input.prompt, serviceTier);
    if (inlineRefusal !== undefined) return inlineRefusal;

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
    // A decode that may take more than one request takes the exact count: its prompt is billed per request.
    const preflightMode = preflightModeFor(input.preflightMode, outputCap);
    if (typeof contextWindow === 'number' && contextWindow > 0) {
      preflight = await countForPreflight(ctx.client, {
        files: scan.files,
        prompt: input.prompt,
        model: resolved.resolved,
        // `filesHash` is post-glob-filter (see `scanWorkspace`), so it
        // already encodes user-supplied includeGlobs/excludeGlobs — no
        // separate globsHash axis needed in the cache key.
        filesHash: scan.filesHash,
        ...(preflightMode !== undefined ? { preflightMode } : {}),
        inputTokenLimit: contextWindow,
        extraTokens: attachmentTokens, // weighs on the heuristic-vs-exact decision, added to the count below
        // Thread the user's `timeoutMs` AbortSignal so a hung countTokens
        // call doesn't bleed past the user's stated wall-clock budget. The
        // SDK's `CountTokensConfig` accepts `abortSignal`; on cancellation
        // the SDK throws `AbortError`, which `countForPreflight` re-throws
        // (rather than swallowing as a fallback) so this outer try/catch
        // maps it to `errorCode: 'TIMEOUT'` immediately.
        signal: abortSignal,
      });
      // the attachments' tokens, counted by Gemini, join the count whichever way it was made: the window must hold them
      preflight = { ...preflight, effectiveTokens: preflight.effectiveTokens + attachmentTokens };
      const threshold = Math.floor(contextWindow * ctx.config.workspaceGuardRatio);
      if (preflight.effectiveTokens > threshold) {
        const pctDisplay = Math.round(ctx.config.workspaceGuardRatio * 100);

        // v1.11.0 — opt-in transparent fallback to `ask_agentic` when the
        // caller explicitly asked for it via `onWorkspaceTooLarge:
        // 'fallback-to-agentic'`. Default stays `'error'` so pre-v1.11.0
        // callers see identical behaviour. The fallback re-uses this
        // tool's resolved inputs (model / globs / thinking config /
        // workspace) and forwards its resolved `timeoutMs` as `iterationTimeoutMs`
        // (per-iteration cap; total wall-clock can be N × that) and `stallMs` as
        // `stallMs` (`ask-agentic-fallback.ts`). Cost + timing shape genuinely
        // changes — opt-in is the right default.
        if (
          input.onWorkspaceTooLarge === 'fallback-to-agentic' &&
          attachments.attached.length > 0
        ) {
          return errorResult(
            'ask: the workspace is too large for the eager path and `attachments` cannot follow the ask_agentic fallback (it sends no inline parts); drop the attachments or narrow the workspace',
            {
              errorCode: 'WORKSPACE_TOO_LARGE',
              retryable: false,
              serviceTier,
              ...attachmentMetadata(attachments),
            },
          );
        }
        if (input.onWorkspaceTooLarge === 'fallback-to-agentic') {
          return fallBackToAgentic({
            input,
            ctx,
            emitter,
            serviceTier,
            preflight,
            threshold,
            timeout: timeoutController,
          });
        }

        const attachmentsNote =
          attachments.attached.length > 0
            ? ' — it carries no attachments: drop them, or narrow the workspace and ask again'
            : '';

        return errorResult(
          `Workspace too large: ~${preflight.effectiveTokens.toLocaleString()} input tokens (${preflight.method} count) exceeds ${threshold.toLocaleString()} (${pctDisplay}% of ${resolved.resolved}'s ${contextWindow.toLocaleString()} context window). Best option: use \`mcp__gemini-code-context__ask_agentic\` — same model, but it reads only the files it needs via sandboxed tool calls (no eager repo upload)${attachmentsNote}. Or set \`onWorkspaceTooLarge: 'fallback-to-agentic'\` on \`ask\` to have the server route automatically. Other options: (a) pass \`excludeGlobs\` to filter large/generated files — supports \`*.ext\` patterns, filenames, and directory paths, (b) narrow with \`includeGlobs\`, (c) switch to a larger-context model, or (d) split the workspace into subdirectories.`,
          {
            errorCode: 'WORKSPACE_TOO_LARGE',
            serviceTier,
            ...attachmentMetadata(attachments),
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

    const { cap: runCap, cut: inputWindowCut } = capThatRuns({
      tool: 'ask',
      cap: outputCap,
      promptTokens: preflight?.effectiveTokens,
      inputTokenLimit: contextWindow,
      emit: (message) => emitter.emit(message),
    });

    // Normalise thinkingBudget:
    //   undefined → null (model-default path — `thinkingBudget` OMITTED on wire)
    //   -1        → -1  (explicit legacy dynamic; kept for Gemini 2.5 and
    //                    power-users who want to force the legacy path)
    //    0        →  0  (thinking disabled; Gemini 3 Pro will 400 here)
    //    N > 0    → clamp to [0, cap that runs - 1024] — the thinking
    //              pool is carved out of the candidate-output allowance,
    //              so reserving ≥1024 tokens for the answer prevents 400s
    //              when a caller passes N ≥ maxOutputTokens, and under a
    //              cap the input window cut to one request (its value on
    //              the wire) the budget stays below it.
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
            ? thinkingBudgetUnder(runCap, rawThinkingBudget)
            : 0;
    // The thinking the budget reservation counts, from the cap that runs.
    const thinkingTokensForEstimate = thinkingReserve(
      input.thinkingLevel,
      effectiveThinkingBudget,
      runCap,
    );

    // Atomic budget reservation. Happens AFTER scan (so the estimate is
    // accurate) but BEFORE any billable upload or generateContent call.
    // Concurrent tool calls cannot all pass a pre-check and then
    // collectively overshoot the cap: `reserveBudget` uses a
    // `BEGIN IMMEDIATE` SQLite transaction that serialises check-and-insert.
    if (Number.isFinite(ctx.config.dailyBudgetUsd)) {
      const estimateUsd = estimatePreCallCostUsd({
        model: resolved.resolved,
        serviceTier,
        extraInputTokens: attachmentTokens,
        workspaceBytes,
        promptChars: input.prompt.length,
        // Budget reservation uses the effective cap (explicit-user-cap
        // OR model's full limit) as `expectedOutputTokens` — a TRUE
        // upper bound, since Gemini's default stops at the model's
        // advertised `outputTokenLimit`.
        expectedOutputTokens: runCap.effective,
        // A cap above the per-request limit (long decode) adds the input every continuation request bills again.
        perRequestOutputTokens: runCap.perRequest,
        // The preflight's count, when it ran: the reservation takes the larger of it and the bytes/4 heuristic.
        countedInputTokens: preflight?.effectiveTokens,
        thinkingTokens: thinkingTokensForEstimate,
        coverMs: timeoutController.timeoutMs,
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
          { errorCode: 'BUDGET_REJECT', retryable: false, serviceTier },
        );
      }
      reservationId = reserve.id;
    }

    const systemPromptHash = createHash('sha256')
      .update(SYSTEM_INSTRUCTION_Q_AND_A)
      .digest('hex')
      .slice(0, 16);

    // v1.14.0 — `cachingMode` default flipped to `'implicit'`: Gemini 2.5+/3
    // Pro applies its automatic implicit caching to repeated workspace prefixes,
    // eliminating the 60–180 s `caches.create` rebuild wait on the
    // review→edit→review path. Per-call `input.cachingMode` always wins;
    // env-level override `GEMINI_CODE_CONTEXT_CACHING_MODE` lets operators force
    // `'explicit'` when they need predictable per-call billing more than
    // warm-path speed. Telemetry on the actual mode (vs requested) is computed
    // AFTER `prepareContext` returns from `activePrep.inlineOnly` — see FN2 fix.
    const caching = cachingModeFor(input.cachingMode ?? ctx.config.cachingMode, resolved, emitter);
    const requestedCachingMode = caching.mode;

    // The context of the call: built here, and again by the stale-cache retry on a fresh cache.
    const prepare = () =>
      prepareContext({
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
        cachingMode: requestedCachingMode,
      });
    const ctxPrep = await prepare();

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
    // reservation always uses the cap the decode runs under (explicit cap
    // OR model limit, cut by the input window on a long decode) as the
    // worst-case upper bound of what a completed request bills.
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
    const tierField = serviceTierConfig(serviceTier);
    const buildConfig = (cacheId: string | null): GenerateContentConfig => {
      const maxOutputField = runCap.wire !== undefined ? { maxOutputTokens: runCap.wire } : {};
      return cacheId
        ? { cachedContent: cacheId, thinkingConfig, ...maxOutputField, ...tierField }
        : {
            systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
            thinkingConfig,
            ...maxOutputField,
            ...tierField,
          };
    };
    // The user turn: the attachments first, the question last; with a cache the turn still carries the parts.
    const userTurn: Content = {
      role: 'user',
      parts: [...attachments.parts, { text: input.prompt }],
    };
    const buildContents = (
      cacheId: string | null,
      inline: typeof ctxPrep.inlineContents,
    ): string | Content[] => {
      if (cacheId) return attachments.parts.length === 0 ? input.prompt : [userTurn];
      return [...inline, userTurn];
    };

    // The decode — and, on a stale cache before any request completed, its one retry on a rebuilt cache. The TPM
    // reservation is taken here, after `prepareContext` and immediately before the first request, so its timestamp
    // is when the tokens reach Gemini's quota counter; only the OPENING of a request is retried (a mid-stream
    // failure re-sent would bill the work again).
    const decoded = await decodeOnContext(
      {
        client: ctx.client,
        booking: { workspaceRoot, toolName: 'ask', model: resolved.resolved, serviceTier },
        cachingMode: (prep) => cachingRan(prep, caching).mode,
        request: (prep) => ({
          contents: buildContents(prep.cacheId, prep.inlineContents),
          config: buildConfig(prep.cacheId),
        }),
        cache: {
          ttlWatcher: ctx.ttlWatcher,
          manifest: ctx.manifest,
          ttlSeconds: ctx.config.cacheTtlSeconds,
          prepare,
        },
        openAttempts: networkAttempts(serviceTier), // a flex request is never re-sent
        limits: { maxRequests: runCap.maxRequests, cap: runCap.effective },
        timeout: timeoutController,
        emit: (message) => emitter.emit(message),
        completed,
        tracking,
        throttle: dispatch,
        inputTokens: { estimated: estimatedInputTokens, counted: preflight?.effectiveTokens },
      },
      ctxPrep,
    );
    const { response, prep: activePrep, retriedOnStaleCache } = decoded;

    const text = response.text;

    // `collectStream` already aggregated thought-flagged parts and capped
    // the joined summary at 1200 chars (T20). Reuse directly — re-iterating
    // `response.candidates` would risk drift between in-flight thought
    // emit (live progress) and post-call summary.
    const thinkingSummary = response.thoughtsSummary;

    // Telemetry and the response record the mode that ran, not the one asked for.
    const ran = cachingRan(activePrep, caching);
    const effectiveCachingMode = ran.mode;

    const durationMs = Date.now() - started;
    // Settled here, once: the outer catch then neither releases the reservation nor books the call again. What the
    // API billed is every request that completed, over a long decode and a stale-cache retry alike.
    const settledReservation = reservationId;
    reservationId = null;
    tracking.ledgerEntry = null;
    const settled = settleAnswer({
      manifest: ctx.manifest,
      reservationId: settledReservation,
      entry: {
        workspaceRoot,
        toolName: 'ask',
        model: resolved.resolved,
        serviceTier,
        cachingMode: effectiveCachingMode,
      },
      completed,
      response,
      cap: runCap,
      cut: inputWindowCut,
      durationMs,
    });
    const finish = settled.finish;

    // Settled and billed above; an empty answer at the cap is a failure the caller can act on, never a success.
    if (settled.outputCapStop !== null) {
      return errorResult(`ask: ${settled.outputCapStop.message}`, settled.outputCapStop.fields);
    }

    if (scan.truncated) {
      logger.warn(
        `workspace ${workspaceRoot} contains more files than GEMINI_CODE_CONTEXT_MAX_FILES (${ctx.config.maxFilesPerWorkspace}); the tail was dropped before indexing.`,
      );
    }

    const metadata: Record<string, unknown> = {
      resolvedModel: resolved.resolved,
      requestedModel: resolved.requested,
      serviceTier,
      ...attachmentMetadata(attachments),
      fallbackApplied: resolved.fallbackApplied,
      modelCategory: resolved.category,
      modelCostTier: resolved.capabilities.costTier,
      contextWindow: resolved.inputTokenLimit,
      thinkingBudget: effectiveThinkingBudget,
      thinkingLevel: input.thinkingLevel ?? null,
      ...settled.usage,
      ...settled.cutFields,
      // `truncated`: the answer stopped at the output cap (MAX_TOKENS, or a long decode at its limits) — it is cut
      finishReason: finish.finishReason,
      truncated: finish.truncated,
      cacheHit: activePrep.reused,
      cacheRebuilt: activePrep.rebuilt || retriedOnStaleCache,
      retriedOnStaleCache,
      inlineOnly: activePrep.inlineOnly,
      cachingMode: effectiveCachingMode,
      ...(ran.note !== null ? { cachingModeNote: ran.note } : {}),
      filesIndexed: scan.files.length,
      filesSkippedTooLarge: scan.skippedTooLarge,
      // v1.21.0+: what the scan left out — the excluded directories it met and the files that are neither source by
      // extension nor a `#!` script — so a caller can tell "not in the workspace" from "not indexed".
      excludedDirs: scan.excludedDirs,
      excludedDirsTotal: scan.excludedDirsTotal,
      filesSkippedNonSource: scan.skippedNonSource,
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
    // A 429's retry hint seeds the throttle; the ledger keeps what the completed requests billed and releases the rest
    // of the reservation (all of it when none completed); their usage goes into the error result.
    const failedUsage = settleFailure({
      manifest: ctx.manifest,
      failed: {
        toolName: 'ask',
        reservationId,
        entry: tracking.ledgerEntry,
        completed,
        durationMs: Date.now() - started,
      },
      err,
      model: resolvedModelKey,
      throttle: ctx.throttle,
      dispatch,
    });
    reservationId = null;
    // Timeout-driven abort gets a dedicated errorCode so callers can
    // distinguish "Gemini was slow" from "schema invalid" / "auth failed".
    // v1.12.0 — `timeoutKind` ('total' | 'stall') distinguishes the
    // wall-clock cap from the heartbeat-aware stall watchdog so callers
    // can apply different policies (e.g. retry on stall but not on total).
    if (isTimeoutAbort(err)) {
      const timedOut = timedOutCall('ask', err, timeoutController);
      emitter.emit(`ask: aborted after ${timedOut.limitMs ?? '?'}ms ${timedOut.kind}`);
      return errorResult(timedOut.message, {
        errorCode: 'TIMEOUT',
        timeoutKind: timedOut.kind,
        timeoutMs: timeoutController.timeoutMs,
        stallMs: timeoutController.stallMs,
        retryable: true,
        serviceTier: reportedTier(),
        ...failedUsage,
      });
    }
    const httpStatus = statusOf(err);
    return errorResult(`ask failed: ${err instanceof Error ? err.message : String(err)}`, {
      ...tierErrorMeta(err, tracking.streamOpened),
      serviceTier: reportedTier(),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...failedUsage,
    });
  } finally {
    timeoutController.dispose();
    emitter.stop();
  }
}
