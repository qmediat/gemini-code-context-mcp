/**
 * One iteration of the `ask_agentic` loop: one streamed `generateContent` and, when the model asked for function
 * calls, one parallel batch of tool executions whose responses are appended to the conversation. Every phase reads its
 * bound from the pass's clock: the request's opening and its stream through the SDK's abort signal, the tools phase
 * (path resolution and the batch, raced as one) through `abortable` and the workers' check before each call.
 */

import type { Content, FunctionCall, GenerateContentConfig, Part } from '@google/genai';
import { abortable, abortableSleep, throwIfAborted, withNetworkRetry } from '../../gemini/retry.js';
import type { MatchConfig } from '../../indexer/globs.js';
import { logger } from '../../utils/logger.js';
import type { ToolContext } from '../registry.js';
import { type CollectedResponse, collectStream } from '../shared/stream-collector.js';
import {
  type DispatchedToolResult,
  type ToolBatch,
  type ToolCall,
  resolveToolExecutionConcurrency,
  startToolBatch,
} from './dispatch.js';
import { type PassCall, completeCall } from './ledger.js';
import type { PassClock } from './pass-clock.js';
import { PHASE_DEFAULTS } from './phase-defaults.js';
import { type UsageCounts, thinkingSummaryOf } from './response.js';
import { resolveInsideWorkspace } from './sandbox.js';

export interface IterationResult {
  /** Text from the final model turn (no function calls) — or null when
   * the model requested more function calls. */
  finalText: string | null;
  functionCallCount: number;
  /** Tool-call signatures observed in THIS iteration (for no-progress
   * detection). Empty on a final-text iteration. */
  signatures: ToolCall[];
  usage: UsageCounts;
  thinkingSummary: string | null;
  /** Approximate token count of the tool-response Parts appended to
   * `conversation` after this iteration's `[model fc]` turn. Bytes/4
   * heuristic — over-estimates dense Unicode but bias is intentional
   * (post-loop rescue's TPM/budget reservation needs to over-reserve
   * rather than under-reserve, which would risk a 429 mid-rescue).
   *
   * Used by the rescue's `finalizationEstimate` (P5/v1.15.0): the rescue
   * replays the entire accumulated conversation, so its actual prompt
   * size ≈ `lastIterationPromptTokens` + size of the tool-response Parts
   * appended AFTER that iteration's `generateContent` returned. Pre-P5
   * the estimate omitted the tool-response delta, undershooting by 100k+
   * tokens when the final iter read several large files concurrently
   * (post-v1.15.1 default `TOOL_EXECUTION_CONCURRENCY = 10`; operator
   * override via `GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY`). */
  toolResponseTokens: number;
}

export interface IterationArgs {
  ctx: ToolContext;
  resolvedModel: string;
  conversation: Content[];
  baseConfig: GenerateContentConfig;
  workspaceRoot: string;
  filesReadSet: Set<string>;
  maxFilesRead: number;
  /** The pass's clock: its signal threads into `withNetworkRetry`, the SDK config and the tools phase; every chunk
   * reaches `recordChunk`; the tools phase is entered the moment the call completed. */
  clock: PassClock;
  /** The pass's model call: marked completed once the stream ended, then given the usage read (`completeCall`). */
  call: PassCall;
  /** User glob filters (v1.9.0+). Honoured by all four agentic executors so
   * a fallback from `ask` (which already applies the same globs to its
   * eager scanner) preserves filter semantics — no privacy regression. */
  matchConfig: MatchConfig;
  /** Surface live thought-chunk previews via the MCP progress channel
   * (T33, v1.16.2). Mirrors the ask/code streaming UX. */
  onThoughtChunk: (text: string) => void;
}

type FunctionCallPart = Part & { functionCall: NonNullable<Part['functionCall']> };

/**
 * The tool calls of one model turn and where each response goes. Positional correlation between
 * `functionCallParts[i]` and `responseParts[i]`: function-call id is not always present (Gemini API
 * marks it optional), so we MUST NOT use id / name for pairing — two parallel same-name calls without
 * ids would then collide, dropping one response and crashing the next turn with Gemini 400
 * "call/response mismatch". Reported in PR #24 review by GPT + Gemini.
 */
interface DispatchPlan {
  signatures: ToolCall[];
  /** responseParts[i] corresponds to functionCallParts[i] — never resort,
   * never dedupe. `null` until either short-circuited or filled after
   * parallel dispatch. */
  responseParts: Array<Part | null>;
  /** The calls that actually need dispatch; `toDispatch[k]` corresponds to
   * `functionCallParts[dispatchIndexMap[k]]`. */
  toDispatch: ToolCall[];
  dispatchIndexMap: number[];
}

/**
 * Each agentic iteration is its own `generateContent` call; a transient
 * pre-response network failure in the middle of a long loop (default 20
 * iterations) would otherwise discard partial progress. `withNetworkRetry`
 * covers `TypeError: fetch failed` (see `src/gemini/retry.ts` for the
 * rationale — SDK-side retry is intentionally disabled because enabling it
 * strips Gemini's informative error bodies; 429 rate-limits continue to be
 * handled at the tool layer via `isGemini429` + `parseRetryDelayMs`).
 *
 * v1.16.2 (T33 TRIM): switched to `generateContentStream` + `collectStream`
 * for two operator wins: (1) live `thinking: …` progress events during the
 * 30-120s thinking phase (previously only iter-counter notifications),
 * (2) heartbeat-aware `stallMs` watchdog that resets on every chunk —
 * catches dead sockets ~30× faster than wall-clock alone without
 * penalising legitimate deep reasoning. Mid-stream failures cannot be
 * retried (Gemini's generateContentStream has no resume), so the retry
 * wraps ONLY the stream OPENING — same contract as `ask`/`code`. The
 * assembled `CollectedResponse` is shape-identical to the previous
 * `GenerateContentResponse`, so all downstream extraction
 * (`response.candidates[0].content.parts`, `response.usageMetadata`) is
 * unchanged. The post-loop forced-finalization rescue does not stream
 * (`generateContent`); both mark their call completed the same way
 * (`completeCall`).
 */
async function streamIteration(args: IterationArgs): Promise<CollectedResponse> {
  const { ctx, resolvedModel, conversation, baseConfig, clock } = args;
  const abortSignal = clock.signal;
  const stream = await withNetworkRetry(
    () =>
      ctx.client.models.generateContentStream({
        model: resolvedModel,
        contents: conversation,
        config: { ...baseConfig, abortSignal },
      }),
    {
      signal: abortSignal,
      onRetry: (attempt, err) => {
        logger.warn(
          `ask_agentic: retrying generateContent after transient network failure (attempt ${attempt}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    },
  );
  return collectStream(stream, {
    signal: abortSignal,
    onThoughtChunk: args.onThoughtChunk,
    onChunkReceived: () => clock.recordChunk(),
  });
}

/** FINAL TEXT path — no function calls requested. A final-text iteration appends nothing new to
 * the conversation (it's the iteration that exits the loop), so there is no tool-response delta. */
function finalTextIteration(
  response: CollectedResponse,
  parts: Part[],
  usage: UsageCounts,
  thinkingSummary: string | null,
): IterationResult {
  const finalText =
    response.text ??
    parts
      .map((p) => p.text ?? '')
      .join('')
      .trim();
  return {
    finalText: finalText.length > 0 ? finalText : '(model returned empty response)',
    functionCallCount: 0,
    signatures: [],
    usage,
    thinkingSummary,
    toolResponseTokens: 0,
  };
}

/** The canonical relpath of `reqPath`, or `null` when it does not resolve — dispatch then produces
 * the real SandboxError (PATH_TRAVERSAL / NOT_FOUND etc.), so the model gets a useful error shape,
 * not a stale-cap-fire. */
async function canonicalRelpath(workspaceRoot: string, reqPath: string): Promise<string | null> {
  try {
    const r = await resolveInsideWorkspace(workspaceRoot, reqPath);
    return r.relpath;
  } catch {
    return null;
  }
}

/**
 * Short-circuit cap on distinct files read — canonical check: the refusal of a `read_file` past
 * `maxFilesRead`, or `null` when the call may run. `filesReadSet` is keyed on the sandbox-resolved
 * `relpath`, not the raw input, so path aliases (`./a.ts`, `a.ts`, `sub/../a.ts`) must be resolved
 * here too before comparing — otherwise the pre-dispatch gate rejects legitimate re-reads at cap
 * boundary. PR #24 round-3 review by GPT, Gemini, and self-review.
 */
async function capRefusal(
  fc: FunctionCall,
  call: ToolCall,
  args: IterationArgs,
): Promise<Part | null> {
  const { workspaceRoot, filesReadSet, maxFilesRead } = args;
  const atCap = call.name === 'read_file' && filesReadSet.size >= maxFilesRead;
  if (!atCap) return null;
  const reqPath = typeof call.args.path === 'string' ? call.args.path : '';
  const canonicalRel = await canonicalRelpath(workspaceRoot, reqPath);
  const alreadyRead = canonicalRel !== null && filesReadSet.has(canonicalRel);
  if (alreadyRead) return null;
  return {
    functionResponse: {
      ...(fc.id ? { id: fc.id } : {}),
      name: call.name,
      response: {
        error: `maxFilesRead (${maxFilesRead}) reached. Summarise with what you have already read, or ask a narrower question.`,
      },
    },
  };
}

async function planDispatch(
  functionCallParts: FunctionCallPart[],
  args: IterationArgs,
): Promise<DispatchPlan> {
  const plan: DispatchPlan = {
    signatures: [],
    responseParts: new Array(functionCallParts.length).fill(null),
    toDispatch: [],
    dispatchIndexMap: [],
  };
  for (let i = 0; i < functionCallParts.length; i++) {
    const part = functionCallParts[i];
    if (!part) continue;
    const fc = part.functionCall;
    const call: ToolCall = {
      name: fc.name ?? 'unknown',
      args: (fc.args ?? {}) as Record<string, unknown>,
    };
    plan.signatures.push(call);
    const refusal = await capRefusal(fc, call, args);
    if (refusal !== null) {
      plan.responseParts[i] = refusal;
      continue;
    }
    plan.dispatchIndexMap.push(i);
    plan.toDispatch.push({ name: call.name, args: call.args });
  }
  return plan;
}

/** A successful `read_file` adds its sandbox-resolved `relpath` — this closes the alias-bypass on
 * `maxFilesRead` because `./a.ts` and `a.ts` both yield `relpath: 'a.ts'` from `resolveInsideWorkspace`. */
function recordRead(res: DispatchedToolResult, filesReadSet: Set<string>): void {
  if (res.name !== 'read_file' || res.isError) return;
  const canonical = (res.response as { relpath?: string }).relpath;
  if (typeof canonical === 'string' && canonical.length > 0) {
    filesReadSet.add(canonical);
  }
}

/** Merge dispatched results back into `responseParts` at their original positions. */
function mergeDispatched(
  dispatched: DispatchedToolResult[],
  plan: DispatchPlan,
  functionCallParts: FunctionCallPart[],
  filesReadSet: Set<string>,
): void {
  for (let k = 0; k < dispatched.length; k++) {
    const res = dispatched[k];
    const originalIdx = plan.dispatchIndexMap[k];
    if (res === undefined || originalIdx === undefined) continue;
    const part = functionCallParts[originalIdx];
    if (!part) continue;
    const fc = part.functionCall;
    plan.responseParts[originalIdx] = {
      functionResponse: {
        ...(fc.id ? { id: fc.id } : {}),
        name: res.name,
        response: res.response,
      },
    };
    recordRead(res, filesReadSet);
  }
}

/**
 * P5 (v1.15.0): bytes/4 heuristic for the tool-response payload size — the
 * rescue's `finalizationEstimate` adds this to `lastIterationPromptTokens`
 * so its TPM/budget reservation accounts for the data that was appended to
 * `conversation` AFTER the iteration's `generateContent` returned (which
 * is what the rescue's prompt will replay). Stringify is wrapped in try so a
 * pathological circular-ref Part (shouldn't happen — Parts are POJOs from
 * the SDK + our `read_file` output — but defensive) falls back to 0
 * rather than blowing the loop. The static `PER_ITERATION_INPUT_TOKENS`
 * fallback at the rescue site still covers the 0-token edge.
 *
 * CC1 fix (v1.15.0 PR-Round-1, Copilot): UTF-8 BYTE length, not
 * String#length. The latter returns UTF-16 code units — for non-ASCII
 * content (CJK, emoji) it under-counts the UTF-8 byte size by 2-3x,
 * re-introducing rescue under-reservation on multilingual workloads.
 * Tokenizers approximate from UTF-8 bytes, so bytes/4 stays the
 * intended heuristic.
 */
function toolResponseTokensOf(finalResponseParts: Part[]): number {
  try {
    const serialized = JSON.stringify(finalResponseParts);
    return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4);
  } catch {
    return 0;
  }
}

/** How an iteration ended: with its result, or at the bound of its tools phase. */
export type IterationOutcome =
  | { readonly kind: 'done'; readonly iteration: IterationResult }
  | { readonly kind: 'tools-timed-out'; readonly running: number; readonly neverStarted: number };

/** How the tools phase ended: the batch's results, or the bound — with the work still running after the grace. */
type ToolsOutcome =
  | {
      readonly kind: 'done';
      readonly plan: DispatchPlan;
      readonly dispatched: DispatchedToolResult[];
    }
  | { readonly kind: 'timed-out'; readonly running: number; readonly neverStarted: number };

/** The tools phase's work as it runs: path resolution in flight, then the batch. */
class ToolsWork {
  resolving = false;
  batch: ToolBatch | null = null;

  constructor(private readonly calls: number) {}

  /** What still runs: a path resolution in flight counts as one call. */
  running(): number {
    return (this.resolving ? 1 : 0) + (this.batch?.running() ?? 0);
  }

  neverStarted(): number {
    return this.batch === null ? this.calls : this.batch.neverStarted();
  }
}

/** Resolve the plan, then run its batch — never once the clock fired. */
async function planAndRun(
  functionCallParts: FunctionCallPart[],
  args: IterationArgs,
  work: ToolsWork,
): Promise<{ plan: DispatchPlan; dispatched: DispatchedToolResult[] }> {
  work.resolving = true;
  const plan = await planDispatch(functionCallParts, args);
  work.resolving = false;
  throwIfAborted(args.clock.signal);
  work.batch = startToolBatch(
    args.workspaceRoot,
    plan.toDispatch,
    resolveToolExecutionConcurrency(),
    args.matchConfig,
    args.clock.signal,
  );
  return { plan, dispatched: await work.batch.settled };
}

/** `true` when `settled` settles within `graceMs`; the grace's timer is cleared when it does. */
async function settlesWithin(settled: Promise<unknown>, graceMs: number): Promise<boolean> {
  const grace = new AbortController();
  const inTime = settled.then(
    () => true,
    () => true,
  );
  const late = abortableSleep(graceMs, grace.signal).then(
    () => false,
    () => false,
  );
  const result = await Promise.race([inTime, late]);
  grace.abort();
  return result;
}

/**
 * The tools phase after its bound fired: the executors still running are given `toolSettleGraceMs` to settle; what
 * still runs then is counted and said, and whatever it returns later is dropped — it never reaches the conversation,
 * the files-read set or the ledger.
 */
async function toolsTimedOut(work: ToolsWork, settled: Promise<unknown>): Promise<ToolsOutcome> {
  const graceMs = PHASE_DEFAULTS.toolSettleGraceMs;
  const inTime = await settlesWithin(settled, graceMs);
  const running = inTime ? 0 : work.running();
  if (running > 0) {
    logger.warn(
      `ask_agentic: ${running} tool call(s) still running ${graceMs} ms after the iteration's bound; their results will be dropped`,
    );
    settled.then(
      () =>
        logger.debug('ask_agentic: a tool batch settled after its bound; its results were dropped'),
      (err: unknown) =>
        logger.debug(`ask_agentic: a tool batch failed after its bound: ${String(err)}`),
    );
  }
  return { kind: 'timed-out', running, neverStarted: work.neverStarted() };
}

/** Path resolution and the batch, raced as one against the pass's clock. */
async function runToolsPhase(
  functionCallParts: FunctionCallPart[],
  args: IterationArgs,
): Promise<ToolsOutcome> {
  const work = new ToolsWork(functionCallParts.length);
  const settled = planAndRun(functionCallParts, args, work);
  try {
    const { plan, dispatched } = await abortable(settled, args.clock.signal);
    return { kind: 'done', plan, dispatched };
  } catch (err) {
    if (!args.clock.signal.aborted) throw err;
    return toolsTimedOut(work, settled);
  }
}

/**
 * Run one iteration. The model's response (including the function calls) is recorded so the next turn has full
 * context — Gemini requires the full call-response pair to stay in the conversation; both turns are appended only when
 * the tools phase answered. The non-capped calls are dispatched in parallel; the concurrency resolves per call from the
 * env override (`GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY`), default 10. Remaining `null` slots shouldn't happen in
 * practice (every call gets either a short-circuit or a dispatched response), but are skipped rather than sending a
 * malformed turn to Gemini.
 */
export async function runAgenticIteration(args: IterationArgs): Promise<IterationOutcome> {
  const response = await streamIteration(args);
  const usage = completeCall(args.call, response);
  args.clock.enter('tools');
  const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const functionCallParts = parts.filter((p): p is FunctionCallPart =>
    Boolean(p.functionCall && typeof p.functionCall.name === 'string'),
  );
  const thinkingSummary = thinkingSummaryOf(parts);
  if (functionCallParts.length === 0) {
    return { kind: 'done', iteration: finalTextIteration(response, parts, usage, thinkingSummary) };
  }
  const tools = await runToolsPhase(functionCallParts, args);
  if (tools.kind === 'timed-out') return { ...tools, kind: 'tools-timed-out' };
  args.conversation.push({ role: 'model', parts });
  mergeDispatched(tools.dispatched, tools.plan, functionCallParts, args.filesReadSet);
  const finalResponseParts = tools.plan.responseParts.filter((p): p is Part => p !== null);
  args.conversation.push({ role: 'user', parts: finalResponseParts });
  const iteration: IterationResult = {
    finalText: null,
    functionCallCount: functionCallParts.length,
    signatures: tools.plan.signatures,
    usage,
    thinkingSummary,
    toolResponseTokens: toolResponseTokensOf(finalResponseParts),
  };
  return { kind: 'done', iteration };
}
