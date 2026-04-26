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
    generateContentStream.mockImplementation(async () => {
      async function* gen() {
        yield { text: 'Hello ' };
        yield { text: 'multi-' };
        yield {
          text: 'chunk world.',
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 0,
            candidatesTokenCount: 50,
            thoughtsTokenCount: 0,
          },
        };
      }
      return gen();
    });

    const result = await askTool.execute({ prompt: 'hi' }, ctx);
    expect(result.isError).toBeFalsy();
    // The CONTENT[0].text contains the streamed answer joined into one string.
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Hello multi-chunk world.');
  });

  it('captures usageMetadata from the FINAL chunk only (not earliest)', async () => {
    const { ctx, generateContentStream } = buildCtx();
    generateContentStream.mockImplementation(async () => {
      async function* gen() {
        // Earlier chunk has usage, but the FINAL chunk's must win.
        yield { text: 'a', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        yield { text: 'b' };
        yield {
          text: 'c',
          usageMetadata: {
            promptTokenCount: 999,
            cachedContentTokenCount: 100,
            candidatesTokenCount: 50,
            thoughtsTokenCount: 10,
          },
        };
      }
      return gen();
    });

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
      async function* gen() {
        yield { text: 'partial-' };
        // Mid-stream throw — simulates network drop after some chunks landed.
        throw new TypeError('fetch failed');
      }
      return gen();
    });

    const result = await askTool.execute({ prompt: 'hi' }, ctx);
    // Stream opens exactly ONCE — the mid-stream failure is terminal.
    expect(openCount).toBe(1);
    // Surfaces as a regular failure (UNKNOWN errorCode + the SDK error message).
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
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
      async function* gen() {
        yield {
          text: 'second-attempt-success',
          usageMetadata: {
            promptTokenCount: 50,
            cachedContentTokenCount: 0,
            candidatesTokenCount: 25,
            thoughtsTokenCount: 0,
          },
        };
      }
      return gen();
    });

    const result = await askTool.execute({ prompt: 'hi', timeoutMs: 60_000 }, ctx);
    expect(openCount).toBe(2); // Initial + 1 retry succeeded.
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('second-attempt-success');
  });
});
