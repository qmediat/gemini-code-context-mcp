/**
 * The ordered trace of one `ask_agentic` call — progress lines, logger lines, budget-ledger and TPM-throttle calls,
 * model calls — for the organic answer, the forced answer and each way a call ends without one, and the shape of the
 * answer it returns. The priced amounts are masked here; `agentic-accounting.test.ts` pins them.
 */

import { ApiError } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ScriptedTurn, runAgentic, traceLines } from '../helpers/agentic-run.js';

vi.mock('../../src/gemini/models.js', () => ({ resolveModel: vi.fn() }));
vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: vi.fn(),
  WorkspaceValidationError: class extends Error {},
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const ENFORCED = { dailyBudgetUsd: 10, tpmThrottleLimit: 1_000_000 } as const;
const READ_A: ScriptedTurn = { calls: [{ name: 'read_file', args: { path: 'a.ts' } }] };

const OPENING = ["emit resolving model 'latest-pro-thinking'…", 'emit starting agentic loop…'];
const RESERVE =
  'ledger reserveBudget [{"workspaceRoot":"<ws>","toolName":"ask_agentic","model":"gemini-3-pro-preview","estimatedCostMicros":"<usd>","dailyBudgetMicros":10000000,"nowMs":"<ms>"}]';
const tpmReserve = (tokens: number) => `throttle reserve ["gemini-3-pro-preview",${tokens}]`;
const booked = (id: number, tokens: number) =>
  `ledger finalizeBudgetReservation [${id},{"cachedTokens":0,"uncachedTokens":${tokens},"costUsdMicro":"<usd>","durationMs":"<ms>"}]`;
const released = (id: number, tokens: number) => `throttle release [${id},${tokens}]`;
const STREAM = 'model generateContentStream ["gemini-3-pro-preview"]';
const CALL = 'model generateContent ["gemini-3-pro-preview"]';
/** The first iteration of a one-iteration loop that read `a.ts`, booked and released at 1000 input tokens. */
const FIRST_READ = [
  RESERVE,
  tpmReserve(50_000),
  STREAM,
  booked(1, 1000),
  released(101, 1000),
  'emit iter 1/1: 1 tool calls, 1000 in-tokens so far',
];
/** The rescue's input estimate after `FIRST_READ`: its 1000 input tokens, the read's response and the 5000 margin. */
const RESCUE_ESTIMATE = 6049;
const RESCUE_OPENING = [
  'emit maxIterations (1) reached — running forced-finalization pass',
  RESERVE,
  'emit running forced-finalization pass (tools disabled)',
  tpmReserve(RESCUE_ESTIMATE),
];

describe('ask_agentic call trace — answers', () => {
  it('organic: each iteration reserves, calls the model, settles and reports, until the answer', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      script: [{ thoughts: ['looking around'], ...READ_A }, { text: 'the answer' }],
    });

    expect(result.isError).toBeFalsy();
    expect(traceLines(trace)).toEqual([
      ...OPENING,
      RESERVE,
      tpmReserve(50_000),
      STREAM,
      'emit thinking: looking around…',
      booked(1, 1000),
      released(101, 1000),
      'emit iter 1/20: 1 tool calls, 1000 in-tokens so far',
      RESERVE,
      tpmReserve(50_000),
      STREAM,
      booked(2, 1000),
      released(102, 1000),
      'emit iter 2/20: 0 tool calls, 2000 in-tokens so far',
    ]);
  });

  it('forced: the finalization pass waits out its TPM delay, calls the model without streaming and settles', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      input: { maxIterations: 1 },
      throttleAnswers: [
        { delayMs: 20, releaseId: 101 },
        { delayMs: 20, releaseId: 102 },
      ],
      script: [READ_A, { text: ' forced ', thoughts: ['why'] }],
    });

    expect(result.content[0]).toMatchObject({ text: 'forced' });
    expect(result.structuredContent).toMatchObject({
      convergenceForced: true,
      apiCalls: 2,
      thinkingSummary: 'why',
    });
    expect(traceLines(trace)).toEqual([
      ...OPENING,
      RESERVE,
      tpmReserve(50_000),
      'emit throttle: waiting 1s for TPM window…',
      STREAM,
      booked(1, 1000),
      released(101, 1000),
      'emit iter 1/1: 1 tool calls, 1000 in-tokens so far',
      ...RESCUE_OPENING,
      'emit finalization throttle: waiting 1s for TPM window…',
      CALL,
      booked(2, 1000),
      released(102, 1000),
    ]);
  });

  it('forced: skipped when the daily budget refuses the finalization pass', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      input: { maxIterations: 1 },
      budgetAnswers: [undefined, { rejected: true, spentMicros: 9_876_543 }],
      script: [READ_A],
    });

    expect(result.structuredContent).toMatchObject({
      finalizationSkipReason: 'daily-budget',
      apiCalls: 1,
    });
    const skipped = 'skipping forced-finalization pass — daily budget cap reached (spent $9.8765)';
    expect(traceLines(trace)).toEqual([
      ...OPENING,
      ...FIRST_READ,
      'emit maxIterations (1) reached — running forced-finalization pass',
      RESERVE,
      `emit ${skipped}`,
      `log warn ${JSON.stringify([`ask_agentic: ${skipped}`])}`,
    ]);
  });
});

/** A finalization response whose read fails after the call returned. */
function failingRead(err: Error): ScriptedTurn {
  return {
    raw: {
      usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 9, thoughtsTokenCount: 2 },
      get candidates(): never {
        throw err;
      },
    },
  };
}

const warned = (line: string) =>
  `log warn ${JSON.stringify([`ask_agentic finalization: ${line}`])}`;
const CANCELLED = ['ledger cancelBudgetReservation [2]', 'throttle cancel [102]'];

describe('ask_agentic call trace — a finalization pass that gives no answer', () => {
  const cases: ReadonlyArray<{ code: string; turn: ScriptedTurn; tail: readonly string[] }> = [
    {
      code: 'RATE_LIMIT',
      turn: { throws: new ApiError({ status: 429, message: 'quota "retryDelay": "13s"' }) },
      tail: [
        'throttle recordRetryHint ["gemini-3-pro-preview",13000]',
        warned('429 rate-limit (retryDelay=13000ms)'),
        ...CANCELLED,
      ],
    },
    {
      code: 'API_ERROR',
      turn: { throws: new ApiError({ status: 400, message: 'bad request' }) },
      tail: [warned('Gemini API returned 400: bad request'), ...CANCELLED],
    },
    {
      code: 'NETWORK',
      turn: { throws: new Error('socket closed') },
      tail: [warned('network failure: socket closed'), ...CANCELLED],
    },
    {
      code: 'INTERNAL',
      turn: failingRead(new Error('candidates unreadable')),
      tail: [
        warned('post-await processing failed: candidates unreadable'),
        booked(2, 4000),
        released(102, 4000),
      ],
    },
    {
      code: 'TIMEOUT',
      turn: failingRead(new DOMException('late', 'TimeoutError')),
      tail: [
        warned('timed out after maxIterations exhaustion'),
        booked(2, 4000),
        released(102, 4000),
      ],
    },
    {
      code: 'EMPTY_TEXT',
      turn: { text: '   ' },
      tail: [booked(2, 1000), released(102, 1000)],
    },
  ];

  it.each(cases)(
    '$code: classified, then booked or cancelled by whether the call returned',
    async ({ code, turn, tail }) => {
      const { result, trace } = await runAgentic({
        ...ENFORCED,
        input: { maxIterations: 1 },
        script: [READ_A, turn],
      });

      expect(result.structuredContent).toMatchObject({
        subReason: 'AGENTIC_MAX_ITERATIONS',
        rescueErrorCode: code,
        apiCalls: 2,
      });
      expect(result.structuredContent).not.toHaveProperty('convergenceForced');
      expect(traceLines(trace)).toEqual([
        ...OPENING,
        ...FIRST_READ,
        ...RESCUE_OPENING,
        CALL,
        ...tail,
      ]);
    },
  );

  it('names the finalization pass when its budget reservation cannot be cancelled', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      cancelBudgetThrows: new Error('ledger down'),
      input: { maxIterations: 1 },
      script: [READ_A, { throws: new Error('socket closed') }],
    });

    expect(traceLines(trace).slice(-3)).toEqual([
      'ledger cancelBudgetReservation [2]',
      'log error ["ask_agentic finalization: cancelBudgetReservation failed for id=2; reservation row keeps the estimate. Error: ledger down"]',
      'throttle cancel [102]',
    ]);
  });
});

describe('ask_agentic call trace — a loop that ends without an answer', () => {
  it('a failed iteration cancels both reservations, naming the call when the budget cancel fails', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      cancelBudgetThrows: new Error('ledger down'),
      script: [{ throws: new Error('plain') }],
    });

    expect(result.structuredContent).toMatchObject({ errorCode: 'UNKNOWN' });
    expect(traceLines(trace)).toEqual([
      ...OPENING,
      RESERVE,
      tpmReserve(50_000),
      STREAM,
      'ledger cancelBudgetReservation [1]',
      'log error ["ask_agentic: cancelBudgetReservation failed for id=1; reservation row keeps the estimate. Error: ledger down"]',
      'throttle cancel [101]',
      'log error ["ask_agentic failed: plain"]',
    ]);
  });

  it('an iteration 429 seeds the retry hint once, in the call own catch, after its log line', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      script: [{ throws: new ApiError({ status: 429, message: 'quota "retryDelay": "7s"' }) }],
    });

    expect(result.structuredContent).toMatchObject({ errorCode: 'UNKNOWN', httpStatus: 429 });
    expect(traceLines(trace)).toEqual([
      ...OPENING,
      RESERVE,
      tpmReserve(50_000),
      STREAM,
      'ledger cancelBudgetReservation [1]',
      'throttle cancel [101]',
      'log error ["ask_agentic failed: quota \\"retryDelay\\": \\"7s\\""]',
      'throttle recordRetryHint ["gemini-3-pro-preview",7000]',
    ]);
  });

  it('a timeout in the TPM wait cancels both reservations before any model call', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      input: { iterationTimeoutMs: 1_000 },
      throttleAnswers: [{ delayMs: 60_000, releaseId: 9 }],
      script: [],
    });

    expect(result.structuredContent).toMatchObject({
      errorCode: 'TIMEOUT',
      timeoutKind: 'total',
      apiCalls: 0,
    });
    expect(traceLines(trace)).toEqual([
      ...OPENING,
      RESERVE,
      tpmReserve(50_000),
      'emit throttle: waiting 60s for TPM window…',
      'ledger cancelBudgetReservation [1]',
      'throttle cancel [9]',
      'emit ask_agentic: iteration 1 aborted after 1000ms (total)',
    ]);
  });

  it('the input-token budget ends the loop after the iteration that passed it was settled', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      input: { maxTotalInputTokens: 10_000 },
      script: [
        {
          calls: [{ name: 'list_directory', args: { path: '.' } }],
          usage: { promptTokenCount: 20_000 },
        },
      ],
    });

    expect(result.structuredContent).toMatchObject({
      subReason: 'AGENTIC_INPUT_BUDGET_EXCEEDED',
      apiCalls: 1,
    });
    expect(traceLines(trace)).toEqual([
      ...OPENING,
      RESERVE,
      tpmReserve(50_000),
      STREAM,
      booked(1, 20_000),
      released(101, 20_000),
      'emit iter 1/20: 1 tool calls, 20000 in-tokens so far',
    ]);
  });

  it('the daily budget refusing the first iteration ends the call before any model call', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      budgetAnswers: [{ rejected: true, spentMicros: 9_990_000 }],
      script: [],
    });

    expect(traceLines(trace)).toEqual([...OPENING, RESERVE]);
  });
});

describe('ask_agentic call trace — the answer it returns', () => {
  it('an organic answer carries no convergenceForced field', async () => {
    const { result } = await runAgentic({ script: [{ text: 'done' }] });

    expect(result.structuredContent).not.toHaveProperty('convergenceForced');
  });

  it('lists at most 40 of the files read, and counts them all', async () => {
    const names = Array.from({ length: 41 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    const { result } = await runAgentic({
      files: Object.fromEntries(names.map((name) => [name, 'export {};\n'])),
      input: { maxFilesRead: 100 },
      script: [
        { calls: names.map((path) => ({ name: 'read_file', args: { path } })) },
        { text: 'done' },
      ],
    });

    expect(result.structuredContent?.filesRead).toBe(41);
    expect(result.structuredContent?.filesReadList).toEqual(names.slice(0, 40));
  });

  it('cuts the thinking summary to 1200 characters', async () => {
    const { result } = await runAgentic({
      script: [{ thoughts: ['t'.repeat(2_000)], text: 'done' }],
    });

    expect(result.structuredContent?.thinkingSummary).toBe('t'.repeat(1_200));
  });

  it('stops the progress keepalive when the call ends', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');

    await runAgentic({ script: [{ text: 'done' }] });

    const keepalives = intervals.mock.calls
      .map((call, i) => ({ delay: call[1], handle: intervals.mock.results[i]?.value }))
      .filter((started) => started.delay === 25_000);
    expect(keepalives).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(keepalives[0]?.handle);
  });
});
