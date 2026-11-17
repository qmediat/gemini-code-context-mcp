/**
 * Tool executor dispatcher — takes a FunctionCall, routes to the right
 * executor, maps `SandboxError` → `response.error` (recoverable signal), and
 * runs one iteration's calls in parallel under the concurrency cap.
 */

import type { MatchConfig } from '../../indexer/globs.js';
import { logger, safeForLog } from '../../utils/logger.js';
import { SandboxError } from './sandbox.js';
import {
  findFilesExecutor,
  grepExecutor,
  listDirectoryExecutor,
  readFileExecutor,
} from './workspace-tools.js';

/**
 * Default cap on parallel tool-call dispatch within a single iteration.
 *
 * Bumped 3 → 10 in v1.15.1 (P9_a). Pre-bump rationale was "be conservative,
 * avoid hammering local filesystem I/O." Empirical: today's `read_file` /
 * `grep` / `find_files` run against the SQLite-backed manifest + workspace
 * mmap, all of which are CPU-bound and parallelism-friendly. The 3-wide cap
 * forced the model to serialise even small batches like 5 `read_file` calls
 * into 2 round-trips of the iteration loop, eating ~30-60s of HIGH-thinking
 * latency per artificial split. 10-wide handles the typical batch a Gemini
 * 3 Pro response emits without queuing.
 *
 * Operators can override via `GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY`
 * env var (clamped to [1, 50]) — kill switch for environments where
 * filesystem contention or local I/O bandwidth makes wider concurrency
 * counter-productive. v1.15.1+ telemetry gap: no per-call dispatch metric
 * yet exists; if a future release adds one, the env-override knob lets
 * operators dial back without code changes. (Tracked in `wiggly-twirling-karp.md`.)
 */
const DEFAULT_TOOL_EXECUTION_CONCURRENCY = 10;

/** Read + clamp the tool-execution concurrency at dispatch time.
 *
 * Why a function not a top-level const: env vars can change between calls
 * within a long-lived MCP-server process (operator ctrl-Cs and re-launches
 * with a different value mid-session). Resolving per-call keeps behaviour
 * predictable. Cost: one env-read per iter; negligible vs the
 * `generateContent` round-trip dominating wall-clock.
 *
 * Clamps numeric inputs to `[1, 50]`. Only NaN / unset / empty falls back
 * to default. 50 cap prevents pathological "concurrency: 99999" misconfig
 * from spawning ~unbounded `read_file` Promise chains. 0 / negative inputs
 * clamp UP to 1 (= serial dispatch) — operators setting `0` or `-3` mean
 * "minimise parallelism", not "use the default" (the v1.15.1 PR-Round-1
 * 2-of-2 cross-reviewer correction: gemini-cli F2 + grok F1 flagged that
 * silently mapping operator-supplied `0` back to 10× was the opposite of
 * intent and a confusing UX on resource-constrained CI / Windows hosts).
 *
 * Exported for unit testing — not part of the public MCP surface. */
export function resolveToolExecutionConcurrency(): number {
  const raw = process.env.GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY;
  if (raw === undefined || raw === '') return DEFAULT_TOOL_EXECUTION_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  // Only NaN (genuinely malformed input like `'banana'`) falls back to
  // default. Numeric inputs always clamp into [1, 50] so the operator's
  // stated intent (lower bound = serial; upper bound = throughput cap)
  // is honoured for any value parseInt can extract a number from.
  if (Number.isNaN(parsed)) return DEFAULT_TOOL_EXECUTION_CONCURRENCY;
  return Math.max(1, Math.min(parsed, 50));
}

/** One function call as the model issued it. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface DispatchedToolResult {
  name: string;
  response: Record<string, unknown>;
  /** Duration of the executor call (for tracing). */
  durationMs: number;
  /** `true` when the executor threw a recoverable error — useful for the
   * no-progress detector so we treat repeated error'd calls as a loop. */
  isError: boolean;
}

type ToolResponse = Record<string, unknown>;
type Executor = (
  workspaceRoot: string,
  args: Record<string, unknown>,
  matchConfig: MatchConfig,
) => Promise<ToolResponse>;

/** A line number the model sent, or `undefined` when it is not a finite number. */
const finiteLine = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const runListDirectory: Executor = async (workspaceRoot, args, matchConfig) => {
  const path = String(args.path ?? '.');
  return (await listDirectoryExecutor(workspaceRoot, path, matchConfig)) as unknown as ToolResponse;
};

const runFindFiles: Executor = async (workspaceRoot, args, matchConfig) => {
  const pattern = String(args.pattern ?? '');
  return (await findFilesExecutor(workspaceRoot, pattern, matchConfig)) as unknown as ToolResponse;
};

const runReadFile: Executor = async (workspaceRoot, args, matchConfig) => {
  const path = String(args.path ?? '');
  const startLine = finiteLine(args.startLine);
  const endLine = finiteLine(args.endLine);
  return (await readFileExecutor(
    workspaceRoot,
    path,
    startLine,
    endLine,
    matchConfig,
  )) as unknown as ToolResponse;
};

const runGrep: Executor = async (workspaceRoot, args, matchConfig) => {
  const pattern = String(args.pattern ?? '');
  const pathPrefix =
    typeof args.pathPrefix === 'string' && args.pathPrefix.length > 0 ? args.pathPrefix : undefined;
  return (await grepExecutor(
    workspaceRoot,
    pattern,
    pathPrefix,
    matchConfig,
  )) as unknown as ToolResponse;
};

/** The executor of each tool the model may call, by its declared name. */
const EXECUTORS: ReadonlyMap<string, Executor> = new Map([
  ['list_directory', runListDirectory],
  ['find_files', runFindFiles],
  ['read_file', runReadFile],
  ['grep', runGrep],
]);

/** The recoverable `response.error` text of an executor failure. */
function failureMessage(err: unknown): string {
  if (err instanceof SandboxError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ops-side observability for excludeGlobs misconfigurations (v1.9.0
 * Phase 1.2, /6step Finding B): the user-visible `.message` for
 * `EXCLUDED_FILE` and `EXCLUDED_DIR` is deliberately path-free to
 * close the existence-probe oracle (Phase 1.1 Findings #1 + #2).
 * Without this debug log, an operator helping a user debug "why is
 * ask_agentic refusing my file?" has no way to map the generic error
 * back to a specific path. The `requestedPath` field on SandboxError
 * was preserved for exactly this purpose; surface it at debug level
 * so prod log volume stays unchanged but ops can opt in via
 * `GEMINI_CODE_CONTEXT_LOG_LEVEL=debug`.
 *
 * NOTE (v1.9.0 self-review S4): no direct regression test on this emit
 * path. The Phase 1.1 test pins `requestedPath` is set on SandboxError
 * (the input contract this branch consumes), and `safeForLog` has its
 * own 18-test coverage in `test/unit/logger.test.ts`. But "the
 * dispatcher actually CALLS logger.debug on SandboxError" is verified
 * by visual review only — if you remove or refactor this block,
 * existing tests will not catch the regression. If you change anything
 * here, please add a `vi.spyOn(logger, 'debug')` test that runs an
 * agentic scenario through `askAgenticTool.execute` with an
 * excludeGlobs config and asserts the spy received a string starting
 * with `agentic dispatch refused:`.
 */
function logSandboxRefusal(name: string, err: unknown): void {
  if (!(err instanceof SandboxError)) return;
  logger.debug(
    `agentic dispatch refused: tool=${safeForLog(name)} code=${safeForLog(err.code)} requestedPath=${safeForLog(err.requestedPath)}`,
  );
}

/**
 * Run one function call. SandboxError and anything else that happens in the
 * executor surfaces as recoverable `response.error` so the model can try a
 * different path. Hard failures (e.g. filesystem I/O errors) follow the same
 * path — the worst case is we waste one iteration. An unknown function name
 * returns an error response rather than throwing: the model may recover by
 * picking a valid tool.
 */
export async function dispatchToolCall(
  workspaceRoot: string,
  name: string,
  args: Record<string, unknown>,
  matchConfig: MatchConfig,
): Promise<DispatchedToolResult> {
  const started = Date.now();
  try {
    const executor = EXECUTORS.get(name);
    if (executor === undefined) {
      return {
        name,
        response: { error: `unknown tool: ${name}` },
        durationMs: Date.now() - started,
        isError: true,
      };
    }
    const response = await executor(workspaceRoot, args, matchConfig);
    return { name, response, durationMs: Date.now() - started, isError: false };
  } catch (err) {
    const message = failureMessage(err);
    logSandboxRefusal(name, err);
    return {
      name,
      response: { error: message },
      durationMs: Date.now() - started,
      isError: true,
    };
  }
}

/** Run up to `concurrency` dispatches in parallel, preserving call order. */
export async function dispatchToolCallsParallel(
  workspaceRoot: string,
  calls: ToolCall[],
  concurrency: number,
  matchConfig: MatchConfig,
): Promise<DispatchedToolResult[]> {
  const results: DispatchedToolResult[] = new Array(calls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < calls.length) {
      const i = next;
      next += 1;
      const call = calls[i];
      if (!call) continue;
      results[i] = await dispatchToolCall(workspaceRoot, call.name, call.args, matchConfig);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, calls.length)) }, worker);
  await Promise.all(workers);
  return results;
}
