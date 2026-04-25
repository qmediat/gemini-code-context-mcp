/**
 * Integration-style tests for `ask.tool.ts` throttle call sequence.
 *
 * These tests mock the leaf dependencies (cache-manager, model-registry,
 * workspace-scanner, workspace-validation, manifest-db, Gemini client) and
 * exercise `askTool.execute()` end-to-end to assert that `ctx.throttle`
 * methods fire in the right order across the supported scenarios:
 *
 *   - happy path: reserve → release
 *   - stale-cache retry: reserve → cancel → reserve → release
 *   - non-stale error: reserve → cancel (+ recordRetryHint when 429 body)
 *   - disabled throttle: no reserve/release/cancel
 *
 * T22b regression guard (PR #19 round-2 GPT + self-review). Future
 * refactors that accidentally drop `cancel` from the retry branch, skip
 * `reserve` placement after `prepareContext`, or forget `recordRetryHint`
 * on a 429 will fail these tests before shipping.
 */

import { ApiError } from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askTool } from '../../src/tools/ask.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import type { TpmReservation, TpmThrottle } from '../../src/tools/shared/throttle.js';

// Hoisted mock state — must be declared before `vi.mock` calls so the mock
// factories close over them. vi.hoisted pattern is the Vitest-official way.
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
  const spy: ThrottleSpy = {
    calls,
    reserve: (model, est, nowMs) => {
      const id = nextId++;
      calls.push({ method: 'reserve', args: [model, est, nowMs] });
      return { delayMs: 0, releaseId: id } satisfies TpmReservation;
    },
    release: (id, actual, nowMs) => {
      calls.push({ method: 'release', args: [id, actual, nowMs] });
    },
    cancel: (id) => {
      calls.push({ method: 'cancel', args: [id] });
    },
    shouldDelay: (model, est, nowMs) => {
      calls.push({ method: 'shouldDelay', args: [model, est, nowMs] });
      return 0;
    },
    recordRetryHint: (model, delay, nowMs) => {
      calls.push({ method: 'recordRetryHint', args: [model, delay, nowMs] });
    },
  };
  return spy;
}

interface BuildCtxOptions {
  readonly tpmThrottleLimit?: number;
  readonly generateContent?: ReturnType<typeof vi.fn>;
  readonly forceMaxOutputTokens?: boolean;
}

function buildCtx(opts: BuildCtxOptions = {}): {
  ctx: ToolContext;
  throttleSpy: ThrottleSpy;
  generateContent: ReturnType<typeof vi.fn>;
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

  // T20 (v1.7.0): production now calls `generateContentStream`, which returns
  // `Promise<AsyncGenerator<GenerateContentResponse>>`. Wrap the
  // `generateContent` mock as a single-chunk stream so existing test
  // assertions (mock call args, return shape) continue to work without each
  // suite needing a hand-rolled stream factory.
  const generateContentStream = vi.fn(async (params: unknown) => {
    // Forward args + resolved value to/from the underlying mock so spies and
    // mockResolvedValue/mockRejectedValue chains keep their existing semantics.
    const response = await generateContent(params);
    async function* gen() {
      yield response;
    }
    return gen();
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
      forceMaxOutputTokens: opts.forceMaxOutputTokens ?? false,
    } as ToolContext['config'],
    client: {
      models: { generateContent, generateContentStream },
    } as unknown as ToolContext['client'],
    manifest: {
      reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
      finalizeBudgetReservation: vi.fn(),
      cancelBudgetReservation: vi.fn(),
      insertUsageMetric: vi.fn(),
    } as unknown as ToolContext['manifest'],
    ttlWatcher: {
      markHot: vi.fn(),
    } as unknown as ToolContext['ttlWatcher'],
    progressToken: undefined,
    throttle: throttleSpy,
  };

  return { ctx, throttleSpy, generateContent };
}

function methodSequence(spy: ThrottleSpy): string[] {
  return spy.calls.map((c) => c.method);
}

describe('ask.tool.ts throttle call sequence (T22b regression)', () => {
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
      requested: 'latest-pro',
      resolved: 'gemini-3-pro-preview',
      inputTokenLimit: 2_000_000,
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

  it('happy path: reserve → release, no cancel', async () => {
    const { ctx, throttleSpy } = buildCtx();
    const result = await askTool.execute({ prompt: 'q' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'release']);
  });

  it('non-stale error: reserve → cancel (no release)', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('boom'));
    const { ctx, throttleSpy } = buildCtx({ generateContent });

    const result = await askTool.execute({ prompt: 'q' }, ctx);

    expect(result.isError).toBe(true);
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
  });

  it('stale-cache retry: reserve → cancel → reserve → release (T22 round-3 regression)', async () => {
    // First call throws a stale-cache error; retry succeeds.
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
    // First prepareContext returns a cacheId so the retry branch is even
    // reachable (isStaleCacheError is gated by `activePrep.cacheId`).
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
    const result = await askTool.execute({ prompt: 'q' }, ctx);

    expect(result.isError).toBeUndefined();
    // Critical invariant from round-3 fix: retry branch must CANCEL the
    // stale reservation and take a FRESH one so tsMs reflects actual
    // retry dispatch time, not the pre-rebuild original reserve.
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel', 'reserve', 'release']);
  });

  it('real ApiError 429: reserve → recordRetryHint → cancel (T22a primary path)', async () => {
    // Real @google/genai ApiError instance with typed `.status === 429`.
    // Gate requires BOTH prototype check + status match. This is the only
    // supported hint-seeding path after v1.3.2 tightening.
    const apiErr = new ApiError({
      status: 429,
      message: '{"error":{"code":429,"details":[{"retryDelay":"7s"}]}}',
    });
    const generateContent = vi.fn().mockRejectedValue(apiErr);
    const { ctx, throttleSpy } = buildCtx({ generateContent });

    const result = await askTool.execute({ prompt: 'q' }, ctx);

    expect(result.isError).toBe(true);
    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'recordRetryHint', 'cancel']);
    const hintCall = throttleSpy.calls.find((c) => c.method === 'recordRetryHint');
    expect(hintCall?.args[0]).toBe('gemini-3-pro-preview');
    expect(hintCall?.args[1]).toBe(7_000);
  });

  it('plain Error with RESOURCE_EXHAUSTED substring: NO hint seeded (v1.3.2 tightening)', async () => {
    // The earlier v1.3.2 draft had a `/RESOURCE_EXHAUSTED/` substring
    // fallback that was user-influenceable (echoed prompt content → open
    // gate → poison). Round-2 GPT + Grok flagged it CRITICAL. Tightened
    // gate requires the ApiError prototype — substring alone no longer
    // opens. This test locks in the tighter contract.
    const generateContent = vi
      .fn()
      .mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED {"retryInfo":{"retryDelay":"7s"}}'));
    const { ctx, throttleSpy } = buildCtx({ generateContent });

    await askTool.execute({ prompt: 'q' }, ctx);

    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
    expect(throttleSpy.calls.find((c) => c.method === 'recordRetryHint')).toBeUndefined();
  });

  it('non-429 error with decoy retryDelay + RESOURCE_EXHAUSTED: NO hint (full poisoning guard)', async () => {
    // Worst-case poisoning attempt: user prompt crafted with BOTH markers
    // (`RESOURCE_EXHAUSTED` AND `"retryDelay":"60s"`), echoed into a
    // non-429 error body. Under the earlier draft's substring fallback
    // this would have seeded a 60 s hint (GPT/Grok CRITICAL bypass).
    // Tightened gate rejects non-ApiError errors regardless of message
    // content. Matches the attack model flagged in round-2 review.
    const generateContent = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Safety filter blocked: RESOURCE_EXHAUSTED detected in prompt {"retryDelay":"60s"}',
        ),
      );
    const { ctx, throttleSpy } = buildCtx({ generateContent });

    await askTool.execute({ prompt: 'q' }, ctx);

    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
    expect(throttleSpy.calls.find((c) => c.method === 'recordRetryHint')).toBeUndefined();
  });

  it('ApiError with non-429 status + retryDelay body: NO hint (status-strict gate)', async () => {
    // Gate requires BOTH `instanceof ApiError` AND `status === 429`.
    // A real ApiError with a different status (500, 503, etc.) that
    // coincidentally contains a `retryDelay` substring in its body must
    // NOT seed a hint — otherwise future Gemini error shapes that embed
    // retry-info fields in non-quota errors could poison the throttle.
    // /6step finding E — marginal hardening test.
    const apiErr = new ApiError({
      status: 500,
      message: '{"error":{"code":500,"details":[{"retryDelay":"15s"}]}}',
    });
    const generateContent = vi.fn().mockRejectedValue(apiErr);
    const { ctx, throttleSpy } = buildCtx({ generateContent });

    await askTool.execute({ prompt: 'q' }, ctx);

    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
    expect(throttleSpy.calls.find((c) => c.method === 'recordRetryHint')).toBeUndefined();
  });

  it('custom wrapper Error with status=429 but no ApiError prototype: NO hint', async () => {
    // `Object.assign(new Error(...), { status: 429 })` can forge the
    // status field but NOT the ApiError prototype. Gate rejects.
    // Prevents Axios re-throws, logger wrappers, upstream HTTP 429s
    // from unrelated services from reaching the parser.
    const wrapped = Object.assign(new Error('{"retryDelay":"7s"}'), { status: 429 });
    const generateContent = vi.fn().mockRejectedValue(wrapped);
    const { ctx, throttleSpy } = buildCtx({ generateContent });

    await askTool.execute({ prompt: 'q' }, ctx);

    expect(methodSequence(throttleSpy)).toEqual(['reserve', 'cancel']);
    expect(throttleSpy.calls.find((c) => c.method === 'recordRetryHint')).toBeUndefined();
  });

  it('disabled throttle (tpmThrottleLimit=0): no reserve/release/cancel', async () => {
    const { ctx, throttleSpy } = buildCtx({ tpmThrottleLimit: 0 });
    const result = await askTool.execute({ prompt: 'q' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(methodSequence(throttleSpy)).toEqual([]);
  });

  it('reserve happens AFTER prepareContext (round-2 timing fix — tsMs accuracy)', async () => {
    const order: string[] = [];
    mocks.prepareContext.mockImplementation(async () => {
      order.push('prepareContext');
      return {
        cacheId: null,
        inlineContents: [],
        reused: false,
        rebuilt: false,
        inlineOnly: true,
        uploaded: { failedCount: 0, failures: [] },
      };
    });

    const { ctx, throttleSpy } = buildCtx();
    // Intercept reserve to record when it runs relative to prepareContext.
    const originalReserve = throttleSpy.reserve;
    throttleSpy.reserve = ((...args: Parameters<typeof originalReserve>) => {
      order.push('reserve');
      return originalReserve(...args);
    }) as typeof originalReserve;

    await askTool.execute({ prompt: 'q' }, ctx);

    expect(order).toEqual(['prepareContext', 'reserve']);
  });
});

describe('ask.tool.ts maxOutputTokens precedence (v1.4.0)', () => {
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

  function lastGenerateContentCall(gc: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const call = gc.mock.calls[gc.mock.calls.length - 1];
    const firstArg = call?.[0] as { config?: Record<string, unknown> } | undefined;
    return firstArg?.config ?? {};
  }

  it('default (no overrides) → maxOutputTokens omitted from wire (auto behaviour)', async () => {
    // Per Gemini docs, omitting `maxOutputTokens` lets the model use its
    // default cap (= advertised `outputTokenLimit`, currently 65,536). We
    // don't set the field; Gemini decides response length on complexity.
    const { ctx, generateContent } = buildCtx();
    await askTool.execute({ prompt: 'q' }, ctx);
    const config = lastGenerateContentCall(generateContent);
    expect(config).not.toHaveProperty('maxOutputTokens');
  });

  it('GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true → wire carries model.outputTokenLimit', async () => {
    // MCP-host env override: every call runs at full model capacity.
    const { ctx, generateContent } = buildCtx({ forceMaxOutputTokens: true });
    await askTool.execute({ prompt: 'q' }, ctx);
    const config = lastGenerateContentCall(generateContent);
    expect(config.maxOutputTokens).toBe(65_536);
  });

  it('per-call input.maxOutputTokens overrides both default and env-force', async () => {
    // Strongest layer: caller wants a tight cap regardless of env setting.
    const { ctx, generateContent } = buildCtx({ forceMaxOutputTokens: true });
    await askTool.execute({ prompt: 'q', maxOutputTokens: 4_096 }, ctx);
    const config = lastGenerateContentCall(generateContent);
    expect(config.maxOutputTokens).toBe(4_096);
  });

  it('per-call cap above model limit is clamped down to the model limit', async () => {
    const { ctx, generateContent } = buildCtx();
    await askTool.execute({ prompt: 'q', maxOutputTokens: 999_999 }, ctx);
    const config = lastGenerateContentCall(generateContent);
    expect(config.maxOutputTokens).toBe(65_536);
  });
});
