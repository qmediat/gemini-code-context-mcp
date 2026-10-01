/**
 * `ask` attachments (inline image / PDF parts, v1.20.0) on the throttle suite's harness: the workspace, the model and
 * the context are mocked; `generateContentStream` and `countTokens` record what would be sent.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentError,
  AttachmentTokensUncountedError,
  countAttachmentTokens,
  inspectAttachments,
  readAttachments,
} from '../../src/attachments.js';
import type { PreparedContext } from '../../src/cache/cache-manager.js';
import type { ScanResult } from '../../src/indexer/workspace-scanner.js';
import { askInputSchema, askTool } from '../../src/tools/ask.tool.js';
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

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gcc-attach-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'gcc-outside-')));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

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
const empty = join(dir, 'empty.png');
writeFileSync(empty, '');
const secret = join(outside, 'secret.png');
writeFileSync(secret, PNG);
const link = join(dir, 'link.png');
symlinkSync(secret, link);
const innerLink = join(dir, 'inner-link.png'); // a symlink to a file INSIDE the workspace: only the leaf rule refuses it
symlinkSync(shot, innerLink);
const linkedDir = join(dir, 'linked-dir');
symlinkSync(outside, linkedDir);
const sshDir = join(dir, '.ssh');
mkdirSync(sshDir);
const inSecretDir = join(sshDir, 'shot.png'); // the sandbox's secret directories apply whatever the file
writeFileSync(inSecretDir, PNG);
const big = join(dir, 'big.png');
writeFileSync(big, PNG);
truncateSync(big, 10 * 1024 * 1024 + 1);

/** A PNG-headed sparse file of `bytes` bytes. */
function pngOfSize(name: string, bytes: number): string {
  const path = join(dir, name);
  writeFileSync(path, PNG);
  truncateSync(path, bytes);
  return path;
}

interface Sent {
  contents: unknown;
  config: Record<string, unknown>;
}

interface Harness {
  ctx: ToolContext;
  sent: Sent[];
  countTokens: ReturnType<typeof vi.fn>;
  generateContentStream: ReturnType<typeof vi.fn>;
}

const COUNTED = 1090; // what gemini-3-flash counted for the 1×1 PNG on 2026-10-01

async function* okStream() {
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

function buildCtx(configOverrides: Partial<ToolContext['config']> = {}): Harness {
  const sent: Sent[] = [];
  const generateContentStream = vi.fn(async (params: Sent) => {
    sent.push(params);
    return okStream();
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
  return { ctx, sent, countTokens, generateContentStream };
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

/** A scan of one 100-byte file, in the scanner's shape. */
function scanOf(size = 100): ScanResult {
  return {
    workspaceRoot: dir,
    filesHash: `files-${size}`,
    files: [
      {
        relpath: 'a.ts',
        absolutePath: join(dir, 'a.ts'),
        size,
        contentHash: 'h1',
        mtimeMs: 1_700_000_000_000,
        memoHit: false,
      },
    ],
    skippedTooLarge: 0,
    truncated: false,
    memoHitCount: 0,
  };
}

/** A prepared context in the cache manager's shape: inline, or a reused cache. */
function prepared(cacheId: string | null): PreparedContext {
  return {
    cacheId,
    cacheExpiresAt: cacheId === null ? null : Date.now() + 3_600_000,
    inlineContents: cacheId === null ? [{ role: 'user', parts: [{ text: 'workspace' }] }] : [],
    uploaded: { files: [], uploadedCount: 0, reusedCount: 0, failedCount: 0, failures: [] },
    rebuilt: false,
    reused: cacheId !== null,
    inlineOnly: cacheId === null,
  };
}

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

const first = <T>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error('empty');
  return item;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorkspacePath.mockReturnValue(undefined);
  mocks.scanWorkspace.mockResolvedValue(scanOf());
  mocks.resolveModel.mockResolvedValue(resolved(true));
  mocks.prepareContext.mockReset().mockResolvedValue(prepared(null));
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

  it('(guard: unchanged behaviour) without attachments a cache hit still sends the bare prompt string and no attachment fields', async () => {
    mocks.prepareContext.mockResolvedValue(prepared('cachedContents/abc'));
    const { ctx, sent, countTokens } = buildCtx();
    const result = await askTool.execute({ prompt: 'q', workspace: dir }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(sentAt(sent, 0).contents).toBe('q');
    expect(countTokens).not.toHaveBeenCalled();
    expect('attachments' in (result.structuredContent ?? {})).toBe(false);
  });

  it('with a cache the prompt is no longer a bare string when attachments are given', async () => {
    mocks.prepareContext.mockResolvedValue(prepared('cachedContents/abc'));
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [spec] }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(typeof sentAt(sent, 0).contents).not.toBe('string');
    expect(lastUserParts(sentAt(sent, 0))).toHaveLength(2);
    expect(lastUserParts(sentAt(sent, 0))[0]).toEqual({
      inlineData: { mimeType: 'application/pdf', data: PDF.toString('base64') },
    });
  });

  it('the stale-cache retry re-sends the parts with the rebuilt context', async () => {
    mocks.prepareContext
      .mockResolvedValueOnce(prepared('cachedContents/stale'))
      .mockResolvedValueOnce(prepared('cachedContents/fresh'));
    mocks.isStaleCacheError.mockReturnValue(true);
    const { ctx, sent, generateContentStream } = buildCtx();
    generateContentStream.mockImplementationOnce(async (params: Sent) => {
      sent.push(params);
      throw new Error('404 cachedContents/stale not found');
    });
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [shot] }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(sent).toHaveLength(2);
    expect(lastUserParts(sentAt(sent, 1))).toHaveLength(2);
    expect(sentAt(sent, 1).config.cachedContent).toBe('cachedContents/fresh');
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
    expect((result.structuredContent?.attachments as unknown[]).length).toBe(1);
    expect(sent).toHaveLength(0);
  });
});

describe('ask attachments: what is refused, before any reservation', () => {
  const refused: Array<[string, string, RegExp]> = [
    ['a file outside the workspace', secret, /secret\.png/],
    ['a symlink leaf to a file outside', link, /symlink/],
    ['a symlink leaf to a file inside the workspace', innerLink, /symlink/],
    ['a symlink leaf named with a leading space', ` ${link}`, /symlink/],
    ['a symlink leaf named with a trailing space', `${innerLink} `, /symlink/],
    ['a path through a symlinked directory', join(linkedDir, 'secret.png'), /secret\.png/],
    ['a file inside a secret directory of the workspace', inSecretDir, /SECRET_DENYLIST/],
    ['an unsupported type', notes, /unsupported type/],
    ['an empty file', empty, /empty file/],
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

  it('too many files, and a total over the cap, are refused at inspection', async () => {
    const { ctx, sent } = buildCtx();
    const many = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: Array.from({ length: 9 }, () => shot) },
      ctx,
    );
    expect(many.isError).toBe(true);
    expect(many.structuredContent?.errorCode).toBe('ATTACHMENT_INVALID');
    expect(String(many.content[0]?.text)).toMatch(/at most 8/);
    expect(sent).toHaveLength(0);
    // the schema lets a ninth file through so the refusal above is the one a real MCP call gets
    expect(
      askInputSchema.safeParse({
        prompt: 'q',
        attachments: Array.from({ length: 9 }, () => 'a.png'),
      }).success,
    ).toBe(true);
    await expect(inspectAttachments([shot], join(dir, 'no-such-root'))).rejects.toBeInstanceOf(
      AttachmentError,
    );
    const eightA = pngOfSize('eight-a.png', 8 * 1024 * 1024);
    const eightB = pngOfSize('eight-b.png', 8 * 1024 * 1024);
    await expect(inspectAttachments([eightA, eightB], dir)).rejects.toThrow(
      /above this server's cap/,
    );
  });

  it("attachments that push the inline request over Google's limit are REQUEST_TOO_LARGE before any reservation", async () => {
    const ten = pngOfSize('ten.png', 10 * 1024 * 1024); // at the per-file cap, not above
    const four = pngOfSize('four.png', 4 * 1024 * 1024 - 1024); // the pair is under the 14 MB total cap
    mocks.scanWorkspace.mockResolvedValue(scanOf(2_000_000));
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

  const failed: Array<[string, number, string, boolean]> = [
    ['a 503', 503, 'ATTACHMENT_TOKENS_UNCOUNTED', true],
    ['a 403', 403, 'ATTACHMENT_TOKENS_UNCOUNTED', false],
    ['a 400 (Gemini refused the parts)', 400, 'ATTACHMENT_INVALID', false],
  ];
  for (const [what, status, code, retryable] of failed) {
    it(`${what} from countTokens is ${code}, retryable ${retryable}, before any reservation`, async () => {
      const { ctx, sent, countTokens } = buildCtx();
      const { reserveBudget, reserve } = reservationMocks(ctx);
      countTokens.mockRejectedValueOnce(
        Object.assign(new Error(`${status} from Gemini`), { status }),
      );
      const result = await askTool.execute(
        { prompt: 'q', workspace: dir, attachments: [shot] },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.errorCode).toBe(code);
      expect(result.structuredContent?.retryable).toBe(retryable);
      expect(reserveBudget).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
    });
  }
});

describe('ask attachments: the count Gemini gives', () => {
  it('the parts are what countTokens is asked about, and the count is what the throttle reserves', async () => {
    const { ctx, countTokens } = buildCtx({ tpmThrottleLimit: 1_000_000 });
    const { reserve } = reservationMocks(ctx);
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
    // ceil(100 bytes / 4) + ceil(1 prompt char / 4) + the counted attachment tokens
    expect(reserve).toHaveBeenCalledWith('gemini-3.1-pro-preview', 25 + 1 + COUNTED);
  });

  it('the budget reservation charges the counted tokens: more with the attachment than without, all else equal', async () => {
    const withIt = buildCtx({ dailyBudgetUsd: 10 });
    const without = buildCtx({ dailyBudgetUsd: 10 });
    const ok1 = await askTool.execute(
      { prompt: 'q', workspace: dir, attachments: [shot] },
      withIt.ctx,
    );
    const ok2 = await askTool.execute({ prompt: 'q', workspace: dir }, without.ctx);
    expect(ok1.isError, String(ok1.content[0]?.text)).not.toBe(true);
    expect(ok2.isError, String(ok2.content[0]?.text)).not.toBe(true);
    const micros = (h: Harness): number =>
      (
        first(reservationMocks(h.ctx).reserveBudget.mock.calls)[0] as {
          estimatedCostMicros: number;
        }
      ).estimatedCostMicros;
    expect(micros(withIt)).toBeGreaterThan(micros(without));
  });

  it('the counted tokens weigh on the heuristic-vs-exact decision: a small workspace with heavy attachments is counted exactly', async () => {
    mocks.resolveModel.mockResolvedValue({ ...resolved(true), inputTokenLimit: 1_000_000 });
    const { ctx, sent, countTokens } = buildCtx();
    countTokens.mockResolvedValueOnce({ totalTokens: 900_000 }); // the parts; the preflight's own call answers COUNTED
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [spec] }, ctx);
    expect(result.isError, String(result.content[0]?.text)).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('WORKSPACE_TOO_LARGE');
    expect(result.structuredContent?.tokenCountMethod).toBe('exact');
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(0);
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
    expect((result.structuredContent?.attachments as unknown[]).length).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('a malformed total is uncounted and retryable; an abort during the count keeps its identity; no parts, no call', async () => {
    const parts = [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }];
    const nan = {
      models: { countTokens: vi.fn(async () => ({ totalTokens: Number.NaN })) },
    } as unknown as Parameters<typeof countAttachmentTokens>[0];
    const err = await countAttachmentTokens(nan, 'm', parts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentTokensUncountedError);
    expect((err as AttachmentTokensUncountedError).retryable).toBe(true);
    for (const bad of [0, 1.5, -1]) {
      const client = {
        models: { countTokens: vi.fn(async () => ({ totalTokens: bad })) },
      } as unknown as Parameters<typeof countAttachmentTokens>[0];
      await expect(countAttachmentTokens(client, 'm', parts)).rejects.toBeInstanceOf(
        AttachmentTokensUncountedError,
      );
    }
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
    expect((nan.models.countTokens as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await expect(countAttachmentTokens(nan, 'm', [])).resolves.toBe(0);
    expect((nan.models.countTokens as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe('ask attachments: between inspection and read', () => {
  it('a file swapped for a symlink after inspection is refused at read; a deleted one too', async () => {
    const swap = join(dir, 'swap.png');
    writeFileSync(swap, PNG);
    const a = first(await inspectAttachments([swap], dir));
    unlinkSync(swap);
    symlinkSync(secret, swap);
    await expect(readAttachments([a])).rejects.toThrow(/swap\.png/);
    unlinkSync(swap);
    await expect(readAttachments([a])).rejects.toThrow(/swap\.png/);
  });

  it('a file replaced by another file (an atomic rename over it: another inode) after inspection is refused at read', async () => {
    const replaced = join(dir, 'replaced.png');
    writeFileSync(replaced, PNG);
    const a = first(await inspectAttachments([replaced], dir));
    const other = join(dir, 'replacement.png');
    writeFileSync(other, PNG); // allocated while the inspected file still exists: a different inode
    renameSync(other, replaced);
    await expect(readAttachments([a])).rejects.toThrow(/not the one inspected/);
  });

  it('a file that shrank or grew after inspection is refused at read, without being read whole', async () => {
    const shrink = join(dir, 'shrink.png');
    writeFileSync(shrink, PNG);
    const s = first(await inspectAttachments([shrink], dir));
    truncateSync(shrink, 20);
    await expect(readAttachments([s])).rejects.toThrow(/changed size/);
    const grow = join(dir, 'grow.png');
    writeFileSync(grow, PNG);
    const g = first(await inspectAttachments([grow], dir));
    truncateSync(grow, 10 * 1024 * 1024 + 1);
    const error = await readAttachments([g]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentError);
    expect(String((error as Error).message)).toMatch(/changed size/);
  });

  it('an aborted read keeps the abort reason as its error', async () => {
    const a = first(await inspectAttachments([shot], dir));
    const controller = new AbortController();
    const reason = new Error('timed out');
    controller.abort(reason);
    await expect(readAttachments([a], controller.signal)).rejects.toBe(reason);
  });

  it('the bytes are in hand before the workspace is prepared: a file deleted during prepareContext still goes out', async () => {
    const gone = join(dir, 'gone.png');
    writeFileSync(gone, PNG);
    mocks.prepareContext.mockImplementation(async () => {
      unlinkSync(gone); // after the read: nothing left to lose
      return prepared(null);
    });
    const { ctx, sent } = buildCtx();
    const result = await askTool.execute({ prompt: 'q', workspace: dir, attachments: [gone] }, ctx);
    expect(result.isError, String(result.content[0]?.text)).not.toBe(true);
    expect(lastUserParts(sentAt(sent, 0))).toHaveLength(2);
  });
});
