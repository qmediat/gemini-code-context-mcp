/**
 * One `ask_agentic` call driven end to end with a scripted model, in a scratch workspace, with every side effect
 * recorded in order: progress lines, logger lines, budget-ledger and TPM-throttle calls, model calls. The test file
 * mocks `gemini/models.js` (`resolveModel: vi.fn()`) and `indexer/workspace-validation.js` itself — a `vi.mock` applies
 * to the file that calls it; the run then sets what the mocked `resolveModel` resolves to.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import { resolveModel } from '../../src/gemini/models.js';
import { type AskAgenticInput, askAgenticTool } from '../../src/tools/ask-agentic.tool.js';
import type { TextToolResult, ToolContext } from '../../src/tools/registry.js';
import type { ResolvedModel } from '../../src/types.js';
import { logger } from '../../src/utils/logger.js';
import { GEMINI_3_PRO } from './models.js';

/** A function call the scripted model makes. */
export interface ScriptedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly id?: string;
}

/** One scripted model turn: what the response carries, or how the call fails. */
export interface ScriptedTurn {
  readonly calls?: readonly ScriptedCall[];
  readonly text?: string;
  readonly thoughts?: readonly string[];
  /** The response's `usageMetadata`; `null` sends none. Default: 1000 in, 100 out, 7 thinking. */
  readonly usage?: Record<string, unknown> | null;
  /** The response object as given (getters that throw included), instead of one built from the fields above. */
  readonly raw?: unknown;
  readonly throws?: unknown;
  /** The call never answers; it rejects when its abort signal fires. */
  readonly hang?: boolean;
  /** The call answers after this many ms. */
  readonly delayMs?: number;
  /** The stream yields the response, then fails with this before its end (`generateContentStream` only). */
  readonly failsMidStream?: unknown;
}

export type BudgetReserveAnswer = { id: number } | { rejected: true; spentMicros: number };
export type ThrottleReserveAnswer = { delayMs: number; releaseId: number };

export interface AgenticRunOptions {
  readonly script: readonly ScriptedTurn[];
  readonly input?: Partial<AskAgenticInput>;
  /** Files of the workspace, by relative path. Default: `a.ts`, `b.ts`, `sub/c.ts`. */
  readonly files?: Readonly<Record<string, string>>;
  readonly dailyBudgetUsd?: number;
  readonly tpmThrottleLimit?: number;
  /** `reserveBudget`'s answers, in call order; an absent entry takes the next id (1, 2, …). */
  readonly budgetAnswers?: ReadonlyArray<BudgetReserveAnswer | undefined>;
  /** `throttle.reserve`'s answers, in call order; an absent entry takes no delay and the next id (101, 102, …). */
  readonly throttleAnswers?: ReadonlyArray<ThrottleReserveAnswer | undefined>;
  /** What `cancelBudgetReservation` throws, when it should. */
  readonly cancelBudgetThrows?: unknown;
  /** What `insertUsageMetric` / `finalizeBudgetReservation` throw, when they should. */
  readonly insertUsageThrows?: unknown;
  readonly finalizeThrows?: unknown;
  readonly env?: Readonly<Record<string, string>>;
  /** What the model resolves to. Default: Gemini 3 Pro (`gemini-3-pro-preview`). */
  readonly model?: ResolvedModel;
}

export type TraceKind = 'emit' | 'log' | 'ledger' | 'throttle' | 'model';

/** One recorded side effect: `name` is the progress line, the logger level, or the method called. */
export interface TraceEvent {
  readonly kind: TraceKind;
  readonly name: string;
  readonly args: readonly unknown[];
}

/** A model call as it was made: the conversation copied at call time, the config as sent. */
export interface ModelCall {
  readonly method: 'generateContent' | 'generateContentStream';
  readonly model: string;
  readonly contents: unknown[];
  readonly config: Record<string, unknown>;
}

export interface AgenticRunRecord {
  readonly result: TextToolResult;
  readonly trace: readonly TraceEvent[];
  readonly modelCalls: readonly ModelCall[];
}

const DEFAULT_FILES: Readonly<Record<string, string>> = {
  'a.ts': 'export const a = 1;\n// needle\n',
  'b.ts': 'export const b = 2;\n',
  'sub/c.ts': 'export const c = "needle";\n',
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** The model response a scripted turn describes. */
export function buildModelResponse(turn: ScriptedTurn): unknown {
  if (turn.raw !== undefined) return turn.raw;
  const usage = turn.usage === undefined ? DEFAULT_USAGE : turn.usage;
  return {
    ...(turn.text !== undefined ? { text: turn.text } : {}),
    candidates: [{ content: { parts: partsOf(turn) } }],
    ...(usage === null ? {} : { usageMetadata: usage }),
  };
}

const DEFAULT_USAGE = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 7 };

/** A turn's parts in the order a model sends them: thoughts, function calls, then the text. */
function partsOf(turn: ScriptedTurn): unknown[] {
  const thoughts = (turn.thoughts ?? []).map((text) => ({ thought: true, text }));
  const calls = (turn.calls ?? []).map((call) => ({
    functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args: call.args },
  }));
  return [...thoughts, ...calls, ...(turn.text !== undefined ? [{ text: turn.text }] : [])];
}

function writeWorkspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'gcctx-agentic-run-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return realpathSync(root);
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason));
  });
}

interface ModelParams {
  model: string;
  contents: unknown[];
  config?: Record<string, unknown> & { abortSignal?: AbortSignal };
}

/** A scripted turn as the model answers it: the response, and the failure its stream ends with, if any. */
interface Answer {
  readonly response: unknown;
  readonly failsMidStream?: unknown;
}

/** The scripted model: each call takes the next turn, in order, whichever method made it. */
function scriptedModel(script: readonly ScriptedTurn[], trace: TraceEvent[], calls: ModelCall[]) {
  let next = 0;
  const answer = async (method: ModelCall['method'], params: ModelParams): Promise<Answer> => {
    const { abortSignal, ...config } = params.config ?? {};
    calls.push({ method, model: params.model, contents: structuredClone(params.contents), config });
    trace.push({ kind: 'model', name: method, args: [params.model] });
    const turn = script[next++];
    if (turn === undefined) throw new Error('script exhausted');
    if (turn.hang) return untilAborted(abortSignal);
    if (turn.delayMs !== undefined) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.throws !== undefined) throw turn.throws;
    return { response: buildModelResponse(turn), failsMidStream: turn.failsMidStream };
  };
  return {
    generateContent: async (params: ModelParams) =>
      (await answer('generateContent', params)).response,
    generateContentStream: async (params: ModelParams) => {
      const { response, failsMidStream } = await answer('generateContentStream', params);
      return (async function* stream() {
        yield response;
        if (failsMidStream !== undefined) throw failsMidStream;
      })();
    },
  };
}

function recorder(trace: TraceEvent[], kind: TraceKind) {
  return (name: string, answer?: (...args: unknown[]) => unknown) =>
    vi.fn((...args: unknown[]) => {
      trace.push({ kind, name, args });
      return answer?.(...args);
    });
}

function recordingManifest(opts: AgenticRunOptions, trace: TraceEvent[]) {
  const record = recorder(trace, 'ledger');
  let nextId = 1;
  let calls = 0;
  return {
    reserveBudget: record('reserveBudget', () => opts.budgetAnswers?.[calls++] ?? { id: nextId++ }),
    finalizeBudgetReservation: record('finalizeBudgetReservation', () => {
      if (opts.finalizeThrows !== undefined) throw opts.finalizeThrows;
    }),
    cancelBudgetReservation: record('cancelBudgetReservation', () => {
      if (opts.cancelBudgetThrows !== undefined) throw opts.cancelBudgetThrows;
    }),
    insertUsageMetric: record('insertUsageMetric', () => {
      if (opts.insertUsageThrows !== undefined) throw opts.insertUsageThrows;
    }),
  };
}

function recordingThrottle(opts: AgenticRunOptions, trace: TraceEvent[]) {
  const record = recorder(trace, 'throttle');
  let nextId = 101;
  let calls = 0;
  return {
    reserve: record(
      'reserve',
      () => opts.throttleAnswers?.[calls++] ?? { delayMs: 0, releaseId: nextId++ },
    ),
    release: record('release'),
    cancel: record('cancel'),
    shouldDelay: vi.fn(() => 0),
    recordRetryHint: record('recordRetryHint'),
  };
}

function contextOf(opts: AgenticRunOptions, trace: TraceEvent[], calls: ModelCall[]): ToolContext {
  const server = {
    notification: async (note: { params: { message: string } }) => {
      trace.push({ kind: 'emit', name: note.params.message, args: [] });
    },
  };
  return {
    server,
    config: {
      dailyBudgetUsd: opts.dailyBudgetUsd ?? Number.POSITIVE_INFINITY,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3_600,
      cacheMinTokens: 1_024,
      tpmThrottleLimit: opts.tpmThrottleLimit ?? 0,
      forceMaxOutputTokens: false,
      workspaceGuardRatio: 0.9,
      defaultModel: 'latest-pro-thinking',
    },
    client: { models: scriptedModel(opts.script, trace, calls) },
    manifest: recordingManifest(opts, trace),
    ttlWatcher: { markHot: vi.fn() },
    progressToken: 'progress',
    throttle: recordingThrottle(opts, trace),
  } as unknown as ToolContext;
}

/** Set `env` for the duration of `body`, then put every variable back as it was. */
async function withEnv<T>(
  env: Readonly<Record<string, string>>,
  body: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run one `ask_agentic` call with `opts` and return its result and everything it did, in order. */
export async function runAgentic(opts: AgenticRunOptions): Promise<AgenticRunRecord> {
  const trace: TraceEvent[] = [];
  const modelCalls: ModelCall[] = [];
  const workspace = writeWorkspace(opts.files ?? DEFAULT_FILES);
  const spies = LOG_LEVELS.map((level) =>
    vi.spyOn(logger, level).mockImplementation((message: string) => {
      trace.push({ kind: 'log', name: level, args: [message] });
    }),
  );
  vi.mocked(resolveModel).mockResolvedValue(opts.model ?? GEMINI_3_PRO);
  try {
    const ctx = contextOf(opts, trace, modelCalls);
    const input = { prompt: 'q', workspace, ...opts.input } as AskAgenticInput;
    const result = await withEnv(opts.env ?? {}, () => askAgenticTool.execute(input, ctx));
    return { result, trace, modelCalls };
  } finally {
    for (const spy of spies) spy.mockRestore();
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** The calls of one kind and name, by their arguments, in order. */
export function callsTo(trace: readonly TraceEvent[], kind: TraceKind, name: string): unknown[][] {
  return trace.filter((e) => e.kind === kind && e.name === name).map((e) => [...e.args]);
}

/** The argument fields that differ from run to run, as the trace lines show them. */
const VOLATILE_FIELDS: Readonly<Record<string, string>> = {
  costUsdMicro: '<usd>',
  estimatedCostMicros: '<usd>',
  durationMs: '<ms>',
  nowMs: '<ms>',
  workspaceRoot: '<ws>',
};

/**
 * The trace as one line per event, for an ordered comparison: `kind name` followed by the arguments as JSON, the
 * fields that differ from run to run (times, the scratch workspace) and the priced amounts (the price table's, pinned
 * where the ledger's amounts are tested) replaced by a placeholder.
 */
export function traceLines(trace: readonly TraceEvent[]): string[] {
  const timeless = (key: string, value: unknown) => VOLATILE_FIELDS[key] ?? value;
  return trace.map((e) => {
    const head = e.kind === 'emit' ? `emit ${e.name}` : `${e.kind} ${e.name}`;
    return e.args.length === 0 ? head : `${head} ${JSON.stringify(e.args, timeless)}`;
  });
}
