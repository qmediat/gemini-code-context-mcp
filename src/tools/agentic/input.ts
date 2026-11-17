/**
 * The input of `ask_agentic`: its zod schema (what the MCP host sees as the tool's input schema) and the type the
 * call reads it as.
 */

import { z } from 'zod';
import { PROMPT_FIELD, WORKSPACE_FIELD } from '../shared/question-fields.js';
import { THINKING_LEVEL_FIELD } from '../shared/thinking.js';

export const askAgenticInputSchema = z
  .object({
    prompt: PROMPT_FIELD,
    workspace: WORKSPACE_FIELD,
    model: z
      .string()
      .optional()
      .describe(
        "Model alias ('latest-pro', 'latest-pro-thinking', 'latest-flash') or literal model ID. Defaults to the configured default (GEMINI_CODE_CONTEXT_DEFAULT_MODEL, then the credentials profile, then `latest-pro-thinking`).",
      ),
    includeGlobs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional file extensions or filenames to include. Honoured by the four agentic tools (`list_directory`, `find_files`, `read_file`, `grep`) — the model never sees paths outside these globs. Mirrors the `ask` / `code` semantics so callers (or `ask` → `ask_agentic` fallback in v1.9.0+) get consistent filtering.',
      ),
    excludeGlobs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional patterns to exclude. Same three shapes as `ask` / `code`: (1) directory names or path prefixes (`node_modules`, `src/vendor`, `./dist/`, `.vercel/`), (2) literal filenames exact-match including bare dot-prefixed names (`pr27-diff.txt`, `foo.bar.baz`, `.env`, `.tsbuildinfo`), (3) extension globs that match via endsWith (`*.tsbuildinfo`, `*.map`). Bare dot-prefixed names like `.env` are treated as exact filename literals — write `*.env` for extension semantics. Paths are POSIX-normalised. Case-insensitive. No mid-string `*` / `**` / `?`. **Privacy-relevant:** when `ask` falls back to `ask_agentic` on `WORKSPACE_TOO_LARGE`, the user-supplied excludes here are honoured by every executor: `read_file` rejects with `EXCLUDED_FILE` (generic message — does NOT echo the excluded path, so the error string cannot be used as a path-existence oracle); `list_directory` and `grep` reject the requested directory / `pathPrefix` itself with `EXCLUDED_DIR` when it matches an exclude (top-level gate, not just child filtering); `find_files` skips the dir during walk; child entries inside an unexcluded parent are still hidden when they themselves match an exclude.',
      ),
    thinkingBudget: z.number().int().min(-1).max(65_536).optional(),
    thinkingLevel: THINKING_LEVEL_FIELD,
    maxOutputTokens: z.number().int().min(1).optional(),
    maxIterations: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Hard cap on agentic LOOP iterations (each iteration = one Gemini generateContent + possible tool calls). Default 20. When the loop exhausts this cap without producing final-text, ONE additional non-tool `generateContent` (forced-finalization rescue) runs to synthesise an answer from gathered tool responses. **`structuredContent.apiCalls` is the authoritative total `generateContent` count** (loop iterations + 1 if the rescue dispatched, regardless of outcome). `convergenceForced: true` indicates ONLY that the rescue produced text successfully — an attempted-but-failed rescue increments `apiCalls` without setting `convergenceForced`. Rescue is bounded by `dailyBudgetUsd` and `iterationTimeoutMs`; see `maxTotalInputTokens` for the cap-overshoot contract. **v1.15.0:** rescue-attempted-but-failed paths additionally surface `structuredContent.rescueErrorCode` (`'TIMEOUT' | 'RATE_LIMIT' | 'INTERNAL' | 'API_ERROR' | 'NETWORK' | 'EMPTY_TEXT'`) + `rescueErrorMessage` (truncated to 500 chars) so wrappers can branch retry behaviour without log scraping. Retry policy: TIMEOUT → raise iterationTimeoutMs; RATE_LIMIT → wait retry-hint window; INTERNAL → investigate code (don't retry blindly); API_ERROR → check status (don't retry 4xx); NETWORK → safe to retry; EMPTY_TEXT → narrow prompt.",
      ),
    maxTotalInputTokens: z
      .number()
      .int()
      .min(10_000)
      .optional()
      .describe(
        "Cumulative input-token budget across all iterations. Default 1_000_000. Loop iterations HARD-STOP past this cap (subReason: 'AGENTIC_INPUT_BUDGET_EXCEEDED'). The post-loop forced-finalization rescue is NOT gated on this cap — it may push cumulative tokens past by one call's worth, signalled via `overBudget: true` on the result. Rescue cost remains bounded by `dailyBudgetUsd`; wall-clock by `iterationTimeoutMs`.",
      ),
    maxFilesRead: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Cap on distinct files opened via `read_file` during this agentic call. Default 40.',
      ),
    iterationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .optional()
      .describe(
        "Per-iteration wall-clock timeout in ms (1s–30min). Each agentic iteration (one generateContent + possible tool calls + per-iteration TPM throttle wait) is bounded by this. **A single iteration that times out FAILS THE WHOLE agentic call** with `errorCode: 'TIMEOUT'` (the failed iteration's function-call results never came back, leaving the conversation structurally incomplete — continuing with partial state would 400 on the next turn). The post-loop forced-finalization rescue pass is ALSO bounded by this timeout, but its timeout behaviour DIFFERS: rescue timeouts are caught best-effort and fall through to the original `subReason: 'AGENTIC_MAX_ITERATIONS'` shape with `errorCode: 'UNKNOWN'` (NOT `'TIMEOUT'`) — the rescue is the documented exit path, and surfacing TIMEOUT for it would obscure the underlying maxIterations exhaustion. Operators detect rescue-attempted-but-failed via `apiCalls > iterations` and `convergenceForced` absent. Whole-loop budget is also bounded by `maxIterations` × `maxTotalInputTokens`. When omitted, falls back to env var `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS`, then to disabled.",
      ),
    stallMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe(
        'Per-iteration HEARTBEAT-AWARE stall watchdog in ms (1s–10min). Resets on every chunk yielded by `generateContentStream` (text or thought) — fires ONLY when the stream goes silent for this long. Does NOT fire while the model is actively thinking. Right knob for "kill dead sockets quickly without penalising deep reasoning." Recommended: `60_000` (60s). Falls back to env var `GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS`, then disabled. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "stall"` on abort. Independent of `iterationTimeoutMs` — both can be set; whichever fires first wins. The tool batch that runs after the stream ended is not counted: `iterationTimeoutMs` bounds it. **Loop iterations only — the post-loop forced-finalization rescue pass does not stream and has no stall watchdog.**',
      ),
  })
  .refine((data) => !(data.thinkingBudget !== undefined && data.thinkingLevel !== undefined), {
    message:
      'Cannot specify both `thinkingBudget` and `thinkingLevel` — mutually exclusive (Gemini rejects).',
    path: [],
  });

export type AskAgenticInput = z.infer<typeof askAgenticInputSchema>;
