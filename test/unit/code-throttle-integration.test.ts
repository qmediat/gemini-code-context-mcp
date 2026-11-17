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
import { ModelCategoryMismatchError } from '../../src/gemini/model-taxonomy.js';
import {
  TRUNCATED_ANSWER_NOTE,
  TRUNCATED_EDITS_NOTE,
  codeInputSchema,
  codeTool,
} from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import type { TpmReservation, TpmThrottle } from '../../src/tools/shared/throttle.js';
import { expectAnswerDespiteUnwrittenUsageRow } from '../helpers/answer-booking.js';
import { GEMINI_3_PRO, GEMINI_4_ARGON, GEMINI_4_HYDROGEN } from '../helpers/models.js';
import { forwardingStream } from '../helpers/stream-mock.js';
import { INLINE_CONTEXT, ONE_FILE_SCAN } from '../helpers/workspace.js';

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
  defaultModel?: string;
  readonly tpmThrottleLimit?: number;
  readonly generateContent?: ReturnType<typeof vi.fn>;
  readonly forceMaxOutputTokens?: boolean;
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

  // T20 (v1.7.0) — production calls generateContentStream; wrap the
  // generateContent mock as a single-chunk stream. See ask-throttle-integration.test.ts.
  const generateContentStream = vi.fn(forwardingStream(generateContent));

  const ctx = {
    server: {} as ToolContext['server'],
    config: {
      dailyBudgetUsd: Number.POSITIVE_INFINITY,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3_600,
      cacheMinTokens: 1_024,
      tpmThrottleLimit: opts.tpmThrottleLimit ?? 80_000,
      forceMaxOutputTokens: opts.forceMaxOutputTokens ?? false,
      defaultModel: opts.defaultModel ?? 'latest-pro-thinking',
    } as ToolContext['config'],
    client: {
      models: { generateContent, generateContentStream },
    } as unknown as ToolContext['client'],
    manifest: {
      reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
      finalizeBudgetReservation: vi.fn(),
      cancelBudgetReservation: vi.fn(),
      insertUsageMetric: vi.fn(),
      getFiles: vi.fn(() => []),
    } as unknown as ToolContext['manifest'],
    ttlWatcher: { markHot: vi.fn(), keepAlive: vi.fn() } as unknown as ToolContext['ttlWatcher'],
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
    mocks.scanWorkspace.mockResolvedValue(ONE_FILE_SCAN);
    mocks.resolveModel.mockResolvedValue({
      ...GEMINI_3_PRO,
      requested: 'latest-pro-thinking',
      inputTokenLimit: 2_000_000,
    });
    mocks.prepareContext.mockResolvedValue(INLINE_CONTEXT);
    mocks.isStaleCacheError.mockReturnValue(false);
  });

  it('happy path: reserve → release', async () => {
    const { ctx, throttleSpy } = buildCtx();
    const result = await codeTool.execute({ task: 'refactor' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'release']);
  });

  it('a usage row that cannot be written: the answer is returned and the failed write logged', async () => {
    const { ctx, throttleSpy } = buildCtx();
    await expectAnswerDespiteUnwrittenUsageRow(
      'code',
      ctx.manifest,
      () => codeTool.execute({ task: 'refactor' }, ctx),
      'ok',
    );
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

describe('code.tool.ts maxOutputTokens precedence (v1.4.0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateWorkspacePath.mockReturnValue(undefined);
    mocks.scanWorkspace.mockResolvedValue(ONE_FILE_SCAN);
    mocks.resolveModel.mockResolvedValue({ ...GEMINI_3_PRO, requested: 'latest-pro-thinking' });
    mocks.prepareContext.mockResolvedValue(INLINE_CONTEXT);
    mocks.isStaleCacheError.mockReturnValue(false);
  });

  function lastGenerateContentCall(gc: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const call = gc.mock.calls[gc.mock.calls.length - 1];
    const firstArg = call?.[0] as { config?: Record<string, unknown> } | undefined;
    return firstArg?.config ?? {};
  }

  it('default (no overrides) → maxOutputTokens omitted (auto)', async () => {
    const { ctx } = buildCtx();
    const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
      typeof vi.fn
    >;
    await codeTool.execute({ task: 'refactor' }, ctx);
    expect(lastGenerateContentCall(generateContent)).not.toHaveProperty('maxOutputTokens');
  });

  it('forceMaxOutputTokens=true → wire carries 65_536', async () => {
    const { ctx } = buildCtx({ forceMaxOutputTokens: true });
    const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
      typeof vi.fn
    >;
    await codeTool.execute({ task: 'refactor' }, ctx);
    const config = lastGenerateContentCall(generateContent);
    expect(config.maxOutputTokens).toBe(65_536);
  });

  it('per-call input.maxOutputTokens wins over forceMaxOutputTokens', async () => {
    const { ctx } = buildCtx({ forceMaxOutputTokens: true });
    const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
      typeof vi.fn
    >;
    await codeTool.execute({ task: 'refactor', maxOutputTokens: 8_192 }, ctx);
    const config = lastGenerateContentCall(generateContent);
    expect(config.maxOutputTokens).toBe(8_192);
  });

  it('per-call cap above model limit is clamped', async () => {
    const { ctx } = buildCtx();
    const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
      typeof vi.fn
    >;
    await codeTool.execute({ task: 'refactor', maxOutputTokens: 1_000_000 }, ctx);
    const config = lastGenerateContentCall(generateContent);
    expect(config.maxOutputTokens).toBe(65_536);
  });

  it('a Gemini 4 model continues past its per-request limit into one edit answer', async () => {
    mocks.resolveModel.mockResolvedValueOnce(GEMINI_4_ARGON);
    const { ctx } = buildCtx();
    const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
      typeof vi.fn
    >;
    generateContent
      .mockResolvedValueOnce({
        candidates: [{ index: 0, finishReason: 'CONTINUATION', continuationToken: 'tok-1' }],
        usageMetadata: {
          promptTokenCount: 1_000,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 65_533,
        },
      })
      .mockResolvedValueOnce({
        text: 'done',
        candidates: [{ index: 0, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 66_536,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 10,
        },
      });
    const result = await codeTool.execute({ task: 'refactor', maxOutputTokens: 262_144 }, ctx);
    expect(generateContent).toHaveBeenCalledTimes(2);
    const config = lastGenerateContentCall(generateContent);
    expect(config).toMatchObject({
      maxOutputTokens: 262_144,
      automaticContinuation: false,
      continuationToken: 'tok-1',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.continuationHops).toBe(1);
    expect(result.structuredContent?.thinkingTokens).toBe(65_543);
    expect(result.structuredContent?.uncachedTokens).toBe(67_536);
  });

  describe('on Gemini 4 Argon, which advertises 32 768 output tokens a request', () => {
    /** Request 1 of an Argon decode: it stops with CONTINUATION at the advertised per-request limit. */
    const argonStop = {
      candidates: [{ index: 0, finishReason: 'CONTINUATION', continuationToken: 'tok-1' }],
      usageMetadata: {
        promptTokenCount: 1_000,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 32_768,
      },
    };

    it('sends a cap above 32 768 unclamped and continues the decode past it', async () => {
      mocks.resolveModel.mockResolvedValueOnce(GEMINI_4_ARGON);
      const { ctx } = buildCtx();
      const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
        typeof vi.fn
      >;
      generateContent.mockResolvedValueOnce(argonStop).mockResolvedValueOnce({
        text: 'done',
        candidates: [{ index: 0, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 33_893,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 10,
        },
      });

      const result = await codeTool.execute({ task: 'refactor', maxOutputTokens: 65_536 }, ctx);

      expect(generateContent).toHaveBeenCalledTimes(2);
      expect(lastGenerateContentCall(generateContent)).toMatchObject({
        maxOutputTokens: 65_536,
        continuationToken: 'tok-1',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        continuationHops: 1,
        finishReason: 'STOP',
        truncated: false,
      });
    });

    it('says an edit list cut at the request limit is incomplete, in the text and the result', async () => {
      mocks.resolveModel.mockResolvedValueOnce(GEMINI_4_ARGON);
      const { ctx } = buildCtx();
      const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
        typeof vi.fn
      >;
      const cutEdits =
        '**FILE: a.ts**\n```ts\nOLD:\nconst a = 1;\nNEW:\nconst a = 2;\n```\n**FILE: b.ts**';
      generateContent.mockResolvedValueOnce(argonStop).mockResolvedValueOnce({
        text: cutEdits,
        candidates: [{ index: 0, finishReason: 'CONTINUATION', continuationToken: 'tok-2' }],
        usageMetadata: {
          promptTokenCount: 33_893,
          candidatesTokenCount: 32_768,
          thoughtsTokenCount: 0,
        },
      });

      const result = await codeTool.execute({ task: 'refactor', maxOutputTokens: 65_536 }, ctx);

      expect(generateContent).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        finishReason: 'CONTINUATION',
        truncated: true,
        editCount: 1,
      });
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(text.startsWith(TRUNCATED_EDITS_NOTE)).toBe(true);
      expect(text).toContain(cutEdits);
    });

    it('says a prose answer (expectEdits: false) cut at the request limit is cut, with no edit list named', async () => {
      mocks.resolveModel.mockResolvedValueOnce(GEMINI_4_ARGON);
      const { ctx } = buildCtx();
      const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
        typeof vi.fn
      >;
      const cutProse = 'The module splits in two because';
      generateContent.mockResolvedValueOnce(argonStop).mockResolvedValueOnce({
        text: cutProse,
        candidates: [{ index: 0, finishReason: 'CONTINUATION', continuationToken: 'tok-2' }],
        usageMetadata: {
          promptTokenCount: 33_893,
          candidatesTokenCount: 32_768,
          thoughtsTokenCount: 0,
        },
      });

      const result = await codeTool.execute(
        { task: 'explain', maxOutputTokens: 65_536, expectEdits: false },
        ctx,
      );

      expect(result.structuredContent).toMatchObject({ truncated: true, editCount: 0 });
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(text.startsWith(TRUNCATED_ANSWER_NOTE)).toBe(true);
      expect(text).not.toContain('edit list');
      expect(text).toContain(cutProse);
    });

    it('a cut by the input window that leaves one request sends the cut value, the thinking budget below it', async () => {
      // a 200 000-token window and a ~171 000-token prompt leave less than one request of 32 768
      mocks.resolveModel.mockResolvedValueOnce({ ...GEMINI_4_ARGON, inputTokenLimit: 200_000 });
      const { ctx } = buildCtx();
      (ctx.client.models as unknown as { countTokens: unknown }).countTokens = vi
        .fn()
        .mockResolvedValue({ totalTokens: 170_000 });
      const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
        typeof vi.fn
      >;

      const result = await codeTool.execute(
        { task: 'refactor', maxOutputTokens: 262_144, thinkingBudget: 50_000 },
        ctx,
      );

      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(lastGenerateContentCall(generateContent)).toMatchObject({
        maxOutputTokens: 32_768,
        thinkingConfig: { thinkingBudget: 32_768 - 1_024 },
      });
      expect(result.structuredContent?.outputCapCutByInputWindow).toMatchObject({
        from: 262_144,
        to: 32_768,
      });
    });

    it('a stop at the cap with no answer is OUTPUT_CAP with the fields ask returns for it', async () => {
      mocks.resolveModel.mockResolvedValueOnce(GEMINI_4_ARGON);
      const { ctx } = buildCtx();
      const generateContent = ctx.client.models.generateContent as unknown as ReturnType<
        typeof vi.fn
      >;
      generateContent.mockResolvedValue(argonStop);

      const result = await codeTool.execute({ task: 'refactor', maxOutputTokens: 32_768 }, ctx);

      expect(result.isError).toBe(true);
      for (const field of [
        'errorCode',
        'retryable',
        'resolvedModel',
        'serviceTier',
        'finishReason',
        'cachedTokens',
        'uncachedTokens',
        'outputTokens',
        'thinkingTokens',
        'costEstimateUsd',
        'continuationHops',
      ]) {
        expect(result.structuredContent, field).toHaveProperty(field);
      }
      expect(result.structuredContent?.errorCode).toBe('OUTPUT_CAP');
      expect(result.structuredContent?.resolvedModel).toBe('gemini-4-argon');
    });
  });

  describe('the ledger of a decode that fails', () => {
    /** A context with a daily cap: the call holds budget reservation 1. */
    const budgeted = () => {
      const built = buildCtx();
      (built.ctx.config as { dailyBudgetUsd: number }).dailyBudgetUsd = 100;
      const generateContent = built.ctx.client.models.generateContent as unknown as ReturnType<
        typeof vi.fn
      >;
      const manifest = built.ctx.manifest as unknown as {
        finalizeBudgetReservation: ReturnType<typeof vi.fn>;
        cancelBudgetReservation: ReturnType<typeof vi.fn>;
      };
      return { ctx: built.ctx, generateContent, manifest };
    };
    const serverError = Object.assign(new Error('Internal error'), { status: 500 });

    beforeEach(() => {
      mocks.resolveModel.mockResolvedValueOnce(GEMINI_4_HYDROGEN);
    });

    it('a continuation request that fails keeps the completed request billed; the result carries its usage', async () => {
      const { ctx, generateContent, manifest } = budgeted();
      generateContent
        .mockResolvedValueOnce({
          candidates: [{ index: 0, finishReason: 'CONTINUATION', continuationToken: 'tok-1' }],
          usageMetadata: {
            promptTokenCount: 10_000,
            candidatesTokenCount: 6,
            thoughtsTokenCount: 65_530,
          },
        })
        .mockRejectedValueOnce(serverError);

      const result = await codeTool.execute({ task: 'refactor', maxOutputTokens: 262_144 }, ctx);

      expect(generateContent).toHaveBeenCalledTimes(2);
      expect(manifest.cancelBudgetReservation).not.toHaveBeenCalled();
      // Hydrogen at 1.50 / 7.50 USD per 1M: 10 000 × 1.50 + 65 536 × 7.50 = 0.50652 USD.
      expect(manifest.finalizeBudgetReservation).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ costUsdMicro: 506_520, uncachedTokens: 10_000 }),
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        httpStatus: 500,
        uncachedTokens: 10_000,
        thinkingTokens: 65_530,
        outputTokens: 6,
        costEstimateUsd: 0.5065,
        continuationHops: 1,
      });
    });

    it('a first request that fails releases the reservation whole and reports no usage', async () => {
      const { ctx, generateContent, manifest } = budgeted();
      generateContent.mockRejectedValueOnce(serverError);

      const result = await codeTool.execute({ task: 'refactor', maxOutputTokens: 262_144 }, ctx);

      expect(manifest.cancelBudgetReservation).toHaveBeenCalledWith(1);
      expect(manifest.finalizeBudgetReservation).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).not.toHaveProperty('costEstimateUsd');
    });
  });
});

describe('code.tool.ts model default (1.18.0): the configured default, like ask and ask_agentic', () => {
  const reasoning = (requested: string, supportsThinking = true) => ({
    requested,
    resolved: supportsThinking ? 'gemini-3-pro-preview' : 'gemini-3-pro-nothink',
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 65_536,
    fallbackApplied: false,
    category: 'text-reasoning' as const,
    capabilities: {
      supportsThinking,
      supportsCaching: true,
      supportsVision: false,
      supportsCodeExecution: true,
    },
  });
  const mismatch = (modelId: string) =>
    new ModelCategoryMismatchError({
      modelId,
      actualCategory: 'text-fast',
      requiredCategory: ['text-reasoning'],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateWorkspacePath.mockReturnValue(undefined);
    mocks.scanWorkspace.mockResolvedValue(ONE_FILE_SCAN);
    mocks.resolveModel.mockImplementation(async (requested: string) => {
      if (requested === 'latest-flash') throw mismatch('gemini-3-flash-preview');
      return reasoning(requested, requested !== 'latest-pro-nothink');
    });
    // this suite's own context: nothing inherited from the sibling suites' beforeEach
    mocks.prepareContext.mockResolvedValue(INLINE_CONTEXT);
    mocks.isStaleCacheError.mockReturnValue(false);
  });

  it('a call without `model` asks for ctx.config.defaultModel (GEMINI_CODE_CONTEXT_DEFAULT_MODEL / the profile)', async () => {
    const { ctx } = buildCtx({ defaultModel: 'latest-pro' });
    const result = await codeTool.execute({ task: 'x' }, ctx);
    expect(mocks.resolveModel.mock.calls.map((c) => c[0])).toEqual(['latest-pro']);
    expect(result.structuredContent?.configuredModelReplaced).toBeNull();
  });

  it('a configured default that cannot reason falls back to latest-pro-thinking, and the response says which default was replaced', async () => {
    const { ctx } = buildCtx({ defaultModel: 'latest-flash' });
    const result = await codeTool.execute({ task: 'x' }, ctx);
    expect(result.isError).not.toBe(true);
    expect(mocks.resolveModel.mock.calls.map((c) => c[0])).toEqual([
      'latest-flash',
      'latest-pro-thinking',
    ]);
    expect(result.structuredContent?.configuredModelReplaced).toBe('latest-flash');
    expect(result.structuredContent?.requestedModel).toBe('latest-pro-thinking');
  });

  it('a configured default that reasons but does not think is replaced too (code always sends a thinking budget)', async () => {
    const { ctx } = buildCtx({ defaultModel: 'latest-pro-nothink' });
    const result = await codeTool.execute({ task: 'x' }, ctx);
    expect(mocks.resolveModel.mock.calls.map((c) => c[0])).toEqual([
      'latest-pro-nothink',
      'latest-pro-thinking',
    ]);
    expect(result.structuredContent?.configuredModelReplaced).toBe('latest-pro-nothink');
  });

  it('an error result after model resolution carries the same audit fields (a failed call still tells a fallback from a choice)', async () => {
    const { ctx } = buildCtx({
      defaultModel: 'latest-flash',
      generateContent: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await codeTool.execute({ task: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
    expect(result.structuredContent?.configuredModelReplaced).toBe('latest-flash');
    expect(result.structuredContent?.resolvedModel).toBe('gemini-3-pro-preview');
  });

  it('an empty per-call model is a schema error, not the configured default', () => {
    expect(codeInputSchema.safeParse({ task: 'x', model: '' }).success).toBe(false);
  });

  it('a per-call `model` wins over the configured default and never falls back', async () => {
    const { ctx } = buildCtx({ defaultModel: 'latest-pro' });
    await codeTool.execute({ task: 'x', model: 'latest-pro-thinking' }, ctx);
    expect(mocks.resolveModel.mock.calls.map((c) => c[0])).toEqual(['latest-pro-thinking']);
    const named = await codeTool.execute({ task: 'x', model: 'latest-flash' }, ctx);
    expect(named.isError).toBe(true);
    expect(mocks.resolveModel.mock.calls.map((c) => c[0])).toEqual([
      'latest-pro-thinking',
      'latest-flash',
    ]);
  });
});
