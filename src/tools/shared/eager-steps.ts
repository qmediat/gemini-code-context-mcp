/**
 * The steps of an `ask` / `code` call before its context that both tools run the same way. Each returns values or a
 * refusal for its tool to report; every result keeps its tool's own fields and their order.
 */

import {
  type OutputCap,
  type PreflightMode,
  preflightModeFor,
  resolveOutputCap,
} from '../../gemini/long-decode.js';
import { type PreflightTokenResult, countForPreflight } from '../../gemini/token-counter.js';
import { type ScanResult, buildScanMemo, scanWorkspace } from '../../indexer/workspace-scanner.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../../indexer/workspace-validation.js';
import type { ResolvedModel } from '../../types.js';
import { estimatePreCallCostUsd, toMicrosUsd } from '../../utils/cost-estimator.js';
import { logger, safeForLog } from '../../utils/logger.js';
import { type TextToolResult, type ToolContext, errorResult } from '../registry.js';
import type { TimedTool } from './abort-timeout.js';
import type { EagerCall, ModelReached } from './eager-call.js';
import type { ServiceTierName } from './service-tier.js';

/**
 * The refusal of a workspace path the validation rejects (`<tool>: <message>`, no fields), else `null`. Called inside
 * the call's `try`: any other error of the validation reaches the call's failure path.
 */
export function workspaceRefusal(tool: TimedTool, workspaceRoot: string): TextToolResult | null {
  try {
    validateWorkspacePath(workspaceRoot);
  } catch (err) {
    if (err instanceof WorkspaceValidationError) {
      return errorResult(`${tool}: ${err.message}`);
    }
    throw err;
  }
  return null;
}

/** The caller's narrowing of the workspace scan: the knobs of both tools' input, read from it as it is. */
export interface ScanFilters {
  readonly includeGlobs?: readonly string[] | undefined;
  readonly excludeGlobs?: readonly string[] | undefined;
  readonly forceRescan?: boolean | undefined;
}

/**
 * Scan the call's workspace. The scan memo, built from the stored file rows, lets the scanner skip re-hashing a file
 * whose mtime and size are unchanged (a new workspace has none: every file hashes); `forceRescan` per call or by the
 * operator bypasses it.
 */
export function scanForCall(
  call: EagerCall<ModelReached>,
  ctx: ToolContext,
  filters: ScanFilters,
): Promise<ScanResult> {
  call.emitter.emit(`scanning workspace ${call.workspaceRoot}…`);
  const scanMemo = buildScanMemo(ctx.manifest.getFiles(call.workspaceRoot));
  return scanWorkspace(call.workspaceRoot, {
    ...(filters.includeGlobs !== undefined ? { includeGlobs: filters.includeGlobs } : {}),
    ...(filters.excludeGlobs !== undefined ? { excludeGlobs: filters.excludeGlobs } : {}),
    maxFiles: ctx.config.maxFilesPerWorkspace,
    maxFileSizeBytes: ctx.config.maxFileSizeBytes,
    manifestMemo: scanMemo,
    forceRescan: filters.forceRescan === true || ctx.config.forceRescan === true,
  });
}

/** The output cap of a model that advertises no `outputTokenLimit`: the pro-tier ceiling, the model's full capacity. */
export const EAGER_OUTPUT_FALLBACK_TOKENS = 65_536;

/**
 * The output cap, in three layers (`resolveOutputCap`): the caller's `maxOutputTokens` (clamped to the model's
 * per-request limit, or on a long-decode model to its long-decode total), else the operator's `forceMaxOutputTokens`
 * (the per-request limit on every call), else none on the wire — one request at the model's own default. A caller's
 * `thinkingBudget` is checked against this cap; the clamp and the reservation use the cap that runs (`capThatRuns`).
 */
export function eagerOutputCap(
  requested: number | undefined,
  ctx: ToolContext,
  resolved: ResolvedModel,
): OutputCap {
  return resolveOutputCap({
    requested,
    forceMax: ctx.config.forceMaxOutputTokens,
    outputTokenLimit: resolved.outputTokenLimit,
    longDecodeTokenLimit: resolved.longDecodeTokenLimit,
    fallbackLimit: EAGER_OUTPUT_FALLBACK_TOKENS,
  });
}

/** The call's input as the budget and the TPM throttle estimate it, before any count. */
export interface InputEstimate {
  readonly workspaceBytes: number;
  /** bytes/4 of the workspace and the prompt, plus the extra tokens: what the TPM reservation holds. */
  readonly tokens: number;
}

/** One estimate for both the budget reservation and the TPM reservation, so the two never drift apart. */
export function estimateInput(
  scan: ScanResult,
  prompt: string,
  extraTokens: number,
): InputEstimate {
  const workspaceBytes = scan.files.reduce((sum, f) => sum + f.size, 0);
  return {
    workspaceBytes,
    tokens: Math.ceil(workspaceBytes / 4) + Math.ceil(prompt.length / 4) + extraTokens,
  };
}

/** What the preflight counts. */
export interface PreflightRequest {
  readonly scan: ScanResult;
  readonly prompt: string;
  readonly resolved: ResolvedModel;
  readonly mode: PreflightMode | undefined;
  /** The cap asked for: a cap that may take more than one request takes the exact count (`preflightModeFor`). */
  readonly cap: OutputCap;
  /** Tokens beyond the files and the prompt, counted by Gemini (`ask`'s attachments; 0 for `code`). */
  readonly extraTokens: number;
}

/** The preflight's count and the window it is held against. */
export interface PreflightCount {
  /** The count, the extra tokens included: the window must hold them whichever way the count was made. */
  readonly preflight: PreflightTokenResult;
  readonly contextWindow: number;
  /** `contextWindow × workspaceGuardRatio`: a count above it is too large for the eager path. */
  readonly threshold: number;
}

/**
 * Count the call's input against the model's advertised input limit (`countForPreflight`: the bytes/4 heuristic well
 * under the limit, Gemini's `countTokens` near it, under the call's signal so a timeout ends the count). `null` when
 * the model advertises no limit: the guard is skipped with a warning, and the request may fail downstream.
 */
export async function countPreflight(
  call: EagerCall<ModelReached>,
  ctx: ToolContext,
  req: PreflightRequest,
): Promise<PreflightCount | null> {
  const contextWindow = req.resolved.inputTokenLimit;
  const preflightMode = preflightModeFor(req.mode, req.cap);
  if (typeof contextWindow !== 'number' || contextWindow <= 0) {
    logger.warn(
      `${call.tool}: resolved model ${safeForLog(req.resolved.resolved)} has no advertised inputTokenLimit — workspace size guard skipped. Request may fail downstream if the workspace exceeds the model's context window.`,
    );
    return null;
  }
  const counted = await countForPreflight(ctx.client, {
    files: req.scan.files,
    prompt: req.prompt,
    model: req.resolved.resolved,
    // post-glob-filter: the hash already encodes the caller's include / exclude globs
    filesHash: req.scan.filesHash,
    ...(preflightMode !== undefined ? { preflightMode } : {}),
    inputTokenLimit: contextWindow,
    extraTokens: req.extraTokens, // weighs on the heuristic-vs-exact decision, added to the count below
    signal: call.timeout.signal,
  });
  return {
    preflight: { ...counted, effectiveTokens: counted.effectiveTokens + req.extraTokens },
    contextWindow,
    threshold: Math.floor(contextWindow * ctx.config.workspaceGuardRatio),
  };
}

/** A count over the window: the workspace is too large for the eager path. */
export interface OverWindow {
  /** The count, the extra tokens included. */
  readonly counted: PreflightTokenResult;
  readonly contextWindow: number;
  readonly threshold: number;
  /** `workspaceGuardRatio` as a whole percent, as the refusal says it. */
  readonly pctDisplay: number;
}

/**
 * The guard's verdict on the count: the values a refusal reports when the count passed the threshold, else `null` —
 * the count fits, or the model advertises no input limit (the guard did not run). Each tool composes its own refusal.
 */
export function overWindow(count: PreflightCount | null, ctx: ToolContext): OverWindow | null {
  if (count !== null && count.preflight.effectiveTokens > count.threshold) {
    return {
      counted: count.preflight,
      contextWindow: count.contextWindow,
      threshold: count.threshold,
      pctDisplay: Math.round(ctx.config.workspaceGuardRatio * 100),
    };
  }
  return null;
}

/** What the daily-budget reservation is estimated from. */
export interface ReservationRequest {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
  readonly estimate: InputEstimate;
  readonly promptChars: number;
  /** Input tokens beyond the files and the prompt (`ask`'s attachments; 0 for `code`). */
  readonly extraInputTokens: number;
  /** The cap that runs: its value bounds what a completed request bills; above the per-request limit (a long decode)
   * every continuation request bills the input again. */
  readonly cap: OutputCap;
  /** The preflight's count, when it ran: the reservation takes the larger of it and the bytes/4 heuristic. */
  readonly countedInputTokens: number | undefined;
  readonly thinkingTokens: number;
}

/** How the reservation ended. */
export type ReservationOutcome =
  /** No daily cap: nothing reserved. */
  | { readonly kind: 'unbounded' }
  /** Reserved: the call's trail holds the id. */
  | { readonly kind: 'reserved' }
  /** The cap would be exceeded: nothing reserved; the message is the same for both tools. */
  | { readonly kind: 'rejected'; readonly message: string };

/**
 * Reserve the call's worst case against the daily budget: after the scan (the estimate needs it), before anything
 * billable. `reserveBudget` checks and inserts in one `BEGIN IMMEDIATE` transaction, so concurrent calls cannot all
 * pass the check and overshoot the cap together. The id goes into the call's trail at once: no statement comes
 * between a reservation and its owner.
 */
export function reserveCallBudget(
  call: EagerCall<ModelReached>,
  ctx: ToolContext,
  req: ReservationRequest,
): ReservationOutcome {
  const dailyBudgetUsd = ctx.config.dailyBudgetUsd;
  if (!Number.isFinite(dailyBudgetUsd)) return { kind: 'unbounded' };
  const estimateUsd = estimatePreCallCostUsd({
    model: req.resolved.resolved,
    serviceTier: req.serviceTier,
    extraInputTokens: req.extraInputTokens,
    workspaceBytes: req.estimate.workspaceBytes,
    promptChars: req.promptChars,
    expectedOutputTokens: req.cap.effective,
    perRequestOutputTokens: req.cap.perRequest,
    countedInputTokens: req.countedInputTokens,
    thinkingTokens: req.thinkingTokens,
    coverMs: call.timeout.timeoutMs,
  });
  const reserve = ctx.manifest.reserveBudget({
    workspaceRoot: call.workspaceRoot,
    toolName: call.tool,
    model: req.resolved.resolved,
    estimatedCostMicros: toMicrosUsd(estimateUsd),
    dailyBudgetMicros: toMicrosUsd(dailyBudgetUsd),
    nowMs: Date.now(),
  });
  if ('rejected' in reserve) {
    const spentUsd = reserve.spentMicros / 1_000_000;
    return {
      kind: 'rejected',
      message: `Daily budget cap would be exceeded: spent $${spentUsd.toFixed(4)} + estimate $${estimateUsd.toFixed(4)} > cap $${dailyBudgetUsd.toFixed(2)}. Retry after UTC midnight, or raise \`GEMINI_DAILY_BUDGET_USD\`.`,
    };
  }
  call.trail.reservationId = reserve.id;
  return { kind: 'reserved' };
}
