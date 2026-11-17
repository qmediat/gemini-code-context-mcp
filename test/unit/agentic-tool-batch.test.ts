/**
 * One iteration's tool batch in `ask_agentic`: the function responses go back to the model in call order with each
 * call's id, a `read_file` past `maxFilesRead` is refused in its place unless it re-reads a file already read, the
 * batch runs at most `GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY` calls at once, the stall watchdog does not count
 * it — nor through the `ask` fallback, which passes `stallMs` on as `stallMs` —, one bound always does (the iteration
 * timeout, else the batch ceiling), and a sandbox refusal is logged at debug level with the path asked for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanWorkspace } from '../../src/indexer/workspace-scanner.js';
import { type AskInput, askTool } from '../../src/tools/ask.tool.js';
import { type ScriptedCall, callsTo, runAgentic, runScripted } from '../helpers/agentic-run.js';
import { oneFileScan } from '../helpers/workspace.js';

const executions = vi.hoisted(() => ({ delayMs: 0, hangs: false, running: 0, mostAtOnce: 0 }));

/** The tool batch's ceiling in this file: above the 2.5 s batches that must finish, short enough to wait for. */
const CEILING_MS = vi.hoisted(() => 3_000);

vi.mock('../../src/gemini/models.js', () => ({ resolveModel: vi.fn() }));
vi.mock('../../src/indexer/workspace-validation.js', () => ({
  validateWorkspacePath: vi.fn(),
  WorkspaceValidationError: class extends Error {},
}));
// The scan `ask` sees: 4 MB ≈ 1 M tokens, past its guard (90 % of Gemini 3 Pro's window), so it falls back.
vi.mock('../../src/indexer/workspace-scanner.js', () => ({
  scanWorkspace: vi.fn(async () => oneFileScan({ relpath: 'big.ts', size: 4_000_000 })),
  buildScanMemo: () => new Map<string, never>(),
}));
vi.mock('../../src/tools/agentic/run.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/tools/agentic/run.js')>(
    '../../src/tools/agentic/run.js',
  )),
  TOOL_BATCH_CEILING_MS: CEILING_MS,
}));
// Every executor runs for real, counted while it runs and held for `executions.delayMs` first; with
// `executions.hangs` it never returns.
vi.mock('../../src/tools/agentic/workspace-tools.js', async () => {
  type Tools = typeof import('../../src/tools/agentic/workspace-tools.js');
  const actual = await vi.importActual<Tools>('../../src/tools/agentic/workspace-tools.js');
  const counted =
    <A extends unknown[], R>(executor: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      executions.running += 1;
      executions.mostAtOnce = Math.max(executions.mostAtOnce, executions.running);
      try {
        if (executions.hangs) await new Promise<never>(() => {});
        await new Promise((resolve) => setTimeout(resolve, executions.delayMs));
        return await executor(...args);
      } finally {
        executions.running -= 1;
      }
    };
  return {
    ...actual,
    listDirectoryExecutor: counted(actual.listDirectoryExecutor),
    findFilesExecutor: counted(actual.findFilesExecutor),
    readFileExecutor: counted(actual.readFileExecutor),
    grepExecutor: counted(actual.grepExecutor),
  };
});

beforeEach(() => {
  executions.delayMs = 0;
  executions.hangs = false;
  executions.running = 0;
  executions.mostAtOnce = 0;
});

interface FunctionResponsePart {
  functionResponse: { id?: string; name: string; response: Record<string, unknown> };
}

/** The function responses of the last turn the model was sent before call `index`. */
function responsesSentTo(
  modelCalls: ReadonlyArray<{ contents: unknown[] }>,
  index: number,
): FunctionResponsePart[] {
  const contents = modelCalls[index]?.contents ?? [];
  const last = contents[contents.length - 1] as { role: string; parts: FunctionResponsePart[] };
  expect(last.role).toBe('user');
  return last.parts;
}

const THREE_TOOLS: readonly ScriptedCall[] = [
  { name: 'grep', args: { pattern: 'needle' } },
  { name: 'list_directory', args: { path: 'sub' } },
  { name: 'find_files', args: { pattern: '*.ts' } },
];

describe('ask_agentic tool batch — responses', () => {
  it('answers a batch in call order with each id: a read refused at the cap, a re-read, a grep', async () => {
    const { result, modelCalls } = await runAgentic({
      input: { maxFilesRead: 1 },
      script: [
        { calls: [{ id: 'r0', name: 'read_file', args: { path: 'a.ts' } }] },
        {
          calls: [
            { id: 'r1', name: 'read_file', args: { path: 'b.ts' } },
            { id: 'r2', name: 'read_file', args: { path: './a.ts' } },
            { id: 'g1', name: 'grep', args: { pattern: 'needle' } },
          ],
        },
        { text: 'done' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const parts = responsesSentTo(modelCalls, 2);
    expect(parts.map((p) => [p.functionResponse.id, p.functionResponse.name])).toEqual([
      ['r1', 'read_file'],
      ['r2', 'read_file'],
      ['g1', 'grep'],
    ]);
    const [refused, reread, grep] = parts.map((p) => p.functionResponse.response);
    expect(refused?.error).toBe(
      'maxFilesRead (1) reached. Summarise with what you have already read, or ask a narrower question.',
    );
    expect(reread).toMatchObject({ relpath: 'a.ts' });
    expect(reread).not.toHaveProperty('error');
    expect(grep).not.toHaveProperty('error');
    expect(result.structuredContent?.filesReadList).toEqual(['a.ts']);
  });

  it('sends no id on the response of a call that had none', async () => {
    const { modelCalls } = await runAgentic({
      script: [{ calls: [{ name: 'read_file', args: { path: 'a.ts' } }] }, { text: 'done' }],
    });

    const [part] = responsesSentTo(modelCalls, 1);
    expect(part?.functionResponse).not.toHaveProperty('id');
    expect(part?.functionResponse.name).toBe('read_file');
  });
});

describe('ask_agentic tool batch — concurrency', () => {
  it('runs one call at a time when GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY is 1', async () => {
    executions.delayMs = 30;

    const { result } = await runAgentic({
      env: { GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY: '1' },
      script: [{ calls: THREE_TOOLS }, { text: 'done' }],
    });

    expect(result.isError).toBeFalsy();
    expect(executions.mostAtOnce).toBe(1);
  });

  it('runs the whole batch at once under the default concurrency', async () => {
    executions.delayMs = 30;

    await runAgentic({
      env: { GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY: '' },
      script: [{ calls: THREE_TOOLS }, { text: 'done' }],
    });

    expect(executions.mostAtOnce).toBe(3);
  });
});

describe('ask_agentic tool batch — the stall watchdog', () => {
  const GREP = { calls: [{ name: 'grep', args: { pattern: 'needle' } }] };

  it('goes on when the tool batch outlasts stallMs: the stream had ended', async () => {
    executions.delayMs = 2_500;

    const { result } = await runAgentic({
      input: { stallMs: 1_000 },
      script: [GREP, { text: 'done' }],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ iterations: 2, apiCalls: 2 });
  });

  it('still aborts a stream that goes silent after its first chunk', async () => {
    const { result, trace } = await runAgentic({
      input: { stallMs: 1_000 },
      script: [{ ...GREP, hangsMidStream: true }],
    });

    expect(result.structuredContent).toMatchObject({
      errorCode: 'TIMEOUT',
      timeoutKind: 'stall',
      iteration: 1,
      responseText: expect.stringContaining(
        'A request aborted after its stream opened is booked 0',
      ),
    });
    expect(result.structuredContent).not.toHaveProperty('uncachedTokens');
    expect(result.structuredContent).not.toHaveProperty('costEstimateUsd');
    expect(executions.mostAtOnce).toBe(0);
    expect(callsTo(trace, 'ledger', 'insertUsageMetric')).toEqual([]);
  });

  it('ends the call as TIMEOUT when the total timeout fires in the batch, the pass booked', async () => {
    executions.delayMs = 2_500;

    const { result, trace } = await runAgentic({
      input: { stallMs: 1_000, iterationTimeoutMs: 1_500 },
      script: [GREP],
    });

    expect(result.structuredContent).toMatchObject({
      errorCode: 'TIMEOUT',
      timeoutKind: 'total',
      iteration: 1,
      uncachedTokens: 1000,
      outputTokens: 100,
      thinkingTokens: 7,
    });
    expect(callsTo(trace, 'ledger', 'insertUsageMetric')).toEqual([
      [expect.objectContaining({ toolName: 'ask_agentic', uncachedTokens: 1000 })],
    ]);
  });
});

describe('ask_agentic tool batch — its bound', () => {
  const GREP = { calls: [{ name: 'grep', args: { pattern: 'needle' } }] };

  it('ends a batch that never returns at the ceiling when only stallMs is set, the pass booked', async () => {
    executions.hangs = true;

    const startedAt = Date.now();
    const { result, trace } = await runAgentic({ input: { stallMs: 1_000 }, script: [GREP] });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CEILING_MS - 50);
    expect(result.structuredContent).toMatchObject({
      errorCode: 'TIMEOUT',
      timeoutKind: 'tool-batch',
      timeoutMs: null,
      stallMs: 1_000,
      iteration: 1,
      apiCalls: 1,
      uncachedTokens: 1000,
      outputTokens: 100,
      thinkingTokens: 7,
      responseText: expect.stringContaining(
        `iteration 1 timed out (tool-batch) after ${CEILING_MS}ms`,
      ),
    });
    expect(String(result.structuredContent?.responseText)).not.toContain('booked 0');
    expect(callsTo(trace, 'ledger', 'insertUsageMetric')).toEqual([
      [expect.objectContaining({ toolName: 'ask_agentic', uncachedTokens: 1000 })],
    ]);
  });

  it('ends a batch that never returns at iterationTimeoutMs when it is set', async () => {
    executions.hangs = true;

    const startedAt = Date.now();
    const { result } = await runAgentic({
      input: { stallMs: 1_000, iterationTimeoutMs: 1_500 },
      script: [GREP],
    });

    expect(Date.now() - startedAt).toBeLessThan(CEILING_MS);
    expect(result.structuredContent).toMatchObject({
      errorCode: 'TIMEOUT',
      timeoutKind: 'total',
      timeoutMs: 1_500,
      uncachedTokens: 1000,
    });
  });
});

describe('ask_agentic tool batch — through the ask fallback', () => {
  const GREP = { calls: [{ name: 'grep', args: { pattern: 'needle' } }] };

  /** One `ask` call that falls back to `ask_agentic` with these timeouts. */
  function askFallingBack(timeouts: Pick<AskInput, 'timeoutMs' | 'stallMs'>) {
    return runScripted({ script: [GREP, { text: 'done' }] }, (workspace, ctx) =>
      askTool.execute(
        {
          prompt: 'q',
          workspace,
          onWorkspaceTooLarge: 'fallback-to-agentic',
          preflightMode: 'heuristic',
          ...timeouts,
        } as AskInput,
        ctx,
      ),
    );
  }

  it('answers when the batch outlasts stallMs: stallMs reaches ask_agentic as its stall watchdog', async () => {
    executions.delayMs = 2_500;

    const { result } = await askFallingBack({ stallMs: 1_000 });

    expect(vi.mocked(scanWorkspace)).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      fallbackApplied: 'ask_agentic',
      stallMs: 1_000,
      responseText: 'done',
      agenticResult: { iterations: 2, apiCalls: 2 },
    });
    expect(result.structuredContent).not.toHaveProperty('iterTimeoutMs');
  });

  it('ends at timeoutMs, which becomes the per-iteration cap, when the batch outlasts it', async () => {
    executions.delayMs = 2_500;

    const { result } = await askFallingBack({ timeoutMs: 1_500, stallMs: 1_000 });

    expect(result.structuredContent).toMatchObject({
      fallbackApplied: 'ask_agentic',
      iterTimeoutMs: 1_500,
      iterTimeoutSource: 'timeoutMs',
      stallMs: 1_000,
      errorCode: 'TIMEOUT',
      timeoutKind: 'total',
      agenticResult: { timeoutMs: 1_500, stallMs: 1_000, iteration: 1 },
    });
  });
});

describe('ask_agentic tool batch — sandbox refusals', () => {
  it('logs a read of an excluded file at debug level with the path asked for; the model gets no path', async () => {
    const { trace, modelCalls } = await runAgentic({
      input: { excludeGlobs: ['b.ts'] },
      script: [{ calls: [{ name: 'read_file', args: { path: 'b.ts' } }] }, { text: 'done' }],
    });

    const debugLines = callsTo(trace, 'log', 'debug').map(([line]) => String(line));
    const refusals = debugLines.filter((line) => line.startsWith('agentic dispatch refused:'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('tool=read_file');
    expect(refusals[0]).toContain('requestedPath=b.ts');
    const [part] = responsesSentTo(modelCalls, 1);
    expect(String(part?.functionResponse.response.error)).not.toContain('b.ts');
  });
});
