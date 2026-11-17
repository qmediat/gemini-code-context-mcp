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
import type { Content, GenerateContentConfig, ThinkingConfig, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { CACHING_MODE_FALLBACK_DESCRIPTION, cachingRan } from '../cache/caching-mode.js';
import { capThatRuns, thinkingBudgetRefusal } from '../gemini/long-decode.js';
import { ModelCategoryMismatchError } from '../gemini/model-taxonomy.js';
import { resolveModel } from '../gemini/models.js';
import type { ResolvedModel } from '../types.js';
import { logger, safeForLog } from '../utils/logger.js';
import { type TextToolResult, type ToolDefinition, errorResult, textResult } from './registry.js';
import { decodeOnContext } from './shared/context-decode.js';
import { LONG_DECODE_CAP_DESCRIPTION } from './shared/continuation.js';
import { prepareCallContext } from './shared/eager-answer.js';
import {
  type FailedEagerCall,
  type ModelReached,
  closeEagerCall,
  openEagerCall,
  settleFailedEager,
} from './shared/eager-call.js';
import {
  countPreflight,
  eagerOutputCap,
  estimateInput,
  reserveCallBudget,
  scanForCall,
  workspaceRefusal,
} from './shared/eager-steps.js';
import {
  SERVICE_TIER_DESCRIPTION,
  ServiceTierError,
  networkAttempts,
  resolveServiceTier,
  serviceTierConfig,
} from './shared/service-tier.js';
import { settleAnswer } from './shared/settle-call.js';
import { SYSTEM_INSTRUCTION_SAFETY_EAGER } from './shared/system-instruction-safety.js';
import { THINKING_LEVEL_FIELD, thinkingBudgetUnder, thinkingReserve } from './shared/thinking.js';

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

async function executeCodeBody(
  input: CodeInput,
  ctx: Parameters<typeof codeTool.execute>[1],
  workspaceRoot: string,
  started: number,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  // The configured default (GEMINI_CODE_CONTEXT_DEFAULT_MODEL, then the profile, then the alias — loadConfig always
  // sets it), as ask and ask_agentic read it. `resolveCodeModel` keeps `code` on a thinking reasoning model when the
  // configured default is not one, and the response names the replaced default.
  const modelRequest = input.model ?? ctx.config.defaultModel ?? CODE_FALLBACK_MODEL; // the last ?? as ask_agentic has it
  const expectEdits = input.expectEdits ?? true;
  const codeExecution = input.codeExecution ?? false;

  // Schema `.refine()` guarantees `thinkingBudget` and `thinkingLevel` are
  // never both set. `usingThinkingLevel` is a single source of truth for
  // the "is the caller driving reasoning via the discrete-tier knob?"
  // predicate — used by the cost estimate, the emitter message, and the
  // thinkingConfig shape below.
  const usingThinkingLevel = input.thinkingLevel !== undefined;

  // `code` keeps its pre-existing default of 16_384 for the `thinkingBudget`
  // path (strong reasoning for coding out of the box — coding tasks
  // genuinely benefit from it and callers rarely want to disable thinking).
  // When the caller uses `thinkingLevel` instead, `thinkingBudget` stays
  // undefined and we take the level branch below.
  const thinkingBudget = usingThinkingLevel ? undefined : (input.thinkingBudget ?? 16_384);

  const call = openEagerCall<CodeModelReached>(
    {
      tool: 'code',
      knobs: input,
      requestedTier: input.serviceTier ?? ctx.config.serviceTier,
      workspaceRoot,
      started,
    },
    ctx,
  );
  const { emitter, completed, tracking, dispatch } = call;
  const timeoutController = call.timeout;
  try {
    const refusal = workspaceRefusal('code', workspaceRoot);
    if (refusal !== null) return refusal;

    emitter.emit(`resolving model '${modelRequest}'…`);
    // `code` is strictly text-reasoning — coding tasks genuinely benefit
    // from reasoning tokens, and dispatching to fast/lite tiers would
    // degrade output quality without meaningful cost savings. Crucially:
    // this category gate prevents image-gen / audio-gen / agent models
    // (which may share `pro` tokens with text models in Google's registry)
    // from reaching `generateContent` with a code-review prompt — the
    // primary motivation for the v1.4.0 taxonomy work.
    const choice = await resolveCodeModel(modelRequest, input.model == null, ctx.client);
    const resolved = choice.resolved;
    // The same two fields on every result after this point, error results included: an audit of a failed call
    // can still tell a fallback from a caller's choice.
    let serviceTier: 'standard' | 'flex';
    try {
      serviceTier = resolveServiceTier(
        input.serviceTier,
        ctx.config.serviceTier,
        ctx.config.vertex,
      );
    } catch (err) {
      if (!(err instanceof ServiceTierError)) throw err;
      return errorResult(`code: ${err.message}`, {
        errorCode: err.code,
        retryable: false,
        serviceTier: 'flex',
        resolvedModel: resolved.resolved,
        configuredModelReplaced: choice.replacedDefault ?? null,
      });
    }
    const modelAudit: CodeModelReached = {
      resolvedModel: resolved.resolved,
      configuredModelReplaced: choice.replacedDefault ?? null,
      serviceTier,
    };
    call.trail.model = modelAudit;
    if (choice.replacedDefault !== undefined) {
      emitter.emit(
        `configured default model ${safeForLog(choice.replacedDefault)} replaced by ${CODE_FALLBACK_MODEL} for this call (code needs a thinking reasoning model)`,
      );
    }

    const scan = await scanForCall(call, ctx, {
      includeGlobs: input.includeGlobs,
      excludeGlobs: input.excludeGlobs,
      forceRescan: input.forceRescan,
    });
    const outputCap = eagerOutputCap(input.maxOutputTokens, ctx, resolved);

    // A positive `thinkingBudget` that leaves no answer reserve under the caller's own cap is refused
    // (`thinkingBudgetRefusal`); below, the budget on the wire is clamped under the cap that runs.
    const budgetRefusal = thinkingBudgetRefusal(
      input.thinkingBudget,
      input.maxOutputTokens,
      outputCap.effective,
    );
    if (budgetRefusal !== null) return errorResult(`code: ${budgetRefusal}`);

    const estimate = estimateInput(scan, input.task, 0);

    // The preflight: the same guard as `ask`'s, with no fallback.
    const count = await countPreflight(call, ctx, {
      scan,
      prompt: input.task,
      resolved,
      mode: input.preflightMode,
      cap: outputCap,
      extraTokens: 0,
    });
    const preflight = count?.preflight;
    if (count !== null && count.preflight.effectiveTokens > count.threshold) {
      const { threshold, contextWindow } = count;
      const counted = count.preflight;
      const pctDisplay = Math.round(ctx.config.workspaceGuardRatio * 100);
      return errorResult(
        `Workspace too large for eager \`code\`: ~${counted.effectiveTokens.toLocaleString()} input tokens (${counted.method} count) exceeds ${threshold.toLocaleString()} (${pctDisplay}% of ${resolved.resolved}'s ${contextWindow.toLocaleString()} context window). Options: (a) pass \`excludeGlobs\` to filter large/generated files — supports \`*.ext\` patterns, filenames, and directory paths, (b) narrow with \`includeGlobs\`, (c) switch to a larger-context model, (d) split the workspace into subdirectories, or (e) use \`ask_agentic\` for Q&A-style analysis without uploading the repo (\`code\` itself still requires the eager path for its OLD/NEW edit format).`,
        {
          errorCode: 'WORKSPACE_TOO_LARGE',
          retryable: false,
          estimatedInputTokens: counted.effectiveTokens,
          tokenCountMethod: counted.method,
          rawTokenCount: counted.rawTokens,
          tokenCountCacheHit: counted.cacheHit,
          contextWindowTokens: contextWindow,
          thresholdTokens: threshold,
          guardRatio: ctx.config.workspaceGuardRatio,
          ...modelAudit,
          filesIndexed: scan.files.length,
        },
      );
    }

    const { cap: runCap, cut: inputWindowCut } = capThatRuns({
      tool: 'code',
      cap: outputCap,
      promptTokens: preflight?.effectiveTokens,
      inputTokenLimit: resolved.inputTokenLimit,
      emit: (message) => emitter.emit(message),
    });

    // The budget on the wire: clamped below the cap that runs, after the input window's cut — a cap cut to one
    // request goes on the wire as its cut value, and `thinkingBudget < maxOutputTokens` holds there too.
    const effectiveThinkingBudget =
      thinkingBudget !== undefined && thinkingBudget > 0
        ? thinkingBudgetUnder(runCap, thinkingBudget)
        : 0;
    // The thinking the budget reservation counts, from the cap that runs.
    const thinkingTokensForEstimate = thinkingReserve(
      input.thinkingLevel,
      effectiveThinkingBudget,
      runCap,
    );

    const reservation = reserveCallBudget(call, ctx, {
      resolved,
      serviceTier,
      estimate,
      promptChars: input.task.length,
      extraInputTokens: 0,
      cap: runCap,
      countedInputTokens: preflight?.effectiveTokens,
      thinkingTokens: thinkingTokensForEstimate,
    });
    if (reservation.kind === 'rejected') {
      return errorResult(reservation.message, {
        errorCode: 'BUDGET_REJECT',
        retryable: false,
        ...modelAudit,
      });
    }

    const context = await prepareCallContext(call, ctx, {
      scan,
      resolved,
      systemInstruction: SYSTEM_INSTRUCTION_CODE,
      // a cache cannot be combined with `tools` (codeExecution): the files go inline
      allowCaching: scan.files.length > 0 && !codeExecution,
      requestedMode: input.cachingMode ?? ctx.config.cachingMode,
    });
    const { caching, prepare, prepared: ctxPrep } = context;

    const userPrompt = expectEdits
      ? `${input.task}\n\nRespond with your rationale and OLD/NEW diff blocks per the system instruction.`
      : input.task;

    const thinkingDescription = usingThinkingLevel
      ? `thinking-level=${input.thinkingLevel}`
      : `thinking=${effectiveThinkingBudget}`;
    emitter.emit(
      codeExecution
        ? `generating with ${thinkingDescription} + codeExecution…`
        : `generating with ${thinkingDescription}…`,
    );

    // Two mutually-exclusive reasoning-control paths (enforced by schema
    // `.refine()`):
    //   a) `thinkingLevel` set → cast to the SDK enum and pass through.
    //      Google's recommended path on Gemini 3. Rejected by Gemini 2.5.
    //      Cast rather than runtime enum-object lookup so a future SDK
    //      rename surfaces as a Gemini 400, not a silent `undefined`.
    //   b) `thinkingBudget` path (default 16_384, clamped above) → pass
    //      `thinkingBudget` as before.
    // `includeThoughts: true` is unconditional so `thinkingSummary`
    // extraction below always has material to find.
    const thinkingConfig: ThinkingConfig = usingThinkingLevel
      ? {
          thinkingLevel: input.thinkingLevel as ThinkingLevel,
          includeThoughts: true,
        }
      : { thinkingBudget: effectiveThinkingBudget, includeThoughts: true };

    // Gemini rejects generateContent({cachedContent, system_instruction|tools|tool_config})
    // with 400. System instruction is baked into the cache at build time; tools
    // (codeExecution) cannot be combined with a cache built without them. When
    // codeExecution is requested AND a cache is active, we can't use both — in that
    // case we bypass the cache so the user's explicit codeExecution request wins.
    const canUseCache = (cacheId: string | null): boolean => cacheId !== null && !codeExecution;
    if (ctxPrep.cacheId && codeExecution) {
      logger.warn(
        'code({ codeExecution: true }) is incompatible with an active cache; bypassing cache for this call.',
      );
    }
    const tierField = serviceTierConfig(serviceTier);
    const buildConfig = (cacheId: string | null): GenerateContentConfig => {
      const maxOutputField = runCap.wire !== undefined ? { maxOutputTokens: runCap.wire } : {};
      if (canUseCache(cacheId) && cacheId) {
        // With cache: system_instruction is baked in; thinkingConfig remains OK.
        // `maxOutputTokens` only emitted when the caller set it explicitly
        // or `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true` — otherwise omit
        // and Gemini uses its model-default.
        return {
          cachedContent: cacheId,
          thinkingConfig,
          ...maxOutputField,
          ...tierField,
        };
      }
      // Without cache (or cache bypassed for codeExecution): pass full config.
      return {
        systemInstruction: SYSTEM_INSTRUCTION_CODE,
        thinkingConfig,
        ...tierField,
        ...maxOutputField,
        ...(codeExecution ? { tools: [{ codeExecution: {} }] } : {}),
      };
    };
    const buildContents = (
      cacheId: string | null,
      inline: typeof ctxPrep.inlineContents,
    ): string | Content[] =>
      canUseCache(cacheId)
        ? userPrompt
        : [...inline, { role: 'user', parts: [{ text: userPrompt }] }];

    // The decode and its one stale-cache retry — the shared path of `ask` and `code` (see ask.tool.ts).
    const decoded = await decodeOnContext(
      {
        client: ctx.client,
        booking: { workspaceRoot, toolName: 'code', model: resolved.resolved, serviceTier },
        // `cachingRan`: a codeExecution call is forced inline and never builds a cache.
        cachingMode: (prep) => cachingRan(prep, caching).mode,
        request: (prep) => ({
          contents: buildContents(prep.cacheId, prep.inlineContents),
          config: buildConfig(prep.cacheId),
        }),
        cache: {
          ttlWatcher: ctx.ttlWatcher,
          manifest: ctx.manifest,
          ttlSeconds: ctx.config.cacheTtlSeconds,
          prepare,
        },
        openAttempts: networkAttempts(serviceTier), // a flex request is never re-sent
        limits: { maxRequests: runCap.maxRequests, cap: runCap.effective },
        timeout: timeoutController,
        emit: (message) => emitter.emit(message),
        completed,
        tracking,
        throttle: dispatch,
        inputTokens: { estimated: estimate.tokens, counted: preflight?.effectiveTokens },
      },
      ctxPrep,
    );
    const { response, prep: activePrep, retriedOnStaleCache } = decoded;

    const text = response.text;
    const edits = expectEdits ? parseEdits(text) : [];
    const codeBlocks = parseCodeBlocks(text);

    // Extract code_execution tool artifacts. Thought summary now comes from
    // `collectStream` (T20) — `response.thoughtsSummary` is already capped
    // and matches the live progress emit. We still iterate candidates here
    // for executableCode / codeExecutionResult parts (those aren't
    // accumulated by collectStream — they're full per-chunk artefacts).
    const executedCode: string[] = [];
    const executionOutput: string[] = [];
    const candidates = response.candidates ?? [];
    for (const cand of candidates) {
      const parts = cand.content?.parts ?? [];
      for (const part of parts) {
        if (part.executableCode?.code) executedCode.push(part.executableCode.code);
        if (part.codeExecutionResult?.output) executionOutput.push(part.codeExecutionResult.output);
      }
    }
    const thinkingSummary = response.thoughtsSummary;

    // Telemetry and the response record the mode that ran, not the one asked for
    // (`cachingRan`: a codeExecution call is forced inline and never builds a cache).
    const ran = cachingRan(activePrep, caching);
    const effectiveCachingMode = ran.mode;

    const durationMs = Date.now() - started;
    // Settled here, once: the outer catch then neither releases the reservation nor books the call again. What the
    // API billed is every request that completed, over a long decode and a stale-cache retry alike.
    const settledReservation = call.trail.reservationId;
    call.trail.reservationId = null;
    tracking.ledgerEntry = null;
    const settled = settleAnswer({
      manifest: ctx.manifest,
      reservationId: settledReservation,
      entry: {
        workspaceRoot,
        toolName: 'code',
        model: resolved.resolved,
        serviceTier,
        cachingMode: effectiveCachingMode,
      },
      completed,
      response,
      cap: runCap,
      cut: inputWindowCut,
      durationMs,
    });
    const finish = settled.finish;

    // Settled and billed above; an empty answer at the cap is a failure the caller can act on, never a success.
    if (settled.outputCapStop !== null) {
      return errorResult(`code: ${settled.outputCapStop.message}`, {
        ...modelAudit,
        ...settled.outputCapStop.fields,
      });
    }

    if (scan.truncated) {
      logger.warn(
        `workspace ${workspaceRoot} contains more files than GEMINI_CODE_CONTEXT_MAX_FILES (${ctx.config.maxFilesPerWorkspace}); the tail was dropped before indexing.`,
      );
    }

    const structured: Record<string, unknown> = {
      ...modelAudit,
      requestedModel: resolved.requested,
      modelCategory: resolved.category,
      modelCostTier: resolved.capabilities.costTier,
      contextWindow: resolved.inputTokenLimit,
      // `thinkingBudget` echoes the clamped value actually sent on the
      // wire; it's only meaningful on the budget path. On the
      // `thinkingLevel` path nothing is sent for `thinkingBudget`, so we
      // emit `null` (not `0`) — `0` is the wire sentinel for "thinking
      // disabled" and reporting it here for a level-path call would lie
      // to downstream audit / dashboard consumers (PR #17 self-review F1,
      // 3-reviewer consensus: GPT + Copilot + Self). Matches `ask.tool.ts`.
      thinkingBudget: usingThinkingLevel ? null : effectiveThinkingBudget,
      thinkingLevel: input.thinkingLevel ?? null,
      codeExecutionUsed: codeExecution,
      cacheHit: activePrep.reused,
      cacheRebuilt: activePrep.rebuilt || retriedOnStaleCache,
      retriedOnStaleCache,
      ...settled.usage,
      ...settled.cutFields,
      // `truncated`: the answer stopped at the output cap (MAX_TOKENS, or a long decode at its limits) — it is cut
      finishReason: finish.finishReason,
      truncated: finish.truncated,
      durationMs,
      edits: edits.map((e) => ({
        file: e.file,
        oldPreview: e.old.slice(0, 120),
        newPreview: e.new.slice(0, 120),
      })),
      editCount: edits.length,
      codeBlocks: codeBlocks.map((b) => ({ lang: b.lang, length: b.content.length })),
      workspaceTruncated: scan.truncated,
      maxFilesCap: ctx.config.maxFilesPerWorkspace,
      filesIndexed: scan.files.length,
      excludedDirs: scan.excludedDirs,
      excludedDirsTotal: scan.excludedDirsTotal,
      filesSkippedNonSource: scan.skippedNonSource,
      filesUploadFailed: activePrep.uploaded.failedCount,
      ...(activePrep.uploaded.failedCount > 0
        ? { uploadFailures: activePrep.uploaded.failures.slice(0, 5) }
        : {}),
      inlineOnly: activePrep.inlineOnly,
      cachingMode: effectiveCachingMode,
      ...(ran.note !== null ? { cachingModeNote: ran.note } : {}),
      // Preflight token-count provenance — surfaces on every successful
      // call. See ask.tool.ts for the contract; same fields apply here.
      ...(preflight !== undefined
        ? {
            tokenCountMethod: preflight.method,
            rawTokenCount: preflight.rawTokens,
            tokenCountCacheHit: preflight.cacheHit,
          }
        : {}),
      ...(thinkingSummary ? { thinkingSummary } : {}),
      ...(executedCode.length > 0 ? { executedCode } : {}),
      ...(executionOutput.length > 0 ? { executionOutput } : {}),
    };

    return textResult(
      finish.truncated ? `${truncatedNote(expectEdits)}\n\n${text}` : text,
      structured,
    );
  } catch (err) {
    return codeFailedResult(settleFailedEager(call, ctx, err));
  } finally {
    closeEagerCall(call);
  }
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
