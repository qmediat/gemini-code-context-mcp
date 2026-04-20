/**
 * Integration-style tests for `code.tool.ts` throttle call sequence.
 *
 * Mirror of `ask-throttle-integration.test.ts` — see there for full
 * rationale. `code.tool.ts` is semantically identical on the throttle
 * integration surface so we test the same 5 scenarios to lock in
 * parity and catch any future divergence.
 */

import { ApiError } from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import type { TpmReservation, TpmThrottle } from '../../src/tools/shared/throttle.js';

const mocks = vi.hoisted(() => ({
  validateWorkspacePath: vi.fn(),
  scanWorkspace: vi.fn(),
  resolveModel: vi.fn(),
  prepareContext: vi.fn(),
  isStaleCacheError: vi.fn(),
  markCacheStale: vi.fn(),
}));

vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: mocks.validateWorkspacePath,
  WorkspaceValidationError: class extends Error {},
}));
vi.mock('../../src/indexer/workspace-scanner.js', () => ({
  scanWorkspace: mocks.scanWorkspace,
}));
vi.mock('../../src/gemini/models.js', () => ({
  resolveModel: mocks.resolveModel,
}));
vi.mock('../../src/cache/cache-manager.js', () => ({
  prepareContext: mocks.prepareContext,
  isStaleCacheError: mocks.isStaleCacheError,
  markCacheStale: mocks.markCacheStale,
}));

interface ThrottleSpy extends TpmThrottle {
  readonly calls: Array<{ method: string; args: unknown[] }>;
}

function createThrottleSpy(): ThrottleSpy {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let nextId = 1;
  return {
    calls,
    reserve: (model, est, nowMs) => {
      const id = nextId++;
      calls.push({ method: 'reserve', args: [model, est, nowMs] });
      return { delayMs: 0, releaseId: id } satisfies TpmReservation;
    },
    release: (id, actual, nowMs) => calls.push({ method: 'release', args: [id, actual, nowMs] }),
    cancel: (id) => calls.push({ method: 'cancel', args: [id] }),
    shouldDelay: (model, est, nowMs) => {
      calls.push({ method: 'shouldDelay', args: [model, est, nowMs] });
      return 0;
    },
    recordRetryHint: (model, delay, nowMs) =>
      calls.push({ method: 'recordRetryHint', args: [model, delay, nowMs] }),
  };
}

interface BuildCtxOptions {
  readonly tpmThrottleLimit?: number;
  readonly generateContent?: ReturnType<typeof vi.fn>;
}

function buildCtx(opts: BuildCtxOptions = {}): {
  ctx: ToolContext;
  throttleSpy: ThrottleSpy;
} {
  const throttleSpy = createThrottleSpy();
  const generateContent =
    opts.generateContent ??
    vi.fn().mockResolvedValue({
      text: 'ok',
      candidates: [],
      usageMetadata: {
        promptTokenCount: 1_000,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 0,
      },
    });

  const ctx = {
    server: {} as ToolContext['server'],
    config: {
      dailyBudgetUsd: Number.POSITIVE_INFINITY,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3_600,
      cacheMinTokens: 1_024,
      tpmThrottleLimit: opts.tpmThrottleLimit ?? 80_000,
    } as ToolContext['config'],
    client: { models: { generateContent } } as unknown as ToolContext['client'],
    manifest: {
      reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
      finalizeBudgetReservation: vi.fn(),
      cancelBudgetReservation: vi.fn(),
      insertUsageMetric: vi.fn(),
    } as unknown as ToolContext['manifest'],
    ttlWatcher: { markHot: vi.fn() } as unknown as ToolContext['ttlWatcher'],
    progressToken: undefined,
    throttle: throttleSpy,
  };

  return { ctx, throttleSpy };
}

const methodSequence = (spy: ThrottleSpy): string[] => spy.calls.map((c) => c.method);

describe('code.tool.ts throttle call sequence (T22b regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateWorkspacePath.mockReturnValue(undefined);
    mocks.scanWorkspace.mockResolvedValue({
      workspaceRoot: '/fake',
      filesHash: 'abc',
      files: [{ path: 'a.ts', size: 100, hash: 'h1' }],
      skippedTooLarge: 0,
      truncated: false,
    });
    mocks.resolveModel.mockResolvedValue({
      requested: 'latest-pro-thinking',
      resolved: 'gemini-3-pro-preview',
      inputTokenLimit: 2_000_000,
      outputTokenLimit: 65_536,
      supportsThinking: true,
      supportsCaching: true,
      fallbackApplied: false,
    });
    mocks.prepareContext.mockResolvedValue({
      cacheId: null,
      inlineContents: [],
      reused: false,
      rebuilt: false,
      inlineOnly: true,
      uploaded: { failedCount: 0, failures: [] },
    });
    mocks.isStaleCacheError.mockReturnValue(false);
  });

  it('happy path: reserve → release', async () => {
    const { ctx, throttleSpy } = buildCtx();
    const result = await codeTool.execute({ task: 'refactor' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'release']);
  });

  it('non-stale error: reserve → cancel', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('boom'));
    const { ctx, throttleSpy } = buildCtx({ generateContent });
    const result = await codeTool.execute({ task: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
  });

  it('stale-cache retry: reserve → cancel → reserve → release', async () => {
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(new Error('stale cache'))
      .mockResolvedValueOnce({
        text: 'ok-retry',
        candidates: [],
        usageMetadata: {
          promptTokenCount: 1_000,
          cachedContentTokenCount: 0,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 0,
        },
      });
    mocks.isStaleCacheError.mockReturnValue(true);
    mocks.prepareContext
      .mockReset()
      .mockResolvedValueOnce({
        cacheId: 'cache-abc',
        inlineContents: [],
        reused: true,
        rebuilt: false,
        inlineOnly: false,
        uploaded: { failedCount: 0, failures: [] },
      })
      .mockResolvedValueOnce({
        cacheId: 'cache-xyz',
        inlineContents: [],
        reused: false,
        rebuilt: true,
        inlineOnly: false,
        uploaded: { failedCount: 0, failures: [] },
      });
    const { ctx, throttleSpy } = buildCtx({ generateContent });
    const result = await codeTool.execute({ task: 'x' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel', 'reserve', 'release']);
  });

  it('real ApiError 429: reserve → recordRetryHint → cancel (primary path)', async () => {
    const apiErr = new ApiError({
      status: 429,
      message: '{"error":{"code":429,"details":[{"retryDelay":"6s"}]}}',
    });
    const generateContent = vi.fn().mockRejectedValue(apiErr);
    const { ctx, throttleSpy } = buildCtx({ generateContent });
    await codeTool.execute({ task: 'x' }, ctx);
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'recordRetryHint', 'cancel']);
    const hintCall = throttleSpy.calls.find((c) => c.method === 'recordRetryHint');
    expect(hintCall?.args[1]).toBe(6_000);
  });

  it('plain Error with RESOURCE_EXHAUSTED substring: NO hint (tightened gate)', async () => {
    const generateContent = vi
      .fn()
      .mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED {"retryInfo":{"retryDelay":"12s"}}'));
    const { ctx, throttleSpy } = buildCtx({ generateContent });
    await codeTool.execute({ task: 'x' }, ctx);
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
    expect(throttleSpy.calls.find((c) => c.method === 'recordRetryHint')).toBeUndefined();
  });

  it('non-429 with decoy retryDelay + RESOURCE_EXHAUSTED: NO hint (full poisoning guard)', async () => {
    const generateContent = vi
      .fn()
      .mockRejectedValue(
        new Error('Validation failed: RESOURCE_EXHAUSTED in task text {"retryDelay":"60s"}'),
      );
    const { ctx, throttleSpy } = buildCtx({ generateContent });
    await codeTool.execute({ task: 'x' }, ctx);
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
    expect(throttleSpy.calls.find((c) => c.method === 'recordRetryHint')).toBeUndefined();
  });

  it('custom wrapper with forged status=429: NO hint (prototype check)', async () => {
    const wrapped = Object.assign(new Error('{"retryDelay":"9s"}'), { status: 429 });
    const generateContent = vi.fn().mockRejectedValue(wrapped);
    const { ctx, throttleSpy } = buildCtx({ generateContent });
    await codeTool.execute({ task: 'x' }, ctx);
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
    expect(throttleSpy.calls.find((c) => c.method === 'recordRetryHint')).toBeUndefined();
  });

  it('disabled throttle: no reserve/release/cancel', async () => {
    const { ctx, throttleSpy } = buildCtx({ tpmThrottleLimit: 0 });
    await codeTool.execute({ task: 'x' }, ctx);
    expect(methodSequence(throttleSpy)).toEqual([]);
  });
});
