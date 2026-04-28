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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askTool } from '../../src/tools/ask.tool.js';
import { codeInputSchema, codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';

const mocks = vi.hoisted(() => ({
  validateWorkspacePath: vi.fn(),
  scanWorkspace: vi.fn(),
  resolveModel: vi.fn(),
  prepareContext: vi.fn(),
  isStaleCacheError: vi.fn(),
  markCacheStale: vi.fn(),
  // v1.11.0 — `ask` may delegate to `ask_agentic` when the caller opts
  // in via `onWorkspaceTooLarge: 'fallback-to-agentic'`. Mock the
  // module so we can assert on the translation + wrapping without
  // booting the agentic loop.
  askAgenticExecute: vi.fn(),
}));

vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: mocks.validateWorkspacePath,
  WorkspaceValidationError: class extends Error {},
}));
vi.mock('../../src/indexer/workspace-scanner.js', () => ({
  scanWorkspace: mocks.scanWorkspace,
  // v1.13.0 — tools call `buildScanMemo(manifest.getFiles(...))` before
  // `scanWorkspace` to thread the scan memo. Stub returning an empty Map
  // so the call is harmless when scanWorkspace itself is mocked out.
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
vi.mock('../../src/tools/ask-agentic.tool.js', () => ({
  askAgenticTool: { execute: mocks.askAgenticExecute },
}));

function buildCtx(opts: {
  workspaceGuardRatio?: number;
  dailyBudgetUsd?: number;
  /** v1.14.0+: override cachingMode default for tests that need to assert
   *  per-config behaviour. Unset → defaults to `'implicit'` (the v1.14.0
   *  production default) so existing tests don't regress. */
  cachingMode?: 'explicit' | 'implicit';
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
      // v1.14.0: default flip pinned at the test-fixture level so the
      // tool's `requestedCachingMode` resolves through `ctx.config.cachingMode`
      // when the per-call field is unset (matches loadConfig() production).
      cachingMode: opts.cachingMode ?? 'implicit',
    } as ToolContext['config'],
    client: {
      models: {
        generateContent,
        // T20 (v1.7.0): production now calls `generateContentStream`; wrap
        // the existing `generateContent` mock as a single-chunk stream so
        // call-args / mockRejectedValue / mockResolvedValue all keep working.
        generateContentStream: vi.fn(async (params: unknown) => {
          const response = await generateContent(params);
          async function* gen() {
            yield response;
          }
          return gen();
        }),
        // v1.10.0: `countForPreflight` may call `client.models.countTokens`
        // when the workspace is >50% of `inputTokenLimit`. We mock it with
        // the same `bytes/4` heuristic the production heuristic uses, so
        // tests authored against the v1.5.0-v1.9.x heuristic-only preflight
        // see identical behaviour by default. Per-test overrides via
        // `vi.spyOn(client.models, 'countTokens').mockResolvedValueOnce(...)`
        // are still possible (see `token-counter.test.ts` for the spy
        // pattern).
        countTokens: vi.fn(
          async (params: { contents: Array<{ parts?: Array<{ text?: string }> }> }) => {
            // Mirror countForPreflight's payload shape (sum text lengths
            // across all parts × 0.25). Doesn't have to be exact; just has
            // to give the SAME tier-2 verdict the heuristic does so the
            // test assertion stays stable.
            let totalBytes = 0;
            for (const content of params.contents ?? []) {
              for (const part of content.parts ?? []) {
                if (typeof part.text === 'string') totalBytes += part.text.length;
              }
            }
            return { totalTokens: Math.ceil(totalBytes / 4) };
          },
        ),
      },
    } as unknown as ToolContext['client'],
    manifest: {
      reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
      finalizeBudgetReservation: vi.fn(),
      cancelBudgetReservation: vi.fn(),
      insertUsageMetric: vi.fn(),
      getFiles: vi.fn(() => []),
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

  // ---------------------------------------------------------------------------
  // v1.11.0 — opt-in `ask` → `ask_agentic` auto-fallback
  // ---------------------------------------------------------------------------

  it("default onWorkspaceTooLarge='error' preserves v1.5.0 behaviour (no fallback)", async () => {
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    const { ctx } = buildCtx({});

    const result = await askTool.execute({ prompt: 'q' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');
    // Critically: ask_agentic must NOT have been called when the user
    // didn't opt in (today's default is 'error').
    expect(mocks.askAgenticExecute).not.toHaveBeenCalled();
  });

  it("onWorkspaceTooLarge='fallback-to-agentic' invokes ask_agentic and wraps the result", async () => {
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    const { ctx, generateContent } = buildCtx({});

    // Mock ask_agentic returning a known shape WITH the canonical
    // `responseText` key — the wrapper must preserve this T23 wire-format
    // invariant on the fallback path. (Pre-fix the wrapper built
    // `wrappedStructured` from scratch and dropped `responseText`,
    // breaking sub-agent orchestrators that extract from
    // `structuredContent.responseText` only.)
    mocks.askAgenticExecute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'agentic prose answer here' }],
      structuredContent: {
        iterations: 4,
        totalInputTokens: 12_345,
        resolvedModel: 'gemini-3-pro-preview',
        responseText: 'agentic prose answer here',
      },
    });

    const result = await askTool.execute(
      {
        prompt: 'analyse this',
        onWorkspaceTooLarge: 'fallback-to-agentic',
        // Pass a few translatable fields to verify the input mapping.
        includeGlobs: ['*.ts'],
        excludeGlobs: ['*.test.ts'],
        timeoutMs: 60_000,
        thinkingLevel: 'HIGH',
      },
      ctx,
    );

    // ask_agentic invoked exactly once with the translated input.
    expect(mocks.askAgenticExecute).toHaveBeenCalledTimes(1);
    const agenticInput = mocks.askAgenticExecute.mock.calls[0]?.[0];
    expect(agenticInput.prompt).toBe('analyse this');
    expect(agenticInput.includeGlobs).toEqual(['*.ts']);
    expect(agenticInput.excludeGlobs).toEqual(['*.test.ts']);
    expect(agenticInput.thinkingLevel).toBe('HIGH');
    // `timeoutMs` translates to `iterationTimeoutMs` (semantic divergence
    // — documented in the schema). No `timeoutMs` should leak through.
    expect(agenticInput.iterationTimeoutMs).toBe(60_000);
    expect(agenticInput.timeoutMs).toBeUndefined();

    // The eager pipeline (scan → preflight → prepareContext → generateContent)
    // is bypassed entirely on the fallback path.
    expect(generateContent).not.toHaveBeenCalled();
    expect(mocks.prepareContext).not.toHaveBeenCalled();

    // The wrapped result keeps the agentic prose verbatim AND enriches
    // structuredContent with fallback-trail metadata.
    expect(result.content?.[0]).toEqual({
      type: 'text',
      text: 'agentic prose answer here',
    });
    expect(result.structuredContent?.fallbackApplied).toBe('ask_agentic');
    expect(result.structuredContent?.fallbackReason).toBe('WORKSPACE_TOO_LARGE');
    // T23 wire-format invariant — `responseText` MUST be present at the
    // top of `structuredContent`. Pre-fix this assertion failed because
    // the wrapper dropped the key.
    expect(result.structuredContent?.responseText).toBe('agentic prose answer here');
    const preflightMeta = result.structuredContent?.preflightEstimate as Record<string, unknown>;
    expect(preflightMeta).toBeDefined();
    expect(preflightMeta.threshold).toBe(943_718);
    expect(typeof preflightMeta.tokens).toBe('number');
    // Original agenticResult preserved for orchestrators that need to
    // audit the underlying agentic loop's metadata.
    const agenticResult = result.structuredContent?.agenticResult as Record<string, unknown>;
    expect(agenticResult.iterations).toBe(4);
  });

  it('falls back to content[0].text for responseText when agenticResult.structuredContent omits it', async () => {
    // Defensive: an older / non-conformant ask_agentic implementation
    // might omit `responseText` from `structuredContent`. The wrapper
    // must still produce a non-empty `responseText` by reading
    // `content[0].text`.
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    const { ctx } = buildCtx({});

    mocks.askAgenticExecute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'prose only — no responseText' }],
      structuredContent: { iterations: 1 },
    });

    const result = await askTool.execute(
      { prompt: 'q', onWorkspaceTooLarge: 'fallback-to-agentic' },
      ctx,
    );
    expect(result.structuredContent?.responseText).toBe('prose only — no responseText');
  });

  it('fallback path lifts agentic errorCode + retryable to top of structuredContent', async () => {
    // If ask_agentic itself fails (e.g. iteration budget exhausted),
    // the wrapped result must propagate `isError` AND lift the
    // top-level error metadata (`errorCode`, `retryable`) so
    // orchestrator policies that switch on these keys keep working
    // without descending into nested `agenticResult.errorCode`.
    mockScanOfBytes(4_000_000);
    mockModelWithLimit(1_048_576);
    const { ctx } = buildCtx({});

    mocks.askAgenticExecute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ask_agentic: budget exhausted' }],
      structuredContent: {
        errorCode: 'BUDGET_EXHAUSTED',
        retryable: false,
        responseText: 'ask_agentic: budget exhausted',
      },
      isError: true,
    });

    const result = await askTool.execute(
      { prompt: 'q', onWorkspaceTooLarge: 'fallback-to-agentic' },
      ctx,
    );

    // `isError` is at the ROOT of CallToolResult per MCP spec — NOT
    // nested inside `structuredContent`. The pre-fix wrapper redundantly
    // set both; this assertion pins the root-only convention.
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.isError).toBeUndefined();

    // Wrapper-trail metadata still present.
    expect(result.structuredContent?.fallbackApplied).toBe('ask_agentic');

    // Top-level error metadata lifted — orchestrator policies switching
    // on `errorCode` / `retryable` keep working.
    expect(result.structuredContent?.errorCode).toBe('BUDGET_EXHAUSTED');
    expect(result.structuredContent?.retryable).toBe(false);

    // T23 wire-format — even on errors, `responseText` is present.
    expect(result.structuredContent?.responseText).toBe('ask_agentic: budget exhausted');
  });

  // Removed: pre-fix `fallback path passes through agentic isError flag
  // faithfully` superseded by the more comprehensive test above
  // (`fallback path lifts agentic errorCode + retryable to top of
  // structuredContent`). The pre-fix test asserted
  // `result.structuredContent?.isError === true`, which contradicts the
  // MCP spec convention (`isError` at the root, not nested) and pinned a
  // bug rather than a behaviour.
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

  it('strips onWorkspaceTooLarge from code input (asymmetry: ask-only)', () => {
    // `code` deliberately does NOT support `onWorkspaceTooLarge` — its
    // OLD/NEW edit format is load-bearing for Claude's Edit pipeline,
    // and `ask_agentic` returns prose only. The Zod schema's default
    // `.strip` mode silently drops unknown keys, so a caller passing
    // `onWorkspaceTooLarge` to `code` sees the field disappear (no
    // error; just a no-op). Pinning this empirically so a future
    // refactor that intentionally adds the field fails this test
    // and forces a deliberate decision to remove the asymmetry.
    const parsed = codeInputSchema.safeParse({
      task: 'refactor foo',
      onWorkspaceTooLarge: 'fallback-to-agentic',
    });
    // Parse succeeds (Zod strips unknown keys by default) — but the
    // field MUST be absent on the typed output. No fallback path can
    // ever fire on `code` because the field is never present.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).onWorkspaceTooLarge).toBeUndefined();
    }
  });
});

// v1.14.0 — `cachingMode` default flip threaded through the tool layer.
// Pins the end-to-end behaviour: when `input.cachingMode` is unset, the tool
// resolves through `ctx.config.cachingMode` and passes the result to
// `prepareContext`. Catches regressions where someone re-introduces the
// conditional spread that was the v1.13.0 bug shape.
describe('cachingMode tool-level default flip (v1.14.0+)', () => {
  it("ask uses ctx.config.cachingMode='implicit' when input.cachingMode is unset", async () => {
    const { ctx } = buildCtx({ cachingMode: 'implicit' });
    mockScanOfBytes(1_000); // small workspace, well under preflight cliff
    mockModelWithLimit(1_000_000);

    await askTool.execute({ prompt: 'hi' }, ctx);

    expect(mocks.prepareContext).toHaveBeenCalledTimes(1);
    const callArgs = mocks.prepareContext.mock.calls[0]?.[0] as { cachingMode?: string };
    expect(callArgs.cachingMode).toBe('implicit');
  });

  it("ask honours ctx.config.cachingMode='explicit' when input.cachingMode is unset", async () => {
    const { ctx } = buildCtx({ cachingMode: 'explicit' });
    mockScanOfBytes(1_000);
    mockModelWithLimit(1_000_000);

    await askTool.execute({ prompt: 'hi' }, ctx);

    const callArgs = mocks.prepareContext.mock.calls[0]?.[0] as { cachingMode?: string };
    expect(callArgs.cachingMode).toBe('explicit');
  });

  it('per-call input.cachingMode overrides ctx.config.cachingMode', async () => {
    const { ctx } = buildCtx({ cachingMode: 'implicit' }); // default
    mockScanOfBytes(1_000);
    mockModelWithLimit(1_000_000);

    // Caller explicitly opts into explicit mode; should override the default.
    await askTool.execute({ prompt: 'hi', cachingMode: 'explicit' }, ctx);

    const callArgs = mocks.prepareContext.mock.calls[0]?.[0] as { cachingMode?: string };
    expect(callArgs.cachingMode).toBe('explicit');
  });

  it("code uses ctx.config.cachingMode='implicit' when input.cachingMode is unset", async () => {
    const { ctx } = buildCtx({ cachingMode: 'implicit' });
    mockScanOfBytes(1_000);
    mockModelWithLimit(1_000_000);

    await codeTool.execute({ task: 'do something' }, ctx);

    const callArgs = mocks.prepareContext.mock.calls[0]?.[0] as { cachingMode?: string };
    expect(callArgs.cachingMode).toBe('implicit');
  });
});

// v1.14.0 — `cachingMode` default flip + env-var override behaviour.
// These tests pin the new default ('implicit') and the operator-level env
// override so a future regression that flips the default back, mistypes
// the env var, or forgets the strict-validation fallback is caught
// immediately rather than silently shipping the wrong cache strategy.
describe('cachingMode env resolution (v1.14.0+)', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'AIza-fake-for-unit-test-only');
  });

  // v1.14.0 round-2 fix (G2-2, Gemini P2): unconditional cleanup so a thrown
  // assertion mid-test doesn't leak stubbed env vars / spy state into sibling
  // tests. Pre-fix the inline `vi.unstubAllEnvs()` and `errSpy.mockRestore()`
  // calls at the bottom of each test only ran on the happy path; an `expect`
  // failure threw before they fired and contaminated downstream tests.
  // `afterEach` runs in both pass-and-fail paths, closing the leak.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('defaults to implicit when env var is unset', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('GEMINI_API_KEY', 'AIza-fake-for-unit-test-only');
    vi.resetModules();
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().cachingMode).toBe('implicit');
  });

  it('honours GEMINI_CODE_CONTEXT_CACHING_MODE=explicit', async () => {
    vi.stubEnv('GEMINI_CODE_CONTEXT_CACHING_MODE', 'explicit');
    vi.resetModules();
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().cachingMode).toBe('explicit');
    vi.unstubAllEnvs();
  });

  it('honours GEMINI_CODE_CONTEXT_CACHING_MODE=implicit', async () => {
    vi.stubEnv('GEMINI_CODE_CONTEXT_CACHING_MODE', 'implicit');
    vi.resetModules();
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().cachingMode).toBe('implicit');
    vi.unstubAllEnvs();
  });

  it('falls back to implicit + warns on invalid env value (no silent mistype)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('GEMINI_CODE_CONTEXT_CACHING_MODE', 'EXPLICITT'); // mistyped
    vi.resetModules();
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().cachingMode).toBe('implicit');
    // Operator gets a clear stderr signal that their override didn't take.
    expect(errSpy).toHaveBeenCalled();
    const warnText = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warnText).toMatch(/GEMINI_CODE_CONTEXT_CACHING_MODE/);
    expect(warnText).toMatch(/EXPLICITT/);
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('case-insensitive: EXPLICIT and Implicit both parse', async () => {
    vi.stubEnv('GEMINI_CODE_CONTEXT_CACHING_MODE', 'EXPLICIT');
    vi.resetModules();
    let { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().cachingMode).toBe('explicit');

    vi.stubEnv('GEMINI_CODE_CONTEXT_CACHING_MODE', 'Implicit');
    vi.resetModules();
    ({ loadConfig } = await import('../../src/config.js'));
    expect(loadConfig().cachingMode).toBe('implicit');
    vi.unstubAllEnvs();
  });

  // v1.14.0 round-1 fix (F9, Grok P1): whitespace-only env values are
  // morally equivalent to "unset" — they should short-circuit to the
  // default silently, NOT trigger the "not a recognised value" warning.
  // Pre-fix the empty-check happened BEFORE `.trim()`, so '   ' fell
  // through to the warn path with a confusing message.
  it('whitespace-only env value silently defaults to implicit (no warn)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('GEMINI_CODE_CONTEXT_CACHING_MODE', '   '); // whitespace only
    vi.resetModules();
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().cachingMode).toBe('implicit');
    // No warn should fire for whitespace-only — that's the F9 fix.
    const warnText = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warnText).not.toMatch(/not a recognised value/);
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  // v1.14.0 round-1 fix (F3+F4, Copilot + GPT P1): log injection via
  // raw env interpolation. Pre-fix, a value containing newlines or ANSI
  // escapes was echoed verbatim into a stderr line — downstream log
  // analyzers parsing line-by-line could see forged separate records.
  // Post-fix uses `safeForLog` which escapes C0 control chars to
  // printable form and caps length at 2000 chars.
  it('log-injection guard: control chars in env value escape to printable form (no record-splitting)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Forge attempt: newline + fake CRITICAL log record with ANSI red.
    const malicious = 'foo\n[CRITICAL] forged record\x1b[31mansi-red';
    vi.stubEnv('GEMINI_CODE_CONTEXT_CACHING_MODE', malicious);
    vi.resetModules();
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().cachingMode).toBe('implicit'); // fallback fired

    // safeForLog escapes \n → '\\n' and ESC → '\\x1b' (or similar
    // printable form). Critical assertion: the warn payload contains NO
    // raw newline character — record-splitting attempts collapse to one
    // line.
    expect(errSpy).toHaveBeenCalled();
    const warnPayload = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('|');
    // Empirical check: the malicious input had a literal '\n', the
    // sanitised version should NOT.
    expect(warnPayload).not.toMatch(/foo\n\[CRITICAL\]/);
    // The printable prefix MUST still be visible to operators (so they
    // see what they typed and can fix it). 'foo' should appear; the
    // escaped form of newline (e.g. '\\n' or 'ESC'-escape) should
    // also appear in the same single-line record.
    expect(warnPayload).toMatch(/foo/);
    // ANSI sequences MUST not survive — operator's terminal can't be
    // hijacked via a forged colour code. Pattern uses string-form regex
    // (NOT literal-regex syntax) to keep biome's noControlCharactersInRegex
    // rule happy: `\x1b` is the JS string-escape for the ESC byte (0x1b);
    // `RegExp(...)` then sees a literal ESC followed by `[31m` and the
    // assertion fires only if that exact byte sequence survived sanitisation.
    expect(warnPayload.includes(`${String.fromCharCode(0x1b)}[31m`)).toBe(false);

    errSpy.mockRestore();
    vi.unstubAllEnvs();
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
