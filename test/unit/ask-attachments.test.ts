/**
 * v1.19.0 — `ask` attachments (inline image/PDF parts) and the service tier, on the same harness as the throttle
 * suite: the workspace, the model and the context are mocked; `generateContentStream` records what would be sent.
 */
import {
  mkdtempSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentTokens,
  inspectAttachments,
  pdfPageCount,
  readAttachments,
} from '../../src/attachments.js';
import { askTool } from '../../src/tools/ask.tool.js';
import { codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { estimatePreCallCostUsd } from '../../src/utils/cost-estimator.js';

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

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gcc-attach-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'gcc-outside-')));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const shot = join(dir, 'shot.png');
writeFileSync(shot, PNG);
const notes = join(dir, 'notes.txt');
writeFileSync(notes, 'x');
const secret = join(outside, 'secret.png');
writeFileSync(secret, PNG);
const link = join(dir, 'link.png');
symlinkSync(secret, link);
const big = join(dir, 'big.png');
writeFileSync(big, PNG);
truncateSync(big, 10 * 1024 * 1024 + 1);

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

describe('ask attachments and service tier (1.19.0)', () => {
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

  it('without attachments a cache hit still sends the bare prompt string (the cached path is unchanged)', async () => {
    mocks.prepareContext.mockResolvedValue({
      cacheId: 'cachedContents/abc',
      inlineContents: [],
      reused: true,
      rebuilt: false,
      inlineOnly: false,
      uploaded: { failedCount: 0, failures: [] },
    });
    const { ctx, sent } = buildCtx();
    await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(sentAt(sent, 0).contents).toBe('q');
  });

  it('a file outside the workspace, a symlink to one and a file over the per-file cap are refused with ATTACHMENT_INVALID', async () => {
    const { ctx, sent } = buildCtx();
    const cases: Array<[string, RegExp]> = [
      [secret, /escapes workspace root|outside/],
      [link, /symlink/],
      [big, /above 10485760/],
    ];
    for (const [path, why] of cases) {
      const result = await askTool.execute(
        { prompt: 'q', workspace: dir, attachments: [path] },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.errorCode).toBe('ATTACHMENT_INVALID');
      expect(result.structuredContent?.retryable).toBe(false);
      expect(String(result.content[0]?.text)).toMatch(why);
    }
    expect(sent).toHaveLength(0);
  });

  it('the ask_agentic fallback refuses attachments with a reason instead of dropping them', async () => {
    mocks.scanWorkspace.mockResolvedValue({
      workspaceRoot: dir,
      filesHash: 'big',
      files: Array.from({ length: 50 }, (_, i) => ({
        relpath: `f${i}.ts`,
        absolutePath: join(dir, `f${i}.ts`),
        size: 400_000,
        contentHash: `h${i}`,
        mtimeMs: 0,
      })),
      skippedTooLarge: 0,
      truncated: false,
    });
    mocks.resolveModel.mockResolvedValue({ ...resolved(true), inputTokenLimit: 10_000 });
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute(
      {
        prompt: 'q',
        workspace: dir,
        attachments: [shot],
        onWorkspaceTooLarge: 'fallback-to-agentic',
      },
      ctx,
    );
    expect(result.isError, String(result.content[0]?.text)).toBe(true);
    expect(result.structuredContent?.errorCode, String(result.content[0]?.text)).toBe(
      'WORKSPACE_TOO_LARGE',
    );
    expect(String(result.content[0]?.text)).toMatch(/attachments/);
    expect(sent).toHaveLength(0);
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
    expect(bad.structuredContent?.errorCode).toBe('ATTACHMENT_INVALID');
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

describe('attachments between inspection and read (1.19.0)', () => {
  it('a file swapped for a symlink after inspection is refused at read; a deleted one too', async () => {
    const swap = join(dir, 'swap.png');
    writeFileSync(swap, PNG);
    const [a] = await inspectAttachments([swap], dir);
    unlinkSync(swap);
    symlinkSync(secret, swap);
    await expect(readAttachments([a as NonNullable<typeof a>])).rejects.toThrow(/swap\.png/);
    unlinkSync(swap);
    await expect(readAttachments([a as NonNullable<typeof a>])).rejects.toThrow(/swap\.png/);
  });

  it('a file that grew after inspection is refused without being read whole; the total is re-checked', async () => {
    const grow = join(dir, 'grow.png');
    writeFileSync(grow, PNG);
    const [a] = await inspectAttachments([grow], dir);
    truncateSync(grow, 10 * 1024 * 1024 + 1);
    await expect(readAttachments([a as NonNullable<typeof a>])).rejects.toThrow(/at read, above/);
  });

  it('the bytes are in hand before the workspace is prepared: a file deleted during prepareContext still goes out', async () => {
    const gone = join(dir, 'gone.png');
    writeFileSync(gone, PNG);
    mocks.prepareContext.mockImplementation(async () => {
      unlinkSync(gone); // after the read: nothing left to lose
      return {
        cacheId: null,
        inlineContents: [],
        reused: false,
        rebuilt: false,
        inlineOnly: true,
        uploaded: { failedCount: 0, failures: [] },
      };
    });
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [gone] }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(lastUserParts(sentAt(sent, 0))).toHaveLength(2);
  });

  it('the total cap is enforced before a file is read, not after every file is in memory', async () => {
    const a = join(dir, 'ta.png');
    const b = join(dir, 'tb.png');
    writeFileSync(a, PNG);
    writeFileSync(b, PNG);
    const [ia, ib] = await inspectAttachments([a, b], dir);
    truncateSync(a, 8 * 1024 * 1024);
    truncateSync(b, 8 * 1024 * 1024);
    await expect(
      readAttachments([ia as NonNullable<typeof ia>, ib as NonNullable<typeof ib>]),
    ).rejects.toThrow(/at read/);
  });

  it('attachment tokens are an upper bound from the bytes: 24 tiles per image, a PDF by its page objects or 1000', () => {
    const threePages = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj<</Type/Page>>endobj\n4 0 obj << /Type /Page /Parent 1 0 R >> endobj\n',
    );
    expect(pdfPageCount(threePages)).toBe(3);
    expect(pdfPageCount(Buffer.from('%PDF-1.5 objects in a compressed stream'))).toBe(1000);
    expect(attachmentTokens('application/pdf', threePages)).toBe(3 * 258);
    expect(attachmentTokens('image/png', PNG)).toBe(24 * 258);
    const base = {
      model: 'gemini-3-pro-preview',
      workspaceBytes: 4_000,
      promptChars: 40,
      expectedOutputTokens: 100,
    };
    expect(estimatePreCallCostUsd({ ...base, extraInputTokens: 24 * 258 })).toBeGreaterThan(
      estimatePreCallCostUsd(base),
    );
  });

  it('a bad attachment costs nothing: no budget reservation, no throttle reservation, no call', async () => {
    const gone = join(dir, 'gone2.png');
    writeFileSync(gone, PNG);
    const { ctx, sent } = buildCtx();
    const manifest = ctx.manifest as unknown as { reserveBudget: ReturnType<typeof vi.fn> };
    const throttle = ctx.throttle as unknown as { reserve: ReturnType<typeof vi.fn> };
    mocks.prepareContext.mockImplementation(async () => {
      throw new Error('prepareContext must not run: the attachment failed before it');
    });
    unlinkSync(gone);
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [gone] }, ctx);
    expect(result.structuredContent?.errorCode).toBe('ATTACHMENT_INVALID');
    expect(manifest.reserveBudget).not.toHaveBeenCalled();
    expect(throttle.reserve).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('attachment tokens count toward WORKSPACE_TOO_LARGE: a PDF without visible page objects fills a small window', async () => {
    const opaque = join(dir, 'opaque.pdf');
    writeFileSync(opaque, '%PDF-1.5 compressed object streams, no page objects in clear');
    mocks.resolveModel.mockResolvedValue({ ...resolved(true), inputTokenLimit: 100_000 });
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: [opaque], preflightMode: 'heuristic' },
      ctx,
    );
    expect(result.isError, String(result.content[0]?.text)).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');
    expect(sent).toHaveLength(0);
  });
});
