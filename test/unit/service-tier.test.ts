/**
 * v1.19.0 — the Gemini service tier on `ask` and `code`: the per-call value, the operator default, what reaches the
 * request config, what the cost estimate charges and what a refused request reports. The workspace, the model and the
 * context are mocked as in the sibling suites; `generateContentStream` records what would be sent.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askTool } from '../../src/tools/ask.tool.js';
import { codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { statusOf, tierErrorCode } from '../../src/tools/shared/service-tier.js';
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
      [429, 'RATE_LIMITED'],
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
    expect(tierErrorCode(500)).toEqual({ errorCode: 'UNKNOWN' });
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
    expect(result.structuredContent?.errorCode).toBe('RATE_LIMITED');
    expect(result.structuredContent?.httpStatus).toBe(429);
  });
});
