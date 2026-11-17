/**
 * What `ask_agentic` books: each pass's daily-budget reservation and its settlement (the tokens and cost booked, or
 * the reservation cancelled), the usage row each billed pass writes when no daily budget is set, each pass's TPM
 * reservation and the input it is released at, and `apiCalls` — the authoritative count of `generateContent` calls —
 * on the exits that end a pass before or after its dispatch.
 */

import { ApiError } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateCostUsd,
  estimateReservationUsd,
  toMicrosUsd,
} from '../../src/utils/cost-estimator.js';
import { callsTo, runAgentic } from '../helpers/agentic-run.js';

/** How long the `grep` tool takes before it runs: a tool batch that outlasts the iteration's timeout. */
const tools = vi.hoisted(() => ({ grepDelayMs: 0 }));

vi.mock('../../src/gemini/models.js', () => ({ resolveModel: vi.fn() }));
vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: vi.fn(),
  WorkspaceValidationError: class extends Error {},
}));
vi.mock('../../src/tools/agentic/workspace-tools.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/tools/agentic/workspace-tools.js')>(
    '../../src/tools/agentic/workspace-tools.js',
  );
  const delayedGrep: typeof actual.grepExecutor = async (...args) => {
    if (tools.grepDelayMs > 0) await new Promise((r) => setTimeout(r, tools.grepDelayMs));
    return actual.grepExecutor(...args);
  };
  return { ...actual, grepExecutor: delayedGrep };
});

afterEach(() => {
  tools.grepDelayMs = 0;
});

const MODEL = 'gemini-3-pro-preview';
/** Daily budget and TPM limit that enforce both reservations without refusing one. */
const ENFORCED = { dailyBudgetUsd: 10, tpmThrottleLimit: 1_000_000 } as const;
const COVER_MS = 60_000;
const READ_A = { calls: [{ name: 'read_file', args: { path: 'a.ts' } }] };

/** The cost booked for a pass with these token counts. */
function bookedMicros(uncached: number, output: number, thinking: number): number {
  return toMicrosUsd(
    estimateCostUsd({
      model: MODEL,
      uncachedInputTokens: uncached,
      cachedInputTokens: 0,
      outputTokens: output,
      thinkingTokens: thinking,
    }),
  );
}

describe('ask_agentic accounting — a loop iteration', () => {
  it('reserves the per-iteration estimate against the daily budget', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      input: { iterationTimeoutMs: COVER_MS },
      script: [{ text: 'done' }],
    });

    const estimate = estimateReservationUsd(
      {
        model: MODEL,
        uncachedInputTokens: 50_000,
        cachedInputTokens: 0,
        outputTokens: 4096,
        thinkingTokens: 4096,
      },
      COVER_MS,
    );
    expect(toMicrosUsd(estimate)).toBeGreaterThan(0);
    expect(callsTo(trace, 'ledger', 'reserveBudget')).toEqual([
      [
        expect.objectContaining({
          toolName: 'ask_agentic',
          model: MODEL,
          estimatedCostMicros: toMicrosUsd(estimate),
          dailyBudgetMicros: toMicrosUsd(10),
        }),
      ],
    ]);
  });

  it('books the tokens, cost and wall time its usage reports', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      script: [
        {
          text: 'done',
          delayMs: 25,
          usage: { promptTokenCount: 3000, candidatesTokenCount: 200, thoughtsTokenCount: 50 },
        },
      ],
    });

    const finalized = callsTo(trace, 'ledger', 'finalizeBudgetReservation');
    expect(finalized).toEqual([
      [
        1,
        {
          cachedTokens: 0,
          uncachedTokens: 3000,
          costUsdMicro: bookedMicros(3000, 200, 50),
          durationMs: expect.any(Number),
        },
      ],
    ]);
    expect((finalized[0]?.[1] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(20);
  });

  it('takes its TPM reservation for the per-iteration estimate and releases it at the input it sent', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      script: [
        {
          text: 'done',
          usage: { promptTokenCount: 3000, candidatesTokenCount: 1, thoughtsTokenCount: 0 },
        },
      ],
    });

    expect(callsTo(trace, 'throttle', 'reserve')).toEqual([[MODEL, 50_000]]);
    expect(callsTo(trace, 'throttle', 'release')).toEqual([[101, 3000]]);
  });

  it('is booked and released at the per-iteration estimate when its response reported no usage', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      script: [{ text: 'done', usage: null }],
    });

    expect(bookedMicros(50_000, 0, 0)).toBeGreaterThan(0);
    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')).toEqual([
      [
        1,
        {
          cachedTokens: 0,
          uncachedTokens: 50_000,
          costUsdMicro: bookedMicros(50_000, 0, 0),
          durationMs: expect.any(Number),
        },
      ],
    ]);
    expect(callsTo(trace, 'throttle', 'release')).toEqual([[101, 50_000]]);
  });

  it('writes no usage row of its own under a daily budget: the reservation is the row', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      script: [READ_A, { text: 'done' }],
    });

    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')).toHaveLength(2);
    expect(callsTo(trace, 'ledger', 'insertUsageMetric')).toEqual([]);
  });
});

/** The usage row a pass without a daily budget writes. */
function usageRow(uncached: number, output: number, thinking: number): unknown[] {
  return [
    {
      workspaceRoot: expect.any(String),
      toolName: 'ask_agentic',
      model: MODEL,
      occurredAt: expect.any(Number),
      cachedTokens: 0,
      uncachedTokens: uncached,
      costUsdMicro: bookedMicros(uncached, output, thinking),
      durationMs: expect.any(Number),
    },
  ];
}

describe('ask_agentic accounting — without a daily budget', () => {
  it('writes one usage row per loop iteration, at the tokens it reported', async () => {
    const { trace } = await runAgentic({
      script: [
        {
          ...READ_A,
          usage: { promptTokenCount: 3000, candidatesTokenCount: 5, thoughtsTokenCount: 6 },
        },
        {
          text: 'done',
          usage: { promptTokenCount: 4000, candidatesTokenCount: 9, thoughtsTokenCount: 2 },
        },
      ],
    });

    expect(callsTo(trace, 'ledger', 'reserveBudget')).toEqual([]);
    expect(callsTo(trace, 'ledger', 'insertUsageMetric')).toEqual([
      usageRow(3000, 5, 6),
      usageRow(4000, 9, 2),
    ]);
  });

  it('writes a usage row for the forced-finalization pass, at its estimate when it reported no usage', async () => {
    const { result, trace } = await runAgentic({
      tpmThrottleLimit: 1_000_000,
      input: { maxIterations: 1 },
      script: [
        {
          ...READ_A,
          usage: { promptTokenCount: 3000, candidatesTokenCount: 5, thoughtsTokenCount: 6 },
        },
        { text: 'forced', usage: null },
      ],
    });

    expect(result.structuredContent?.convergenceForced).toBe(true);
    const rescueEstimate = callsTo(trace, 'throttle', 'reserve')[1]?.[1];
    expect(rescueEstimate).toBeGreaterThanOrEqual(3000 + 5_000);
    expect(callsTo(trace, 'ledger', 'insertUsageMetric')).toEqual([
      usageRow(3000, 5, 6),
      usageRow(rescueEstimate as number, 0, 0),
    ]);
  });
});

describe('ask_agentic accounting — the forced-finalization pass', () => {
  it('is reserved, booked and released at its estimate when neither the loop nor its response reported usage', async () => {
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      input: { maxIterations: 1 },
      script: [
        { calls: [{ name: 'grep', args: { pattern: 'needle' } }], usage: null },
        { text: 'forced', usage: null },
      ],
    });

    expect(result.structuredContent?.convergenceForced).toBe(true);
    expect(callsTo(trace, 'throttle', 'reserve')).toEqual([
      [MODEL, 50_000],
      [MODEL, 50_000],
    ]);
    expect(callsTo(trace, 'throttle', 'release')).toEqual([
      [101, 50_000],
      [102, 50_000],
    ]);
    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')[1]).toEqual([
      2,
      {
        cachedTokens: 0,
        uncachedTokens: 50_000,
        costUsdMicro: bookedMicros(50_000, 0, 0),
        durationMs: expect.any(Number),
      },
    ]);
  });

  it('is booked at the usage it read before its response failed', async () => {
    const response = {
      usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 9, thoughtsTokenCount: 2 },
      get candidates(): never {
        throw new Error('candidates unreadable');
      },
    };
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      input: { maxIterations: 1 },
      script: [READ_A, { raw: response }],
    });

    expect(result.structuredContent?.rescueErrorCode).toBe('INTERNAL');
    expect(callsTo(trace, 'throttle', 'release')[1]).toEqual([102, 4000]);
    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')[1]).toEqual([
      2,
      {
        cachedTokens: 0,
        uncachedTokens: 4000,
        costUsdMicro: bookedMicros(4000, 9, 2),
        durationMs: expect.any(Number),
      },
    ]);
  });

  it('adds its tokens, thinking included, to the loop totals of the forced answer', async () => {
    const { result } = await runAgentic({
      input: { maxIterations: 1 },
      script: [
        {
          ...READ_A,
          usage: { promptTokenCount: 3000, candidatesTokenCount: 5, thoughtsTokenCount: 6 },
        },
        {
          text: 'forced',
          usage: { promptTokenCount: 4000, candidatesTokenCount: 9, thoughtsTokenCount: 2 },
        },
      ],
    });

    expect(result.structuredContent).toMatchObject({
      apiCalls: 2,
      cumulativeInputTokens: 7000,
      cumulativeOutputTokens: 14,
      cumulativeThinkingTokens: 8,
    });
  });
});

describe('ask_agentic accounting — apiCalls on a pass that never reached the model', () => {
  it('does not count an iteration the daily budget refused, on the first iteration', async () => {
    const { result, modelCalls } = await runAgentic({
      ...ENFORCED,
      budgetAnswers: [{ rejected: true, spentMicros: 9_990_000 }],
      script: [],
    });

    expect(result.structuredContent).toMatchObject({
      errorCode: 'BUDGET_REJECT',
      iterations: 1,
      apiCalls: 0,
    });
    expect(modelCalls).toHaveLength(0);
  });

  it('does not count an iteration the daily budget refused, after one that ran', async () => {
    const { result, modelCalls } = await runAgentic({
      ...ENFORCED,
      budgetAnswers: [undefined, { rejected: true, spentMicros: 9_990_000 }],
      script: [READ_A],
    });

    expect(result.structuredContent).toMatchObject({
      errorCode: 'BUDGET_REJECT',
      iterations: 2,
      apiCalls: 1,
    });
    expect(modelCalls).toHaveLength(1);
  });

  it('does not count an iteration whose timeout fired during its TPM wait', async () => {
    const { result, modelCalls, trace } = await runAgentic({
      ...ENFORCED,
      input: { iterationTimeoutMs: 1_000 },
      throttleAnswers: [undefined, { delayMs: 60_000, releaseId: 202 }],
      script: [READ_A],
    });

    expect(result.structuredContent).toMatchObject({
      errorCode: 'TIMEOUT',
      iterations: 2,
      apiCalls: 1,
    });
    expect(modelCalls).toHaveLength(1);
    expect(callsTo(trace, 'throttle', 'cancel')).toEqual([[202]]);
    expect(callsTo(trace, 'ledger', 'cancelBudgetReservation')).toEqual([[2]]);
  });

  it('does not count a finalization pass whose timeout fired during its TPM wait', async () => {
    const { result, modelCalls, trace } = await runAgentic({
      ...ENFORCED,
      input: { maxIterations: 1, iterationTimeoutMs: 1_000 },
      throttleAnswers: [undefined, { delayMs: 60_000, releaseId: 202 }],
      script: [READ_A],
    });

    expect(result.structuredContent).toMatchObject({
      subReason: 'AGENTIC_MAX_ITERATIONS',
      rescueErrorCode: 'TIMEOUT',
      iterations: 1,
      apiCalls: 1,
    });
    expect(modelCalls).toHaveLength(1);
    expect(callsTo(trace, 'throttle', 'cancel')).toEqual([[202]]);
    expect(callsTo(trace, 'ledger', 'cancelBudgetReservation')).toEqual([[2]]);
  });
});

describe('ask_agentic accounting — a ledger write that fails', () => {
  it('returns the answer and logs the error when the usage row cannot be written', async () => {
    const { result, trace } = await runAgentic({
      tpmThrottleLimit: 1_000_000,
      insertUsageThrows: new Error('SQLITE_BUSY'),
      script: [{ text: 'done', usage: { promptTokenCount: 7, candidatesTokenCount: 1 } }],
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('done');
    expect(trace.filter((e) => e.kind === 'log' && e.name === 'error')).toHaveLength(1);
    expect(callsTo(trace, 'throttle', 'release')).toEqual([[101, 7]]);
  });

  it('says a failed finalize left the reserved estimate and names the pass: the loop and the forced pass apart', async () => {
    const { trace } = await runAgentic({
      ...ENFORCED,
      finalizeThrows: new Error('SQLITE_BUSY'),
      input: { maxIterations: 1 },
      script: [
        { ...READ_A, usage: { promptTokenCount: 3000, candidatesTokenCount: 5 } },
        { text: 'forced', usage: { promptTokenCount: 4000, candidatesTokenCount: 9 } },
      ],
    });

    const lines = trace
      .filter((e) => e.kind === 'log' && e.name === 'error')
      .map((e) => String(e.args[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^ask_agentic: finalizeBudgetReservation failed for id=1; the row keeps its reserved estimate, the billed \d+ micros were not written/,
    );
    expect(lines[1]).toMatch(
      /^ask_agentic finalization: finalizeBudgetReservation failed for id=2/,
    );
  });
});

/** The reservation of pass 1 finalised at a pass's booked tokens. */
function finalizedAt(uncached: number, output: number, thinking: number): unknown[][] {
  return [
    [
      1,
      {
        cachedTokens: 0,
        uncachedTokens: uncached,
        costUsdMicro: bookedMicros(uncached, output, thinking),
        durationMs: expect.any(Number),
      },
    ],
  ];
}

const USAGE_3000 = { promptTokenCount: 3000, candidatesTokenCount: 200, thoughtsTokenCount: 50 };

describe('ask_agentic accounting — an iteration that fails after its model call completed', () => {
  it('books the call at its reported usage when the iteration times out in its tool batch', async () => {
    tools.grepDelayMs = 1_500;
    const { result, trace } = await runAgentic({
      ...ENFORCED,
      input: { iterationTimeoutMs: 1_000 },
      script: [{ calls: [{ name: 'grep', args: { pattern: 'needle' } }], usage: USAGE_3000 }],
    });

    expect(result.structuredContent).toEqual({
      errorCode: 'TIMEOUT',
      timeoutMs: 1_000,
      stallMs: null,
      timeoutKind: 'total',
      iteration: 1,
      iterations: 1,
      apiCalls: 1,
      retryable: true,
      responseText: expect.stringContaining('iteration 1 timed out (total) after 1000ms'),
    });
    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')).toEqual(
      finalizedAt(3000, 200, 50),
    );
    expect(callsTo(trace, 'throttle', 'release')).toEqual([[101, 3000]]);
    expect(callsTo(trace, 'ledger', 'cancelBudgetReservation')).toEqual([]);
    expect(callsTo(trace, 'throttle', 'cancel')).toEqual([]);
  });

  it('books the call at its estimate when its usage could not be read', async () => {
    const response = {
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
      usageMetadata: {
        get promptTokenCount(): never {
          throw new Error('usage unreadable');
        },
      },
    };
    const { result, trace } = await runAgentic({ ...ENFORCED, script: [{ raw: response }] });

    expect(result.isError).toBe(true);
    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')).toEqual(
      finalizedAt(50_000, 0, 0),
    );
    expect(callsTo(trace, 'throttle', 'release')).toEqual([[101, 50_000]]);
    expect(callsTo(trace, 'ledger', 'cancelBudgetReservation')).toEqual([]);
  });

  it('books the call at its reported usage when its parts could not be read', async () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              {
                get functionCall(): never {
                  throw new Error('part unreadable');
                },
              },
            ],
          },
        },
      ],
      usageMetadata: USAGE_3000,
    };
    const { result, trace } = await runAgentic({ ...ENFORCED, script: [{ raw: response }] });

    expect(result.isError).toBe(true);
    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')).toEqual(
      finalizedAt(3000, 200, 50),
    );
    expect(callsTo(trace, 'throttle', 'release')).toEqual([[101, 3000]]);
  });
});

describe('ask_agentic accounting — an iteration whose model call did not complete', () => {
  it.each([
    ['refused at its opening', { throws: new ApiError({ status: 429, message: 'quota' }) }],
    ['failed at its opening', { throws: new ApiError({ status: 500, message: 'server' }) }],
    [
      'failed mid-stream after a chunk that carried usage',
      { text: 'partial', usage: USAGE_3000, failsMidStream: new Error('stream reset') },
    ],
  ])('cancels both reservations when %s', async (_case, turn) => {
    const { result, trace } = await runAgentic({ ...ENFORCED, script: [turn] });

    expect(result.isError).toBe(true);
    expect(callsTo(trace, 'ledger', 'cancelBudgetReservation')).toEqual([[1]]);
    expect(callsTo(trace, 'throttle', 'cancel')).toEqual([[101]]);
    expect(callsTo(trace, 'ledger', 'finalizeBudgetReservation')).toEqual([]);
    expect(callsTo(trace, 'throttle', 'release')).toEqual([]);
  });
});
