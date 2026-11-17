/**
 * The time bounds of an `ask_agentic` call (`docs/DESIGN-agentic-time-bounds.md`): each phase of a pass ends at the
 * bound its target table names — the knob that bounds it, else its default — with the phase, the source and the
 * booking the table gives. The defaults are replaced with bounds of tens of ms; a hang is a promise that never
 * settles; the knobs keep their 1 s minimum. Every test has a hard timeout: none can hang the suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_KNOB_NAMES } from '../../src/tools/ask-agentic-fallback.js';
import { runAskAgentic } from '../../src/tools/ask-agentic.tool.js';
import { type AgenticRunOptions, callsTo, runAgentic } from '../helpers/agentic-run.js';

const bounds = vi.hoisted(() => ({
  openingMs: 60,
  streamGapMs: 60,
  toolsMs: 60,
  finalizationMs: 60,
  toolSettleGraceMs: 30,
}));

/** How each executor behaves: `run` for real, `hang` (never settles, ignores the signal), `honour` (settles when the
 * signal fires), `slow` (runs for real after `slowMs`, ignoring the signal); the names of the calls started, in order. */
const tools = vi.hoisted(() => ({
  mode: 'run' as 'run' | 'hang' | 'honour' | 'slow',
  slowMs: 0,
  started: [] as string[],
  /** A path whose sandbox resolution never returns. */
  hangPath: null as string | null,
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
  const gated =
    <A extends unknown[], R>(name: string, executor: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      tools.started.push(name);
      const signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
      if (tools.mode === 'hang') return new Promise<R>(() => undefined);
      if (tools.mode === 'honour') {
        return new Promise<R>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        });
      }
      if (tools.mode === 'slow') await new Promise((r) => setTimeout(r, tools.slowMs));
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
    toolsMs: 60,
    finalizationMs: 60,
    toolSettleGraceMs: 30,
  });
  Object.assign(tools, { mode: 'run', slowMs: 0, started: [], hangPath: null });
});

const ENFORCED = { dailyBudgetUsd: 10, tpmThrottleLimit: 1_000_000 } as const;
const GREP = { calls: [{ name: 'grep', args: { pattern: 'needle' } }] };
const HARD_TIMEOUT_MS = 8_000;

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
      bounds.toolsMs = 5_000;
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
      expect(String(result.structuredContent?.responseText)).toContain(
        'ran past the 60 ms default for its tools',
      );
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
      // the path resolution in flight is the work still running; no executor started for b.ts
      expect(result.structuredContent?.toolCallsRunning).toBe(1);
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
        script: [
          {
            calls: [
              { name: 'grep', args: { pattern: 'a' } },
              { name: 'grep', args: { pattern: 'b' } },
              { name: 'grep', args: { pattern: 'c' } },
            ],
          },
        ],
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
      const { result, trace } = await timedOutRun({ script: [GREP] });

      expect(result.structuredContent).toMatchObject({
        timeoutPhase: 'tools',
        retryable: false,
        toolCallsRunning: 1,
      });
      const warnings = callsTo(trace, 'log', 'warn').map(([line]) => String(line));
      expect(warnings).toContain(
        "ask_agentic: 1 tool call(s) still running 30 ms after the iteration's bound; their results will be dropped",
      );
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
      expect(bookings(trace)).toEqual(RELEASED_ONCE);
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
        retryable: false,
        apiCalls: 2,
      });
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
