/**
 * v1.19.0 — the Gemini service tier on `ask` and `code`: the per-call value, the operator default, what reaches the
 * request config, what the cost estimate charges and what a refused request reports. The workspace, the model and the
 * context are mocked as in the sibling suites; `generateContentStream` records what would be sent.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readServiceTierEnv } from '../../src/config.js';
import { askTool } from '../../src/tools/ask.tool.js';
import { codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import {
  networkAttempts,
  resolveServiceTier,
  statusOf,
  tierErrorMeta,
} from '../../src/tools/shared/service-tier.js';
import {
  FLEX_PRICE_FACTOR,
  estimateCostUsd,
  estimatePreCallCostUsd,
} from '../../src/utils/cost-estimator.js';

const mocks = vi.hoisted(() => ({
  validateWorkspacePath: vi.fn(),
  scanWorkspace: vi.fn(),
  buildScanMemo: vi.fn(() => new Map()),
  resolveModel: vi.fn(),
  prepareContext: vi.fn(),
  isStaleCacheError: vi.fn(),
  markCacheStale: vi.fn(),
}));

vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: mocks.validateWorkspacePath,
}));
vi.mock('../../src/indexer/workspace-scanner.js', () => ({
  scanWorkspace: mocks.scanWorkspace,
  buildScanMemo: mocks.buildScanMemo,
}));
vi.mock('../../src/gemini/models.js', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('../../src/cache/cache-manager.js', () => ({
  prepareContext: mocks.prepareContext,
  isStaleCacheError: mocks.isStaleCacheError,
  markCacheStale: mocks.markCacheStale,
}));

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gcc-tier-')));

interface Sent {
  contents: unknown;
  config: Record<string, unknown>;
}

/** The i-th request, or a failing assertion — never a non-null assertion. */
function sentAt(sent: Sent[], i: number): Sent {
  const s = sent[i];
  if (s === undefined) throw new Error(`no request #${i} was sent (${sent.length} sent)`);
  return s;
}

function buildCtx(
  configOverrides: Partial<ToolContext['config']> = {},
  failWith?: () => never,
): { ctx: ToolContext; sent: Sent[] } {
  const sent: Sent[] = [];
  const generateContentStream = vi.fn(async (params: Sent) => {
    sent.push(params);
    if (failWith) failWith();
    async function* gen() {
      yield {
        text: 'ok',
        candidates: [],
        usageMetadata: {
          promptTokenCount: 1_000,
          cachedContentTokenCount: 0,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 0,
        },
      };
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
      tpmThrottleLimit: 0,
      forceMaxOutputTokens: false,
      serviceTier: 'standard',
      vertex: false,
      defaultModel: 'latest-pro',
      workspaceGuardRatio: 0.8,
      ...configOverrides,
    } as ToolContext['config'],
    client: {
      models: { generateContentStream, generateContent: vi.fn(), countTokens: vi.fn() },
    } as unknown as ToolContext['client'],
    manifest: {
      reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
      finalizeBudgetReservation: vi.fn(),
      cancelBudgetReservation: vi.fn(),
      insertUsageMetric: vi.fn(),
      getFiles: vi.fn(() => []),
    } as unknown as ToolContext['manifest'],
    ttlWatcher: { markHot: vi.fn() } as unknown as ToolContext['ttlWatcher'],
    throttle: {
      reserve: vi.fn(() => ({ delayMs: 0, releaseId: 1 })),
      release: vi.fn(),
      cancel: vi.fn(),
      shouldDelay: vi.fn(() => 0),
      recordRetryHint: vi.fn(),
    } as unknown as ToolContext['throttle'],
    progressToken: undefined,
  } as unknown as ToolContext;
  return { ctx, sent };
}

const resolved = {
  requested: 'latest-pro',
  resolved: 'gemini-3-pro-preview',
  inputTokenLimit: 2_000_000,
  outputTokenLimit: 65_536,
  fallbackApplied: false,
  category: 'text-reasoning' as const,
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
    supportsCodeExecution: true,
    costTier: 'premium',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorkspacePath.mockReturnValue(undefined);
  mocks.scanWorkspace.mockResolvedValue({
    workspaceRoot: dir,
    filesHash: 'abc',
    files: [
      {
        relpath: 'a.ts',
        absolutePath: join(dir, 'a.ts'),
        size: 100,
        contentHash: 'h1',
        mtimeMs: 0,
      },
    ],
    skippedTooLarge: 0,
    truncated: false,
  });
  mocks.resolveModel.mockResolvedValue(resolved);
  mocks.prepareContext.mockResolvedValue({
    cacheId: null,
    inlineContents: [{ role: 'user', parts: [{ text: 'workspace' }] }],
    reused: false,
    rebuilt: false,
    inlineOnly: true,
    uploaded: { failedCount: 0, failures: [] },
  });
  mocks.isStaleCacheError.mockReturnValue(false);
});

describe('service tier (1.19.0)', () => {
  it("serviceTier 'flex' reaches the request config of ask; standard (the default) sends no tier field", async () => {
    const { ctx, sent } = buildCtx();
    await askTool.execute({ prompt: 'q', workspace: dir, serviceTier: 'flex' }, ctx);
    const standard = await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(sentAt(sent, 0).config.serviceTier).toBe('flex');
    expect('serviceTier' in sentAt(sent, 1).config).toBe(false);
    expect(standard.structuredContent?.serviceTier).toBe('standard');
  });

  it('the operator default applies to ask and code; a per-call standard overrides it; code reports it', async () => {
    const { ctx, sent } = buildCtx({ serviceTier: 'flex' });
    await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    await askTool.execute({ prompt: 'q', workspace: dir, serviceTier: 'standard' }, ctx);
    const code = await codeTool.execute({ task: 'x', workspace: dir }, ctx);
    expect(sentAt(sent, 0).config.serviceTier).toBe('flex');
    expect('serviceTier' in sentAt(sent, 1).config).toBe(false);
    expect(code.isError, String(code.content[0]?.text)).not.toBe(true);
    expect(code.structuredContent?.serviceTier).toBe('flex');
    expect(sentAt(sent, 2).config.serviceTier).toBe('flex');
  });

  it('flex is priced at half: the estimate, the pre-call estimate, and so the budget reservation', () => {
    const base = {
      model: 'gemini-3-pro-preview',
      uncachedInputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 2_000,
    };
    const standard = estimateCostUsd(base);
    expect(estimateCostUsd({ ...base, serviceTier: 'flex' })).toBeCloseTo(
      standard * FLEX_PRICE_FACTOR,
      10,
    );
    const pre = {
      model: 'gemini-3-pro-preview',
      workspaceBytes: 400_000,
      promptChars: 40,
      expectedOutputTokens: 100,
    };
    expect(estimatePreCallCostUsd({ ...pre, serviceTier: 'flex' })).toBeCloseTo(
      estimatePreCallCostUsd(pre) * FLEX_PRICE_FACTOR,
      10,
    );
  });

  it('a 429 or 503 is reported as a retryable tier error with the tier, not UNKNOWN', async () => {
    for (const [status, code] of [
      [429, 'RATE_LIMIT'],
      [503, 'OVERLOADED'],
    ] as const) {
      const { ctx } = buildCtx({ serviceTier: 'flex' }, () => {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      });
      const result = await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.errorCode).toBe(code);
      expect(result.structuredContent?.retryable).toBe(true);
      expect(result.structuredContent?.serviceTier).toBe('flex');
    }
    expect(tierErrorMeta(Object.assign(new Error('x'), { status: 500 }))).toEqual({
      errorCode: 'UNKNOWN',
    });
    expect(
      tierErrorMeta(
        Object.assign(new Error('{"error":{"code":429,"details":[{"retryDelay":"7s"}]}}'), {
          status: 429,
        }),
      ),
    ).toEqual({ errorCode: 'RATE_LIMIT', retryable: true, retryAfterMs: 7_000 });
    expect(statusOf(Object.assign(new Error('x'), { status: 429 }))).toBe(429);
    expect(statusOf(new Error('x'))).toBeUndefined();
  });

  it('a 429 that hits the retry after a stale cache keeps its status on the wrapped error', async () => {
    let calls = 0;
    const { ctx } = buildCtx({}, () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('cache gone'), { status: 404 });
      throw Object.assign(new Error('HTTP 429'), { status: 429 });
    });
    mocks.isStaleCacheError.mockImplementation(
      (e: unknown) => (e as { status?: number }).status === 404,
    );
    mocks.prepareContext.mockResolvedValue({
      cacheId: 'cachedContents/abc',
      inlineContents: [],
      reused: true,
      rebuilt: false,
      inlineOnly: false,
      uploaded: { failedCount: 0, failures: [] },
    });
    const result = await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('RATE_LIMIT');
    expect(result.structuredContent?.httpStatus).toBe(429);
  });

  it('a status-less failure on the stale-cache retry reports no httpStatus (the stale 404 is not the error)', async () => {
    let calls = 0;
    const { ctx } = buildCtx({}, () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('cache gone'), { status: 404 });
      throw new Error('boom');
    });
    mocks.isStaleCacheError.mockImplementation(
      (e: unknown) => (e as { status?: number }).status === 404,
    );
    mocks.prepareContext.mockResolvedValue({
      cacheId: 'cachedContents/abc',
      inlineContents: [],
      reused: true,
      rebuilt: false,
      inlineOnly: false,
      uploaded: { failedCount: 0, failures: [] },
    });
    const result = await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
    expect(result.structuredContent?.httpStatus).toBeUndefined();
  });

  it('a flex request is sent once: a connection failure is not re-sent; standard keeps its three attempts', async () => {
    const flex = buildCtx({}, () => {
      throw new TypeError('fetch failed');
    });
    const standard = buildCtx({}, () => {
      throw new TypeError('fetch failed');
    });
    await askTool.execute(
      { prompt: 'q', workspace: dir, serviceTier: 'flex', timeoutMs: 30_000 },
      flex.ctx,
    );
    expect(flex.sent).toHaveLength(1);
    await askTool.execute({ prompt: 'q', workspace: dir, timeoutMs: 30_000 }, standard.ctx);
    expect(standard.sent).toHaveLength(3);
    expect(networkAttempts('flex')).toBe(1);
    expect(networkAttempts('standard')).toBe(3);
  }, 30_000);

  it('on Vertex a per-call flex is refused by name; an operator default of flex runs standard', async () => {
    const { ctx, sent } = buildCtx({ vertex: true, serviceTier: 'flex' });
    const refused = await askTool.execute(
      { prompt: 'q', workspace: dir, serviceTier: 'flex' },
      ctx,
    );
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.errorCode).toBe('SERVICE_TIER_UNSUPPORTED');
    expect(sent).toHaveLength(0);
    const defaulted = await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(defaulted.structuredContent?.serviceTier).toBe('standard');
    expect('serviceTier' in sentAt(sent, 0).config).toBe(false);
    const code = await codeTool.execute({ task: 'x', workspace: dir, serviceTier: 'flex' }, ctx);
    expect(code.structuredContent?.errorCode).toBe('SERVICE_TIER_UNSUPPORTED');
    expect(resolveServiceTier(undefined, 'flex', true)).toBe('standard');
  });

  it('the operator knob is trimmed and case-insensitive; an invalid value is standard; flex on Vertex is standard', () => {
    const saved = process.env.GEMINI_CODE_CONTEXT_SERVICE_TIER;
    const set = (value: string | undefined) => {
      if (value === undefined)
        Reflect.deleteProperty(process.env, 'GEMINI_CODE_CONTEXT_SERVICE_TIER');
      else process.env.GEMINI_CODE_CONTEXT_SERVICE_TIER = value;
    };
    try {
      set('  FLEX ');
      expect(readServiceTierEnv()).toBe('flex');
      expect(readServiceTierEnv(true)).toBe('standard');
      set('fast');
      expect(readServiceTierEnv()).toBe('standard');
      set(undefined);
      expect(readServiceTierEnv()).toBe('standard');
    } finally {
      set(saved);
    }
  });

  it('code on the cached path sends the tier, and its usage row is written at the flex price', async () => {
    mocks.prepareContext.mockResolvedValue({
      cacheId: 'cachedContents/abc',
      inlineContents: [],
      reused: true,
      rebuilt: false,
      inlineOnly: false,
      uploaded: { failedCount: 0, failures: [] },
    });
    const flex = buildCtx({ serviceTier: 'flex' });
    const standard = buildCtx();
    await codeTool.execute({ task: 'x', workspace: dir }, flex.ctx);
    await codeTool.execute({ task: 'x', workspace: dir }, standard.ctx);
    expect(sentAt(flex.sent, 0).config.serviceTier).toBe('flex');
    expect(sentAt(flex.sent, 0).config.cachedContent).toBe('cachedContents/abc');
    const rowOf = (ctx: ToolContext) =>
      (ctx.manifest as unknown as { insertUsageMetric: ReturnType<typeof vi.fn> }).insertUsageMetric
        .mock.calls[0]?.[0] as { costUsdMicro: number } | undefined;
    const flexRow = rowOf(flex.ctx);
    const standardRow = rowOf(standard.ctx);
    expect(flexRow?.costUsdMicro).toBeDefined();
    expect(flexRow?.costUsdMicro).toBeCloseTo(
      (standardRow?.costUsdMicro ?? 0) * FLEX_PRICE_FACTOR,
      -1,
    );
  });

  it('a flex timeout reports the tier too', async () => {
    const { ctx } = buildCtx({}, () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const result = await askTool.execute(
      { prompt: 'q', workspace: dir, serviceTier: 'flex', timeoutMs: 1_000 },
      ctx,
    );
    expect(result.structuredContent?.serviceTier).toBe('flex');
  });
});
