/**
 * `code` tool — dedicated coding delegation to Gemini.
 *
 * Uses native Gemini features:
 *   - Thinking budget (reasoning tokens before generation)
 *   - Optional Code Execution tool (Gemini runs Python in a sandbox)
 *   - Coding-optimized system prompt
 *   - Structured output parser extracts code blocks and OLD/NEW diffs
 */

import { resolve } from 'node:path';
import type { GenerateContentConfig, ThinkingConfig } from '@google/genai';
import { z } from 'zod';
import type { PreparedContext } from '../cache/cache-manager.js';
import { CACHING_MODE_FALLBACK_DESCRIPTION, type RanCaching } from '../cache/caching-mode.js';
import {
  type BoundedOutputCap,
  type OutputCap,
  capThatRuns,
  thinkingBudgetRefusal,
} from '../gemini/long-decode.js';
import { ModelCategoryMismatchError } from '../gemini/model-taxonomy.js';
import { resolveModel } from '../gemini/models.js';
import type { ScanResult } from '../indexer/workspace-scanner.js';
import type { ResolvedModel } from '../types.js';
import { logger, safeForLog } from '../utils/logger.js';
import {
  type TextToolResult,
  type ToolContext,
  type ToolDefinition,
  errorResult,
  textResult,
} from './registry.js';
import type { ContextDecode } from './shared/context-decode.js';
import { type DecodedResponse, LONG_DECODE_CAP_DESCRIPTION } from './shared/continuation.js';
import {
  type RequestBuilder,
  type SettledDecode,
  decodeEagerCall,
  prepareCallContext,
  scanFields,
  settleDecoded,
  warnTruncatedScan,
} from './shared/eager-answer.js';
import {
  type EagerCall,
  type FailedEagerCall,
  type ModelReached,
  type StepOutcome,
  closeEagerCall,
  openEagerCall,
  settleFailedEager,
} from './shared/eager-call.js';
import {
  type InputEstimate,
  type OverWindow,
  type PreflightCount,
  countPreflight,
  eagerOutputCap,
  estimateInput,
  overWindow,
  preflightFields,
  reserveCallBudget,
  scanForCall,
} from './shared/eager-steps.js';
import {
  SERVICE_TIER_DESCRIPTION,
  ServiceTierError,
  type ServiceTierName,
  serviceTierConfig,
  serviceTierOrRefusal,
} from './shared/service-tier.js';
import { SYSTEM_INSTRUCTION_SAFETY_EAGER } from './shared/system-instruction-safety.js';
import {
  THINKING_LEVEL_FIELD,
  levelThinkingConfig,
  thinkingBudgetUnder,
  thinkingReserve,
} from './shared/thinking.js';
import { workspaceRefusal } from './shared/workspace-refusal.js';

/**
 * `code` system instruction. Prepends the shared `SYSTEM_INSTRUCTION_SAFETY_EAGER`
 * data-vs-instruction firewall (added in v1.15.2 — pre-v1.15.2 `code` had no
 * safety rules at all). The eager firewall is especially load-bearing for
 * `code` because the model is already steered to emit code edits in OLD/NEW
 * blocks that downstream consumers (Claude Code Edit-tool / IDE auto-apply)
 * may apply automatically — a hijacked model with no firewall could emit
 * malicious edits targeting unrelated files. Safety rules MUST come BEFORE
 * the edit-format guidance so the firewall is established first.
 */
const SYSTEM_INSTRUCTION_CODE = [
  SYSTEM_INSTRUCTION_SAFETY_EAGER,
  '',
  'You are an expert software engineer. Generate production-quality, idiomatic code with proper error handling.',
  'Match the existing code style and conventions visible in the provided workspace context.',
  '',
  'When modifying existing code, output edits in this exact format so they can be applied programmatically:',
  '',
  '  **FILE: <relative/path/to/file>**',
  '  ```',
  '  OLD:',
  '  <exact existing content to replace, including all whitespace>',
  '  NEW:',
  '  <replacement content>',
  '  ```',
  '',
  'The OLD block must be a unique, exact substring of the current file (include enough surrounding',
  'lines to make it unique). For net-new code, omit the OLD block (use an empty OLD).',
  '',
  'When generating brand-new files not yet in the workspace, use a standard fenced code block with',
  'the language hint and a comment on line 1 indicating the target path.',
  '',
  'Always explain briefly WHY a change is made before the edit block.',
].join('\n');

export const codeInputSchema = z
  .object({
    task: z.string().min(1).describe('Describe the coding task — what to build, refactor, or fix.'),
    workspace: z.string().optional().describe('Workspace path (default: cwd).'),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model alias or literal ID. Defaults to the configured default (GEMINI_CODE_CONTEXT_DEFAULT_MODEL, then the credentials profile); a configured default that resolves but cannot reason or think (a flash/lite tier) is replaced by 'latest-pro-thinking' for this tool and the response says so (configuredModelReplaced); a model named here is never replaced.",
      ),
    thinkingBudget: z
      .number()
      .int()
      .min(0)
      .max(65_536)
      .optional()
      .describe(
        'Explicit reasoning-token cap. Default (when both `thinkingBudget` and `thinkingLevel` are omitted): 16384 — a strong default for coding. Pass a positive integer to cap reasoning at that many tokens; `0` disables thinking (rejected by Gemini 3 Pro with 400). CAVEAT on Gemini 3 Pro: low positive values (empirically ≤256 with cached content) can cause the API to hang — use ≥4096 if you must bound it. For discrete-tier control on Gemini 3 use `thinkingLevel` instead — the two are mutually exclusive.',
      ),
    thinkingLevel: THINKING_LEVEL_FIELD,
    codeExecution: z
      .boolean()
      .optional()
      .describe(
        "Enable Gemini's Code Execution tool — Gemini can run Python in a sandbox to verify its output. Off by default.",
      ),
    expectEdits: z
      .boolean()
      .optional()
      .describe('Request OLD/NEW diff format in the response (default: true).'),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        [
          "Per-call opt-in cap on response length (tokens). OMIT for auto — Gemini uses its model-default cap (per Google docs, equal to the model's advertised `outputTokenLimit`: 65,536 for Gemini 3.x / 2.5 Pro-tier; see ai.google.dev/gemini-api/docs/models/gemini-2.5-pro). Pass a smaller value to bound a specific call (e.g. `maxOutputTokens: 16384` for a tight code-review summary). On any other model a value larger than the resolved model's limit is clamped to it. Operators who want EVERY call at full model capacity set `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true` at MCP-host level — that env override is still beaten by this per-call field.",
          LONG_DECODE_CAP_DESCRIPTION,
        ].join(' '),
      ),
    includeGlobs: z
      .array(z.string())
      .optional()
      .describe('Additional file extensions or filenames to include.'),
    excludeGlobs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional patterns to exclude. Supports three shapes: (1) directory names or path prefixes (`node_modules`, `src/vendor`, `./dist/`, `.vercel/`), (2) literal filenames exact-match, including bare dot-prefixed names (`pr27-diff.txt`, `foo.bar.baz`, `.env`, `.map`, `.tsbuildinfo`), (3) extension globs that match via endsWith (`*.tsbuildinfo`, `*.map`). Bare dot-prefixed names like `.env` are treated as exact filename literals — write `*.env` for extension semantics. Paths are POSIX-normalised (backslashes → `/`, leading `./` and trailing `/` stripped). Case-insensitive. No mid-string `*` / `**` / `?` — split into dir + extension patterns if needed.',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .optional()
      .describe(
        'Per-call wall-clock TOTAL timeout in ms (1s–30min). The cost ceiling — aborts the in-flight `generateContent` request even if it is actively streaming. A request aborted after its stream opened is booked 0; whether Google bills it is not measured (docs/cost-model.md). When omitted, falls back to env var `GEMINI_CODE_CONTEXT_CODE_TIMEOUT_MS`, then to disabled. v1.12.0 RECOMMENDATION: prefer `stallMs` for liveness — `timeoutMs` is the cost cap, `stallMs` is the heartbeat-aware liveness watchdog that does NOT fire while the model is actively thinking. Both can be set simultaneously. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "total"` on abort.',
      ),
    stallMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe(
        'Per-call HEARTBEAT-AWARE stall watchdog in ms (1s–10min, v1.12.0+). Resets on every chunk (text or thought) — fires ONLY when the stream goes silent for this long. Does NOT fire while the model is actively thinking. Recommended setting: `60_000` (60s). When omitted, falls back to env var `GEMINI_CODE_CONTEXT_CODE_STALL_MS`, then to disabled. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "stall"` on abort. Independent of `timeoutMs` — both can be set; whichever fires first wins.',
      ),
    serviceTier: z.enum(['standard', 'flex']).optional().describe(SERVICE_TIER_DESCRIPTION),
    cachingMode: z
      .enum(['explicit', 'implicit'])
      .optional()
      .describe(
        `Cache strategy for the workspace context. **\`'implicit'\` (default since v1.14.0)** skips \`caches.create\` entirely; file content is sent inline every call and Gemini 2.5+/3 Pro applies its automatic implicit caching on the repeated workspace prefix when prefix matches across calls. Optimised for the edit→review→edit cycle — no rebuild wait when files change between queries. **\`'explicit'\`** builds a Gemini Context Cache via \`caches.create\` — guaranteed ~75% discount on cached input tokens, but pays the 60–180 s rebuild cost on every file change. Note: \`code({ codeExecution: true })\` always forces inline content (Gemini rejects \`cachedContent\` + \`tools\` simultaneously), so \`cachingMode\` has no effect when codeExecution is enabled. Hit rate observable via \`status.structuredContent.caching.implicitHitRate\`. Operator-level override: env \`GEMINI_CODE_CONTEXT_CACHING_MODE\`.${CACHING_MODE_FALLBACK_DESCRIPTION}`,
      ),
    forceRescan: z
      .boolean()
      .optional()
      .describe(
        'Bypass the v1.13.0 scan memo and re-hash every file in the workspace (default `false`). The scan memo skips per-file SHA256 when `mtime_ms` and `size` match the previously-stored values. Set this when you suspect the manifest is stale (e.g. files mutated outside the dev workflow). Equivalent to setting env `GEMINI_CODE_CONTEXT_FORCE_RESCAN=true` for a single call.',
      ),
    preflightMode: z
      .enum(['heuristic', 'exact', 'auto'])
      .optional()
      .describe(
        "Token-count strategy for the WORKSPACE_TOO_LARGE preflight (v1.10.0+). `'heuristic'` = bytes/4 fast estimate (skips API call; coarse — undercounts dense Unicode by 30-50%). `'exact'` = always call Gemini's `countTokens` (free, no quota share with `generateContent`; ~hundreds of ms per call; cached per (filesHash + task + model) — `filesHash` is post-glob-filter so changing globs that resolve to different files invalidates automatically). `'auto'` (default, recommended) = heuristic when the workspace is well under 50% of the model's input limit; exact when near the cliff where accuracy matters. Use `'exact'` in CI / tests where you want predictable, accurate behaviour regardless of size.",
      ),
  })
  .refine((data) => !(data.thinkingBudget !== undefined && data.thinkingLevel !== undefined), {
    message:
      'Cannot specify both `thinkingBudget` and `thinkingLevel` — they are mutually exclusive. Gemini rejects the combination with 400. Choose one: `thinkingLevel` (recommended for Gemini 3) or `thinkingBudget` (required on Gemini 2.5).',
    // `path: []` (root-level error) reflects that the violation is the
    // RELATION between two fields, not a problem with either field
    // individually.
    path: [],
  })
  .refine((data) => data.thinkingLevel !== 'XHIGH', {
    message:
      "`thinkingLevel: 'XHIGH'` is not usable with `code`: only Gemini 4 Hydrogen takes it, a fast-tier model, and `code` runs reasoning-tier models, which answer it with a 400. Use `HIGH` here, or `ask` with `model: 'gemini-4-hydrogen'`.",
    path: ['thinkingLevel'],
  });

export type CodeInput = z.infer<typeof codeInputSchema>;

/** @internal — exported for testing only. Not part of the public API surface. */
export interface ParsedEdit {
  file: string;
  old: string;
  new: string;
}

/** Leads the text result of an answer with edits (`expectEdits`) cut at the output cap: its edit list is incomplete. */
export const TRUNCATED_EDITS_NOTE =
  '[truncated] The answer stopped at the output cap before the model finished it (see `finishReason`): the edit list below is cut — do not apply it as complete. Raise `maxOutputTokens` or lower the thinking, and ask again.';

/** Leads the text result of a prose answer (`expectEdits: false`) cut at the output cap. */
export const TRUNCATED_ANSWER_NOTE =
  '[truncated] The answer stopped at the output cap before the model finished it (see `finishReason`): the answer below is cut. Raise `maxOutputTokens` or lower the thinking, and ask again.';

/** The note that leads a truncated answer: about its edit list when edits were asked for, else about the prose. */
export function truncatedNote(expectEdits: boolean): string {
  return expectEdits ? TRUNCATED_EDITS_NOTE : TRUNCATED_ANSWER_NOTE;
}

const EDIT_REGEX =
  /\*\*FILE: (.+?)\*\*\s*\n```[^\n]*\n(?:OLD:\s*\n([\s\S]*?)\n)?NEW:\s*\n([\s\S]*?)\n```/g;

/** @internal — exported for testing only. Not part of the public API surface. */
export function parseEdits(text: string): ParsedEdit[] {
  const edits: ParsedEdit[] = [];
  for (const m of text.matchAll(EDIT_REGEX)) {
    const [, file, oldBlock, newBlock] = m;
    if (!file || newBlock === undefined) continue;
    edits.push({
      file: file.trim(),
      old: (oldBlock ?? '').trimEnd(),
      new: newBlock.trimEnd(),
    });
  }
  return edits;
}

const CODE_BLOCK_REGEX = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g;

/** @internal — exported for testing only. Not part of the public API surface. */
export function parseCodeBlocks(text: string): Array<{ lang: string; content: string }> {
  const blocks: Array<{ lang: string; content: string }> = [];
  for (const m of text.matchAll(CODE_BLOCK_REGEX)) {
    const [full, lang, content] = m;
    if (!content) continue;
    // Skip blocks that are edit OLD/NEW format — those are handled separately.
    if (content.startsWith('OLD:') || content.startsWith('NEW:')) continue;
    // Skip empty shell preamble blocks.
    if (full.trim().length === 0) continue;
    blocks.push({ lang: lang ?? '', content });
  }
  return blocks;
}

export const codeTool: ToolDefinition<CodeInput> = {
  name: 'code',
  title: 'Delegate coding to Gemini',
  description:
    'Delegate a coding task to Gemini using its native thinking budget and (optional) code execution. Returns structured edits in OLD/NEW format that Claude Code can apply via its Edit tool, plus a brief rationale.',
  schema: codeInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    return executeCodeBody(input, ctx, workspaceRoot, started);
  },
};

const CODE_FALLBACK_MODEL = 'latest-pro-thinking';
const CODE_CATEGORY: readonly ['text-reasoning'] = ['text-reasoning'];

/** `code`'s model audit, created in this field order: the results spread it. */
interface CodeModelReached extends ModelReached {
  readonly configuredModelReplaced: string | null;
}

interface CodeModelChoice {
  resolved: ResolvedModel;
  /** The configured default this call did not use, when `code` fell back to the alias; absent otherwise. */
  replacedDefault?: string;
}

/**
 * `code` needs a reasoning model that thinks (it always sends a thinking budget or level). A model the caller named is
 * resolved as asked and a category mismatch is the caller's error, as before. The CONFIGURED default (`fromConfig`) is
 * honoured when it resolves to such a model; when it resolves but cannot (a flash or lite alias or ID set for cheaper
 * `ask` calls, or a model without thinking), `code` uses the alias instead and says so — in the log and in the response
 * (`configuredModelReplaced`). A configured default that does not resolve at all fails the call, as it fails `ask`.
 */
async function resolveCodeModel(
  requested: string,
  fromConfig: boolean,
  client: Parameters<typeof resolveModel>[1],
): Promise<CodeModelChoice> {
  const replaceable = fromConfig && requested !== CODE_FALLBACK_MODEL;
  let why: string;
  try {
    const resolved = await resolveModel(requested, client, { requiredCategory: CODE_CATEGORY });
    if (!replaceable || resolved.capabilities.supportsThinking) return { resolved };
    why = `resolves to ${safeForLog(resolved.resolved)}, which does not support thinking`;
  } catch (err) {
    if (!replaceable || !(err instanceof ModelCategoryMismatchError)) throw err;
    why = `is '${safeForLog(err.actualCategory)}', not a reasoning model`;
  }
  logger.warn(
    `code: the configured default model ${safeForLog(requested)} ${why} — using ${CODE_FALLBACK_MODEL} for this call (set GEMINI_CODE_CONTEXT_DEFAULT_MODEL to a thinking pro alias, or pass model per call)`,
  );
  const resolved = await resolveModel(CODE_FALLBACK_MODEL, client, {
    requiredCategory: CODE_CATEGORY,
  });
  return { resolved, replacedDefault: requested };
}

/** One `code` call: its input with the two defaults read once, its context, its machinery. */
interface CodeCall {
  readonly input: CodeInput;
  readonly ctx: ToolContext;
  readonly eager: EagerCall<CodeModelReached>;
  /** OLD/NEW diff blocks asked for (default `true`). */
  readonly expectEdits: boolean;
  /** Gemini's Code Execution tool on (default `false`). */
  readonly codeExecution: boolean;
}

/** The model and the tier resolved, and the audit every later result carries. */
interface CodeResolved extends CodeCall {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
  readonly audit: CodeModelReached;
}

/** The workspace scanned, the output cap asked for, the input estimated and counted; no refusal over them. */
interface CodeCounted extends CodeResolved {
  readonly scan: ScanResult;
  readonly outputCap: OutputCap;
  readonly estimate: InputEstimate;
  readonly count: PreflightCount | null;
}

/** The cap that runs and the budget under it: the call as the reservation, the decode and the settlement read it. */
interface CodeSized extends CodeCounted {
  readonly bounded: BoundedOutputCap;
  /** The `thinkingBudget` sent on the budget path, clamped under the cap that runs; `0` on the level path, where
   * none is sent. */
  readonly thinkingBudget: number;
}

/** What the answer carries besides its text: the edits, the code blocks, the Code Execution tool's parts. */
interface CodeArtifacts {
  readonly edits: ParsedEdit[];
  readonly codeBlocks: Array<{ lang: string; content: string }>;
  readonly executedCode: string[];
  readonly executionOutput: string[];
}

/** `code`'s default thinking budget: strong reasoning for coding out of the box, which coding tasks benefit from. */
const CODE_DEFAULT_THINKING_BUDGET = 16_384;

/**
 * One `code` call: opened before its first await, its steps run in order — each goes on with the next stage or ends
 * the call — and closed on every path. Every throw of a step reaches the one failure path.
 */
async function executeCodeBody(
  input: CodeInput,
  ctx: ToolContext,
  workspaceRoot: string,
  started: number,
): Promise<TextToolResult> {
  const eager = openEagerCall<CodeModelReached>(
    {
      tool: 'code',
      knobs: input,
      requestedTier: input.serviceTier ?? ctx.config.serviceTier,
      workspaceRoot,
      started,
    },
    ctx,
  );
  const expectEdits = input.expectEdits ?? true;
  const codeExecution = input.codeExecution ?? false;
  try {
    const refusal = workspaceRefusal('code', workspaceRoot);
    if (refusal !== null) return refusal;
    const resolved = await resolveCode({ input, ctx, eager, expectEdits, codeExecution });
    if ('end' in resolved) return resolved.end;
    const counted = await guardCode(resolved.next);
    if ('end' in counted) return counted.end;
    const sized = sizeCode(counted.next);
    if ('end' in sized) return sized.end;
    return await answerCode(sized.next);
  } catch (err) {
    return codeFailedResult(settleFailedEager(eager, ctx, err));
  } finally {
    closeEagerCall(eager);
  }
}

/**
 * Resolve the model and the tier. The model asked for is the caller's, else the configured default
 * (GEMINI_CODE_CONTEXT_DEFAULT_MODEL, then the profile, then the alias — loadConfig always sets it), as `ask` and
 * `ask_agentic` read it; `resolveCodeModel` keeps `code` on a thinking reasoning model when the configured default is
 * not one, and the results name the replaced default. `code` is strictly text-reasoning: the category gate keeps an
 * image, audio or agent model (which may share `pro` tokens with text models in Google's registry) from reaching
 * `generateContent` with a coding prompt. From here every result, error results included, carries the audit, so an
 * audit of a failed call can still tell a fallback from a caller's choice.
 */
async function resolveCode(call: CodeCall): Promise<StepOutcome<CodeResolved>> {
  const { input, ctx, eager } = call;
  const modelRequest = input.model ?? ctx.config.defaultModel ?? CODE_FALLBACK_MODEL; // the last ?? as ask_agentic has it
  eager.emitter.emit(`resolving model '${modelRequest}'…`);
  const choice = await resolveCodeModel(modelRequest, input.model == null, ctx.client);
  const { resolved } = choice;
  const configuredModelReplaced = choice.replacedDefault ?? null;
  const serviceTier = serviceTierOrRefusal(input.serviceTier, ctx.config);
  if (serviceTier instanceof ServiceTierError) {
    return {
      end: errorResult(`code: ${serviceTier.message}`, {
        errorCode: serviceTier.code,
        retryable: false,
        serviceTier: 'flex',
        resolvedModel: resolved.resolved,
        configuredModelReplaced,
      }),
    };
  }
  const audit: CodeModelReached = {
    resolvedModel: resolved.resolved,
    configuredModelReplaced,
    serviceTier,
  };
  eager.trail.model = audit;
  if (choice.replacedDefault !== undefined) {
    eager.emitter.emit(
      `configured default model ${safeForLog(choice.replacedDefault)} replaced by ${CODE_FALLBACK_MODEL} for this call (code needs a thinking reasoning model)`,
    );
  }
  return { next: { ...call, resolved, serviceTier, audit } };
}

/**
 * Scan the workspace and hold the call against the model's window — the same guard as `ask`'s, with no fallback. A
 * positive `thinkingBudget` that leaves no answer reserve under the caller's own cap is refused first
 * (`thinkingBudgetRefusal`; the budget on the wire is clamped under the cap that runs later).
 */
async function guardCode(call: CodeResolved): Promise<StepOutcome<CodeCounted>> {
  const { input, ctx, eager, resolved } = call;
  const scan = await scanForCall(eager, ctx, input);
  const outputCap = eagerOutputCap(input.maxOutputTokens, ctx, resolved);
  const budgetRefusal = thinkingBudgetRefusal(
    input.thinkingBudget,
    input.maxOutputTokens,
    outputCap.effective,
  );
  if (budgetRefusal !== null) return { end: errorResult(`code: ${budgetRefusal}`) };
  const estimate = estimateInput(scan, input.task, 0);
  const count = await countPreflight(eager, ctx, {
    scan,
    prompt: input.task,
    resolved,
    mode: input.preflightMode,
    cap: outputCap,
    extraTokens: 0,
  });
  const counted: CodeCounted = { ...call, scan, outputCap, estimate, count };
  const over = overWindow(count, ctx);
  if (over !== null) return { end: codeTooLargeResult(counted, over) };
  return { next: counted };
}

/** The refusal of a workspace over the window, with the ways out. */
function codeTooLargeResult(call: CodeCounted, over: OverWindow): TextToolResult {
  const { counted, threshold, contextWindow } = over;
  return errorResult(
    `Workspace too large for eager \`code\`: ~${counted.effectiveTokens.toLocaleString()} input tokens (${counted.method} count) exceeds ${threshold.toLocaleString()} (${over.pctDisplay}% of ${call.resolved.resolved}'s ${contextWindow.toLocaleString()} context window). Options: (a) pass \`excludeGlobs\` to filter large/generated files — supports \`*.ext\` patterns, filenames, and directory paths, (b) narrow with \`includeGlobs\`, (c) switch to a larger-context model, (d) split the workspace into subdirectories, or (e) use \`ask_agentic\` for Q&A-style analysis without uploading the repo (\`code\` itself still requires the eager path for its OLD/NEW edit format).`,
    {
      errorCode: 'WORKSPACE_TOO_LARGE',
      retryable: false,
      estimatedInputTokens: counted.effectiveTokens,
      tokenCountMethod: counted.method,
      rawTokenCount: counted.rawTokens,
      tokenCountCacheHit: counted.cacheHit,
      contextWindowTokens: contextWindow,
      thresholdTokens: threshold,
      guardRatio: call.ctx.config.workspaceGuardRatio,
      ...call.audit,
      filesIndexed: call.scan.files.length,
    },
  );
}

/**
 * Size the call: the output cap bounded by the model's input window (a cut is said on the progress channel and the
 * log), the budget clamped under it, then the reservation — the thinking it counts from the cap that runs.
 */
function sizeCode(call: CodeCounted): StepOutcome<CodeSized> {
  const { input, eager } = call;
  const bounded = capThatRuns({
    tool: 'code',
    cap: call.outputCap,
    promptTokens: call.count?.preflight.effectiveTokens,
    inputTokenLimit: call.resolved.inputTokenLimit,
    emit: (message) => eager.emitter.emit(message),
  });
  const thinkingBudget = codeThinkingBudget(input, bounded.cap);
  const sized: CodeSized = { ...call, bounded, thinkingBudget };
  const refusal = reserveCallBudget(eager, call.ctx, sized, {
    promptChars: input.task.length,
    extraInputTokens: 0,
    thinkingTokens: thinkingReserve(input.thinkingLevel, thinkingBudget, bounded.cap),
  });
  if (refusal !== null) {
    return {
      end: errorResult(refusal, {
        errorCode: 'BUDGET_REJECT',
        retryable: false,
        ...call.audit,
      }),
    };
  }
  return { next: sized };
}

/**
 * The budget on the wire: the caller's `thinkingBudget`, else `code`'s default, clamped below the cap that runs —
 * after the input window's cut, so under a cap cut to one request `thinkingBudget < maxOutputTokens` holds too. `0` on
 * the `thinkingLevel` path (schema `.refine()` guarantees the two are never both set) and for a budget of `0`.
 */
function codeThinkingBudget(input: CodeInput, cap: OutputCap): number {
  if (input.thinkingLevel !== undefined) return 0;
  const budget = input.thinkingBudget ?? CODE_DEFAULT_THINKING_BUDGET;
  return budget > 0 ? thinkingBudgetUnder(cap, budget) : 0;
}

/**
 * Prepare the context — a cache only with files and without `codeExecution` (a cache cannot be combined with `tools`:
 * the files go inline) —, decode, parse the artefacts, then book the answer once. The artefacts are parsed BEFORE the
 * settlement: a failure there is booked at the completed requests and reports their usage. The stop at the output cap
 * is returned before the truncated-scan warning.
 */
async function answerCode(call: CodeSized): Promise<TextToolResult> {
  const { input, ctx, eager, scan } = call;
  const context = await prepareCallContext(eager, ctx, {
    scan,
    resolved: call.resolved,
    systemInstruction: SYSTEM_INSTRUCTION_CODE,
    allowCaching: scan.files.length > 0 && !call.codeExecution,
    requestedMode: input.cachingMode ?? ctx.config.cachingMode,
  });
  eager.emitter.emit(codeGeneratingLine(call));
  const decoded = await decodeEagerCall(
    eager,
    ctx,
    call,
    codeRequest(call, context.prepared),
    context,
  );
  const artifacts = codeArtifacts(decoded.response, call.expectEdits);
  const settledDecode = settleDecoded(eager, ctx, decoded, call, context.caching);
  const stop = settledDecode.settled.outputCapStop;
  // Settled and billed above; an empty answer at the cap is a failure the caller can act on, never a success.
  if (stop !== null) return errorResult(`code: ${stop.message}`, { ...call.audit, ...stop.fields });
  warnTruncatedScan(eager, ctx, scan);
  return codeAnswerResult(call, decoded, settledDecode, artifacts);
}

/** The progress line that opens the decode. */
function codeGeneratingLine(call: CodeSized): string {
  const level = call.input.thinkingLevel;
  const thinking =
    level !== undefined ? `thinking-level=${level}` : `thinking=${call.thinkingBudget}`;
  return call.codeExecution
    ? `generating with ${thinking} + codeExecution…`
    : `generating with ${thinking}…`;
}

/**
 * The request builder of one call; what a cached context forbids is `RequestBuilder`'s rule
 * (`./shared/eager-answer.ts`). `tools` (`codeExecution`) are among it, so with `codeExecution` an active cache is
 * bypassed (said in the log) and the caller's explicit request wins. The user prompt asks for OLD/NEW blocks when
 * edits are expected.
 */
function codeRequest(call: CodeSized, prepared: PreparedContext): RequestBuilder {
  const { codeExecution } = call;
  const userPrompt = call.expectEdits
    ? `${call.input.task}\n\nRespond with your rationale and OLD/NEW diff blocks per the system instruction.`
    : call.input.task;
  const canUseCache = (cacheId: string | null): boolean => cacheId !== null && !codeExecution;
  if (prepared.cacheId && codeExecution) {
    logger.warn(
      'code({ codeExecution: true }) is incompatible with an active cache; bypassing cache for this call.',
    );
  }
  const config = codeConfig(call, canUseCache);
  return (prep) => ({
    contents: canUseCache(prep.cacheId)
      ? userPrompt
      : [...prep.inlineContents, { role: 'user', parts: [{ text: userPrompt }] }],
    config: config(prep.cacheId),
  });
}

/**
 * The `config` of every request. With a cache, `cachedContent` and `thinkingConfig`; without one — or with the cache
 * bypassed for `codeExecution` — the full config, `tools` with `codeExecution`. `maxOutputTokens` goes on the wire only when the cap has a wire value (the caller's
 * `maxOutputTokens`, `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true`, or a cap the input window cut); otherwise Gemini
 * applies the model's default.
 */
function codeConfig(
  call: CodeSized,
  canUseCache: (cacheId: string | null) => boolean,
): (cacheId: string | null) => GenerateContentConfig {
  const thinkingConfig = codeThinkingConfig(call);
  const tierField = serviceTierConfig(call.serviceTier);
  const cap = call.bounded.cap;
  return (cacheId) => {
    const maxOutputField = cap.wire !== undefined ? { maxOutputTokens: cap.wire } : {};
    if (canUseCache(cacheId) && cacheId) {
      return { cachedContent: cacheId, thinkingConfig, ...maxOutputField, ...tierField };
    }
    return {
      systemInstruction: SYSTEM_INSTRUCTION_CODE,
      thinkingConfig,
      ...tierField,
      ...maxOutputField,
      ...(call.codeExecution ? { tools: [{ codeExecution: {} }] } : {}),
    };
  };
}

/**
 * The `thinkingConfig` of every request: the caller's `thinkingLevel` (`levelThinkingConfig`), else the budget.
 * `includeThoughts: true` always, so the answer has a thought summary to report.
 */
function codeThinkingConfig(call: CodeSized): ThinkingConfig {
  const level = call.input.thinkingLevel;
  return level !== undefined
    ? levelThinkingConfig(level)
    : { thinkingBudget: call.thinkingBudget, includeThoughts: true };
}

/**
 * The answer's artefacts: the OLD/NEW edits (when asked for), the code blocks, and the Code Execution tool's
 * `executableCode` / `codeExecutionResult` parts, which the stream collector does not accumulate — they are whole
 * per-chunk artefacts, read from the candidates.
 */
function codeArtifacts(response: DecodedResponse, expectEdits: boolean): CodeArtifacts {
  const { text } = response;
  const edits = expectEdits ? parseEdits(text) : [];
  const codeBlocks = parseCodeBlocks(text);
  return { edits, codeBlocks, ...executionParts(response) };
}

/** The Code Execution tool's parts of every candidate, in their order. */
function executionParts(
  response: DecodedResponse,
): Pick<CodeArtifacts, 'executedCode' | 'executionOutput'> {
  const executedCode: string[] = [];
  const executionOutput: string[] = [];
  for (const cand of response.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (part.executableCode?.code) executedCode.push(part.executableCode.code);
      if (part.codeExecutionResult?.output) executionOutput.push(part.codeExecutionResult.output);
    }
  }
  return { executedCode, executionOutput };
}

/** The answer: its text, led by the truncation note when it was cut, and what the call ran on and produced. */
function codeAnswerResult(
  call: CodeSized,
  decoded: ContextDecode,
  settledDecode: SettledDecode,
  artifacts: CodeArtifacts,
): TextToolResult {
  const { response } = decoded;
  const { finish } = settledDecode.settled;
  const { executedCode, executionOutput } = artifacts;
  // the thought summary as the stream collector capped it, the same the progress channel showed
  const thinkingSummary = response.thoughtsSummary;
  return textResult(
    finish.truncated ? `${truncatedNote(call.expectEdits)}\n\n${response.text}` : response.text,
    {
      ...codeModelFields(call),
      ...codeDecodeFields(decoded, settledDecode),
      ...artifactFields(artifacts),
      ...codeWorkspaceFields(call, decoded.prep, settledDecode.ran),
      ...preflightFields(call.count),
      ...(thinkingSummary ? { thinkingSummary } : {}),
      ...(executedCode.length > 0 ? { executedCode } : {}),
      ...(executionOutput.length > 0 ? { executionOutput } : {}),
    },
  );
}

/**
 * The audit, the model and the thinking the call ran with. `thinkingBudget` is the clamped value sent on the wire;
 * on the `thinkingLevel` path nothing is sent, so it is `null`, never `0` — the wire's "thinking disabled" — as
 * `ask` reports it.
 */
function codeModelFields(call: CodeSized): Record<string, unknown> {
  const { resolved, input } = call;
  return {
    ...call.audit,
    requestedModel: resolved.requested,
    modelCategory: resolved.category,
    modelCostTier: resolved.capabilities.costTier,
    contextWindow: resolved.inputTokenLimit,
    thinkingBudget: input.thinkingLevel !== undefined ? null : call.thinkingBudget,
    thinkingLevel: input.thinkingLevel ?? null,
    codeExecutionUsed: call.codeExecution,
  };
}

/** The context the decode ran on, what it billed and how it ended. */
function codeDecodeFields(
  decoded: ContextDecode,
  settledDecode: SettledDecode,
): Record<string, unknown> {
  const { prep, retriedOnStaleCache } = decoded;
  const { settled, durationMs } = settledDecode;
  return {
    cacheHit: prep.reused,
    cacheRebuilt: prep.rebuilt || retriedOnStaleCache,
    retriedOnStaleCache,
    ...settled.usage,
    ...settled.cutFields,
    // `truncated`: the answer stopped at the output cap (MAX_TOKENS, or a long decode at its limits) — it is cut
    finishReason: settled.finish.finishReason,
    truncated: settled.finish.truncated,
    durationMs,
  };
}

/** The edits as previews, the code blocks as their lengths. */
function artifactFields(artifacts: CodeArtifacts): Record<string, unknown> {
  const { edits, codeBlocks } = artifacts;
  return {
    edits: edits.map((e) => ({
      file: e.file,
      oldPreview: e.old.slice(0, 120),
      newPreview: e.new.slice(0, 120),
    })),
    editCount: edits.length,
    codeBlocks: codeBlocks.map((b) => ({ lang: b.lang, length: b.content.length })),
  };
}

/** What the scan indexed and dropped, what the upload could not send, and the caching mode that ran. */
function codeWorkspaceFields(
  call: CodeSized,
  prep: PreparedContext,
  ran: RanCaching,
): Record<string, unknown> {
  const { scan } = call;
  return {
    workspaceTruncated: scan.truncated,
    maxFilesCap: call.ctx.config.maxFilesPerWorkspace,
    filesIndexed: scan.files.length,
    ...scanFields(scan, prep),
    inlineOnly: prep.inlineOnly,
    cachingMode: ran.mode,
    ...(ran.note !== null ? { cachingModeNote: ran.note } : {}),
  };
}

/**
 * `code`'s result of a failed call: its model audit once the model resolved, none before — a timeout then carries no
 * tier, any other failure the requested one.
 */
function codeFailedResult(failure: FailedEagerCall<CodeModelReached>): TextToolResult {
  if (failure.kind === 'timeout') {
    return errorResult(failure.timedOut.message, {
      errorCode: 'TIMEOUT',
      timeoutKind: failure.timedOut.kind,
      timeoutMs: failure.timeoutMs,
      stallMs: failure.stallMs,
      retryable: true,
      ...failure.model,
      ...failure.usage,
    });
  }
  return errorResult(failure.message, {
    ...failure.tierMeta,
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    serviceTier: failure.requestedTier, // the audit's tier replaces it once the model resolved
    ...failure.model,
    ...failure.usage,
  });
}
