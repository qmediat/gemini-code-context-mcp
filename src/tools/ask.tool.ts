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
import { z } from 'zod';
import {
  type Attachment,
  AttachmentError,
  AttachmentTokensUncountedError,
  INLINE_REQUEST_LIMIT_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
  countAttachmentTokens,
  inlineRequestBytes,
  inspectAttachments,
  readAttachments,
} from '../attachments.js';
import { prepareContext } from '../cache/cache-manager.js';
import {
  CACHING_MODE_FALLBACK_DESCRIPTION,
  cachingModeFor,
  cachingRan,
} from '../cache/caching-mode.js';
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
import { type AskAgenticInput, askAgenticTool } from './ask-agentic.tool.js';
import { type TextToolResult, type ToolDefinition, errorResult, textResult } from './registry.js';
import { createTimeoutController, isTimeoutAbort, timedOutCall } from './shared/abort-timeout.js';
import { type DecodeTracking, decodeOnContext } from './shared/context-decode.js';
import { CompletedRequests, LONG_DECODE_CAP_DESCRIPTION } from './shared/continuation.js';
import { DispatchThrottle } from './shared/dispatch-throttle.js';
import { PROMPT_FIELD, WORKSPACE_FIELD } from './shared/question-fields.js';
import {
  SERVICE_TIER_DESCRIPTION,
  ServiceTierError,
  networkAttempts,
  resolveServiceTier,
  serviceTierConfig,
  statusOf,
  tierErrorMeta,
} from './shared/service-tier.js';
import { settleAnswer, settleFailure } from './shared/settle-call.js';
import { SYSTEM_INSTRUCTION_SAFETY_EAGER } from './shared/system-instruction-safety.js';
import { THINKING_LEVEL_FIELD, thinkingBudgetUnder, thinkingReserve } from './shared/thinking.js';

/**
 * `ask` system instruction. Prepends the shared `SYSTEM_INSTRUCTION_SAFETY_EAGER`
 * data-vs-instruction firewall (added in v1.15.2 — pre-v1.15.2 `ask` had no
 * safety rules at all, leaving it open to indirect prompt injection via
 * adversarial workspace file content; same risk profile as v1.14.4 A1' for
 * `ask_agentic`'s rescue path, just for the eager workspace upload channel).
 *
 * The role-statement after the safety block is the original v1.0 wording —
 * task-specific guidance lives there; cross-tool security boundaries live
 * in the shared safety block above.
 */
const SYSTEM_INSTRUCTION_Q_AND_A = [
  SYSTEM_INSTRUCTION_SAFETY_EAGER,
  '',
  'You are a senior software engineer analysing a codebase. Be precise, reference specific file paths and line numbers, and cite evidence from the provided files rather than guessing. If the answer is not derivable from the context, say so.',
].join('\n');

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
    prompt: PROMPT_FIELD,
    workspace: WORKSPACE_FIELD,
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
    thinkingLevel: THINKING_LEVEL_FIELD,
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        [
          "Per-call opt-in cap on response length (tokens). OMIT for the default 'auto' behaviour — Gemini uses its model-default cap (per Google docs, equal to the model's advertised `outputTokenLimit`: 65,536 for Gemini 3.x / 2.5 Pro-tier; see ai.google.dev/gemini-api/docs/models/gemini-2.5-pro). Pass a smaller value when you want a bounded response (e.g. strict summary length, tighter budget per call). On any other model a value larger than the resolved model's limit is clamped down to it. Budget reservation always uses the effective cap (explicit OR model limit) as worst-case, so `GEMINI_DAILY_BUDGET_USD` bounds what a completed call books (a request aborted mid-stream is booked 0: docs/cost-model.md).",
          LONG_DECODE_CAP_DESCRIPTION,
        ].join(' '),
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .optional()
      .describe(
        'Per-call wall-clock TOTAL timeout in ms (1s–30min). The cost ceiling — aborts the in-flight `generateContent` request even if it is actively streaming. A request aborted after its stream opened is booked 0; whether Google bills it is not measured (docs/cost-model.md). When omitted, falls back to env var `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`, then to disabled. v1.12.0 RECOMMENDATION: prefer `stallMs` for liveness — `timeoutMs` is the cost cap, `stallMs` is the heartbeat-aware liveness watchdog that does NOT fire while the model is actively thinking. Both can be set simultaneously. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "total"` on abort.',
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
    serviceTier: z.enum(['standard', 'flex']).optional().describe(SERVICE_TIER_DESCRIPTION),
    attachments: z
      .array(z.string().min(1)) // the count cap is inspectAttachments' (ATTACHMENT_INVALID), not the schema's
      .optional()
      .describe(
        `Local image or PDF files (png, jpg, jpeg, webp, pdf; up to ${MAX_ATTACHMENTS}, ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each, ${MAX_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024} MB together) sent inline before the question — a screenshot of the bug, a diagram, a spec. Paths are inside the workspace (relative to it or absolute; a symlink is refused, the sandbox's secret rules apply, the first bytes must match the type). They belong to THIS question only, never to the workspace cache. Their tokens are counted by Gemini (one free countTokens call) and enter the size preflight, the budget reservation and the TPM throttle; a count that cannot be obtained refuses the call (ATTACHMENT_TOKENS_UNCOUNTED — retryable after a transient failure: no status, 429, 5xx; not after 401/403/404; a 400 means Gemini refused the parts: ATTACHMENT_INVALID). The model must support vision (ATTACHMENTS_UNSUPPORTED otherwise); a bad file is ATTACHMENT_INVALID, never retryable, and costs nothing. Not available with the ask_agentic fallback.`,
      ),
    cachingMode: z
      .enum(['explicit', 'implicit'])
      .optional()
      .describe(
        `Cache strategy for the workspace context. **\`'implicit'\` (default since v1.14.0)** skips \`caches.create\` entirely; file content is sent inline every call and Gemini 2.5+/3 Pro applies its automatic implicit caching on the repeated workspace prefix when prefix matches across calls. Optimised for the review→edit→review workflow — no 60–180 s rebuild wait when files change between queries. **\`'explicit'\`** builds a Gemini Context Cache via \`caches.create\` — guaranteed ~75% discount on cached input tokens, but pays the rebuild cost on every file change. Use explicit when you need predictable per-call costs more than warm-path latency; the trade-off is documented in Gemini's docs as 'no cost saving guarantee' for implicit caching. Hit rate is observable via \`status.structuredContent.caching.implicitHitRate\`. Operator-level override available via env \`GEMINI_CODE_CONTEXT_CACHING_MODE\`.${CACHING_MODE_FALLBACK_DESCRIPTION}`,
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
  const timeoutController = createTimeoutController({
    ...(input.timeoutMs !== undefined ? { totalMs: input.timeoutMs } : {}),
    totalEnvVar: 'GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS',
    ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
    stallEnvVar: 'GEMINI_CODE_CONTEXT_ASK_STALL_MS',
  });
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
        // workspace) and re-translates `timeoutMs` to `iterationTimeoutMs`
        // (per-iteration cap; total wall-clock can be N × that). Cost +
        // timing shape genuinely changes — opt-in is the right default.
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
          if (serviceTier === 'flex') {
            const note =
              'ask: the ask_agentic fallback has no service tier — this call runs standard, not flex';
            emitter.emit(note);
            logger.warn(note);
          }
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
            serviceTier: 'standard', // ask_agentic has no tier: the fallback runs standard whatever was asked
            ...(serviceTier === 'flex' ? { serviceTierDowngraded: 'flex' } : {}),
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
