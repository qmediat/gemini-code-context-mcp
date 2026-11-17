/**
 * The answer of an `ask` / `code` call: its context, prepared once and again by the stale-cache retry. Each result
 * keeps its tool's own fields and their order.
 */

import { createHash } from 'node:crypto';
import { type PreparedContext, prepareContext } from '../../cache/cache-manager.js';
import { type CachingModeChoice, cachingModeFor } from '../../cache/caching-mode.js';
import type { ScanResult } from '../../indexer/workspace-scanner.js';
import type { ResolvedModel } from '../../types.js';
import type { ToolContext } from '../registry.js';
import type { EagerCall, ModelReached } from './eager-call.js';

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
