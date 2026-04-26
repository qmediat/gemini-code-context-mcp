/**
 * `ask` end-to-end timeout integration (T19, v1.6.0).
 *
 * Verifies that when `generateContent` throws a `TimeoutError` (the shape
 * produced by `createTimeoutController`'s abort), `ask`:
 *   - returns a structured error with `errorCode: 'TIMEOUT'`
 *   - includes the configured `timeoutMs` in metadata
 *   - cancels the budget reservation (no rollover into next-day cap)
 *   - cancels the throttle reservation (no permanent TPM bucket entry)
 *
 * Uses module mocks for the cache + scanner + resolver, and a thrown-error
 * mock for `generateContent` itself — no real timer races needed. The actual
 * timer logic is covered by `abort-timeout.test.ts`; this file pins the
 * tool-level error-mapping contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askTool } from '../../src/tools/ask.tool.js';
import { codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';

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

function buildCtx(): {
  ctx: ToolContext;
  generateContent: ReturnType<typeof vi.fn>;
  cancelBudget: ReturnType<typeof vi.fn>;
  cancelThrottle: ReturnType<typeof vi.fn>;
} {
  const generateContent = vi.fn();
  const cancelBudget = vi.fn();
  const cancelThrottle = vi.fn();
  const throttle = {
    reserve: () => ({ delayMs: 0, releaseId: 1 }),
    release: vi.fn(),
    cancel: cancelThrottle,
    shouldDelay: () => 0,
    recordRetryHint: vi.fn(),
  };
  const ctx = {
    server: {} as ToolContext['server'],
    config: {
      // Finite budget so `reserveBudget` runs (gated on Number.isFinite)
      // — required to verify the cancelBudgetReservation cleanup path.
      dailyBudgetUsd: 100,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3_600,
      cacheMinTokens: 1_024,
      tpmThrottleLimit: 80_000,
      forceMaxOutputTokens: false,
      workspaceGuardRatio: 0.9,
    } as ToolContext['config'],
    client: {
      models: {
        generateContent,
        // T20 (v1.7.0): production calls generateContentStream. Wrap the
        // generateContent mock as a single-chunk stream so the same
        // mockRejectedValue / mockResolvedValue chains keep working.
        generateContentStream: vi.fn(async (params: unknown) => {
          const response = await generateContent(params);
          async function* gen() {
            yield response;
          }
          return gen();
        }),
      },
    } as unknown as ToolContext['client'],
    manifest: {
      reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
      finalizeBudgetReservation: vi.fn(),
      cancelBudgetReservation: cancelBudget,
      insertUsageMetric: vi.fn(),
    } as unknown as ToolContext['manifest'],
    ttlWatcher: { markHot: vi.fn() } as unknown as ToolContext['ttlWatcher'],
    progressToken: undefined,
    throttle,
  };
  return { ctx, generateContent, cancelBudget, cancelThrottle };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorkspacePath.mockReturnValue(undefined);
  mocks.scanWorkspace.mockResolvedValue({
    workspaceRoot: '/fake',
    filesHash: 'abc',
    files: [{ relpath: 'a.ts', size: 1000, contentHash: 'h1', absolutePath: '/fake/a.ts' }],
    skippedTooLarge: 0,
    truncated: false,
  });
  mocks.resolveModel.mockResolvedValue({
    requested: 'latest-pro',
    resolved: 'gemini-3-pro-preview',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    fallbackApplied: false,
    category: 'text-reasoning',
    capabilities: {
      supportsThinking: true,
      supportsVision: true,
      supportsCodeExecution: true,
      costTier: 'premium',
    },
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

describe('ask — TIMEOUT errorCode mapping (T19)', () => {
  it('returns errorCode TIMEOUT when generateContent throws a TimeoutError', async () => {
    const { ctx, generateContent, cancelBudget, cancelThrottle } = buildCtx();
    generateContent.mockRejectedValue(new DOMException('timed out at 5000ms', 'TimeoutError'));

    const result = await askTool.execute({ prompt: 'hi', timeoutMs: 5000 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(5000);
    expect(result.structuredContent?.retryable).toBe(true);
    // Reservations released so the failed call doesn't leak budget/quota.
    expect(cancelBudget).toHaveBeenCalledTimes(1);
    expect(cancelThrottle).toHaveBeenCalled();
  });

  it('does not surface TIMEOUT for plain AbortError (user-cancelled, not timed out)', async () => {
    const { ctx, generateContent } = buildCtx();
    // Plain AbortError is what fires when the SDK is cancelled by user code
    // unrelated to our timeout. Should fall through to UNKNOWN — not TIMEOUT.
    generateContent.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const result = await askTool.execute({ prompt: 'hi' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
  });

  it('detects TimeoutError nested under a wrapped error.cause', async () => {
    const { ctx, generateContent } = buildCtx();
    const inner = new DOMException('inner', 'TimeoutError');
    const wrapped = new Error('SDK wrapped the abort', { cause: inner });
    generateContent.mockRejectedValue(wrapped);

    const result = await askTool.execute({ prompt: 'hi', timeoutMs: 2000 }, ctx);

    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(2000);
  });
});

describe('code — TIMEOUT errorCode mapping (T19)', () => {
  it('returns errorCode TIMEOUT when generateContent throws a TimeoutError', async () => {
    const { ctx, generateContent, cancelBudget, cancelThrottle } = buildCtx();
    generateContent.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    const result = await codeTool.execute({ task: 'refactor', timeoutMs: 3000 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(3000);
    expect(cancelBudget).toHaveBeenCalledTimes(1);
    expect(cancelThrottle).toHaveBeenCalled();
  });
});

describe('Stale-cache retry + timeout — T19 H2 regression fix', () => {
  it('ask: timeout DURING stale-cache retry maps to TIMEOUT (not UNKNOWN)', async () => {
    const { ctx, generateContent } = buildCtx();
    // First call: stale-cache error.
    // Retry call: TimeoutError.
    // Without the fix: outer catch wraps with `cause: <stale-cache-err>`,
    // outer's `isTimeoutAbort(err)` walks the wrapped chain and sees the
    // stale-cache error first → UNKNOWN. With the fix: timeout re-thrown
    // directly so isTimeoutAbort returns true on the retry's TimeoutError.
    mocks.prepareContext
      .mockResolvedValueOnce({
        cacheId: 'cachedContents/stale',
        inlineContents: [],
        reused: true,
        rebuilt: false,
        inlineOnly: false,
        uploaded: { failedCount: 0, failures: [] },
      })
      .mockResolvedValueOnce({
        cacheId: 'cachedContents/fresh',
        inlineContents: [],
        reused: false,
        rebuilt: true,
        inlineOnly: false,
        uploaded: { failedCount: 0, failures: [] },
      });
    mocks.isStaleCacheError.mockReturnValue(true);
    generateContent
      .mockRejectedValueOnce(new Error('cachedContent NOT_FOUND'))
      .mockRejectedValueOnce(new DOMException('retry timed out', 'TimeoutError'));

    const result = await askTool.execute({ prompt: 'hi', timeoutMs: 5000 }, ctx);

    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(5000);
  });

  it('code: timeout DURING stale-cache retry maps to TIMEOUT (not UNKNOWN)', async () => {
    const { ctx, generateContent } = buildCtx();
    mocks.prepareContext
      .mockResolvedValueOnce({
        cacheId: 'cachedContents/stale',
        inlineContents: [],
        reused: true,
        rebuilt: false,
        inlineOnly: false,
        uploaded: { failedCount: 0, failures: [] },
      })
      .mockResolvedValueOnce({
        cacheId: 'cachedContents/fresh',
        inlineContents: [],
        reused: false,
        rebuilt: true,
        inlineOnly: false,
        uploaded: { failedCount: 0, failures: [] },
      });
    mocks.isStaleCacheError.mockReturnValue(true);
    generateContent
      .mockRejectedValueOnce(new Error('cachedContent NOT_FOUND'))
      .mockRejectedValueOnce(new DOMException('retry timed out', 'TimeoutError'));

    const result = await codeTool.execute({ task: 'refactor', timeoutMs: 7000 }, ctx);

    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(7000);
  });
});
