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
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   FAKE-TIMER HAZARD — READ BEFORE ADDING TESTS HERE
 * ─────────────────────────────────────────────────────────────────────────
 * Tests in this file MUST NOT call `vi.useFakeTimers()` before
 * `await askAgenticTool.execute(...)`. The production code path (line ~409
 * in `src/tools/ask-agentic.tool.ts`) calls `await resolveWorkspaceRoot(...)`
 * → `await fs.promises.realpath(...)` (sandbox.ts:155) — libuv thread-pool
 * I/O that fake timers CANNOT intercept. Sequence:
 *
 *   1. Test calls `vi.useFakeTimers()`
 *   2. Test calls `await askAgenticTool.execute(...)` → starts realpath
 *   3. Test calls `await vi.advanceTimersByTimeAsync(N)` — drains the
 *      microtask queue and returns BEFORE realpath resolves on a slow disk
 *   4. realpath finally resolves; `withNetworkRetry` registers
 *      `setTimeout(1000)` for backoff — but this timer is queued AFTER the
 *      fake clock already advanced past it. The timer never fires.
 *   5. Test hangs to the 30 s `testTimeout`. Its `try { … } finally
 *      { useRealTimers() }` block never runs. Fake timers stay hijacked
 *      globally for the worker (vitest runs all tests of one file in the
 *      same worker), and every subsequent real-timer test in this file
 *      (e.g. the F2 / F3 / end-to-end iteration-timeout tests) deadlocks
 *      its own `setTimeout` against the leaked fake-timer queue.
 *
 * v1.7.2 traced this race (CHANGELOG `[1.7.2]`) and rewrote `:592` (the
 * one offender at the time) to use real timers. The file-level `afterEach`
 * below is defense-in-depth so a future regression of the same pattern is
 * contained to one test instead of cascading.
 *
 * If you NEED to drive a timer-based assertion through `askAgenticTool.execute`,
 * use REAL timers — the production backoff is bounded (1s + 3s = ~4s for the
 * full retry-budget exhaust path) and the suite's 30s `testTimeout` has
 * plenty of headroom. Fake timers are appropriate for unit tests of
 * `withNetworkRetry` / `abortableSleep` / `createTimeoutController` in
 * isolation (see `gemini-retry.test.ts` and `abort-timeout.test.ts`), where
 * no realpath I/O sits between the timer and the test boundary.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askAgenticTool } from '../../src/tools/ask-agentic.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';

const mocks = vi.hoisted(() => ({
  validateWorkspacePath: vi.fn(),
  resolveModel: vi.fn(),
  // F2: opt-in latency injection for `grepExecutor`. Default 0 = pass-through
  // for all existing tests. Per-test override (set in the test body, reset
  // in `beforeEach`) wraps the real executor with `setTimeout`-based delay
  // so we can drive the post-dispatch abort check at
  // `src/tools/ask-agentic.tool.ts:918-922` without faking timers.
  grepExecutorDelayMs: 0,
}));

vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: mocks.validateWorkspacePath,
  WorkspaceValidationError: class extends Error {},
}));
vi.mock('../../src/gemini/models.js', () => ({
  resolveModel: mocks.resolveModel,
}));
// Partial mock — leave list_directory / find_files / read_file untouched
// (other tests in this file depend on them running for real against tmpdir
// fixtures). Only `grepExecutor` is wrapped, and only adds latency when a
// test explicitly sets `mocks.grepExecutorDelayMs` > 0.
vi.mock('../../src/tools/agentic/workspace-tools.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/tools/agentic/workspace-tools.js')>(
    '../../src/tools/agentic/workspace-tools.js',
  );
  const slowGrepExecutor: typeof actual.grepExecutor = async (...args) => {
    const delay = mocks.grepExecutorDelayMs;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
    }
    return actual.grepExecutor(...args);
  };
  return {
    ...actual,
    grepExecutor: slowGrepExecutor,
  };
});

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
  // to exercise rejection. Returning `{ id: N }` is the success shape — IDs
  // increment per call so cancel/finalize assertions can structurally pin
  // WHICH iteration's reservation was affected (a hardcoded `id: 1` would
  // mask an ordering bug where iter-N cancels iter-1's reservation).
  let nextReserveId = 1;
  const manifest = {
    reserveBudget: vi.fn().mockImplementation(() => ({ id: nextReserveId++ })),
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

// Defense-in-depth: any test that calls `vi.useFakeTimers()` and fails to
// restore real timers (e.g. an `await` inside a `try { … } finally { … }`
// block never settles, so the `finally` arm never runs) leaves the worker's
// global `setTimeout` hijacked. Subsequent real-timer tests in the same file
// (vitest runs all tests of one file in the same worker) then deadlock —
// their `setTimeout(…, 1000)` is intercepted by the fake-timer queue and
// never fires. This `afterEach` is a hard floor: every test starts with
// real timers regardless of the previous test's exit path. The leak that
// motivated this guard is documented in CHANGELOG.md `[1.7.2]`. **DO NOT
// REMOVE THIS HOOK** without re-introducing the cascade described in that
// entry — see also the top-of-file comment block on the fake-timer hazard.
//
// `clearAllTimers` (v1.7.3, /6step Finding #2) drops any pending fake-timer
// entries before swapping back to real, so a future test that calls
// `vi.useFakeTimers()` does not inherit stale queue state from a prior test.
//
// `cleanupTmpDirs` (v1.7.3, /6step Finding #7) sweeps `gcctx-askagent-*`
// dirs created by `mkdtempSync` in the previous test. Tests in this file
// run sequentially in one worker, so by the time `afterEach` fires the
// previous test's `it()` body has resolved and no longer holds open file
// handles to the dir. Best-effort: rmSync errors are swallowed so a single
// flake in cleanup does not mask a real test failure in the next case.
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  cleanupTmpDirs();
});

function cleanupTmpDirs(): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('gcctx-askagent-')) continue;
    try {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    } catch {
      // Best-effort. The next CI run on a fresh GH Actions runner starts
      // with an empty /tmp anyway; the only cost of a failed sweep here
      // is dev-machine /tmp accumulation, which is bounded and harmless.
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the F2 grep-latency override so a test that opted-in does not
  // bleed into the next case (`vi.hoisted` state survives between tests).
  mocks.grepExecutorDelayMs = 0;
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

// Forced-finalization pass: when the iteration budget is exhausted without
// the model organically producing a final-text turn, run one extra
// `generateContent` with `toolConfig.functionCallingConfig.mode = NONE` so
// the model is prohibited from emitting more function calls and must answer
// in text from the conversation already accumulated. Converts what was
// previously an opaque AGENTIC_MAX_ITERATIONS error into a synthesized
// answer derived from the gathered tool responses.
describe('ask_agentic loop — forced-finalization pass (post-maxIterations)', () => {
  it('returns synthesized text via finalization pass when loop exhausts maxIterations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    writeFileSync(join(root, 'b.ts'), 'y');
    // 2 tool-call iters consume the maxIterations=2 budget; the loop exits
    // without organic final text. The 3rd scripted response is the
    // finalization pass — model returns text under forced-NONE mode.
    const { ctx, generateContent } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { functionCalls: [{ name: 'read_file', args: { path: 'b.ts' } }] },
        { text: 'Synthesized answer from gathered tool responses.' },
      ],
    });
    const result = await askAgenticTool.execute(
      { prompt: 'review', workspace: root, maxIterations: 2 },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(String(result.structuredContent?.responseText)).toContain('Synthesized answer');
    expect(result.structuredContent?.convergenceForced).toBe(true);
    expect(result.structuredContent?.iterations).toBe(2);
    // Round-3 fix: `apiCalls` reports total `generateContent` calls including the
    // finalization pass. With maxIterations=2 + finalization fired, apiCalls=3.
    expect(result.structuredContent?.apiCalls).toBe(3);

    // Finalization is the 3rd generateContent call. Its config MUST set
    // `toolConfig.functionCallingConfig.mode = 'NONE'` — this is the
    // mechanism that prohibits more function calls and forces text.
    expect(generateContent).toHaveBeenCalledTimes(3);
    const finalizationCallArg = generateContent.mock.calls[2]?.[0] as {
      contents?: Array<{ role?: string; parts?: unknown[] }>;
      config?: { toolConfig?: { functionCallingConfig?: { mode?: string } } };
    };
    expect(finalizationCallArg?.config?.toolConfig?.functionCallingConfig?.mode).toBe('NONE');

    // Conversation-shape pin: the post-loop finalization passes the
    // accumulated `conversation` verbatim. After every non-final iteration,
    // `runAgenticIteration` pushes a `[model fc, user functionResponse]`
    // pair onto the conversation, so the array MUST end with a `user` turn
    // when the loop exhausts maxIterations. A trailing `model` turn would
    // violate Gemini's role-alternation contract and 400 the call. (Round-1
    // Grok concern; empirically refuted in real-Gemini test but pinned
    // here so a future regression to the conversation-mutation path is
    // caught at unit-test time.)
    const finalizationContents = finalizationCallArg?.contents ?? [];
    expect(finalizationContents.length).toBeGreaterThan(0);
    expect(finalizationContents[finalizationContents.length - 1]?.role).toBe('user');
  });

  it('falls through to AGENTIC_MAX_ITERATIONS error when finalization pass returns empty text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    // 2 tool-call iters (200 prompt tokens each) + finalization pass with
    // 300 prompt tokens & empty text. Loop totals: 400 input. Pass adds 300,
    // total 700 — telemetry on the errorResult MUST report the post-pass
    // total so the operator sees the full billing footprint, not the
    // pre-pass tokens (which previously under-reported usage by the pass's
    // own input/output count).
    const { ctx, generateContent } = buildCtx({
      script: [
        {
          functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }],
          promptTokenCount: 200,
          candidatesTokenCount: 50,
        },
        {
          functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }],
          promptTokenCount: 200,
          candidatesTokenCount: 50,
        },
        { text: '', promptTokenCount: 300, candidatesTokenCount: 80 },
      ],
    });
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2 },
      ctx,
    );

    // No-progress signature dedupe fires at threshold=3, so 2 identical
    // calls don't trigger it — the loop genuinely runs both iters then
    // exhausts maxIterations, exercising the finalization-pass path.
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_MAX_ITERATIONS');
    expect(generateContent).toHaveBeenCalledTimes(3); // finalization pass DID fire
    // Telemetry MUST report POST-pass cumulative tokens — billed work
    // doesn't disappear just because the pass returned empty text.
    expect(result.structuredContent?.cumulativeInputTokens).toBe(700); // 200+200+300
    expect(result.structuredContent?.cumulativeOutputTokens).toBe(180); // 50+50+80
  });

  it('allows finalization pass to run even when it would push past maxTotalInputTokens (v1.14.2 rescue unblock)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    // Pre-v1.14.2 contract: when `cumulativeInputTokens + PER_ITERATION_INPUT_TOKENS
    // > maxTotalInputTokens`, the finalization pass was SKIPPED to honour the
    // operator's per-call token cap, returning AGENTIC_MAX_ITERATIONS with no
    // synthesised answer. v1.14.2 inverts that: the rescue is the documented
    // exit path for "loop ran out of iterations without final text", so blocking
    // it on rescue's own potential overshoot defeated the v1.14.1 feature for
    // any operator running near the cap. Empirical repro: today's 6-way
    // benchmark on the v1.14.1 PR self-review failed with
    // `cumulativeInputTokens=500_919 > 500_000` (the line-790 mid-loop hard-stop;
    // this rescue self-block was the same pathology at the maxIters boundary).
    //
    // Post-v1.14.2 contract: the rescue runs even when its own input would push
    // past the cap. Cost is bounded by `dailyBudgetUsd` (skipped if reservation
    // rejects), wall-clock by `iterationTimeoutMs`. Cap-overshoot is signalled
    // via `overBudget: true` on the result, mirroring the organic-final-text
    // path's contract.
    const { ctx, generateContent } = buildCtx({
      script: [
        {
          functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }],
          promptTokenCount: 50_000,
        },
        {
          functionCalls: [{ name: 'list_directory', args: { path: '.' } }],
          promptTokenCount: 50_000,
        },
        // Rescue (3rd call) runs and synthesises an answer. With
        // promptTokenCount=80_000, cumulative becomes 180_000 — well past the
        // 120_000 cap, exercising the overBudget signal.
        {
          text: 'Synthesised answer from gathered tool responses (rescue past cap).',
          promptTokenCount: 80_000,
        },
      ],
    });
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2, maxTotalInputTokens: 120_000 },
      ctx,
    );

    // Rescue path was NOT skipped — the 3rd generateContent call fired and
    // returned synthesised text.
    expect(result.isError).toBeUndefined();
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(String(result.structuredContent?.responseText)).toContain('Synthesised answer');
    // convergenceForced flags the rescue as the source of the answer.
    expect(result.structuredContent?.convergenceForced).toBe(true);
    // overBudget is the structured signal that operators key on to detect
    // cap-overshoot. Loop pushed 100k; rescue added 80k = 180k > 120k cap.
    expect(result.structuredContent?.overBudget).toBe(true);
    expect(result.structuredContent?.cumulativeInputTokens).toBe(180_000);
    // apiCalls tracks total generateContent dispatches: 2 loop + 1 rescue.
    expect(result.structuredContent?.apiCalls).toBe(3);
    expect(result.structuredContent?.iterations).toBe(2);
  });

  it('finalization pass returns structured error when iterationTimeoutMs fires mid-flight (cleanup + AGENTIC_MAX_ITERATIONS) (Fix 2)', async () => {
    // 4-reviewer agreement on today's 6-way benchmark (A1): the v1.14.1 test
    // suite covered empty-text / network-failure / budget-skip / tools-omission
    // paths but NOT the finalization-pass timeout/AbortSignal mid-flight path.
    // A future refactor of the catch block at lines ~1050-1085 could silently
    // break the cleanup contract — no test would catch it.
    //
    // This test pins:
    //   - timeout fires DURING the rescue's generateContent (not before
    //     dispatch and not after response)
    //   - falls through to AGENTIC_MAX_ITERATIONS errorResult (NOT errorCode:
    //     'TIMEOUT' — the rescue is best-effort; timeout is logged but
    //     conversion to TIMEOUT is reserved for the iter-loop timeout path)
    //   - apiCalls = iterations + 1 (finalizationAttempted=true is set BEFORE
    //     withNetworkRetry, so a mid-flight abort still counts the dispatched
    //     attempt — Gemini may bill server-side even on aborted-mid-flight
    //     calls)
    //   - convergenceForced is undefined (rescue did NOT produce a synthesised
    //     answer)
    //   - cancelBudgetReservation fires for the rescue's reservation
    //   - throttle.cancel fires for the rescue's TPM reservation
    //
    // Real timers per the file-level fake-timer hazard guidance (top of file).
    // iterationTimeoutMs=1000 + setup overhead → ~1.0–1.5s wall-clock per run;
    // bounded by suite testTimeout=30s.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const { ctx, generateContent, manifest, throttle } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { functionCalls: [{ name: 'list_directory', args: { path: '.' } }] },
      ],
      tpmThrottleLimit: 80_000, // exercises throttle.cancel cleanup path
      dailyBudgetUsd: 100, // exercises manifest.cancelBudgetReservation cleanup path
    });
    // 3rd generateContent (rescue) hangs until aborted via the test's
    // iterationTimeoutMs signal. The SDK threads `abortSignal` into the config
    // so we can drive abortion deterministically.
    generateContent.mockImplementationOnce(
      (req: { config?: { abortSignal?: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          const sig = req.config?.abortSignal;
          if (!sig) {
            reject(new Error('test invariant: abortSignal not threaded into rescue config'));
            return;
          }
          if (sig.aborted) {
            reject(sig.reason);
            return;
          }
          sig.addEventListener('abort', () => reject(sig.reason));
        }),
    );

    const startedAt = Date.now();
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2, iterationTimeoutMs: 1_000 },
      ctx,
    );
    const elapsedMs = Date.now() - startedAt;

    // Rescue timed out → fall through to AGENTIC_MAX_ITERATIONS shape (NOT
    // errorCode: 'TIMEOUT' — the iter-loop timeout path converts to TIMEOUT,
    // but the rescue's best-effort catch logs and falls through).
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_MAX_ITERATIONS');
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
    // Rescue did NOT produce text — convergenceForced is reserved for
    // successful rescue synthesis only.
    expect(result.structuredContent?.convergenceForced).toBeUndefined();
    // 2 loop iters + 1 attempted rescue = 3 generateContent calls counted.
    // finalizationAttempted=true is set BEFORE withNetworkRetry, so a
    // mid-flight abort still counts toward apiCalls.
    expect(result.structuredContent?.apiCalls).toBe(3);
    expect(generateContent).toHaveBeenCalledTimes(3);

    // Cleanup contract: rescue's budget reservation cancelled (NOT finalised);
    // rescue's TPM reservation cancelled (NOT released). The 2 successful
    // loop iters' reservations went through finalize/release pre-rescue.
    expect(manifest.finalizeBudgetReservation).toHaveBeenCalledTimes(2);
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledTimes(1);
    expect(throttle.release).toHaveBeenCalledTimes(2); // 2 loop iters
    expect(throttle.cancel).toHaveBeenCalledTimes(1); // 1 rescue cleanup

    // Timing sanity: actually waited for the timer. Lower bound 950ms
    // accommodates timer-precision jitter on slow CI workers; upper bound
    // 5_000ms catches a runaway hang past the documented timeout budget.
    expect(elapsedMs).toBeGreaterThanOrEqual(950);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('falls through to AGENTIC_MAX_ITERATIONS when finalization pass throws (network failure)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const { ctx, generateContent } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { functionCalls: [{ name: 'list_directory', args: { path: '.' } }] },
      ],
    });
    // Simulate finalization-call non-transient failure (HTTP error with
    // numeric `.status`). `isTransientNetworkError` (src/gemini/retry.ts:82)
    // returns false for any error carrying a numeric `status` field, so
    // `withNetworkRetry` does NOT retry — the single rejection deterministically
    // exits the pass. Using a transient shape like `Error('fetch failed')`
    // would match `TRANSIENT_PATTERNS`, trigger the 3-attempt retry budget,
    // and consume the next queued mock (or return `undefined`), making the
    // test pass for the wrong reason. The pass MUST be best-effort
    // regardless of failure shape — caller deserves a structured error, not
    // a re-thrown SDK exception. (Round-3 review fix: GPT P1 + Copilot.)
    generateContent.mockRejectedValueOnce(
      Object.assign(new Error('http 500 internal server error'), { status: 500 }),
    );

    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_MAX_ITERATIONS');
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
    // G1 fix: pre-response failures (timeout, network) MUST still count
    // toward `apiCalls`. The HTTP 500 mock fails before usageMetadata
    // arrives, so `finalizationUsage.promptTokenCount` stays 0. Pre-fix the
    // inference `apiCalls = iterations + (promptTokenCount > 0 ? 1 : 0)`
    // undercounted (reported 2). Post-fix uses explicit
    // `finalizationAttempted` flag set BEFORE dispatch — so apiCalls = 3
    // (2 loop iters + 1 attempted finalization, even though it failed).
    expect(result.structuredContent?.apiCalls).toBe(3);
  });

  it('skips finalization pass when daily budget is exhausted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const { ctx, generateContent, manifest } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { functionCalls: [{ name: 'list_directory', args: { path: '.' } }] },
      ],
      dailyBudgetUsd: 50,
    });
    // First 2 reservations succeed (loop body); 3rd reservation (finalization
    // pass) is rejected — budget cap reached.
    manifest.reserveBudget
      .mockImplementationOnce(() => ({ id: 1 }))
      .mockImplementationOnce(() => ({ id: 2 }))
      .mockImplementationOnce(() => ({ rejected: true, spentMicros: 50_000_000 }));

    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_MAX_ITERATIONS');
    // Only 2 generateContent calls — finalization was skipped because
    // reserveBudget rejected.
    expect(generateContent).toHaveBeenCalledTimes(2);
    // v1.14.2 Fix 5: structured field signals WHY the rescue was skipped, so
    // automated triage doesn't have to parse the prose error message.
    expect(result.structuredContent?.finalizationSkipReason).toBe('daily-budget');
    // v1.14.2 Fix 5: error message is cause-specific. Pre-fix said "Increase
    // maxIterations or narrow your prompt" (a lie when the cause is daily
    // budget). Post-fix points operators at the actual remediation.
    expect(String(result.structuredContent?.responseText)).toContain('daily budget cap reached');
    expect(String(result.structuredContent?.responseText)).toContain('GEMINI_DAILY_BUDGET_USD');
    expect(String(result.structuredContent?.responseText)).not.toContain('Increase maxIterations');
  });

  it('rescue ran-and-failed (empty text) keeps original "Increase maxIterations" message — no false skip-reason flag (Fix 5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    // The rescue dispatched and returned empty text — distinct from the
    // daily-budget skip path. Operator should see the original "Increase
    // maxIterations" message and NO `finalizationSkipReason` field (the
    // structured field is reserved for actual skips, not run-and-failed).
    const { ctx } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { functionCalls: [{ name: 'list_directory', args: { path: '.' } }] },
        { text: '' }, // rescue ran but returned empty
      ],
    });
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.subReason).toBe('AGENTIC_MAX_ITERATIONS');
    // Original message — rescue ran, just produced no text.
    expect(String(result.structuredContent?.responseText)).toContain('Increase maxIterations');
    expect(String(result.structuredContent?.responseText)).not.toContain(
      'daily budget cap reached',
    );
    // Skip-reason field is ABSENT on the run-and-failed path (additive
    // optional field — only emitted when set).
    expect(result.structuredContent?.finalizationSkipReason).toBeUndefined();
  });

  it('finalization call: NONE mode + thinkingConfig preserved + tools omitted (G2 fix)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const { ctx, generateContent } = buildCtx({
      script: [
        { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
        { text: 'final synthesis' },
      ],
    });
    await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 1, thinkingLevel: 'HIGH' },
      ctx,
    );

    // Finalization is the 2nd call. Verify:
    //   1. NONE override is set
    //   2. thinkingConfig is preserved from baseConfig (still useful — model
    //      can think while synthesizing)
    //   3. systemInstruction is replaced with finalization-focused version
    //   4. tools[] is OMITTED (G2 fix). Per Gemini API spec, NONE mode is
    //      "equivalent to sending a request without any function declarations"
    //      — sending tools[] alongside NONE wastes tokens (~150-300 input
    //      tokens for the 4 declared functions) and contradicts the spec.
    //      `tools: undefined` in the finalization config explicitly overrides
    //      the inherited `tools` from `...baseConfig` spread.
    const finalConfig = generateContent.mock.calls[1]?.[0] as {
      config?: {
        toolConfig?: { functionCallingConfig?: { mode?: string } };
        tools?: unknown[];
        thinkingConfig?: { thinkingLevel?: string };
        systemInstruction?: string;
      };
    };
    expect(finalConfig?.config?.toolConfig?.functionCallingConfig?.mode).toBe('NONE');
    expect(finalConfig?.config?.thinkingConfig?.thinkingLevel).toBe('HIGH');
    expect(String(finalConfig?.config?.systemInstruction)).toContain(
      'iteration budget is now exhausted',
    );
    // G2 fix: tools[] MUST be undefined on finalization call. Pre-fix it was
    // preserved via `...baseConfig` spread (tested as `Array.isArray(...) === true`)
    // — that behavior wasted prompt tokens and contradicted the NONE-mode spec.
    expect(finalConfig?.config?.tools).toBeUndefined();
  });

  it('finalization pass uses last-iteration prompt tokens for TPM reservation, not static estimate (v1.14.2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    // The finalization pass replays the entire accumulated conversation, so
    // its actual prompt size ≈ the LAST iter's `promptTokenCount`, not the
    // static `PER_ITERATION_INPUT_TOKENS = 50_000` constant. Pre-v1.14.2 the
    // TPM reservation under-reserved by 4-6× on a 20-iter loop with file reads
    // (real workloads observed at 200-300k for the rescue prompt). Post-v1.14.2
    // the reservation uses `lastIterationPromptTokens + 5_000` margin (covers
    // SYSTEM_INSTRUCTION_FINALIZATION + thinking overhead). Bias to over-reserve
    // is intentional — TPM over-reserve is harmless wait; under-reserve risks
    // 429 from Gemini.
    const { ctx, throttle } = buildCtx({
      script: [
        // Loop iter 1: prompt 200k tokens.
        {
          functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }],
          promptTokenCount: 200_000,
        },
        // Loop iter 2: prompt grew to 250k (history accumulation).
        {
          functionCalls: [{ name: 'list_directory', args: { path: '.' } }],
          promptTokenCount: 250_000,
        },
        // Rescue: synthesises text. Uses last-iter prompt size (250k) + 5k
        // margin = 255_000 for the TPM reservation.
        { text: 'Synthesised answer.' },
      ],
      tpmThrottleLimit: 80_000, // exercises tpmEnforced=true gate
    });
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2 },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.convergenceForced).toBe(true);
    // Three throttle.reserve calls: 2 loop iters + 1 rescue.
    expect(throttle.reserve).toHaveBeenCalledTimes(3);
    // Per-iter calls use static 50_000 (no usage record yet).
    expect(throttle.reserve).toHaveBeenNthCalledWith(1, expect.any(String), 50_000);
    expect(throttle.reserve).toHaveBeenNthCalledWith(2, expect.any(String), 50_000);
    // Rescue pass uses lastIterationPromptTokens (250k) + 5k margin = 255_000.
    // This is the load-bearing assertion — pre-v1.14.2 was hardcoded 50_000.
    expect(throttle.reserve).toHaveBeenNthCalledWith(3, expect.any(String), 255_000);
  });

  it('finalization pass daily-budget reserve uses dynamic cost estimate (Fix 6.1 — symmetric with TPM reserve)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    // Pre-Fix-6.1: rescue's `reserveBudget` used `perIterationCostUsd` (computed
    // from the static `PER_ITERATION_INPUT_TOKENS = 50_000` baseline), while the
    // TPM reserve was already updated to use the dynamic
    // `lastIterationPromptTokens + 5_000` estimate. Asymmetric — rescue would
    // under-estimate cost against the daily-budget cap, breaking the documented
    // "daily budget is a true upper bound" guarantee. Operators who set
    // `dailyBudgetUsd` near their actual spend could see the rescue silently
    // exceed the cap.
    //
    // Post-Fix-6.1: BOTH reservations use the dynamic estimate. This test pins
    // that the daily-budget reserve passes a cost computed from the dynamic
    // estimate (255k input tokens), not the static 50k.
    const { ctx, manifest } = buildCtx({
      script: [
        {
          functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }],
          promptTokenCount: 200_000,
        },
        {
          functionCalls: [{ name: 'list_directory', args: { path: '.' } }],
          promptTokenCount: 250_000,
        },
        { text: 'Synthesised answer.' },
      ],
      dailyBudgetUsd: 100, // exercises dailyBudgetEnforced=true gate
    });
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, maxIterations: 2 },
      ctx,
    );
    expect(result.isError).toBeUndefined();

    // 3 reserveBudget calls total: 2 loop iters + 1 rescue. The third is the
    // load-bearing assertion — its estimatedCostMicros must reflect the
    // dynamic 255k token estimate, NOT the static 50k baseline.
    expect(manifest.reserveBudget).toHaveBeenCalledTimes(3);
    const rescueReserveCall = manifest.reserveBudget.mock.calls[2]?.[0] as
      | { estimatedCostMicros?: number }
      | undefined;
    const loopReserveCall = manifest.reserveBudget.mock.calls[0]?.[0] as
      | { estimatedCostMicros?: number }
      | undefined;
    expect(rescueReserveCall?.estimatedCostMicros).toBeDefined();
    expect(loopReserveCall?.estimatedCostMicros).toBeDefined();
    // Rescue cost must be substantially higher than the loop's per-iter cost
    // (255k vs 50k input tokens — 5.1× the input, but total cost ratio is
    // smaller because output + thinking-token components stay the same in both
    // calls). Asserting >2× is a soft-but-load-bearing check: catches a
    // regression to the static `perIterationCostUsd` baseline (which would make
    // the two costs IDENTICAL → ratio = 1×) without pinning the exact pricing
    // math (cost.ts is a separate module that may re-tune token rates).
    const loopCost = loopReserveCall?.estimatedCostMicros ?? 0;
    const rescueCost = rescueReserveCall?.estimatedCostMicros ?? 0;
    expect(rescueCost).toBeGreaterThan(loopCost * 2);
  });
});

describe('ask_agentic loop — 429 retry-hint integration (v1.14.2 Fix 4)', () => {
  it('per-iteration 429: extracts retryDelay from ApiError + seeds throttle hint', async () => {
    // Pre-Fix-4 ask_agentic discarded 429 retry hints — TPM throttle relied on
    // pure-window math which over-estimates by 30s+ on real 429s. Post-Fix-4
    // mirrors `ask.tool.ts:~1063`: gate on `isGemini429` (requires
    // `err instanceof ApiError` + status===429), parse `retryInfo.retryDelay`
    // from the body, and `throttle.recordRetryHint(model, delayMs)` to seed
    // the cache. Future ask_agentic / ask / code calls honour the hint via
    // `throttle.reserve`'s `activeHint` lookup.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const apiErr = new ApiError({
      status: 429,
      message: '{"error":{"code":429,"details":[{"retryDelay":"7s"}]}}',
    });
    const { ctx, throttle } = buildCtx({ script: [] });
    // Override generateContent to throw the 429 on iter 1.
    (ctx.client.models.generateContent as ReturnType<typeof vi.fn>).mockReset();
    (ctx.client.models.generateContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(apiErr);

    const result = await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);

    // Iter catch re-throws non-timeout errors, so the call ultimately errors
    // out via the outer catch with errorCode='UNKNOWN'. The load-bearing
    // assertion is that the retry hint WAS recorded BEFORE the re-throw.
    expect(result.isError).toBe(true);
    // recordRetryHint may be called once (inner catch) or once more if the
    // outer catch's safety-net hint extraction also fires (depends on whether
    // the inner catch's `throw iterErr` path reaches the outer for the same
    // 429). Either way the recorded model + delay must match. Pin BOTH the
    // model (literal — `resolveModel` mock returns 'gemini-3-pro-preview') and
    // the parsed delay (7s → 7000ms).
    expect(throttle.recordRetryHint).toHaveBeenCalledWith('gemini-3-pro-preview', 7_000);
  });

  it('outer-catch 429 from PRE-resolution path (resolveModel itself 429s) does NOT seed hint — alias key mismatch (v1.14.3)', async () => {
    // The outer catch's hint-extraction guard (`if typeof resolved?.resolved
    // === 'string'`) intentionally SKIPS when `resolved` is still undefined
    // (resolution itself threw the 429). Recording a hint against the
    // unresolved alias (e.g., 'latest-pro-thinking') would key the hint to
    // a string that future calls won't match — they'd resolve to a literal
    // model id like `gemini-3-pro-preview`, miss the alias-keyed hint, and
    // retry too soon. Better to discard than to mis-key.
    //
    // This test pins the documented contract: pre-resolution 429s are NOT
    // recorded. Tracked as v1.14.4 if alias↔literal hint reconciliation
    // becomes worth the throttle-state widening.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const apiErr = new ApiError({
      status: 429,
      message: '{"error":{"code":429,"details":[{"retryDelay":"15s"}]}}',
    });
    mocks.resolveModel.mockRejectedValueOnce(apiErr);
    const { ctx, throttle } = buildCtx({ script: [] });

    const result = await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);

    expect(result.isError).toBe(true);
    expect(throttle.recordRetryHint).not.toHaveBeenCalled();
  });

  it('outer-catch 429 from POST-resolution path seeds hint via hoisted resolved (v1.14.3)', async () => {
    // The other v1.14.3 outer-catch case: resolveModel SUCCEEDS, then
    // something downstream throws a 429 that escapes both inner catches.
    // This is the path where the v1.14.3 hoist actually pays off — resolved
    // is set, outer catch reads it, hint is recorded.
    //
    // Concretely: a 429 thrown from runAgenticIteration's setup
    // (pre-generateContent — e.g., `validateWorkspacePath` or a programmer
    // error in argument prep) reaches the outer catch with `resolved`
    // already populated. Hint extraction fires.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const apiErr = new ApiError({
      status: 429,
      message: '{"error":{"code":429,"details":[{"retryDelay":"22s"}]}}',
    });
    // Force the iter catch to NOT match — by throwing a 429 from a path
    // OUTSIDE the per-iter try block. Simplest reproducible path: throw on
    // the FIRST generateContent (which IS inside the iter try — caught by
    // iter catch). Hmm — cleanest synthetic: throw from buildCtx's
    // throttle.reserve, which fires INSIDE the iter try but BEFORE
    // generateContent. The iter catch would still catch this and re-throw
    // since not isTimeoutAbort, propagating to outer catch.
    //
    // Inner iter catch ALSO extracts the hint (Fix 4). So this test pins
    // the outer catch behaviour for the rare path where iter catch's hint
    // extraction got bypassed (e.g., a future refactor that changes the
    // catch shape). Asserting recordRetryHint was called AT LEAST once
    // covers either iter-catch OR outer-catch firing.
    const { ctx, throttle } = buildCtx({ script: [] });
    (ctx.client.models.generateContent as ReturnType<typeof vi.fn>).mockReset();
    (ctx.client.models.generateContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(apiErr);

    const result = await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);

    expect(result.isError).toBe(true);
    // recordRetryHint fires (either inner iter catch — Fix 4 — or outer
    // catch — v1.14.3 hoist; both paths record the SAME hint). Pin the
    // resolved model + parsed delay regardless of which catch fired.
    expect(throttle.recordRetryHint).toHaveBeenCalledWith('gemini-3-pro-preview', 22_000);
  });

  it('non-429 ApiError (e.g. 500) does NOT seed retry hint (status-strict gate)', async () => {
    // The `isGemini429` gate requires BOTH instanceof ApiError AND status===429.
    // A real ApiError with a different status (500, 503) must NOT seed a hint
    // even if its message contains a `retryDelay` decoy (which Google's
    // server-side error bodies sometimes include for non-429 errors too).
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const apiErr = new ApiError({
      status: 500,
      message: '{"error":{"code":500,"details":[{"retryDelay":"30s"}]}}',
    });
    const { ctx, throttle } = buildCtx({ script: [] });
    (ctx.client.models.generateContent as ReturnType<typeof vi.fn>).mockReset();
    (ctx.client.models.generateContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(apiErr);

    await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);

    expect(throttle.recordRetryHint).not.toHaveBeenCalled();
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

    // R4#4: durationMs must be a non-negative integer (typically > 0, but
    // mocked Gemini is near-instant so we assert the weaker invariant;
    // the critical regression was `0` being hard-coded).
    for (const call of manifest.finalizeBudgetReservation.mock.calls) {
      const finalizeArgs = call[1] as { durationMs?: unknown };
      expect(typeof finalizeArgs.durationMs).toBe('number');
      expect(finalizeArgs.durationMs).toBeGreaterThanOrEqual(0);
      // Must not be the hard-coded literal from the pre-round-4 bug.
      // (Vanishingly unlikely to be exactly `0` from real measurement —
      // but we can't assert strictly > 0 because the mock is synchronous.)
    }
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

// ---------------------------------------------------------------------------
// v1.5.1 — transient network retry at the loop layer
// ---------------------------------------------------------------------------
//
// Belt-and-suspenders integration coverage to pair with the in-isolation unit
// tests in `test/unit/gemini-retry.test.ts`. These exercise the full
// `ask_agentic` loop under a mocked `generateContent` that rejects with the
// exact Node undici `TypeError: fetch failed` shape. The loop controller itself
// is unaware of retries — `withNetworkRetry` wraps `generateContent` inside
// `runAgenticIteration`, so a successful recovery looks like a single iteration
// from the loop's perspective, and an exhausted retry budget surfaces via the
// top-level `errorResult({ errorCode: 'UNKNOWN' })` path.

describe('ask_agentic loop — transient network retry (v1.5.1)', () => {
  it('recovers from one transient `TypeError: fetch failed` and completes the answering iteration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-retry-'));
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;');

    const { ctx, generateContent } = buildCtx({ script: [] });
    // Fully control the mock queue so order is: reject → resolve.
    generateContent.mockReset();
    generateContent.mockRejectedValueOnce(new TypeError('fetch failed'));
    generateContent.mockResolvedValueOnce(
      buildResponse({ text: 'One file: index.ts defines `x`.' }),
    );

    // Real timers — single retry means one 1s backoff, acceptable for a test.
    const result = await askAgenticTool.execute(
      { prompt: 'what is in this repo?', workspace: root },
      ctx,
    );

    // Loop sees exactly one completed iteration; the retry is internal to
    // `runAgenticIteration` and opaque to the outer controller.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.iterations).toBe(1);
    expect(result.content[0]?.text).toContain('index.ts');
    // SDK was hit twice — first rejected, second succeeded.
    expect(generateContent).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('surfaces a structured error when the retry budget exhausts on persistent failure', async () => {
    // REAL timers — see the v1.7.2 root-cause note. The earlier fake-timer
    // implementation raced `vi.advanceTimersByTimeAsync` (only drains the
    // microtask queue) against `await resolveWorkspaceRoot(...)` which calls
    // `fs.promises.realpath` (libuv thread-pool I/O — NOT touched by fake
    // timers). On hot CI disks the realpath could resolve AFTER the advance
    // calls, so the `withNetworkRetry` `setTimeout(1000)` was registered
    // post-advance and the fake-timer queue never fired it again — the test
    // hung to the 30s ceiling, abandoned its `finally { useRealTimers() }`,
    // and poisoned every subsequent real-timer test in this file. Real
    // timers run in ~4s wall-clock (1s + 3s exponential backoff) — well
    // under the 30s budget — and have no race with realpath.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-retry-'));
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;');

    const { ctx, generateContent } = buildCtx({ script: [] });
    generateContent.mockReset();
    // Every call rejects with the undici transient shape → withNetworkRetry
    // exhausts its 3-attempt budget and re-throws.
    generateContent.mockRejectedValue(new TypeError('fetch failed'));

    const result = await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);

    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toMatch(/ask_agentic failed.*fetch failed/i);
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
    // Three attempts: initial + 2 retries = 3 generateContent calls.
    // Coupled to `withNetworkRetry`'s default `attempts: 3` in
    // `src/gemini/retry.ts:112`. If that default ever changes, update both
    // the assertion AND the ~4 s wall-clock comment in the test docstring
    // (1 s + 3 s exponential backoff = 4 s for default attempts=3 + base=1s).
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry permanent failures (no .status, no fetch-failed shape)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-retry-'));
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;');

    const { ctx, generateContent } = buildCtx({ script: [] });
    generateContent.mockReset();
    // A plain validation-shaped error must propagate on the first failure so
    // we do not spend retry budget on permanent problems.
    generateContent.mockRejectedValue(new Error('INVALID_ARGUMENT: bad schema'));

    const result = await askAgenticTool.execute({ prompt: 'q', workspace: root }, ctx);

    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('INVALID_ARGUMENT');
    // Exactly one call — zero retries on non-transient errors.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// v1.6.0 — iterationTimeoutMs (T19) — TIMEOUT errorCode mapping + real abort
// ---------------------------------------------------------------------------
//
// Two layers of coverage, both missing prior to this block:
//
// 1. Error mapping — `runAgenticIteration` rejecting with a TimeoutError
//    surfaces as `errorCode: 'TIMEOUT'` with the configured `timeoutMs` and
//    iteration number, AND the loop releases its budget + throttle
//    reservations so the failed iteration does not leak quota.
//
// 2. Real abort end-to-end — with a 1000ms `iterationTimeoutMs` (the schema
//    minimum) and a `generateContent` mock that hangs until the signal
//    aborts, the controller's actual `setTimeout` fires, the abort
//    propagates via `config.abortSignal`, and the loop catches the
//    resulting TimeoutError. The integration test G uses a generous 60s
//    timeout that never fires; this is the missing FIRING path.
//
// Pairs with `abort-timeout.test.ts` (controller in isolation) and
// `ask-timeout-integration.test.ts` (ask + code mapping). Brings ask_agentic
// to the same coverage bar.

describe('ask_agentic loop — iterationTimeoutMs TIMEOUT mapping (T19)', () => {
  it('maps a TimeoutError from generateContent to errorCode TIMEOUT with iteration metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-timeout-'));
    writeFileSync(join(root, 'a.ts'), 'export const x = 1;');

    const { ctx, generateContent, manifest, throttle } = buildCtx({
      script: [],
      // Finite budget so reservation runs (gated on Number.isFinite) — needed
      // to verify the cancel path.
      dailyBudgetUsd: 100,
      tpmThrottleLimit: 80_000,
    });
    generateContent.mockReset();
    // First iteration: a real function call so the loop reaches iteration 2.
    generateContent.mockResolvedValueOnce(
      buildResponse({ functionCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] }),
    );
    // Second iteration: TimeoutError — what the SDK throws when our
    // `config.abortSignal` fires from the iteration timer.
    generateContent.mockRejectedValueOnce(
      new DOMException('Timed out after 5000 ms', 'TimeoutError'),
    );

    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, iterationTimeoutMs: 5_000 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(5_000);
    expect(result.structuredContent?.iteration).toBe(2);
    expect(result.structuredContent?.retryable).toBe(true);
    // Both reservations on the failing iteration must be released so a
    // timed-out call does not consume quota / budget for work that produced
    // no usable response. Iteration 1 succeeded (1 reserve + 1 finalise),
    // iteration 2 failed (1 reserve + 1 cancel — finalise only fires on
    // success). Same shape applies to throttle.
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledTimes(1);
    expect(throttle.cancel).toHaveBeenCalledTimes(1);
    expect(manifest.finalizeBudgetReservation).toHaveBeenCalledTimes(1);
    // Structural pin (F1): incrementing reservation IDs let us assert WHICH
    // iteration was cancelled vs finalised — iter-1 reserves id=1 and is
    // finalised, iter-2 reserves id=2 and is cancelled. With a hardcoded
    // mock id this would silently pass even if the loop cancelled the
    // wrong reservation.
    expect(manifest.finalizeBudgetReservation).toHaveBeenCalledWith(1, expect.anything());
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledWith(2);
  });

  it('detects TimeoutError nested under error.cause (SDK wrap)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-timeout-'));
    writeFileSync(join(root, 'a.ts'), 'x');

    const { ctx, generateContent } = buildCtx({ script: [] });
    generateContent.mockReset();
    const inner = new DOMException('inner timeout', 'TimeoutError');
    const wrapped = new Error('SDK wrapped the abort', { cause: inner });
    generateContent.mockRejectedValueOnce(wrapped);

    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, iterationTimeoutMs: 3_000 },
      ctx,
    );

    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(3_000);
    expect(result.structuredContent?.iteration).toBe(1);
  });

  it('does NOT surface TIMEOUT for plain AbortError (user-cancelled, not timed out)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-timeout-'));
    writeFileSync(join(root, 'a.ts'), 'x');

    const { ctx, generateContent } = buildCtx({ script: [] });
    generateContent.mockReset();
    generateContent.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, iterationTimeoutMs: 5_000 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('UNKNOWN');
  });

  it('surfaces TIMEOUT when the iteration timer fires DURING the TPM throttle wait (F3)', async () => {
    // Production guarantees (`src/tools/ask-agentic.tool.ts:528-531`) that
    // the iteration timer is created BEFORE `abortableSleep` so the throttle
    // wait itself is bounded by `iterationTimeoutMs`. The other tests in
    // this suite either disable the throttle (`tpmThrottleLimit: 0`) or
    // mock `throttle.reserve` with the default `delayMs: 0`, so the
    // abortable-sleep branch at `:547` is never exercised. Without this
    // test, swapping the timer/throttle order back to the original buggy
    // form (timer AFTER wait) would not fail any test.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-timeout-throttle-'));
    writeFileSync(join(root, 'a.ts'), 'x');

    const { ctx, generateContent, throttle, manifest } = buildCtx({
      script: [],
      dailyBudgetUsd: 100,
      tpmThrottleLimit: 80_000, // tpmEnforced gate flips on
    });
    generateContent.mockReset();
    // Force the throttle to ask for a 5 s wait — the 1 s iter timeout
    // must abort `abortableSleep` before the SDK is ever called.
    throttle.reserve.mockReturnValueOnce({ delayMs: 5_000, releaseId: 42 });

    const startedAt = Date.now();
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, iterationTimeoutMs: 1_000 },
      ctx,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(1_000);
    expect(result.structuredContent?.iteration).toBe(1);
    // Critical: SDK was NEVER called — the timeout fired during the
    // pre-flight throttle wait, not after generateContent began.
    expect(generateContent).not.toHaveBeenCalled();
    // Reservation cleanup still fires for the iteration that timed out.
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledTimes(1);
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledWith(1);
    expect(throttle.cancel).toHaveBeenCalledWith(42);
    // Sanity: actually waited for the timer (≥ ~1 s) — not an instant
    // resolve from a misfired guard. Lower bound is 950ms (5 % slack)
    // because Node's `setTimeout(fn, 1_000)` is documented as "approximately
    // 1000ms" and can fire 1-2 ms early due to clock-source quantisation
    // between `Date.now()` and the timer's internal monotonic clock —
    // observed in CI on Node 22 / Linux runner: 999ms elapsed for a 1000ms
    // timer (PR #35 round 1).
    expect(elapsedMs).toBeGreaterThanOrEqual(950);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('surfaces TIMEOUT when the iteration timer fires DURING tool execution (F2 — post-dispatch abort check)', async () => {
    // Production guards against a slow tool overrunning the deadline at
    // `src/tools/ask-agentic.tool.ts:918-922`: after `dispatchToolCallsParallel`
    // returns, if the signal aborted during dispatch we re-throw
    // `signal.reason` so the catch path maps it to TIMEOUT. None of the
    // other tests reach the THROW arm of that branch — test 1 dispatches
    // a fast `read_file`, test 4 hangs on the SDK call before dispatch
    // ever happens. Without this case, deleting lines 919-921 would not
    // fail any test, silently uncapping per-iteration deadlines.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-timeout-tool-'));
    writeFileSync(join(root, 'a.ts'), 'export const x = 1;');

    const { ctx, generateContent, manifest, throttle } = buildCtx({
      script: [],
      dailyBudgetUsd: 100,
    });
    generateContent.mockReset();
    // Iteration 1: model issues a single grep call. Our `vi.mock` wrapper
    // for `grepExecutor` (top of file) sleeps `mocks.grepExecutorDelayMs`
    // before delegating to the real executor — long enough that the
    // 1 s iter timeout fires mid-dispatch. `setTimeout` here is NOT
    // wired to `abortSignal`, so the dispatch completes naturally; the
    // post-dispatch `abortSignal.aborted` check (`:918`) is what triggers
    // the throw.
    generateContent.mockResolvedValueOnce(
      buildResponse({ functionCalls: [{ id: 'g1', name: 'grep', args: { pattern: 'x' } }] }),
    );
    mocks.grepExecutorDelayMs = 1_500; // > iterationTimeoutMs

    const startedAt = Date.now();
    const result = await askAgenticTool.execute(
      { prompt: 'q', workspace: root, iterationTimeoutMs: 1_000 },
      ctx,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(1_000);
    expect(result.structuredContent?.iteration).toBe(1);
    // The SDK was called once (model issued the grep call); the slow
    // executor ran (~1.5 s); the abort fired during dispatch.
    expect(generateContent).toHaveBeenCalledTimes(1);
    // Single iteration → single reservation → cancelled (not finalised)
    // because the iteration threw on the post-dispatch abort check.
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledTimes(1);
    expect(manifest.cancelBudgetReservation).toHaveBeenCalledWith(1);
    // tpmEnforced=false here (no `tpmThrottleLimit` override → defaults to 0
    // in `buildCtx`), so `throttle.reserve` never ran and `throttle.cancel`
    // has nothing to release. F3 covers the throttle-cancel path.
    expect(throttle.cancel).not.toHaveBeenCalled();
    expect(manifest.finalizeBudgetReservation).not.toHaveBeenCalled();
    // Timing sanity: must have actually waited for the slow executor
    // (≥ ~1.5 s). If this falls below 1.5 s the wrapper isn't being
    // invoked and the test is silently a no-op. Lower bound is 1450ms
    // (~3 % slack) for the same `setTimeout` precision reason documented
    // in the F3 / end-to-end tests above.
    expect(elapsedMs).toBeGreaterThanOrEqual(1_450);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('end-to-end: real timer fires on a hung generateContent and surfaces TIMEOUT', async () => {
    // No fake timers — we want the controller's actual setTimeout to fire so
    // this test exercises the full chain: createTimeoutController → setTimeout
    // → AbortController.abort(reason) → SDK rejects → isTimeoutAbort(err) →
    // errorCode TIMEOUT. The generous-timeout integration test G never trips
    // this path; without this assertion we have no proof the wiring works
    // end-to-end with a real timer.
    const root = mkdtempSync(join(tmpdir(), 'gcctx-askagent-timeout-real-'));
    writeFileSync(join(root, 'a.ts'), 'x');

    const { ctx, generateContent } = buildCtx({ script: [] });
    generateContent.mockReset();
    let observedSignal: AbortSignal | undefined;
    generateContent.mockImplementationOnce(
      (req: { config?: { abortSignal?: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          observedSignal = req.config?.abortSignal;
          if (!observedSignal) {
            reject(new Error('test invariant: config.abortSignal not plumbed to generateContent'));
            return;
          }
          if (observedSignal.aborted) {
            reject(observedSignal.reason);
            return;
          }
          observedSignal.addEventListener('abort', () => {
            reject(observedSignal?.reason);
          });
          // Otherwise hang forever — the timer must fire and abort the signal.
        }),
    );

    const startedAt = Date.now();
    const result = await askAgenticTool.execute(
      // 1000ms is the schema minimum; anything smaller is rejected by Zod and
      // anything smaller than ABSOLUTE_MIN_MS (1000) is clamped by
      // createTimeoutController. 1s is the smallest deadline we can verify.
      { prompt: 'q', workspace: root, iterationTimeoutMs: 1_000 },
      ctx,
    );
    const elapsedMs = Date.now() - startedAt;

    // Wiring contract: SDK saw OUR signal — same controller as the loop's
    // iterTimeout (proves config.abortSignal threading is real).
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect((observedSignal?.reason as { name?: string })?.name).toBe('TimeoutError');

    // Outcome contract: structured TIMEOUT surfaces to the caller.
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe('TIMEOUT');
    expect(result.structuredContent?.timeoutMs).toBe(1_000);
    expect(result.structuredContent?.iteration).toBe(1);

    // Sanity: actually waited for the timer to fire (≥ ~1 s) and didn't
    // run into pathological stall (< 5s gives generous CI headroom).
    // Tightening the upper bound risks flakes on slow shared runners.
    // Lower bound is 950ms (5 % slack) because Node's `setTimeout(fn, 1_000)`
    // is documented as "approximately 1000ms" and can fire 1-2 ms early —
    // observed in CI on Node 22 / Linux: 999ms elapsed (PR #35 round 1).
    expect(elapsedMs).toBeGreaterThanOrEqual(950);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
