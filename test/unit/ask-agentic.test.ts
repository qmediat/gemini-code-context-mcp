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
}): { ctx: ToolContext; generateContent: ReturnType<typeof vi.fn> } {
  const generateContent = vi.fn();
  for (const s of args.script) {
    generateContent.mockResolvedValueOnce(buildResponse(s));
  }

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
      workspaceGuardRatio: 0.9,
      defaultModel: 'latest-pro-thinking',
    } as ToolContext['config'],
    client: { models: { generateContent } } as unknown as ToolContext['client'],
    manifest: {} as ToolContext['manifest'],
    ttlWatcher: { markHot: vi.fn() } as unknown as ToolContext['ttlWatcher'],
    progressToken: undefined,
    throttle: {
      reserve: vi.fn(),
      release: vi.fn(),
      cancel: vi.fn(),
      shouldDelay: vi.fn(() => 0),
      recordRetryHint: vi.fn(),
    } as unknown as ToolContext['throttle'],
  };
  return { ctx, generateContent };
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
