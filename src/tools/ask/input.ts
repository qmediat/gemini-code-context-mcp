/**
 * The input of `ask`: its zod schema (what the MCP host sees as the tool's input schema) and the type the call reads it
 * as.
 */

import { z } from 'zod';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
} from '../../attachments.js';
import { CACHING_MODE_FALLBACK_DESCRIPTION } from '../../cache/caching-mode.js';
import { LONG_DECODE_CAP_DESCRIPTION } from '../shared/continuation.js';
import { PROMPT_FIELD, WORKSPACE_FIELD } from '../shared/question-fields.js';
import { SERVICE_TIER_DESCRIPTION } from '../shared/service-tier.js';
import { THINKING_LEVEL_FIELD } from '../shared/thinking.js';

export const askInputSchema = z
  .object({
    prompt: PROMPT_FIELD,
    workspace: WORKSPACE_FIELD,
    model: z
      .string()
      .optional()
      .describe(
        "Model alias ('latest-pro', 'latest-pro-thinking', 'latest-flash', 'latest-lite', 'latest-vision') or literal model ID. Defaults to the configured default.",
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
    noCache: z
      .boolean()
      .optional()
      .describe('Skip the context cache and embed files inline (slower, more expensive).'),
    thinkingBudget: z
      .number()
      .int()
      .min(-1)
      .max(65_536)
      .optional()
      .describe(
        "Explicit reasoning-token cap. OMIT to use each model's native default — recommended on Gemini 3 (Google flags explicit `thinkingBudget` as 'legacy'). Pass a value only when you need a specific cap: `-1` = legacy dynamic, `0` = disable thinking (rejected by Gemini 3 Pro), positive integer = fixed cap. CAVEAT on Gemini 3 Pro: low positive values (empirically ≤256 with cached content) can cause the API to hang — use `-1` or ≥4096 if you must bound it there. For discrete-tier control on Gemini 3 use `thinkingLevel` instead — the two are mutually exclusive.",
      ),
    thinkingLevel: THINKING_LEVEL_FIELD,
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        [
          "Per-call opt-in cap on response length (tokens). OMIT for the default 'auto' behaviour — Gemini uses its model-default cap (per Google docs, equal to the model's advertised `outputTokenLimit`: 65,536 for Gemini 3.x / 2.5 Pro-tier; see ai.google.dev/gemini-api/docs/models/gemini-2.5-pro). Pass a smaller value when you want a bounded response (e.g. strict summary length, tighter budget per call). On any other model a value larger than the resolved model's limit is clamped down to it. Budget reservation always uses the effective cap (explicit OR model limit) as worst-case, so `GEMINI_DAILY_BUDGET_USD` bounds what a completed call books (a request aborted mid-stream is booked 0: docs/cost-model.md).",
          LONG_DECODE_CAP_DESCRIPTION,
        ].join(' '),
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .optional()
      .describe(
        'Per-call wall-clock TOTAL timeout in ms (1s–30min). The cost ceiling — aborts the in-flight `generateContent` request even if it is actively streaming. A request aborted after its stream opened is booked 0; whether Google bills it is not measured (docs/cost-model.md). When omitted, falls back to env var `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`, then to disabled. v1.12.0 RECOMMENDATION: prefer `stallMs` for liveness — `timeoutMs` is the cost cap, `stallMs` is the heartbeat-aware liveness watchdog that does NOT fire while the model is actively thinking. Both can be set simultaneously. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "total"` on abort.',
      ),
    stallMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe(
        'Per-call HEARTBEAT-AWARE stall watchdog in ms (1s–10min, v1.12.0+). Resets on every chunk (text or thought) — fires ONLY when the stream goes silent for this long. Does NOT fire while the model is actively thinking — the streaming heartbeat (every ~1500ms via `onThoughtChunk`) keeps the watchdog reset. This is the right knob for "kill dead sockets quickly without penalising deep reasoning." Recommended setting: `60_000` (60s) — Gemini Pro can pause 15-30s mid-reasoning between thought chunks under heavy thinking; 60s absorbs jitter while still killing truly dead sockets ~30× faster than the wall-clock alternative. When omitted, falls back to env var `GEMINI_CODE_CONTEXT_ASK_STALL_MS`, then to disabled. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "stall"` on abort. Independent of `timeoutMs` — both can be set; whichever fires first wins.',
      ),
    preflightMode: z
      .enum(['heuristic', 'exact', 'auto'])
      .optional()
      .describe(
        "Token-count strategy for the WORKSPACE_TOO_LARGE preflight (v1.10.0+). `'heuristic'` = bytes/4 fast estimate (skips API call; coarse — undercounts dense Unicode by 30-50%). `'exact'` = always call Gemini's `countTokens` (free, no quota share with `generateContent`; ~hundreds of ms per call; cached per (filesHash + prompt + model) — `filesHash` is post-glob-filter so changing globs that resolve to different files invalidates automatically). `'auto'` (default, recommended) = heuristic when the workspace is well under 50% of the model's input limit; exact when near the cliff where accuracy matters. Use `'exact'` in CI / tests where you want predictable, accurate behaviour regardless of size.",
      ),
    serviceTier: z.enum(['standard', 'flex']).optional().describe(SERVICE_TIER_DESCRIPTION),
    attachments: z
      .array(z.string().min(1)) // the count cap is inspectAttachments' (ATTACHMENT_INVALID), not the schema's
      .optional()
      .describe(
        `Local image or PDF files (png, jpg, jpeg, webp, pdf; up to ${MAX_ATTACHMENTS}, ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each, ${MAX_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024} MB together) sent inline before the question — a screenshot of the bug, a diagram, a spec. Paths are inside the workspace (relative to it or absolute; a symlink is refused, the sandbox's secret rules apply, the first bytes must match the type). They belong to THIS question only, never to the workspace cache. Their tokens are counted by Gemini (one free countTokens call) and enter the size preflight, the budget reservation and the TPM throttle; a count that cannot be obtained refuses the call (ATTACHMENT_TOKENS_UNCOUNTED — retryable after a transient failure: no status, 429, 5xx; not after 401/403/404; a 400 means Gemini refused the parts: ATTACHMENT_INVALID). The model must support vision (ATTACHMENTS_UNSUPPORTED otherwise); a bad file is ATTACHMENT_INVALID, never retryable, and costs nothing. Not available with the ask_agentic fallback.`,
      ),
    cachingMode: z
      .enum(['explicit', 'implicit'])
      .optional()
      .describe(
        `Cache strategy for the workspace context. **\`'implicit'\` (default since v1.14.0)** skips \`caches.create\` entirely; file content is sent inline every call and Gemini 2.5+/3 Pro applies its automatic implicit caching on the repeated workspace prefix when prefix matches across calls. Optimised for the review→edit→review workflow — no 60–180 s rebuild wait when files change between queries. **\`'explicit'\`** builds a Gemini Context Cache via \`caches.create\` — guaranteed ~75% discount on cached input tokens, but pays the rebuild cost on every file change. Use explicit when you need predictable per-call costs more than warm-path latency; the trade-off is documented in Gemini's docs as 'no cost saving guarantee' for implicit caching. Hit rate is observable via \`status.structuredContent.caching.implicitHitRate\`. Operator-level override available via env \`GEMINI_CODE_CONTEXT_CACHING_MODE\`.${CACHING_MODE_FALLBACK_DESCRIPTION}`,
      ),
    forceRescan: z
      .boolean()
      .optional()
      .describe(
        'Bypass the v1.13.0 scan memo and re-hash every file in the workspace (default `false`). The scan memo skips per-file SHA256 when `mtime_ms` and `size` match the previously-stored values — typically ~95% of files on a warm rescan, cutting scan wall-clock by ≥10× on large workspaces. Set this when you suspect the manifest is stale (e.g. files mutated outside the dev workflow, NTP clock-skew, or you ran `git checkout` on a directory tree). Equivalent to setting env `GEMINI_CODE_CONTEXT_FORCE_RESCAN=true` for a single call.',
      ),
    onWorkspaceTooLarge: z
      .enum(['error', 'fallback-to-agentic'])
      .optional()
      .describe(
        "Behaviour when the v1.5.0 preflight detects the workspace exceeds the model's `inputTokenLimit × workspaceGuardRatio` (v1.11.0+). `'error'` (default — preserves v1.5.0 behaviour) returns a structured `errorCode: 'WORKSPACE_TOO_LARGE'` and lets the caller decide how to recover. `'fallback-to-agentic'` opt-in: the server transparently re-routes through `ask_agentic` (sandboxed file-access loop — no eager upload, scales to arbitrarily large repos), wraps the agentic result, and surfaces `fallbackApplied: 'ask_agentic'` in `structuredContent` so callers can audit the swap. **Semantic divergence:** `ask_agentic` runs as a multi-iteration loop, so `timeoutMs` (ask's wall-clock cap, per call or `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`) translates to `iterationTimeoutMs` (per-iteration cap; total wall-clock can be N × timeoutMs) and `stallMs` (per call or `GEMINI_CODE_CONTEXT_ASK_STALL_MS`) to the loop's `stallMs` (a stream's silence only — a tool batch longer than `stallMs` answers); a phase neither bounds ends at `ask_agentic`'s default (600 s for a request's opening and a silent stream, 120 s without progress in an iteration's tools). The result reports `iterTimeoutMs`, `iterTimeoutSource: 'timeoutMs'` and `stallMs`, and lifts `errorCode`, `retryable`, `timeoutKind`, `timeoutPhase` and `timeoutSource` of a failed agentic call. Cost shape also changes (multiple smaller calls vs one big eager call). Recommended setting for orchestrators that prioritise getting an answer over a single round-trip; default stays `'error'` so existing callers see no behaviour change. **`code` does NOT support this field** — `code`'s OLD/NEW edit format is load-bearing for Claude's Edit pipeline, and `ask_agentic` returns prose only.",
      ),
  })
  .refine((data) => !(data.thinkingBudget !== undefined && data.thinkingLevel !== undefined), {
    message:
      'Cannot specify both `thinkingBudget` and `thinkingLevel` — they are mutually exclusive. Gemini rejects the combination with 400. Choose one: `thinkingLevel` (recommended for Gemini 3) or `thinkingBudget` (required on Gemini 2.5).',
    // `path: []` (root-level error) reflects that the violation is the
    // RELATION between two fields, not a problem with either field
    // individually. MCP clients that render per-field errors won't
    // misattribute the issue to `thinkingLevel` alone.
    path: [],
  });

export type AskInput = z.infer<typeof askInputSchema>;
