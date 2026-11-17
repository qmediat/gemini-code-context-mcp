/**
 * The time bounds of an `ask_agentic` call (`docs/DESIGN-agentic-time-bounds.md`): each phase of a pass ends at the
 * bound its target table names — the knob that bounds it, else its default — with the phase, the source and the
 * booking the table gives. The defaults are replaced with bounds of tens of ms; a hang is a promise that never
 * settles; the knobs keep their 1 s minimum. Every test has a hard timeout: none can hang the suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolWatch } from '../../src/tools/agentic/workspace-tools.js';
import {
  ASK_KNOB_NAMES,
  ASK_STALL_ENV,
  ASK_TIMEOUT_ENV,
  fallBackToAgentic,
} from '../../src/tools/ask-agentic-fallback.js';
import { type AskAgenticInput, runAskAgentic } from '../../src/tools/ask-agentic.tool.js';
import type { AskInput } from '../../src/tools/ask.tool.js';
import type { TextToolResult, ToolContext } from '../../src/tools/registry.js';
import { createTimeoutController } from '../../src/tools/shared/abort-timeout.js';
import { type AgenticRunOptions, callsTo, runAgentic } from '../helpers/agentic-run.js';

const bounds = vi.hoisted(() => ({
  openingMs: 60,
  streamGapMs: 60,
  toolsIdleMs: 60,
  finalizationMs: 60,
  toolSettleGraceMs: 30,
}));

/** How each executor behaves: `run` for real, `hang` (never settles, ignores the signal), `honour` (settles when the
 * signal fires), `slow` (runs for real after `slowMs`, ignoring the signal and reporting nothing), `progressing` (runs
 * for real after `slowMs` of progress reported every few ms), `stalls` (reports progress for `slowMs`, then nothing,
 * settling when the signal fires); the names of the calls started, in order. */
const tools = vi.hoisted(() => ({
  mode: 'run' as 'run' | 'hang' | 'honour' | 'slow' | 'progressing' | 'stalls',
  slowMs: 0,
  started: [] as string[],
  /** A path whose sandbox resolution never returns. */
  hangPath: null as string | null,
  /** With `hang`: the one argument whose call hangs; `null` hangs every call. */
  hangArg: null as string | null,
}));

vi.mock('../../src/tools/agentic/phase-defaults.js', () => ({ PHASE_DEFAULTS: bounds }));
vi.mock('../../src/gemini/models.js', () => ({ resolveModel: vi.fn() }));
vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: vi.fn(),
  WorkspaceValidationError: class extends Error {},
}));
vi.mock('../../src/tools/agentic/sandbox.js', async () => {
  type Sandbox = typeof import('../../src/tools/agentic/sandbox.js');
  const actual = await vi.importActual<Sandbox>('../../src/tools/agentic/sandbox.js');
  const resolveInsideWorkspace: Sandbox['resolveInsideWorkspace'] = (root, path) =>
    path === tools.hangPath
      ? new Promise(() => undefined)
      : actual.resolveInsideWorkspace(root, path);
  return { ...actual, resolveInsideWorkspace };
});
vi.mock('../../src/tools/agentic/workspace-tools.js', async () => {
  type Tools = typeof import('../../src/tools/agentic/workspace-tools.js');
  const actual = await vi.importActual<Tools>('../../src/tools/agentic/workspace-tools.js');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const never = () => new Promise<never>(() => undefined);
  const untilAborted = (watch: ToolWatch | undefined) =>
    new Promise<never>((_, reject) => {
      watch?.signal?.addEventListener('abort', () => reject(watch.signal?.reason));
    });
  /** Progress reported every 15 ms for `ms`. */
  const progressFor = async (ms: number, watch: ToolWatch | undefined) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 15) {
      await sleep(15);
      watch?.onProgress?.();
    }
  };
  /** What each mode does before the executor runs for real; a mode whose step never returns never runs it. */
  const before: Record<
    typeof tools.mode,
    (watch: ToolWatch | undefined, args: unknown[]) => Promise<void>
  > = {
    run: async () => undefined,
    hang: (_, args) =>
      tools.hangArg === null || args.includes(tools.hangArg) ? never() : Promise.resolve(),
    honour: (watch) => untilAborted(watch),
    slow: () => sleep(tools.slowMs),
    progressing: (watch) => progressFor(tools.slowMs, watch),
    stalls: async (watch) => {
      await progressFor(tools.slowMs, watch);
      await untilAborted(watch);
    },
  };
  const isWatch = (arg: unknown): arg is ToolWatch =>
    typeof arg === 'object' && arg !== null && 'onProgress' in arg;
  const gated =
    <A extends unknown[], R>(name: string, executor: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      tools.started.push(name);
      await before[tools.mode](args.find(isWatch), args);
      return executor(...args);
    };
  return {
    ...actual,
    listDirectoryExecutor: gated('list_directory', actual.listDirectoryExecutor),
    findFilesExecutor: gated('find_files', actual.findFilesExecutor),
    readFileExecutor: gated('read_file', actual.readFileExecutor),
    grepExecutor: gated('grep', actual.grepExecutor),
  };
});

afterEach(() => {
  Object.assign(bounds, {
    openingMs: 60,
    streamGapMs: 60,
    toolsIdleMs: 60,
    finalizationMs: 60,
    toolSettleGraceMs: 30,
  });
  Object.assign(tools, { mode: 'run', slowMs: 0, started: [], hangPath: null, hangArg: null });
});

const ENFORCED = { dailyBudgetUsd: 10, tpmThrottleLimit: 1_000_000 } as const;
const GREP = { calls: [{ name: 'grep', args: { pattern: 'needle' } }] };
const THREE_GREPS = {
  calls: ['a', 'b', 'c'].map((pattern) => ({ name: 'grep', args: { pattern } })),
};
const HARD_TIMEOUT_MS = 8_000;

/** A transient network failure: `withNetworkRetry` sends the request again after its backoff (1 s first). */
const FETCH_FAILED = { throws: new TypeError('fetch failed') };

/**
 * The call made as `ask`'s fallback, through the real hand-off: `ask`'s controller built from its knobs and its env
 * vars, as `ask` builds it, and the agentic call's input mapped from them.
 */
function viaAsk(knobs: { timeoutMs?: number; stallMs?: number } = {}) {
  return (input: AskAgenticInput, ctx: ToolContext): Promise<TextToolResult> =>
    fallBackToAgentic({
      input: { prompt: input.prompt, workspace: input.workspace, ...knobs } as AskInput,
      ctx,
      emitter: { emit: () => undefined, stop: () => undefined },
      serviceTier: undefined,
      preflight: { effectiveTokens: 2, method: 'heuristic', rawTokens: 1, cacheHit: false },
      threshold: 1,
      timeout: createTimeoutController({
        totalMs: knobs.timeoutMs,
        totalEnvVar: ASK_TIMEOUT_ENV,
        stallMs: knobs.stallMs,
        stallEnvVar: ASK_STALL_ENV,
      }),
    });
}

/** The prose of a result: the agentic call's message, `ask`'s fallback's included. */
const messageOf = (result: TextToolResult): string =>
  String(result.structuredContent?.responseText);

/** The booking calls of a run: finalised and cancelled budget reservations, released and cancelled TPM ones. */
function bookings(trace: Awaited<ReturnType<typeof runAgentic>>['trace']) {
  return {
    finalized: callsTo(trace, 'ledger', 'finalizeBudgetReservation').length,
    cancelled: callsTo(trace, 'ledger', 'cancelBudgetReservation').length,
    released: callsTo(trace, 'throttle', 'release').length,
    throttleCancelled: callsTo(trace, 'throttle', 'cancel').length,
  };
}

/** A pass booked at what it billed (the default usage: 1000 in, 100 out, 7 thinking) and closed once. */
const BOOKED_ONCE = { finalized: 1, cancelled: 0, released: 1, throttleCancelled: 0 };
/** A pass booked 0: both reservations released, once. */
const RELEASED_ONCE = { finalized: 0, cancelled: 1, released: 0, throttleCancelled: 1 };

async function timedOutRun(opts: AgenticRunOptions) {
  const run = await runAgentic({ ...ENFORCED, ...opts });
  expect(run.result.structuredContent?.errorCode).toBe('TIMEOUT');
  return run;
}

describe('ask_agentic bounds — the tools phase', () => {
  it(
    'a tool batch longer than stallMs answers: the stall watchdog ends with the stream',
    async () => {
      Object.assign(tools, { mode: 'slow', slowMs: 1_300 });
      bounds.toolsIdleMs = 5_000;
      const { result } = await runAgentic({
        ...ENFORCED,
        input: { stallMs: 1_000 },
        script: [GREP, { text: 'done' }],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content?.[0]).toEqual({ type: 'text', text: 'done' });
      expect(tools.started).toEqual(['grep']);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a batch of executors that keep reporting progress answers, however long past the tools default it runs',
    async () => {
      Object.assign(tools, { mode: 'progressing', slowMs: 300 });
      const { result } = await runAgentic({
        ...ENFORCED,
        script: [THREE_GREPS, { text: 'done' }],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content?.[0]).toEqual({ type: 'text', text: 'done' });
      expect(tools.started).toEqual(['grep', 'grep', 'grep']);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a batch that stops reporting progress ends at the tools default, the pass booked once',
    async () => {
      Object.assign(tools, { mode: 'stalls', slowMs: 150 });
      const { result, trace } = await timedOutRun({ script: [GREP] });

      expect(result.structuredContent).toMatchObject({
        timeoutKind: 'total',
        timeoutPhase: 'tools',
        timeoutSource: 'default',
        retryable: true,
      });
      expect(messageOf(result)).toContain(
        "The iteration's tool calls made no progress for the 60 ms default.",
      );
      expect(bookings(trace)).toEqual(BOOKED_ONCE);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a tools timeout whose booking throws closes the pass once',
    async () => {
      tools.mode = 'hang';
      const { result, trace } = await runAgentic({
        ...ENFORCED,
        script: [GREP],
        run: (input, ctx) => {
          const release = ctx.throttle.release.bind(ctx.throttle);
          ctx.throttle.release = ((...args: Parameters<typeof release>) => {
            release(...args);
            throw new Error('throttle release failed');
          }) as typeof ctx.throttle.release;
          return runAskAgentic(input, ctx, ASK_KNOB_NAMES);
        },
      });

      expect(result.isError).toBe(true);
      expect(bookings(trace)).toEqual(BOOKED_ONCE);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a batch that never returns ends at iterationTimeoutMs, phase tools, the pass booked once with its fields',
    async () => {
      tools.mode = 'hang';
      const { result, trace } = await timedOutRun({
        input: { iterationTimeoutMs: 1_000 },
        script: [GREP],
      });

      expect(result.structuredContent).toMatchObject({
        timeoutKind: 'total',
        timeoutPhase: 'tools',
        timeoutSource: 'iterationTimeoutMs',
        timeoutMs: 1_000,
        apiCalls: 1,
        uncachedTokens: 1000,
        outputTokens: 100,
        thinkingTokens: 7,
      });
      expect(bookings(trace)).toEqual(BOOKED_ONCE);
    },
    HARD_TIMEOUT_MS,
  );

  it.each([
    ['only stallMs', { stallMs: 1_000 }],
    ['no knob', {}],
  ])(
    'a batch that never returns ends at the default tools bound with %s, the pass booked once',
    async (_label, input) => {
      tools.mode = 'hang';
      const { result, trace } = await timedOutRun({ input, script: [GREP] });

      expect(result.structuredContent).toMatchObject({
        timeoutKind: 'total',
        timeoutPhase: 'tools',
        timeoutSource: 'default',
        uncachedTokens: 1000,
      });
      expect(messageOf(result)).toContain('made no progress for the 60 ms default');
      expect(bookings(trace)).toEqual(BOOKED_ONCE);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a path resolution that hangs at the maxFilesRead cap ends at the tools bound, the pass closed once',
    async () => {
      tools.hangPath = 'b.ts';
      const { result, trace } = await timedOutRun({
        input: { maxFilesRead: 1 },
        script: [
          { calls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
          { calls: [{ name: 'read_file', args: { path: 'b.ts' } }] },
        ],
      });

      expect(result.structuredContent).toMatchObject({
        timeoutPhase: 'tools',
        timeoutSource: 'default',
        iteration: 2,
        apiCalls: 2,
      });
      // the path resolution in flight is the work still running, counted once; no executor started for b.ts
      expect(result.structuredContent?.toolCallsRunning).toBe(1);
      expect(callsTo(trace, 'log', 'warn').map(([line]) => line)).toContain(
        "ask_agentic: 1 tool call(s) still running 30 ms after the iteration's bound (0 never started); their results will be dropped",
      );
      expect(tools.started).toEqual(['read_file']);
      expect(bookings(trace)).toEqual({ ...BOOKED_ONCE, finalized: 2, released: 2 });
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'no queued tool call starts once the bound fired (one call at a time, three calls)',
    async () => {
      tools.mode = 'honour';
      const { result } = await timedOutRun({
        env: { GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY: '1' },
        script: [THREE_GREPS],
      });

      expect(result.structuredContent?.timeoutPhase).toBe('tools');
      expect(tools.started).toEqual(['grep']);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a tools timeout is retryable when every started executor honoured the signal',
    async () => {
      tools.mode = 'honour';
      const { result } = await timedOutRun({ script: [GREP] });

      expect(result.structuredContent).toMatchObject({ timeoutPhase: 'tools', retryable: true });
      expect(result.structuredContent).not.toHaveProperty('toolCallsRunning');
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a tools timeout is not retryable while an executor that ignores the signal still runs, and says how many',
    async () => {
      tools.mode = 'hang';
      const { result, trace } = await timedOutRun({
        env: { GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY: '1' },
        script: [THREE_GREPS],
      });

      expect(result.structuredContent).toMatchObject({
        timeoutPhase: 'tools',
        retryable: false,
        toolCallsRunning: 1,
      });
      const warnings = callsTo(trace, 'log', 'warn').map(([line]) => String(line));
      expect(warnings).toContain(
        "ask_agentic: 1 tool call(s) still running 30 ms after the iteration's bound (2 never started); their results will be dropped",
      );
    },
    HARD_TIMEOUT_MS,
  );
});

describe('ask_agentic bounds — the work still running', () => {
  it(
    'counts only the executors still running: one settled, one hung',
    async () => {
      Object.assign(tools, { mode: 'hang', hangArg: 'b' });
      const { result } = await timedOutRun({
        script: [{ calls: ['a', 'b'].map((pattern) => ({ name: 'grep', args: { pattern } })) }],
      });

      expect(tools.started).toEqual(['grep', 'grep']);
      expect(result.structuredContent).toMatchObject({ retryable: false, toolCallsRunning: 1 });
    },
    HARD_TIMEOUT_MS,
  );
});

describe('ask_agentic bounds — the request and its stream', () => {
  it(
    'a request that never opens ends at the default opening bound with only stallMs, booked 0',
    async () => {
      const { result, trace } = await timedOutRun({
        input: { stallMs: 1_000 },
        script: [{ hang: true }],
      });

      expect(result.structuredContent).toMatchObject({
        timeoutKind: 'total',
        timeoutPhase: 'opening',
        timeoutSource: 'default',
        stallMs: 1_000,
        timeoutMs: null,
        apiCalls: 1,
        retryable: true,
      });
      expect(result.structuredContent).not.toHaveProperty('uncachedTokens');
      expect(messageOf(result)).toContain(
        "No chunk arrived within the 60 ms default for a request's opening. Set `iterationTimeoutMs` per call or `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS`",
      );
      expect(bookings(trace)).toEqual(RELEASED_ONCE);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    "each request of an iteration gets the whole opening default: a retried request's clock starts at its sending",
    async () => {
      bounds.openingMs = 1_200;
      // the first request fails at once, the second is sent after the 1 s backoff and answers 500 ms later
      const { result } = await runAgentic({
        ...ENFORCED,
        script: [FETCH_FAILED, { abortableDelayMs: 500, text: 'done' }],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content?.[0]).toEqual({ type: 'text', text: 'done' });
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a TimeoutError the clock did not raise is reported as external: no bound of the call named, its message quoted',
    async () => {
      const { result } = await timedOutRun({
        script: [{ throws: new DOMException('sdk timeout', 'TimeoutError') }],
      });

      expect(result.structuredContent).toMatchObject({
        timeoutKind: 'total',
        timeoutPhase: 'opening',
        timeoutSource: 'external',
      });
      const message = messageOf(result);
      expect(message).toContain(
        'iteration 1 timed out (total). No bound of this call fired: the request ended with a timeout of its own ("sdk timeout").',
      );
      expect(message).not.toMatch(/\?ms|null|default/);
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a stream silent after its first chunk with no knob ends as a stall at the default gap bound, booked 0',
    async () => {
      const { result, trace } = await timedOutRun({ script: [{ ...GREP, hangsMidStream: true }] });

      expect(result.structuredContent).toMatchObject({
        timeoutKind: 'stall',
        timeoutPhase: 'stream',
        timeoutSource: 'default',
        stallMs: null,
      });
      expect(String(result.structuredContent?.responseText)).toContain(
        'The stream sent nothing for the 60 ms default',
      );
      expect(tools.started).toEqual([]);
      expect(bookings(trace)).toEqual(RELEASED_ONCE);
    },
    HARD_TIMEOUT_MS,
  );
});

describe('ask_agentic bounds — the forced-finalization pass', () => {
  it(
    'ends at the default finalization bound with only stallMs: AGENTIC_MAX_ITERATIONS, rescueErrorCode TIMEOUT',
    async () => {
      const { result, trace } = await runAgentic({
        ...ENFORCED,
        input: { maxIterations: 1, stallMs: 1_000 },
        script: [GREP, { hang: true }],
      });

      expect(result.structuredContent).toMatchObject({
        errorCode: 'UNKNOWN',
        subReason: 'AGENTIC_MAX_ITERATIONS',
        rescueErrorCode: 'TIMEOUT',
        rescueErrorMessage: 'Timed out after 60 ms (total wall-clock)',
        timeoutPhase: 'finalization',
        timeoutSource: 'default',
        retryable: false,
        apiCalls: 2,
      });
      expect(messageOf(result)).toContain(
        'the forced-finalization pass timed out (total) after 60ms. A request of the forced-finalization pass ran past the 60 ms default. Set `iterationTimeoutMs` per call or `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS`',
      );
      // the loop's pass booked, the forced pass's released
      expect(bookings(trace)).toEqual({
        finalized: 1,
        cancelled: 1,
        released: 1,
        throttleCancelled: 1,
      });
    },
    HARD_TIMEOUT_MS,
  );
});

describe('ask_agentic bounds — the forced pass, per request and at its knob', () => {
  it(
    'each request of the forced pass gets the whole finalization default',
    async () => {
      bounds.finalizationMs = 1_200;
      const { result } = await runAgentic({
        ...ENFORCED,
        input: { maxIterations: 1 },
        script: [GREP, FETCH_FAILED, { abortableDelayMs: 500, text: 'forced' }],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content?.[0]).toEqual({ type: 'text', text: 'forced' });
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'a forced pass ended by iterationTimeoutMs in its TPM wait names the phase, the knob and its hint',
    async () => {
      const { result } = await runAgentic({
        ...ENFORCED,
        input: { maxIterations: 1, iterationTimeoutMs: 1_000 },
        throttleAnswers: [undefined, { delayMs: 60_000, releaseId: 102 }],
        script: [GREP],
      });

      expect(result.structuredContent).toMatchObject({
        subReason: 'AGENTIC_MAX_ITERATIONS',
        rescueErrorCode: 'TIMEOUT',
        timeoutPhase: 'tpm-wait',
        timeoutSource: 'iterationTimeoutMs',
        apiCalls: 1,
      });
      expect(messageOf(result)).toContain(
        'Increase `iterationTimeoutMs` per call or set `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS` higher.',
      );
    },
    HARD_TIMEOUT_MS,
  );
});

describe('ask_agentic bounds — the knobs a message names', () => {
  it(
    "names ask's knobs when the call is ask's fallback, never iterationTimeoutMs",
    async () => {
      tools.mode = 'hang';
      const { result } = await runAgentic({
        ...ENFORCED,
        script: [GREP],
        run: (input, ctx) => runAskAgentic(input, ctx, ASK_KNOB_NAMES),
      });

      const message = String(result.structuredContent?.responseText);
      expect(message).toContain('Set `timeoutMs` per call or `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`');
      expect(message).not.toContain('iterationTimeoutMs');
    },
    HARD_TIMEOUT_MS,
  );
});

describe("ask_agentic bounds — ask's fallback, through the real hand-off", () => {
  it.each([
    [
      'a tool batch',
      () => Object.assign(tools, { mode: 'slow', slowMs: 1_300 }),
      [GREP, { text: 'done' }],
    ],
    [
      'a request',
      () => Object.assign(bounds, { openingMs: 5_000 }),
      [{ delayMs: 1_300, text: 'done' }],
    ],
  ])(
    "%s longer than ask's stallMs answers: stallMs is no wall clock",
    async (_label, setUp, turns) => {
      setUp();
      bounds.toolsIdleMs = 5_000;
      const { result } = await runAgentic({
        ...ENFORCED,
        script: turns,
        run: viaAsk({ stallMs: 1_000 }),
      });

      expect(result.isError).toBeFalsy();
      expect(messageOf(result)).toBe('done');
    },
    HARD_TIMEOUT_MS,
  );

  it(
    "a request that never opens ends at the default opening bound with only ask's stallMs, naming ask's knobs",
    async () => {
      const { result } = await runAgentic({
        ...ENFORCED,
        script: [{ hang: true }],
        run: viaAsk({ stallMs: 1_000 }),
      });

      expect(result.structuredContent).toMatchObject({
        errorCode: 'TIMEOUT',
        timeoutKind: 'total',
        timeoutPhase: 'opening',
        timeoutSource: 'default',
        stallMs: 1_000,
      });
      expect(messageOf(result)).toContain(
        "No chunk arrived within the 60 ms default for a request's opening. Set `timeoutMs` per call or `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`",
      );
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'names the agentic env var that set the iteration bound where ask set no timeoutMs',
    async () => {
      tools.mode = 'hang';
      const { result } = await runAgentic({
        ...ENFORCED,
        env: { GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS: '1000' },
        script: [GREP],
        run: viaAsk(),
      });

      expect(result.structuredContent).toMatchObject({ timeoutSource: 'iterationTimeoutMs' });
      const message = messageOf(result);
      expect(message).toContain(
        'Increase `timeoutMs` per call or set `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS` higher.',
      );
      expect(message).not.toContain('GEMINI_CODE_CONTEXT_ASK_');
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'names the agentic env var that set the stall bound where ask set no stallMs',
    async () => {
      const { result } = await runAgentic({
        ...ENFORCED,
        env: { GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS: '1000' },
        script: [{ ...GREP, hangsMidStream: true }],
        run: viaAsk(),
      });

      expect(result.structuredContent).toMatchObject({
        timeoutKind: 'stall',
        timeoutSource: 'stallMs',
      });
      const message = messageOf(result);
      expect(message).toContain(
        'Increase `stallMs` per call or set `GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS` higher.',
      );
      expect(message).not.toContain('GEMINI_CODE_CONTEXT_ASK_');
    },
    HARD_TIMEOUT_MS,
  );

  it(
    'lifts an external timeout as it lifts the others',
    async () => {
      const { result } = await runAgentic({
        ...ENFORCED,
        script: [{ throws: new DOMException('sdk timeout', 'TimeoutError') }],
        run: viaAsk(),
      });

      expect(result.structuredContent).toMatchObject({
        errorCode: 'TIMEOUT',
        timeoutPhase: 'opening',
        timeoutSource: 'external',
      });
    },
    HARD_TIMEOUT_MS,
  );
});
