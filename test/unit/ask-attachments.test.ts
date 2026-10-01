/**
 * `ask` attachments (inline image / PDF parts, v1.20.0) on the throttle suite's harness: the workspace, the model and
 * the context are mocked; `generateContentStream` and `countTokens` record what would be sent.
 */
import {
  mkdirSync,
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
  AttachmentTokensUncountedError,
  countAttachmentTokens,
  inspectAttachments,
  readAttachments,
} from '../../src/attachments.js';
import { askTool } from '../../src/tools/ask.tool.js';
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
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const shot = join(dir, 'shot.png');
writeFileSync(shot, PNG);
const spec = join(dir, 'spec.pdf');
writeFileSync(spec, PDF);
const notes = join(dir, 'notes.txt');
writeFileSync(notes, 'x');
const fake = join(dir, 'fake.png');
writeFileSync(fake, 'not a png at all, whatever the extension says');
const secret = join(outside, 'secret.png');
writeFileSync(secret, PNG);
const link = join(dir, 'link.png');
symlinkSync(secret, link);
const linkedDir = join(dir, 'linked-dir');
symlinkSync(outside, linkedDir);
const sshDir = join(dir, '.ssh');
mkdirSync(sshDir);
const inSecretDir = join(sshDir, 'shot.png'); // the sandbox's secret directories apply whatever the file
writeFileSync(inSecretDir, PNG);
const big = join(dir, 'big.png');
writeFileSync(big, PNG);
truncateSync(big, 10 * 1024 * 1024 + 1);

interface Sent {
  contents: unknown;
  config: Record<string, unknown>;
}

interface Harness {
  ctx: ToolContext;
  sent: Sent[];
  countTokens: ReturnType<typeof vi.fn>;
}

const COUNTED = 1090; // what gemini-3-flash counted for the 1×1 PNG on 2026-10-01

function buildCtx(configOverrides: Partial<ToolContext['config']> = {}): Harness {
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
  const countTokens = vi.fn(async () => ({ totalTokens: COUNTED }));
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
      models: { generateContentStream, generateContent: vi.fn(), countTokens },
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
  return { ctx, sent, countTokens };
}

const resolved = (supportsVision: boolean) => ({
  requested: 'latest-pro',
  resolved: 'gemini-3.1-pro-preview',
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

function reservationMocks(ctx: ToolContext): {
  reserveBudget: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
} {
  const manifest = ctx.manifest as unknown as { reserveBudget: ReturnType<typeof vi.fn> };
  const throttle = ctx.throttle as unknown as { reserve: ReturnType<typeof vi.fn> };
  return { reserveBudget: manifest.reserveBudget, reserve: throttle.reserve };
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

describe('ask attachments: the request', () => {
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
    expect(result.structuredContent?.attachmentTokens).toBe(COUNTED);
  });

  it('without attachments a cache hit still sends the bare prompt string and no attachment fields', async () => {
    mocks.prepareContext.mockResolvedValue({
      cacheId: 'cachedContents/abc',
      inlineContents: [],
      reused: true,
      rebuilt: false,
      inlineOnly: false,
      uploaded: { failedCount: 0, failures: [] },
    });
    const { ctx, sent, countTokens } = buildCtx();
    const result = await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(sentAt(sent, 0).contents).toBe('q');
    expect(countTokens).not.toHaveBeenCalled();
    expect('attachments' in (result.structuredContent ?? {})).toBe(false);
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
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [spec] }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(typeof sentAt(sent, 0).contents).not.toBe('string');
    expect(lastUserParts(sentAt(sent, 0))).toHaveLength(2);
    expect(lastUserParts(sentAt(sent, 0))[0]).toEqual({
      inlineData: { mimeType: 'application/pdf', data: PDF.toString('base64') },
    });
  });

  it('a model without vision is refused by name before any call', async () => {
    mocks.resolveModel.mockResolvedValue(resolved(false));
    const { ctx, sent, countTokens } = buildCtx();
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [shot] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('ATTACHMENTS_UNSUPPORTED');
    expect(result.structuredContent?.retryable).toBe(false);
    expect(countTokens).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('the ask_agentic fallback refuses attachments with a reason instead of dropping them', async () => {
    mocks.resolveModel.mockResolvedValue({ ...resolved(true), inputTokenLimit: 1_000 });
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute(
      {
        prompt: 'q',
        workspace: dir,
        attachments: [shot],
        onWorkspaceTooLarge: 'fallback-to-agentic',
        preflightMode: 'heuristic',
      },
      ctx,
    );
    expect(result.isError, String(result.content[0]?.text)).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');
    expect(String(result.content[0]?.text)).toMatch(/attachments/);
    expect(sent).toHaveLength(0);
  });
});

describe('ask attachments: what is refused, before any reservation', () => {
  const refused: Array<[string, string, RegExp]> = [
    ['a file outside the workspace', secret, /secret\.png/],
    ['a symlink leaf', link, /symlink/],
    ['a path through a symlinked directory', join(linkedDir, 'secret.png'), /secret\.png/],
    ['a file inside a secret directory of the workspace', inSecretDir, /SECRET_DENYLIST/],
    ['an unsupported type', notes, /unsupported type/],
    ['a file over the per-file cap', big, /above/],
    ['a file whose bytes are not its type', fake, /not image\/png/],
    ['a missing file', join(dir, 'nope.png'), /nope\.png/],
  ];
  for (const [what, path, why] of refused) {
    it(`${what} is ATTACHMENT_INVALID: no count, no budget, no throttle, no call`, async () => {
      const { ctx, sent, countTokens } = buildCtx();
      const { reserveBudget, reserve } = reservationMocks(ctx);
      mocks.prepareContext.mockImplementation(async () => {
        throw new Error('prepareContext must not run: the attachment failed before it');
      });
      const result = await askTool.execute(
        { prompt: 'q', workspace: dir, attachments: [path] },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.errorCode).toBe('ATTACHMENT_INVALID');
      expect(result.structuredContent?.retryable).toBe(false);
      expect(String(result.content[0]?.text)).toMatch(why);
      expect(countTokens).not.toHaveBeenCalled();
      expect(reserveBudget).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
    });
  }

  it("attachments that push the inline request over Google's limit are REQUEST_TOO_LARGE before any reservation", async () => {
    const ten = join(dir, 'ten.png');
    const four = join(dir, 'four.png');
    writeFileSync(ten, PNG);
    truncateSync(ten, 10 * 1024 * 1024); // at the per-file cap, not above
    writeFileSync(four, PNG);
    truncateSync(four, 4 * 1024 * 1024 - 1024); // the pair is under the 14 MB total cap
    mocks.scanWorkspace.mockResolvedValue({
      workspaceRoot: dir,
      filesHash: 'big',
      files: [{ path: 'a.ts', size: 2_000_000, hash: 'h1' }],
      skippedTooLarge: 0,
      truncated: false,
    });
    const { ctx, sent } = buildCtx();
    const { reserveBudget, reserve } = reservationMocks(ctx);
    const result = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: [ten, four] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('REQUEST_TOO_LARGE');
    expect(result.structuredContent?.retryable).toBe(false);
    expect((result.structuredContent?.attachments as unknown[]).length).toBe(2);
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('too many files fail loud before any call', async () => {
    const { ctx, sent } = buildCtx();
    const many = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: Array.from({ length: 9 }, () => shot) },
      ctx,
    );
    expect(many.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('a count Gemini cannot give refuses the call as ATTACHMENT_TOKENS_UNCOUNTED, retryable, before any reservation', async () => {
    const { ctx, sent, countTokens } = buildCtx();
    const { reserveBudget, reserve } = reservationMocks(ctx);
    countTokens.mockRejectedValueOnce(Object.assign(new Error('503 high demand'), { status: 503 }));
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [shot] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('ATTACHMENT_TOKENS_UNCOUNTED');
    expect(result.structuredContent?.retryable).toBe(true);
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe('ask attachments: the count Gemini gives', () => {
  it('the parts are what countTokens is asked about, and the count is what the budget and the throttle reserve', async () => {
    const { ctx, countTokens } = buildCtx({ dailyBudgetUsd: 10, tpmThrottleLimit: 1_000_000 });
    const { reserveBudget, reserve } = reservationMocks(ctx);
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [shot] }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(countTokens).toHaveBeenCalledTimes(1);
    const asked = countTokens.mock.calls[0]?.[0] as {
      model: string;
      contents: Array<{ parts: unknown[] }>;
    };
    expect(asked.model).toBe('gemini-3.1-pro-preview');
    expect(asked.contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
    ]);
    // the throttle reserves the heuristic workspace + prompt tokens plus the counted attachment tokens
    expect(reserve).toHaveBeenCalledWith('gemini-3.1-pro-preview', 25 + 1 + COUNTED);
    // the budget estimate charges the counted tokens at the uncached input price
    const reserved = reserveBudget.mock.calls[0]?.[0] as { estimatedCostMicros: number };
    const without = estimatePreCallCostUsd({
      model: 'gemini-3.1-pro-preview',
      serviceTier: 'standard',
      workspaceBytes: 100,
      promptChars: 1,
      expectedOutputTokens: 65_536,
      thinkingTokens: 0,
    });
    expect(reserved.estimatedCostMicros).toBeGreaterThan(Math.round(without * 1_000_000));
  });

  it('the counted tokens are in the preflight comparison: an attachment fills a small window', async () => {
    mocks.resolveModel.mockResolvedValue({ ...resolved(true), inputTokenLimit: 2_000 });
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: [shot], preflightMode: 'heuristic' },
      ctx,
    );
    expect(result.isError, String(result.content[0]?.text)).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');
    expect(result.structuredContent?.estimatedInputTokens).toBeGreaterThanOrEqual(COUNTED);
    expect(sent).toHaveLength(0);
  });

  it('a malformed total is uncounted; an abort during the count keeps its identity', async () => {
    const client = {
      models: { countTokens: vi.fn(async () => ({ totalTokens: Number.NaN })) },
    } as unknown as Parameters<typeof countAttachmentTokens>[0];
    const parts = [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }];
    await expect(countAttachmentTokens(client, 'm', parts)).rejects.toBeInstanceOf(
      AttachmentTokensUncountedError,
    );
    const controller = new AbortController();
    const reason = new Error('timed out');
    const aborting = {
      models: {
        countTokens: vi.fn(async () => {
          controller.abort(reason);
          throw new Error('aborted by the SDK');
        }),
      },
    } as unknown as Parameters<typeof countAttachmentTokens>[0];
    await expect(countAttachmentTokens(aborting, 'm', parts, controller.signal)).rejects.toBe(
      reason,
    );
    await expect(countAttachmentTokens(client, 'm', [])).resolves.toBe(0);
  });
});

describe('ask attachments: between inspection and read', () => {
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

  it('a file replaced by another file (another inode) after inspection is refused at read', async () => {
    const replaced = join(dir, 'replaced.png');
    writeFileSync(replaced, PNG);
    const [a] = await inspectAttachments([replaced], dir);
    unlinkSync(replaced);
    writeFileSync(replaced, PNG); // same bytes, another inode
    await expect(readAttachments([a as NonNullable<typeof a>])).rejects.toThrow(
      /not the one inspected/,
    );
  });

  it('a file that grew after inspection is refused without being read whole; the total is re-checked', async () => {
    const grow = join(dir, 'grow.png');
    writeFileSync(grow, PNG);
    const [a] = await inspectAttachments([grow], dir);
    truncateSync(grow, 10 * 1024 * 1024 + 1);
    await expect(readAttachments([a as NonNullable<typeof a>])).rejects.toThrow(/at read, above/);
    const ta = join(dir, 'ta.png');
    const tb = join(dir, 'tb.png');
    writeFileSync(ta, PNG);
    writeFileSync(tb, PNG);
    const [ia, ib] = await inspectAttachments([ta, tb], dir);
    truncateSync(ta, 8 * 1024 * 1024);
    truncateSync(tb, 8 * 1024 * 1024);
    await expect(
      readAttachments([ia as NonNullable<typeof ia>, ib as NonNullable<typeof ib>]),
    ).rejects.toThrow(/at read/);
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
});
