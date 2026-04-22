/**
 * Pre-flight workspace size guard (v1.5.0, `WORKSPACE_TOO_LARGE`).
 *
 * Verifies both `ask` and `code` fail-fast with a structured error when the
 * estimated input tokens exceed `inputTokenLimit * workspaceGuardRatio`,
 * WITHOUT calling into `prepareContext` / `generateContent` / the throttle.
 *
 * Background: before v1.5.0, an oversized workspace (e.g. a mid-size project 1.7M tokens
 * vs Gemini 1M context) dispatched the request anyway. Gemini returned
 * `400 INVALID_ARGUMENT` whose message is indistinguishable from transient
 * 400s; the orchestrating sub-agent retried until it exhausted its
 * tool-call budget — the observed "agent exhausted budget retrying".
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

function buildCtx(opts: {
  workspaceGuardRatio?: number;
  dailyBudgetUsd?: number;
}): {
  ctx: ToolContext;
  generateContent: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
} {
  const generateContent = vi.fn();
  const reserve = vi.fn();
  const throttle = {
    reserve: (...args: unknown[]) => {
      reserve(...args);
      return { delayMs: 0, releaseId: 1 };
    },
    release: vi.fn(),
    cancel: vi.fn(),
    shouldDelay: () => 0,
    recordRetryHint: vi.fn(),
  };
  const ctx = {
    server: {} as ToolContext['server'],
    config: {
      dailyBudgetUsd: opts.dailyBudgetUsd ?? Number.POSITIVE_INFINITY,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3_600,
      cacheMinTokens: 1_024,
      tpmThrottleLimit: 80_000,
      forceMaxOutputTokens: false,
      workspaceGuardRatio: opts.workspaceGuardRatio ?? 0.9,
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
    throttle,
  };
  return { ctx, generateContent, reserve };
}

/**
 * Build a scan result that sums to `totalBytes` worth of workspace — used
 * to trigger the preflight guard at a chosen size. Estimated tokens =
 * `totalBytes / 4 + promptChars / 4`.
 */
function mockScanOfBytes(totalBytes: number): void {
  mocks.scanWorkspace.mockResolvedValue({
    workspaceRoot: '/fake',
    filesHash: 'abc',
    files: [
      { relpath: 'big.ts', size: totalBytes, contentHash: 'h1', absolutePath: '/fake/big.ts' },
    ],
    skippedTooLarge: 0,
    truncated: false,
  });
}

function mockModelWithLimit(inputTokenLimit: number | null): void {
  mocks.resolveModel.mockResolvedValue({
    requested: 'latest-pro',
    resolved: 'gemini-3-pro-preview',
    inputTokenLimit,
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
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorkspacePath.mockReturnValue(undefined);
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

describe('ask preflight workspace guard (v1.5.0)', () => {
  it('blocks when estimated tokens exceed threshold, returns structured error', async () => {
    // Workspace: 4M bytes → ~1M tokens (bytes/4). Model: 1M input cap.
    // Threshold at 0.9 = 900k. 1M + prompt tokens ≫ 900k → blocked.
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    const { ctx, generateContent, reserve } = buildCtx({});

    const result = await askTool.execute({ prompt: 'analyse this' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');
    expect(result.structuredContent?.retryable).toBe(false);
    expect(result.structuredContent?.contextWindowTokens).toBe(1_048_576);
    expect(result.structuredContent?.thresholdTokens).toBe(943_718); // floor(1048576 * 0.9)
    expect(typeof result.structuredContent?.estimatedInputTokens).toBe('number');

    // Downstream pipeline MUST NOT have been reached: no throttle, no cache
    // build, no generateContent. That's the whole point of fail-fast.
    expect(generateContent).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(mocks.prepareContext).not.toHaveBeenCalled();
  });

  it('passes through when estimated tokens sit below threshold', async () => {
    // 100k bytes = ~25k tokens. Plenty of room under 900k threshold.
    mockScanOfBytes(100_000);
    mockModelWithLimit(1_048_576);
    const { ctx, generateContent } = buildCtx({});

    generateContent.mockResolvedValue({
      text: 'ok',
      candidates: [],
      usageMetadata: {
        promptTokenCount: 25_000,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 0,
      },
    });

    const result = await askTool.execute({ prompt: 'q' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('respects `workspaceGuardRatio` when operator bumps it up', async () => {
    // 4M bytes ≈ 1M tokens. Model 1M cap. With ratio 0.95 threshold = 995k.
    // This is the boundary where a ratio bump from 0.9 flips the answer.
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    // Estimated = 1_000_001 (from workspaceBytes/4 + promptChars/4, prompt='q' ≈ 1 token).
    // 1_000_001 > 943_718 (0.9) but also > 996_147 (0.95) — still blocked.
    // Flip threshold: reduce workspace so 0.95 passes but 0.9 blocks.
    // Use 3.9M bytes → 975_000 tokens. 975_000 > 943_718 (0.9 blocks) but
    // 975_000 < 996_147 (0.95 passes).
    mockScanOfBytes(3_900_000);

    // With default ratio (0.9) → blocks.
    const { ctx: defaultCtx } = buildCtx({});
    const defaultRes = await askTool.execute({ prompt: 'q' }, defaultCtx);
    expect(defaultRes.isError).toBe(true);
    expect(defaultRes.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');

    // With ratio 0.95 → passes.
    const { ctx: permissiveCtx, generateContent } = buildCtx({ workspaceGuardRatio: 0.95 });
    generateContent.mockResolvedValue({
      text: 'ok',
      candidates: [],
      usageMetadata: {
        promptTokenCount: 975_000,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 0,
      },
    });
    const permissiveRes = await askTool.execute({ prompt: 'q' }, permissiveCtx);
    expect(permissiveRes.isError).toBeUndefined();
  });

  it('skips guard and logs warning when model has no advertised inputTokenLimit', async () => {
    mockScanOfBytes(4_000_000); // would normally trigger guard
    mockModelWithLimit(null); // model didn't advertise a limit
    const { ctx, generateContent } = buildCtx({});

    generateContent.mockResolvedValue({
      text: 'ok',
      candidates: [],
      usageMetadata: {
        promptTokenCount: 1_000,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 0,
      },
    });

    const result = await askTool.execute({ prompt: 'q' }, ctx);

    // Guard skipped → downstream reached. Per codex feedback #2: missing
    // metadata shouldn't block legitimate calls. If the underlying API
    // can't handle the size, it'll surface naturally.
    expect(result.isError).toBeUndefined();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe('code preflight workspace guard (v1.5.0)', () => {
  it('blocks oversized workspace for `code` tool too, mirrors ask behaviour', async () => {
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    const { ctx, generateContent } = buildCtx({});

    const result = await codeTool.execute({ task: 'refactor foo' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');
    expect(result.structuredContent?.retryable).toBe(false);
    expect(generateContent).not.toHaveBeenCalled();
    expect(mocks.prepareContext).not.toHaveBeenCalled();
  });

  it('carries resolvedModel and filesIndexed in structured payload', async () => {
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    const { ctx } = buildCtx({});

    const result = await codeTool.execute({ task: 'q' }, ctx);

    expect(result.structuredContent?.resolvedModel).toBe('gemini-3-pro-preview');
    expect(result.structuredContent?.filesIndexed).toBe(1);
    expect(result.structuredContent?.guardRatio).toBe(0.9);
  });
});

describe('workspaceGuardRatio env clamping', () => {
  it('config clamps guard ratio to [0.5, 0.98]', async () => {
    // Direct config parse test — `loadConfig` re-reads env each call.
    // We verify via behaviour: pass ratio=99 into buildCtx (bypassing
    // loadConfig's clamp) and confirm the guard still fires when the
    // tool reads the value — i.e. the tool doesn't do its own clamp,
    // it trusts `config.workspaceGuardRatio` which must be pre-clamped
    // by loadConfig.
    //
    // `vi.stubEnv` is used over raw `process.env` mutation so Vitest
    // auto-restores on assertion failure + isolates parallel workers.
    // The fake `GEMINI_API_KEY` is needed because `loadConfig` also
    // invokes `resolveAuth` which throws on missing credentials — CI
    // (no secret) hit that throw before ratio-clamp logic could run.
    // PR #24 round-4 (external review confirmed by GPT-5.3-codex + Gemini 3-pro).
    vi.stubEnv('GEMINI_API_KEY', 'AIza-fake-for-unit-test-only');
    vi.stubEnv('GEMINI_CODE_CONTEXT_WORKSPACE_GUARD_RATIO', '99');
    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();
    expect(config.workspaceGuardRatio).toBeLessThanOrEqual(0.98);
    expect(config.workspaceGuardRatio).toBeGreaterThanOrEqual(0.5);
    vi.unstubAllEnvs();
  });
});
