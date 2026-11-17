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

import type { GoogleGenAI } from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlWatcher } from '../../src/cache/ttl-watcher.js';
import type { ManifestDb } from '../../src/manifest/db.js';
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
    ttlWatcher: { markHot: vi.fn(), keepAlive: vi.fn() } as unknown as ToolContext['ttlWatcher'],
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

/** A prepared context that reads an explicit cache. */
const CACHED_CONTEXT = {
  cacheId: 'cachedContents/old',
  inlineContents: [],
  reused: true,
  rebuilt: false,
  inlineOnly: false,
  uploaded: { failedCount: 0, failures: [] },
};

/** The workspace every test scans unless it says otherwise: one 100-byte file. */
const ONE_FILE_SCAN = {
  workspaceRoot: '/fake',
  filesHash: 'abc',
  files: [{ relpath: 'a.ts', size: 100, contentHash: 'h', absolutePath: '/fake/a.ts' }],
  skippedTooLarge: 0,
  excludedDirs: [],
  excludedDirsTotal: 0,
  skippedNonSource: 0,
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorkspacePath.mockReturnValue(undefined);
  mocks.scanWorkspace.mockResolvedValue(ONE_FILE_SCAN);
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
    ...CACHED_CONTEXT,
    cacheId: null,
    reused: false,
    inlineOnly: true,
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

/** One request that thinks through the per-request limit and stops with CONTINUATION and `token`. */
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
        totalTokenCount: prompt + 65_536,
      },
    },
  ]);

/** A request that answers `text` and stops with `finishReason` (a token when it is CONTINUATION). */
const answering = (text: string, finishReason: 'STOP' | 'CONTINUATION', prompt: number) =>
  chunkedStream([
    {
      text,
      candidates: [
        {
          index: 0,
          finishReason: finishReason as never,
          content: { role: 'model', parts: [{ text }] },
          ...(finishReason === 'CONTINUATION' ? { continuationToken: 'tok-last' } : {}),
        },
      ],
      usageMetadata: {
        promptTokenCount: prompt,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 0,
        totalTokenCount: prompt + 100,
      },
    },
  ]);

/** Resolves after `ms` of real time. */
const waitMs = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe('ask — long decode on a Gemini 4 model', () => {
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
    expect(result.structuredContent).toMatchObject({ finishReason: 'STOP', truncated: false });
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
    expect(String(result.structuredContent?.responseText)).toContain(
      'Raise `maxOutputTokens` above 131,072 (up to 1,048,576)',
    );
    expect(result.structuredContent?.finishReason).toBe('CONTINUATION');
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

describe('ask — a long decode between its requests', () => {
  beforeEach(() => {
    mocks.resolveModel.mockResolvedValue(GEMINI_4_HYDROGEN);
  });

  it('flags an answer cut at the request limit: truncated, with its finish reason', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream
      .mockImplementationOnce(continuationStop('tok-1', 100_000))
      .mockImplementationOnce(answering('the first half of the answer', 'CONTINUATION', 165_661));

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 131_072 }, ctx);

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      finishReason: 'CONTINUATION',
      truncated: true,
      continuationHops: 1,
    });
  });

  it('the stall watchdog does not count the gap before a continuation request opens', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream
      .mockImplementationOnce(continuationStop('tok-1', 100_000))
      .mockImplementationOnce(async () => {
        await waitMs(1_600); // the opening and prefill of request 2: longer than stallMs
        return answering('The answer.', 'STOP', 165_661)();
      });

    const result = await askTool.execute(
      { prompt: 'review', maxOutputTokens: 262_144, stallMs: 1_000 },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.continuationHops).toBe(1);
  });

  it('a stall inside a continuation request still aborts the call', async () => {
    const { ctx, generateContentStream } = buildCtx();
    async function* stallsAfterOneChunk() {
      yield { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'a' }] } }] };
      await waitMs(1_600);
      yield { text: 'late', candidates: [{ index: 0, finishReason: 'STOP' }] };
    }
    generateContentStream
      .mockImplementationOnce(continuationStop('tok-1', 100_000))
      .mockImplementationOnce(async () => stallsAfterOneChunk());

    const result = await askTool.execute(
      { prompt: 'review', maxOutputTokens: 262_144, stallMs: 1_000 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ errorCode: 'TIMEOUT', timeoutKind: 'stall' });
  });

  it('each request holds its own TPM reservation, settled at the input it reported', async () => {
    const { ctx, generateContentStream } = buildCtx();
    const reserved: number[] = [];
    let nextId = 0;
    const throttle = {
      ...ctx.throttle,
      reserve: (_model: string, tokens: number) => {
        reserved.push(tokens);
        nextId += 1;
        return { delayMs: 0, releaseId: nextId };
      },
      release: vi.fn(),
    };
    generateContentStream
      .mockImplementationOnce(continuationStop('tok-1', 99_712))
      .mockImplementationOnce(answering('The answer.', 'STOP', 165_373));

    const result = await askTool.execute(
      { prompt: 'review', maxOutputTokens: 262_144 },
      { ...ctx, throttle },
    );

    expect(result.isError).toBeFalsy();
    // request 1: the estimate; request 2: request 1's prompt plus the 65 536 tokens it decoded
    expect(reserved.slice(1)).toEqual([99_712 + 65_536]);
    expect(throttle.release.mock.calls).toEqual([
      [1, 99_712],
      [2, 165_373],
    ]);
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

  it('a stale cache at a continuation request ends the call: no restart, the completed request billed', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    const stale = new Error('CachedContent not found');
    mocks.isStaleCacheError.mockImplementation((err: unknown) => err === stale);
    mocks.prepareContext.mockResolvedValueOnce(CACHED_CONTEXT);
    generateContentStream
      .mockImplementationOnce(firstRequest)
      .mockRejectedValueOnce(stale)
      .mockImplementation(answering('a restarted decode', 'STOP', 100_000));

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.responseText)).toContain('not restarted');
    expect(manifestOf(ctx).finalizeBudgetReservation).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ costUsdMicro: FIRST_REQUEST_MICROS }),
    );
    expect(result.structuredContent).toMatchObject({
      uncachedTokens: 100_000,
      continuationHops: 1,
    });
    expect(mocks.markCacheStale).toHaveBeenCalledTimes(1);
  });

  it('a stale cache at the first request is rebuilt and the decode run once more', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    const stale = new Error('CachedContent not found');
    mocks.isStaleCacheError.mockImplementation((err: unknown) => err === stale);
    mocks.prepareContext.mockResolvedValueOnce(CACHED_CONTEXT);
    generateContentStream
      .mockRejectedValueOnce(stale)
      .mockImplementationOnce(answering('The answer.', 'STOP', 1_000));

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.retriedOnStaleCache).toBe(true);
    // 1 000 × 1.50 + 100 × 7.50 = 0.00225 USD
    expect(manifestOf(ctx).finalizeBudgetReservation).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ costUsdMicro: 2_250 }),
    );
  });

  it('a 500 000-token prompt at a cap of 1 048 576 whose cache goes stale at request 16 bills within its reservation', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    const prompt = 500_000;
    mocks.scanWorkspace.mockResolvedValueOnce({
      ...ONE_FILE_SCAN,
      filesHash: 'big',
      files: [{ relpath: 'a.ts', size: prompt * 4, contentHash: 'h', absolutePath: '/fake/a.ts' }],
    });
    (ctx.client.models as unknown as { countTokens: unknown }).countTokens = vi
      .fn()
      .mockResolvedValue({ totalTokens: prompt });
    const stale = new Error('CachedContent not found');
    mocks.isStaleCacheError.mockImplementation((err: unknown) => err === stale);
    mocks.prepareContext.mockResolvedValue(CACHED_CONTEXT);
    let sent = 0;
    generateContentStream.mockImplementation(async () => {
      sent += 1;
      if (sent === 16) throw stale;
      // request k bills the prompt, what was decoded before it and 125 tokens more
      const k = (sent - 1) % 16;
      return continuationStop(`tok-${sent}`, prompt + k * 65_536 + (k > 0 ? 125 : 0))();
    });

    const result = await askTool.execute(
      { prompt: 'review', maxOutputTokens: 1_048_576, thinkingLevel: 'LOW' },
      ctx,
    );

    expect(result.isError).toBe(true);
    const reservedMicros = (ctx.manifest.reserveBudget as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0].estimatedCostMicros as number;
    const billedMicros = manifestOf(ctx).finalizeBudgetReservation.mock.calls[0]?.[1]
      .costUsdMicro as number;
    expect(billedMicros).toBeGreaterThan(0);
    expect(billedMicros).toBeLessThanOrEqual(reservedMicros);
    // one decode's worth of requests at most: the 15 that completed and the one the stale cache refused
    expect(generateContentStream).toHaveBeenCalledTimes(16);
  });

  it('keeps the cache of a long decode alive before every request it sends', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    mocks.prepareContext.mockResolvedValueOnce(CACHED_CONTEXT);
    const events: string[] = [];
    (ctx.ttlWatcher.keepAlive as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('keepAlive');
    });
    generateContentStream
      .mockImplementationOnce(async () => {
        events.push('request 1');
        return continuationStop('tok-1', 100_000)();
      })
      .mockImplementationOnce(async () => {
        events.push('request 2');
        return answering('The answer.', 'STOP', 165_661)();
      });

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    expect(result.isError).toBeFalsy();
    expect(events).toEqual(['keepAlive', 'request 1', 'keepAlive', 'request 2']);
    expect(ctx.ttlWatcher.keepAlive).toHaveBeenCalledWith(
      expect.any(String),
      'cachedContents/old',
      3_600,
      expect.any(AbortSignal),
    );
  });

  it('a failure after the decode answered counts the continuation requests it sent, not one more', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    mocks.prepareContext.mockResolvedValueOnce(CACHED_CONTEXT);
    let answered = false;
    async function* answerThenMark() {
      yield* await answering('The answer.', 'STOP', 165_661)();
      answered = true;
    }
    generateContentStream
      .mockImplementationOnce(firstRequest)
      .mockImplementationOnce(async () => answerThenMark());
    (ctx.ttlWatcher.markHot as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (answered) throw new Error('watcher down');
    });

    const result = await askTool.execute({ prompt: 'review', maxOutputTokens: 262_144 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.continuationHops).toBe(1);
  });

  it('a cache refresh that hangs before request 1 ends the call as a TIMEOUT: no request opened, the reservation released whole', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    mocks.prepareContext.mockResolvedValueOnce(CACHED_CONTEXT);
    ctx.ttlWatcher = watcherRefreshingWith(pendingUntilAborted);

    const result = await withinMs(
      5_000,
      askTool.execute({ prompt: 'review', maxOutputTokens: 262_144, timeoutMs: 1_000 }, ctx),
    );

    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(generateContentStream).not.toHaveBeenCalled();
    expect(manifestOf(ctx).cancelBudgetReservation).toHaveBeenCalledWith(1);
    expect(manifestOf(ctx).finalizeBudgetReservation).not.toHaveBeenCalled();
  });

  it('a cache refresh that hangs before request 2 ends the call as a TIMEOUT with the completed request billed', async () => {
    const { ctx, generateContentStream } = budgetedCtx();
    mocks.prepareContext.mockResolvedValueOnce(CACHED_CONTEXT);
    let refreshes = 0;
    ctx.ttlWatcher = watcherRefreshingWith((params) => {
      refreshes += 1;
      return refreshes === 1 ? Promise.resolve({}) : pendingUntilAborted(params);
    });
    generateContentStream
      .mockImplementationOnce(firstRequest)
      .mockImplementation(answering('never sent', 'STOP', 165_661));

    const result = await withinMs(
      5_000,
      askTool.execute({ prompt: 'review', maxOutputTokens: 262_144, timeoutMs: 1_000 }, ctx),
    );

    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(manifestOf(ctx).cancelBudgetReservation).not.toHaveBeenCalled();
    expect(manifestOf(ctx).finalizeBudgetReservation).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ costUsdMicro: FIRST_REQUEST_MICROS, uncachedTokens: 100_000 }),
    );
    expect(result.structuredContent).toMatchObject({
      uncachedTokens: 100_000,
      thinkingTokens: 65_533,
      // the continuation request was never sent
      continuationHops: 0,
    });
  });
});

type CacheUpdate = (params: { config?: { abortSignal?: AbortSignal } }) => Promise<unknown>;

/** A real watcher whose cache expires within the refresh window at every request, refreshed through `update`. */
function watcherRefreshingWith(update: CacheUpdate): ToolContext['ttlWatcher'] {
  const row = {
    workspaceRoot: '/fake',
    filesHash: 'abc',
    model: 'm',
    systemPromptHash: '',
    cacheId: CACHED_CONTEXT.cacheId,
    cacheExpiresAt: Date.now() + 60_000,
    fileIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
  const manifest = { getWorkspace: () => row, upsertWorkspace: vi.fn() } as unknown as ManifestDb;
  const client = { caches: { update: vi.fn(update) } } as unknown as GoogleGenAI;
  return new TtlWatcher(client, manifest);
}

/** A `caches.update` that stays pending until its request's signal aborts it, then rejects as an aborted fetch. */
const pendingUntilAborted: CacheUpdate = (params) =>
  new Promise((_resolve, reject) => {
    params.config?.abortSignal?.addEventListener(
      'abort',
      () => reject(new DOMException('This operation was aborted', 'AbortError')),
      { once: true },
    );
  });

/** `work`'s value, or a failure when it has not settled within `ms` of real time. */
async function withinMs<T>(ms: number, work: Promise<T>): Promise<T> {
  const late = Symbol('late');
  const outcome = await Promise.race([work, waitMs(ms).then(() => late)]);
  if (outcome === late) throw new Error(`still waiting after ${ms} ms`);
  return outcome as T;
}
