/**
 * Tool-level streaming integration (T20, v1.7.0).
 *
 * Closes the v1.7.0 review's MEDIUM finding: existing tool tests wrap the
 * legacy `generateContent` mock as a single-chunk stream, which never
 * exercises true multi-chunk accumulation or mid-stream failure semantics.
 *
 * These tests pin three load-bearing properties of the v1.7.0 hot path:
 *   1. Multi-chunk accumulation — `ask` must concatenate text from N chunks
 *      and surface the joined string in the response.
 *   2. Mid-stream failures DO NOT retry (would discard partial billable
 *      response → double billing). They propagate as terminal failures.
 *   3. Stream opening (pre-response) DOES retry on transient errors.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askTool } from '../../src/tools/ask.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { GEMINI_4_HYDROGEN } from '../helpers/models.js';
import { chunkedStream, midStreamFailure, singleChunkStream } from '../helpers/stream-mock.js';

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
  buildScanMemo: () => new Map<string, never>(),
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
  generateContentStream: ReturnType<typeof vi.fn>;
} {
  const generateContentStream = vi.fn();
  const ctx = {
    server: {} as ToolContext['server'],
    config: {
      dailyBudgetUsd: Number.POSITIVE_INFINITY,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3_600,
      cacheMinTokens: 1_024,
      tpmThrottleLimit: 80_000,
      forceMaxOutputTokens: false,
      workspaceGuardRatio: 0.9,
    } as ToolContext['config'],
    client: { models: { generateContentStream } } as unknown as ToolContext['client'],
    manifest: {
      reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
      finalizeBudgetReservation: vi.fn(),
      cancelBudgetReservation: vi.fn(),
      insertUsageMetric: vi.fn(),
      // v1.13.0: ask/code now read manifest.getFiles to seed the scan memo.
      getFiles: vi.fn(() => []),
    } as unknown as ToolContext['manifest'],
    ttlWatcher: { markHot: vi.fn() } as unknown as ToolContext['ttlWatcher'],
    progressToken: undefined,
    throttle: {
      reserve: () => ({ delayMs: 0, releaseId: 1 }),
      release: vi.fn(),
      cancel: vi.fn(),
      shouldDelay: () => 0,
      recordRetryHint: vi.fn(),
    },
  };
  return { ctx, generateContentStream };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorkspacePath.mockReturnValue(undefined);
  mocks.scanWorkspace.mockResolvedValue({
    workspaceRoot: '/fake',
    filesHash: 'abc',
    files: [{ relpath: 'a.ts', size: 100, contentHash: 'h', absolutePath: '/fake/a.ts' }],
    skippedTooLarge: 0,
    excludedDirs: [],
    excludedDirsTotal: 0,
    skippedNonSource: 0,
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

describe('ask — multi-chunk stream accumulation (T20)', () => {
  it('concatenates text across multiple chunks before returning', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream.mockImplementation(
      chunkedStream([
        { text: 'Hello ' },
        { text: 'multi-' },
        {
          text: 'chunk world.',
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 0,
            candidatesTokenCount: 50,
            thoughtsTokenCount: 0,
          },
        },
      ]),
    );

    const result = await askTool.execute({ prompt: 'hi' }, ctx);
    expect(result.isError).toBeFalsy();
    // The CONTENT[0].text contains the streamed answer joined into one string.
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Hello multi-chunk world.');
  });

  it('captures usageMetadata from the FINAL chunk only (not earliest)', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream.mockImplementation(
      chunkedStream([
        // Earlier chunk has usage, but the FINAL chunk's must win.
        { text: 'a', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
        { text: 'b' },
        {
          text: 'c',
          usageMetadata: {
            promptTokenCount: 999,
            cachedContentTokenCount: 100,
            candidatesTokenCount: 50,
            thoughtsTokenCount: 10,
          },
        },
      ]),
    );

    const result = await askTool.execute({ prompt: 'hi' }, ctx);
    // Token counts surfaced in metadata reflect the final chunk's usage.
    expect(result.structuredContent?.cachedTokens).toBe(100);
    expect(result.structuredContent?.uncachedTokens).toBe(899); // 999 - 100
    expect(result.structuredContent?.outputTokens).toBe(50);
    expect(result.structuredContent?.thinkingTokens).toBe(10);
  });
});

describe('ask — mid-stream failure semantics (T20 review CRITICAL fix)', () => {
  it('mid-stream transient error is NOT retried (would double-bill)', async () => {
    const { ctx, generateContentStream } = buildCtx();
    let openCount = 0;
    generateContentStream.mockImplementation(async () => {
      openCount += 1;
      // Mid-stream throw — simulates network drop after some chunks landed.
      return midStreamFailure([{ text: 'partial-' }], new TypeError('fetch failed'))();
    });

    const result = await askTool.execute({ prompt: 'hi' }, ctx);
    // Stream opens exactly ONCE — the mid-stream failure is terminal.
    expect(openCount).toBe(1);
    // Surfaces as a transport failure that must NOT be retried: the stream had opened, the work is billed.
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('NETWORK_ERROR');
    expect(result.structuredContent?.retryable).toBe(false);
  });

  it('PRE-stream transient error IS retried (withNetworkRetry path)', async () => {
    const { ctx, generateContentStream } = buildCtx();
    let openCount = 0;
    generateContentStream.mockImplementation(async () => {
      openCount += 1;
      if (openCount === 1) {
        // First open fails BEFORE yielding any chunk → eligible for retry.
        throw new TypeError('fetch failed');
      }
      return singleChunkStream({
        text: 'second-attempt-success',
        usageMetadata: {
          promptTokenCount: 50,
          cachedContentTokenCount: 0,
          candidatesTokenCount: 25,
          thoughtsTokenCount: 0,
        },
      })();
    });

    const result = await askTool.execute({ prompt: 'hi', timeoutMs: 60_000 }, ctx);
    expect(openCount).toBe(2); // Initial + 1 retry succeeded.
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('second-attempt-success');
  });
});

describe('ask — long decode on a Gemini 4 model', () => {
  /** One request that thinks through the per-request limit and stops with CONTINUATION. */
  const continuationStop = (token: string, prompt: number) =>
    chunkedStream([
      {
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: `thinking ${token}`, thought: true }] },
          },
        ],
      },
      {
        candidates: [{ index: 0, finishReason: 'CONTINUATION' as never, continuationToken: token }],
        usageMetadata: {
          promptTokenCount: prompt,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 65_533,
        },
      },
    ]);

  type StreamCall = { config: Record<string, unknown> };
  const configs = (mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] =>
    mock.mock.calls.map((call) => (call[0] as StreamCall).config);

  beforeEach(() => {
    mocks.resolveModel.mockResolvedValue(GEMINI_4_HYDROGEN);
  });

  it('continues a CONTINUATION stop into one answer with the usage of both requests', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream
      .mockImplementationOnce(continuationStop('tok-1', 99_712))
      .mockImplementationOnce(
        chunkedStream([
          {
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: 'more thinking', thought: true }] },
              },
            ],
          },
          {
            text: 'The answer.',
            candidates: [
              {
                index: 0,
                finishReason: 'STOP' as never,
                content: { role: 'model', parts: [{ text: 'The answer.' }] },
              },
            ],
            usageMetadata: {
              promptTokenCount: 165_373,
              candidatesTokenCount: 1_045,
              thoughtsTokenCount: 20_197,
            },
          },
        ]),
      );

    const result = await askTool.execute(
      { prompt: 'review', maxOutputTokens: 262_144, thinkingLevel: 'XHIGH' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.type === 'text' ? result.content[0].text : '').toBe('The answer.');
    expect(result.structuredContent?.continuationHops).toBe(1);
    expect(result.structuredContent?.uncachedTokens).toBe(265_085);
    expect(result.structuredContent?.thinkingTokens).toBe(85_730);
    expect(result.structuredContent?.outputTokens).toBe(1_048);
    // Hydrogen at 1.50 / 7.50 USD per 1M: the server's own estimate of the measured call.
    expect(result.structuredContent?.costEstimateUsd).toBe(1.0485);
    expect(result.structuredContent?.thinkingSummary).toBe('thinking tok-1\nmore thinking');
    const [first, second] = configs(generateContentStream);
    expect(first).toMatchObject({ maxOutputTokens: 262_144, automaticContinuation: false });
    expect(first).not.toHaveProperty('continuationToken');
    expect(second).toMatchObject({
      maxOutputTokens: 262_144,
      automaticContinuation: false,
      continuationToken: 'tok-1',
    });
  });

  it('stops at the caller cap with no answer: OUTPUT_CAP with the usage and the hops', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream
      .mockImplementationOnce(continuationStop('tok-1', 100_000))
      .mockImplementationOnce(continuationStop('tok-2', 165_536))
      .mockImplementationOnce(continuationStop('tok-3', 231_072));

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 131_072 }, ctx);

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('OUTPUT_CAP');
    expect(result.structuredContent?.retryable).toBe(false);
    expect(result.structuredContent?.continuationHops).toBe(1);
    expect(result.structuredContent?.thinkingTokens).toBe(131_066);
    expect(result.structuredContent?.uncachedTokens).toBe(265_536);
    expect(result.structuredContent?.costEstimateUsd).toBeGreaterThan(0);
    expect(String(result.structuredContent?.responseText)).toContain('long decode');
  });

  it('a default call that stops at MAX_TOKENS with no text carries the usage and OUTPUT_CAP', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream.mockImplementation(
      chunkedStream([
        {
          candidates: [{ index: 0, finishReason: 'MAX_TOKENS' as never }],
          usageMetadata: {
            promptTokenCount: 120_000,
            candidatesTokenCount: 0,
            thoughtsTokenCount: 65_533,
          },
        },
      ]),
    );

    const result = await askTool.execute({ prompt: 'review', thinkingLevel: 'XHIGH' }, ctx);

    expect(configs(generateContentStream)[0]).not.toHaveProperty('maxOutputTokens');
    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('OUTPUT_CAP');
    expect(result.structuredContent?.thinkingTokens).toBe(65_533);
    expect(result.structuredContent?.uncachedTokens).toBe(120_000);
    expect(result.structuredContent?.continuationHops).toBe(0);
  });

  it('never re-sends a continuation request that failed mid-stream', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream
      .mockImplementationOnce(continuationStop('tok-1', 100_000))
      .mockImplementationOnce(
        midStreamFailure([{ text: 'partial' }], new TypeError('fetch failed')),
      );

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('NETWORK_ERROR');
    expect(result.structuredContent?.retryable).toBe(false);
  });
});

describe('ask — the ledger of a decode that fails', () => {
  /** A context whose daily cap makes the call hold budget reservation 1. */
  const budgetedCtx = (): ReturnType<typeof buildCtx> => {
    const built = buildCtx();
    (built.ctx.config as { dailyBudgetUsd: number }).dailyBudgetUsd = 100;
    return built;
  };
  const manifestOf = (ctx: ToolContext) =>
    ctx.manifest as unknown as {
      finalizeBudgetReservation: ReturnType<typeof vi.fn>;
      cancelBudgetReservation: ReturnType<typeof vi.fn>;
    };
  /** A request that thinks through the per-request limit: 100 000 prompt tokens, 65 536 decoded. */
  const firstRequest = chunkedStream([
    {
      candidates: [{ index: 0, finishReason: 'CONTINUATION' as never, continuationToken: 'tok-1' }],
      usageMetadata: {
        promptTokenCount: 100_000,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 65_533,
      },
    },
  ]);
  // Hydrogen at 1.50 / 7.50 USD per 1M: 100 000 × 1.50 + 65 536 × 7.50 = 0.64152 USD.
  const FIRST_REQUEST_MICROS = 641_520;

  beforeEach(() => {
    mocks.resolveModel.mockResolvedValue(GEMINI_4_HYDROGEN);
  });

  it('a continuation request that fails keeps the completed request billed; the result carries its usage', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    generateContentStream
      .mockImplementationOnce(firstRequest)
      .mockImplementationOnce(
        midStreamFailure([{ text: 'partial' }], new TypeError('fetch failed')),
      );

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    const manifest = manifestOf(ctx);
    expect(manifest.cancelBudgetReservation).not.toHaveBeenCalled();
    expect(manifest.finalizeBudgetReservation).toHaveBeenCalledTimes(1);
    expect(manifest.finalizeBudgetReservation).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ costUsdMicro: FIRST_REQUEST_MICROS, uncachedTokens: 100_000 }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      errorCode: 'NETWORK_ERROR',
      uncachedTokens: 100_000,
      thinkingTokens: 65_533,
      outputTokens: 3,
      costEstimateUsd: 0.6415,
      continuationHops: 1,
    });
  });

  it('a first request that fails releases the reservation whole and reports no usage', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    generateContentStream.mockImplementationOnce(
      midStreamFailure([{ text: 'partial' }], new TypeError('fetch failed')),
    );

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    const manifest = manifestOf(ctx);
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledWith(1);
    expect(manifest.finalizeBudgetReservation).not.toHaveBeenCalled();
    expect(result.structuredContent?.errorCode).toBe('NETWORK_ERROR');
    expect(result.structuredContent).not.toHaveProperty('costEstimateUsd');
  });

  it('a continuation that meets a stale cache keeps its completed request billed beside the retry', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    const stale = new Error('CachedContent not found');
    mocks.isStaleCacheError.mockImplementation((err: unknown) => err === stale);
    mocks.prepareContext.mockResolvedValueOnce({
      cacheId: 'cachedContents/old',
      inlineContents: [],
      reused: true,
      rebuilt: false,
      inlineOnly: false,
      uploaded: { failedCount: 0, failures: [] },
    });
    generateContentStream
      .mockImplementationOnce(firstRequest)
      .mockImplementationOnce(async () => {
        throw stale;
      })
      .mockImplementationOnce(
        chunkedStream([
          {
            text: 'The answer.',
            candidates: [{ index: 0, finishReason: 'STOP' as never }],
            usageMetadata: {
              promptTokenCount: 1_000,
              candidatesTokenCount: 100,
              thoughtsTokenCount: 0,
            },
          },
        ]),
      );

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.retriedOnStaleCache).toBe(true);
    // The retry's answer (1 000 × 1.50 + 100 × 7.50 = 0.00225 USD) and the abandoned decode's completed request.
    expect(manifestOf(ctx).finalizeBudgetReservation).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ costUsdMicro: FIRST_REQUEST_MICROS + 2_250 }),
    );
    expect(result.structuredContent?.uncachedTokens).toBe(101_000);
    expect(result.structuredContent?.continuationHops).toBe(0);
  });
});
