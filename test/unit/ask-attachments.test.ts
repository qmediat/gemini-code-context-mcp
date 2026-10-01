/**
 * v1.19.0 — `ask` attachments (inline image/PDF parts) and the service tier, on the same harness as the throttle
 * suite: the workspace, the model and the context are mocked; `generateContentStream` records what would be sent.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askTool } from '../../src/tools/ask.tool.js';
import { codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';

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

const dir = mkdtempSync(join(tmpdir(), 'gcc-attach-'));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const shot = join(dir, 'shot.png');
writeFileSync(shot, PNG);
const notes = join(dir, 'notes.txt');
writeFileSync(notes, 'x');

interface Sent {
  contents: unknown;
  config: Record<string, unknown>;
}

function buildCtx(configOverrides: Partial<ToolContext['config']> = {}): {
  ctx: ToolContext;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const generateContentStream = vi.fn(async (params: Sent) => {
    sent.push(params);
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

const resolved = (supportsVision: boolean) => ({
  requested: 'latest-pro',
  resolved: 'gemini-3-pro-preview',
  inputTokenLimit: 2_000_000,
  outputTokenLimit: 65_536,
  fallbackApplied: false,
  category: 'text-reasoning' as const,
  capabilities: {
    supportsThinking: true,
    supportsVision,
    supportsCodeExecution: true,
    costTier: 'premium',
  },
});

/** The i-th request, or a failing assertion — never a non-null assertion. */
function sentAt(sent: Sent[], i: number): Sent {
  const s = sent[i];
  if (s === undefined) throw new Error(`no request #${i} was sent (${sent.length} sent)`);
  return s;
}

function lastUserParts(sent: Sent): Array<Record<string, unknown>> {
  const contents = sent.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const user = contents.filter((c) => c.role === 'user').at(-1);
  return user?.parts ?? [];
}

describe('ask attachments and service tier (1.19.0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateWorkspacePath.mockReturnValue(undefined);
    mocks.scanWorkspace.mockResolvedValue({
      workspaceRoot: dir,
      filesHash: 'abc',
      files: [{ path: 'a.ts', size: 100, hash: 'h1' }],
      skippedTooLarge: 0,
      truncated: false,
    });
    mocks.resolveModel.mockResolvedValue(resolved(true));
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

  it('an attachment becomes an inlineData part before the question, in the last user turn', async () => {
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute(
      { prompt: 'what is wrong here?', workspace: dir, attachments: ['shot.png'] },
      ctx,
    );
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(sent).toHaveLength(1);
    const parts = lastUserParts(sentAt(sent, 0));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: PNG.toString('base64') },
    });
    expect(parts[1]).toEqual({ text: 'what is wrong here?' });
    expect(result.structuredContent?.attachments).toEqual([
      { path: shot, mimeType: 'image/png', bytes: PNG.length },
    ]);
  });

  it('with a cache the prompt is no longer a bare string when attachments are given', async () => {
    mocks.prepareContext.mockResolvedValue({
      cacheId: 'cachedContents/abc',
      inlineContents: [],
      reused: true,
      rebuilt: false,
      inlineOnly: false,
      uploaded: { failedCount: 0, failures: [] },
    });
    const { ctx, sent } = buildCtx();
    await askTool.execute({ prompt: 'q', workspace: dir, attachments: [shot] }, ctx);
    expect(typeof sentAt(sent, 0).contents).not.toBe('string');
    expect(lastUserParts(sentAt(sent, 0))).toHaveLength(2);
  });

  it('a model without vision is refused by name before any call', async () => {
    mocks.resolveModel.mockResolvedValue(resolved(false));
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [shot] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('ATTACHMENTS_UNSUPPORTED');
    expect(sent).toHaveLength(0);
  });

  it('an unsupported type, a missing file and too many files fail loud before any call', async () => {
    const { ctx, sent } = buildCtx();
    const bad = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [notes] }, ctx);
    expect(bad.isError).toBe(true);
    expect(String(bad.content[0]?.text)).toMatch(/unsupported type/);
    const missing = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: ['nope.png'] },
      ctx,
    );
    expect(missing.isError).toBe(true);
    expect(String(missing.content[0]?.text)).toMatch(/nope\.png/);
    const many = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: Array(9).fill(shot) },
      ctx,
    );
    expect(many.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("serviceTier 'flex' reaches the request config; standard (the default) sends no tier field", async () => {
    const { ctx, sent } = buildCtx();
    await askTool.execute({ prompt: 'q', workspace: dir, serviceTier: 'flex' }, ctx);
    await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(sentAt(sent, 0).config.serviceTier).toBe('flex');
    expect('serviceTier' in sentAt(sent, 1).config).toBe(false);
  });

  it('the operator default GEMINI_CODE_CONTEXT_SERVICE_TIER=flex applies to ask and code; a per-call standard overrides it', async () => {
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
});
