/**
 * Integration-ish test for the `ask_agentic` loop controller.
 *
 * Mocks the Gemini SDK's `generateContent` to return scripted responses
 * (functionCall → functionCall → text) and asserts that:
 *   - The loop drives function calls to the correct executors
 *   - No-progress detector trips on a 3× repeated call signature
 *   - `maxIterations` guard fires when loop never returns text
 *   - `maxTotalInputTokens` guard fires when cumulative input blows
 *   - Final text response propagates with metadata
 *   - Sandbox errors come back as recoverable `functionResponse.error`
 *
 * `generateContent` is mocked; the executors (list_directory / read_file
 * / find_files / grep) run for real against a tmpdir workspace.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askAgenticTool } from '../../src/tools/ask-agentic.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';

const mocks = vi.hoisted(() => ({
  validateWorkspacePath: vi.fn(),
  resolveModel: vi.fn(),
}));

vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: mocks.validateWorkspacePath,
  WorkspaceValidationError: class extends Error {},
}));
vi.mock('../../src/gemini/models.js', () => ({
  resolveModel: mocks.resolveModel,
}));

interface ScriptedResponse {
  functionCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  text?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

function buildResponse(scripted: ScriptedResponse): {
  text?: string;
  candidates: Array<{ content: { parts: unknown[] } }>;
  usageMetadata: Record<string, number>;
} {
  const parts: unknown[] = [];
  if (scripted.functionCalls) {
    for (const fc of scripted.functionCalls) {
      parts.push({
        functionCall: {
          ...(fc.id ? { id: fc.id } : {}),
          name: fc.name,
          args: fc.args,
        },
      });
    }
  }
  if (scripted.text !== undefined) {
    parts.push({ text: scripted.text });
  }
  return {
    ...(scripted.text !== undefined ? { text: scripted.text } : {}),
    candidates: [{ content: { parts } }],
    usageMetadata: {
      promptTokenCount: scripted.promptTokenCount ?? 1_000,
      candidatesTokenCount: scripted.candidatesTokenCount ?? 100,
      thoughtsTokenCount: scripted.thoughtsTokenCount ?? 0,
    },
  };
}

function buildCtx(args: {
  script: ScriptedResponse[];
  dailyBudgetUsd?: number;
  tpmThrottleLimit?: number;
}): {
  ctx: ToolContext;
  generateContent: ReturnType<typeof vi.fn>;
  manifest: { reserveBudget: ReturnType<typeof vi.fn>; [k: string]: ReturnType<typeof vi.fn> };
  throttle: { reserve: ReturnType<typeof vi.fn>; [k: string]: ReturnType<typeof vi.fn> };
} {
  const generateContent = vi.fn();
  for (const s of args.script) {
    generateContent.mockResolvedValueOnce(buildResponse(s));
  }

  // Budget-enforced scenarios get a real-ish reserveBudget that accepts by
  // default; tests override via `.mockReturnValueOnce({rejected:true,...})`
  // to exercise rejection. Returning `{ id: N }` is the success shape.
  const manifest = {
    reserveBudget: vi.fn().mockReturnValue({ id: 1 }),
    finalizeBudgetReservation: vi.fn(),
    cancelBudgetReservation: vi.fn(),
    insertUsageMetric: vi.fn(),
  };
  const throttle = {
    reserve: vi.fn().mockReturnValue({ delayMs: 0, releaseId: 1 }),
    release: vi.fn(),
    cancel: vi.fn(),
    shouldDelay: vi.fn(() => 0),
    recordRetryHint: vi.fn(),
  };

  const ctx = {
    server: {} as ToolContext['server'],
    config: {
      dailyBudgetUsd: args.dailyBudgetUsd ?? Number.POSITIVE_INFINITY,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3_600,
      cacheMinTokens: 1_024,
      tpmThrottleLimit: args.tpmThrottleLimit ?? 0,
      forceMaxOutputTokens: false,
      workspaceGuardRatio: 0.9,
      defaultModel: 'latest-pro-thinking',
    } as ToolContext['config'],
    client: { models: { generateContent } } as unknown as ToolContext['client'],
    manifest: manifest as unknown as ToolContext['manifest'],
    ttlWatcher: { markHot: vi.fn() } as unknown as ToolContext['ttlWatcher'],
    progressToken: undefined,
    throttle: throttle as unknown as ToolContext['throttle'],
  };
  return { ctx, generateContent, manifest, throttle };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorkspacePath.mockReturnValue(undefined);
  mocks.resolveModel.mockResolvedValue({
    requested: 'latest-pro-thinking',
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
});

describe('ask_agentic loop — happy path', () => {
  it('runs a list_directory → read_file → text conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'index.ts'), 'export const greet = () => "hi";');
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'util.ts'),
      'export const add = (a: number, b: number) => a + b;',
    );

    const { ctx, generateContent } = buildCtx({
      script: [
        // Iteration 1: model asks to list the root.
        { functionCalls: [{ id: 'c1', name: 'list_directory', args: { path: '.' } }] },
        // Iteration 2: model reads index.ts.
        { functionCalls: [{ id: 'c2', name: 'read_file', args: { path: 'index.ts' } }] },
        // Iteration 3: model gives final answer.
        { text: 'The repo defines `greet` in `index.ts:1` and `add` in `src/util.ts:1`.' },
      ],
    });

    const result = await askAgenticTool.execute(
      { prompt: 'What does this codebase do?', workspace: root },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(result.content[0]?.text).toContain('greet');
    expect(result.structuredContent?.iterations).toBe(3);
    expect(result.structuredContent?.filesRead).toBe(1); // index.ts
    expect(result.structuredContent?.cumulativeInputTokens).toBeGreaterThan(0);
  });

  it('dispatches parallel tool calls in a single turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'A');
    writeFileSync(join(root, 'b.ts'), 'B');

    const { ctx, generateContent } = buildCtx({
      script: [
        {
          functionCalls: [
            { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
            { id: 'c2', name: 'read_file', args: { path: 'b.ts' } },
          ],
        },
        { text: 'Read both files.' },
      ],
    });

    const result = await askAgenticTool.execute({ prompt: 'read a and b', workspace: root }, ctx);
    expect(result.isError).toBeUndefined();
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(result.structuredContent?.filesRead).toBe(2);
  });
});

describe('ask_agentic loop — guards', () => {
  it('triggers AGENTIC_NO_PROGRESS on 3× repeated call signature', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const sameCall = { id: 'c1', name: 'list_directory' as const, args: { path: '.' } };
    const { ctx } = buildCtx({
      script: [
        { functionCalls: [sameCall] },
        { functionCalls: [sameCall] },
        { functionCalls: [sameCall] }, // 3rd repeat → should trip
      ],
    });

    const result = await askAgenticTool.execute({ prompt: 'loop?', workspace: root }, ctx);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_NO_PROGRESS');
    expect(String(result.structuredContent?.repeatedSignature)).toContain('list_directory');
  });

  it('triggers AGENTIC_MAX_ITERATIONS when loop never returns text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    writeFileSync(join(root, 'b.ts'), 'y');
    // 4 distinct read_file calls, then maxIterations=3 cap trips.
    const { ctx } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { functionCalls: [{ name: 'read_file', args: { path: 'b.ts' } }] },
        { functionCalls: [{ name: 'list_directory', args: { path: '.' } }] },
      ],
    });
    const result = await askAgenticTool.execute(
      { prompt: 'keep going', workspace: root, maxIterations: 3 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_MAX_ITERATIONS');
    expect(result.structuredContent?.iterations).toBe(3);
  });

  it('triggers AGENTIC_INPUT_BUDGET_EXCEEDED when cumulative tokens blow budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');

    const { ctx } = buildCtx({
      script: [
        // First iteration returns a huge prompt token count — blows 100k budget.
        {
          functionCalls: [{ name: 'list_directory', args: { path: '.' } }],
          promptTokenCount: 200_000,
        },
      ],
    });
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxTotalInputTokens: 100_000 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_INPUT_BUDGET_EXCEEDED');
  });

  it('enforces maxFilesRead: subsequent reads past the cap return recoverable error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    writeFileSync(join(root, 'b.ts'), 'y');
    writeFileSync(join(root, 'c.ts'), 'z');
    const { ctx, generateContent } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] }, // 1/2 OK
        { functionCalls: [{ name: 'read_file', args: { path: 'b.ts' } }] }, // 2/2 OK
        { functionCalls: [{ name: 'read_file', args: { path: 'c.ts' } }] }, // 3/2 → rejected
        { text: 'Ran out of budget.' },
      ],
    });

    const result = await askAgenticTool.execute(
      { prompt: 'read all', workspace: root, maxFilesRead: 2 },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.filesRead).toBe(2); // didn't go past cap

    // Third iteration's user-turn response must contain an error functionResponse.
    const thirdCall = generateContent.mock.calls[2]?.[0];
    const userTurn = (
      thirdCall?.contents as Array<{
        role: string;
        parts: Array<{ functionResponse?: { response?: { error?: string } } }>;
      }>
    ).findLast?.((c) => c.role === 'user' && c.parts.some((p) => p.functionResponse));
    const errorResp = userTurn?.parts.find((p) => p.functionResponse?.response?.error);
    expect(errorResp).toBeDefined();
    expect(String(errorResp?.functionResponse?.response?.error)).toContain('maxFilesRead');
  });
});

describe('ask_agentic loop — sandbox integration', () => {
  it('path traversal attempts come back as recoverable functionResponse.error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const { ctx, generateContent } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: '../../../../etc/passwd' } }] },
        { text: 'Gave up on that path.' },
      ],
    });

    const result = await askAgenticTool.execute({ prompt: 'try escape', workspace: root }, ctx);
    expect(result.isError).toBeUndefined();

    const secondCall = generateContent.mock.calls[1]?.[0];
    const userTurn = (
      secondCall?.contents as Array<{
        role: string;
        parts: Array<{ functionResponse?: { response?: { error?: string } } }>;
      }>
    ).findLast?.((c) => c.role === 'user' && c.parts.some((p) => p.functionResponse));
    const errorResp = userTurn?.parts.find((p) => p.functionResponse?.response?.error);
    expect(errorResp).toBeDefined();
    expect(String(errorResp?.functionResponse?.response?.error)).toMatch(/PATH_TRAVERSAL/);
  });

  it('secret denylist comes back as recoverable error, not fatal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, '.env'), 'API_KEY=secret');
    writeFileSync(join(root, 'safe.ts'), 'x');
    const { ctx } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: '.env' } }] },
        { functionCalls: [{ name: 'read_file', args: { path: 'safe.ts' } }] },
        { text: 'OK, used safe.ts.' },
      ],
    });
    const result = await askAgenticTool.execute({ prompt: 'try env', workspace: root }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.iterations).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Regression coverage for v1.5.0 code review findings (#1-21 from PR #24)
// ---------------------------------------------------------------------------

describe('PR #24 review regressions — ID-less & alias & budget', () => {
  it('F#3: two same-name parallel calls without `id` return both responses (positional pairing)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'A contents');
    writeFileSync(join(root, 'b.ts'), 'B contents');

    const { ctx, generateContent } = buildCtx({
      script: [
        // Both reads in one turn, BOTH without `id`. Pre-fix code dropped
        // the second because `.find()` matched the first by name.
        {
          functionCalls: [
            { name: 'read_file', args: { path: 'a.ts' } },
            { name: 'read_file', args: { path: 'b.ts' } },
          ],
        },
        { text: 'Done.' },
      ],
    });

    const result = await askAgenticTool.execute({ prompt: 'both', workspace: root }, ctx);
    expect(result.isError).toBeUndefined();
    // The second turn sent back to Gemini must contain BOTH function
    // responses, positionally aligned with BOTH function calls.
    const secondCall = generateContent.mock.calls[1]?.[0];
    const userTurn = (
      secondCall?.contents as Array<{
        role: string;
        parts: Array<{ functionResponse?: { name?: string } }>;
      }>
    ).findLast?.((c) => c.role === 'user' && c.parts.some((p) => p.functionResponse));
    const functionResponses = userTurn?.parts.filter((p) => p.functionResponse) ?? [];
    expect(functionResponses.length).toBe(2);
    // Both responses should be read_file (not dropped/collapsed).
    expect(functionResponses.every((p) => p.functionResponse?.name === 'read_file')).toBe(true);
  });

  it('F#4: alias paths count as ONE against maxFilesRead via canonical relpath', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'A');

    // Three reads all resolving to `a.ts`. maxFilesRead=1 must still
    // permit them all (canonical set counts 1 distinct file).
    const { ctx } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { functionCalls: [{ name: 'read_file', args: { path: './a.ts' } }] },
        { functionCalls: [{ name: 'read_file', args: { path: 'sub/../a.ts' } }] },
        { text: 'Read one file three times.' },
      ],
    });

    // Create `sub` dir for the third alias to normalise through.
    mkdirSync(join(root, 'sub'), { recursive: true });

    const result = await askAgenticTool.execute(
      { prompt: 'aliases', workspace: root, maxFilesRead: 1 },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    // filesRead counts CANONICAL distinct paths — one, not three.
    expect(result.structuredContent?.filesRead).toBe(1);
  });
});

describe('PR #24 review regressions — budget/throttle integration (F#1)', () => {
  it('agentic reserves, finalises, and respects per-iteration budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'A');

    const { ctx, manifest, throttle } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { text: 'Done.' },
      ],
      dailyBudgetUsd: 10,
      tpmThrottleLimit: 80_000,
    });

    const result = await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);
    expect(result.isError).toBeUndefined();
    // 2 iterations → 2 reservations, 2 finalisations, 0 cancellations.
    expect(manifest.reserveBudget).toHaveBeenCalledTimes(2);
    expect(manifest.finalizeBudgetReservation).toHaveBeenCalledTimes(2);
    expect(manifest.cancelBudgetReservation).not.toHaveBeenCalled();
    // Same for throttle.
    expect(throttle.reserve).toHaveBeenCalledTimes(2);
    expect(throttle.release).toHaveBeenCalledTimes(2);
  });

  it('agentic returns BUDGET_REJECT when reserveBudget rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'A');

    const { ctx, manifest, generateContent } = buildCtx({
      script: [{ text: 'unused — we reject before dispatch.' }],
      dailyBudgetUsd: 0.0001,
    });
    manifest.reserveBudget.mockReturnValueOnce({
      rejected: true,
      spentMicros: 1000,
      capMicros: 100,
      estimateMicros: 50000,
    });

    const result = await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('BUDGET_REJECT');
    // Must NOT have called generateContent if reservation rejected.
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe('PR #24 review regressions — compat guards & final-text (F#6, F#9)', () => {
  it('F#6: rejects locally when thinkingBudget + reserve exceeds maxOutputTokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');

    const { ctx, generateContent } = buildCtx({ script: [] });
    const result = await askAgenticTool.execute(
      {
        prompt: 'q',
        workspace: root,
        thinkingBudget: 60_000,
        maxOutputTokens: 1000, // 60000 + 1024 > 1000 → local reject
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('thinkingBudget');
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('F#9: returns finalText even when cumulative budget trips on the answering iteration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');

    const { ctx } = buildCtx({
      script: [
        // Single iteration with a huge prompt-token report + final answer.
        { text: 'The answer is 42.', promptTokenCount: 200_000 },
      ],
    });
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxTotalInputTokens: 100_000 },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('42');
    expect(result.structuredContent?.overBudget).toBe(true);
  });
});
