/**
 * The answer of an `ask` / `code` call: its context, prepared once and again by the stale-cache retry. Each result
 * keeps its tool's own fields and their order.
 */

import { createHash } from 'node:crypto';
import { type PreparedContext, prepareContext } from '../../cache/cache-manager.js';
import {
  type CachingModeChoice,
  type RanCaching,
  cachingModeFor,
  cachingRan,
} from '../../cache/caching-mode.js';
import type { BoundedOutputCap, OutputCap } from '../../gemini/long-decode.js';
import type { ScanResult } from '../../indexer/workspace-scanner.js';
import type { ResolvedModel } from '../../types.js';
import { logger } from '../../utils/logger.js';
import type { ToolContext } from '../registry.js';
import { type ContextDecode, type ContextRequest, decodeOnContext } from './context-decode.js';
import type { EagerCall, ModelReached } from './eager-call.js';
import type { InputEstimate } from './eager-steps.js';
import { type ServiceTierName, networkAttempts } from './service-tier.js';
import { type SettledAnswer, settleAnswer } from './settle-call.js';

/** What the call's context is built from. */
export interface ContextSpec {
  readonly scan: ScanResult;
  readonly resolved: ResolvedModel;
  /** The tool's system instruction: baked into a cache, or sent with each request without one. */
  readonly systemInstruction: string;
  /** `false` forces the files inline (no cache built): `ask`'s `noCache`, `code`'s `codeExecution`, no files. */
  readonly allowCaching: boolean;
  /** The caching mode asked for: per call, else the operator's. */
  readonly requestedMode: 'explicit' | 'implicit';
}

/** The call's context and how to build it again. */
export interface CallContext {
  /** The mode the call runs with, and why it differs from the one asked for. */
  readonly caching: CachingModeChoice;
  /** Builds the context again, with the same arguments: the stale-cache retry calls it on a fresh cache. */
  readonly prepare: () => Promise<PreparedContext>;
  readonly prepared: PreparedContext;
}

/**
 * Prepare the call's context: the caching mode the model allows (a model without `createCachedContent` runs
 * `explicit` as `implicit`, said on the progress channel), then the context itself under the call's signal, so a
 * timeout also ends an upload.
 */
export async function prepareCallContext(
  call: EagerCall<ModelReached>,
  ctx: ToolContext,
  spec: ContextSpec,
): Promise<CallContext> {
  const systemPromptHash = createHash('sha256')
    .update(spec.systemInstruction)
    .digest('hex')
    .slice(0, 16);
  const caching = cachingModeFor(spec.requestedMode, spec.resolved, call.emitter);
  const prepare = () =>
    prepareContext({
      client: ctx.client,
      manifest: ctx.manifest,
      scan: spec.scan,
      model: spec.resolved,
      systemPromptHash,
      systemInstruction: spec.systemInstruction,
      ttlSeconds: ctx.config.cacheTtlSeconds,
      cacheMinTokens: ctx.config.cacheMinTokens,
      emitter: call.emitter,
      allowCaching: spec.allowCaching,
      signal: call.timeout.signal,
      cachingMode: caching.mode,
    });
  return { caching, prepare, prepared: await prepare() };
}

/** What the decode sends and runs under. */
export interface DecodeSpec {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
  /** The request on a prepared context: with a cache, or inline on a context without one. */
  readonly request: (prep: PreparedContext) => ContextRequest;
  /** The cap that runs. */
  readonly cap: OutputCap;
  readonly estimate: InputEstimate;
  /** The preflight's count, when it ran. */
  readonly countedInputTokens: number | undefined;
}

/**
 * Decode the answer on the call's context — and, on a stale cache before any request completed, once more on a rebuilt
 * one (`decodeOnContext`). The TPM reservation is taken after the context and just before the first request, so its
 * timestamp is when the tokens reach Gemini's quota counter; only the OPENING of a request is retried (a flex request
 * never): a mid-stream failure re-sent would bill the work again.
 */
export function decodeEagerCall(
  call: EagerCall<ModelReached>,
  ctx: ToolContext,
  spec: DecodeSpec,
  context: CallContext,
): Promise<ContextDecode> {
  return decodeOnContext(
    {
      client: ctx.client,
      booking: {
        workspaceRoot: call.workspaceRoot,
        toolName: call.tool,
        model: spec.resolved.resolved,
        serviceTier: spec.serviceTier,
      },
      cachingMode: (prep) => cachingRan(prep, context.caching).mode,
      request: spec.request,
      cache: {
        ttlWatcher: ctx.ttlWatcher,
        manifest: ctx.manifest,
        ttlSeconds: ctx.config.cacheTtlSeconds,
        prepare: context.prepare,
      },
      openAttempts: networkAttempts(spec.serviceTier),
      limits: { maxRequests: spec.cap.maxRequests, cap: spec.cap.effective },
      timeout: call.timeout,
      emit: (message) => call.emitter.emit(message),
      completed: call.completed,
      tracking: call.tracking,
      throttle: call.dispatch,
      inputTokens: { estimated: spec.estimate.tokens, counted: spec.countedInputTokens },
    },
    context.prepared,
  );
}

/** What the decode ran on: the booking's model and tier, the caching mode, the cap and its cut. */
export interface DecodeRun {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
  readonly caching: CachingModeChoice;
  readonly bounded: BoundedOutputCap;
}

/** The answer booked, the caching mode that ran, the call's duration. */
export interface SettledDecode {
  readonly settled: SettledAnswer;
  readonly ran: RanCaching;
  readonly durationMs: number;
}

/**
 * Book the answered call once, at every request that completed (over a long decode and a stale-cache retry alike).
 * The trail's reservation and the decode's entry are cleared BEFORE the booking, so a failure after it neither books
 * the call again nor releases what was booked — and reports no usage.
 */
export function settleDecoded(
  call: EagerCall<ModelReached>,
  ctx: ToolContext,
  decoded: ContextDecode,
  run: DecodeRun,
): SettledDecode {
  // the mode that ran, not the one asked for: telemetry and the result record it
  const ran = cachingRan(decoded.prep, run.caching);
  const durationMs = Date.now() - call.started;
  const settledReservation = call.trail.reservationId;
  call.trail.reservationId = null;
  call.tracking.ledgerEntry = null;
  const settled = settleAnswer({
    manifest: ctx.manifest,
    reservationId: settledReservation,
    entry: {
      workspaceRoot: call.workspaceRoot,
      toolName: call.tool,
      model: run.resolved.resolved,
      serviceTier: run.serviceTier,
      cachingMode: ran.mode,
    },
    completed: call.completed,
    response: decoded.response,
    cap: run.bounded.cap,
    cut: run.bounded.cut,
    durationMs,
  });
  return { settled, ran, durationMs };
}

/** Said in the log when the scan dropped the files past `GEMINI_CODE_CONTEXT_MAX_FILES`. */
export function warnTruncatedScan(
  call: EagerCall<ModelReached>,
  ctx: ToolContext,
  scan: ScanResult,
): void {
  if (!scan.truncated) return;
  logger.warn(
    `workspace ${call.workspaceRoot} contains more files than GEMINI_CODE_CONTEXT_MAX_FILES (${ctx.config.maxFilesPerWorkspace}); the tail was dropped before indexing.`,
  );
}

/**
 * What the scan left out and what the upload could not send, as both tools' answers report it: the excluded
 * directories met, the files that are neither source by extension nor a `#!` script — so a caller can tell "not in
 * the workspace" from "not indexed" — and the first five failed uploads.
 */
export function scanFields(scan: ScanResult, prep: PreparedContext): Record<string, unknown> {
  return {
    excludedDirs: scan.excludedDirs,
    excludedDirsTotal: scan.excludedDirsTotal,
    filesSkippedNonSource: scan.skippedNonSource,
    filesUploadFailed: prep.uploaded.failedCount,
    ...(prep.uploaded.failedCount > 0
      ? { uploadFailures: prep.uploaded.failures.slice(0, 5) }
      : {}),
  };
}
