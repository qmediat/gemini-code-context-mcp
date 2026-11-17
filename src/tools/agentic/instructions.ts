/**
 * What `ask_agentic` sends the model besides the conversation: the system instructions of the loop and of the
 * forced-finalization pass, and the declarations of the four sandboxed tools the loop may call.
 */

import type { FunctionDeclaration, Schema } from '@google/genai';
import { Type as GeminiType } from '@google/genai';
import { SYSTEM_INSTRUCTION_SAFETY_AGENTIC } from '../shared/system-instruction-safety.js';

// ---------------------------------------------------------------------------
// systemInstruction — prompt-injection defence + tool usage guidance
// ---------------------------------------------------------------------------

// Safety preamble — moved to `../shared/system-instruction-safety.ts` in v1.15.2
// so `ask` and `code` can share the same firewall. See that module for the
// full rationale + threat model. Two variants exist (AGENTIC vs EAGER) because
// the data-vs-instruction wording must match the file-delivery channel.
//
// `ask_agentic` uses the AGENTIC variant (references the four agentic
// executors that surface file content into `conversation`). The rescue pass
// uses the same variant — even though tool dispatch is disabled on the
// rescue, the conversation history still contains tool-response data that
// could carry adversarial text, so the firewall stays in effect.

export const SYSTEM_INSTRUCTION_AGENTIC = [
  'You are a senior code reviewer analysing a user codebase via sandboxed file-access tools.',
  '',
  SYSTEM_INSTRUCTION_SAFETY_AGENTIC,
  '',
  '# TOOLS AVAILABLE',
  '- `list_directory(path)` — list immediate children (files + subdirs) of a workspace-relative path. Start with `"."` to see the root.',
  '- `find_files(pattern)` — recursive glob (`*` any-except-slash, `**` any). Good for locating files by name without reading them.',
  '- `read_file(path, startLine?, endLine?)` — read a file (or slice). Responses are hard-capped at 200 KB; you will see `truncated: true` with `totalLines` metadata — page through large files via startLine/endLine.',
  '- `grep(pattern, pathPrefix?)` — JS RegExp search. Great for finding symbols before opening files.',
  '',
  '# STRATEGY',
  'Prefer narrow tool calls over wide ones. A typical flow:',
  '1. Scout with `list_directory(".")` or `find_files("**/*.ts")`',
  '2. Locate relevant symbols with `grep`',
  '3. Open only the handful of files that actually bear on the question via `read_file`',
  'When you have enough context, respond with a plain-text answer and make NO further tool calls.',
  'Batch your tool calls within a single iteration. If you need to read 5 files, issue all 5 `read_file` calls in ONE turn rather than one-per-iteration across 5 turns — each iteration costs 30-60s of thinking-token latency that you only pay once when calls are batched. The dispatcher runs the batch in parallel (up to 10 concurrent by default). Only batch calls for paths you have already seen in prior tool results (e.g., from `list_directory`, `find_files`, or `grep` output) or that the user provided. Never synthesize or guess additional paths solely to fill a batch — a hallucinated path costs the same iteration latency as the split you were trying to avoid, and the executors will reject it.',
  '',
  '# DECISIVENESS',
  "Be decisive. Once you have read the relevant files and gathered evidence, produce your final answer. Continuing to call tools when you already have an answer is a failure mode — it wastes the user's budget and delays the response.",
  'When the user provides a complete diff inline, your primary task is reasoning ABOUT the diff. Read each touched file at most once unless a specific concern requires re-reading; do not recursively explore the project tree to verify what the diff already shows.',
  'A focused investigation typically converges in 3–8 iterations. If you find yourself on iteration 10+ still calling tools, stop and synthesize what you know — state findings as Known / Unknown / Next checks rather than chasing completeness.',
  '',
  '# OUTPUT',
  "Your final response (the one with no function calls) should directly answer the user's prompt. Cite specific `file:line` when referring to code. Be concrete; do not speculate beyond what you read.",
].join('\n');

/**
 * Forced-finalization system instruction. Sent on the post-loop synthesis
 * pass when the iteration budget is exhausted. Combined with
 * `toolConfig.functionCallingConfig.mode = NONE`, the model is prohibited
 * from emitting further function calls (per Gemini API spec, NONE mode is
 * "equivalent to sending a request without any function declarations") and
 * must answer with text using the conversation it has already accumulated.
 *
 * Tightened in v1.14.4 after empirical replay (2026-04-30) showed Gemini 3 Pro
 * under HIGH thinking treating the previous "Synthesize the evidence ... in
 * the format the user originally requested" wording as an invitation to
 * narrate its thought process — producing stream-of-consciousness output
 * instead of the structured findings the caller requested. The CRITICAL
 * OUTPUT INSTRUCTIONS block below is authoritative ordering: parse the
 * caller's format spec, synthesize evidence into it, no preamble, no narrative,
 * no apologies. The user's original prompt (with any output-format directive)
 * is preserved across the rescue via `contents[0]`, so the model has the
 * format spec available — the system instruction's job is to enforce
 * compliance.
 *
 * SAFETY: this rescue runs with `mode: NONE` (tools disabled) but still
 * evaluates the FULL conversation history including any malicious payloads
 * surfaced by prior `read_file` / `grep` results (LLM calls are stateless
 * per Gemini API semantics — each turn's output is generated under THAT
 * turn's systemInstruction). The shared `SYSTEM_INSTRUCTION_SAFETY_AGENTIC` block
 * (data-vs-instruction firewall) is therefore prepended below. A 3-of-3
 * cross-reviewer audit on 2026-04-30 (gemini-cli + gemini-chat + grok)
 * flagged the prior absence as an indirect-prompt-injection vector.
 *
 * v1.15.0 (C2): citation directive conditionalised symmetrically with the
 * "Unknown" handling — both gemini-chat (Round-2) and Copilot (Round-1)
 * flagged the v1.14.4 unconditional `Cite specific file:line` as a
 * potential format-break for strict JSON / fixed-shape outputs (e.g., a
 * pure JSON array of strings can't carry `(file:42)` annotations without
 * mutating the data). Now reads "ONLY where the requested format provides
 * a compatible place to put citations".
 */
export const SYSTEM_INSTRUCTION_FINALIZATION = [
  SYSTEM_INSTRUCTION_SAFETY_AGENTIC,
  '',
  'You are wrapping up an investigation. The conversation history above already contains the tool responses you have gathered.',
  'Your iteration budget is now exhausted. You CANNOT call any more tools — function calling is disabled for this turn.',
  '',
  'CRITICAL OUTPUT INSTRUCTIONS:',
  "1. PARSE the user's original prompt for exact output format specifications (e.g., markdown headers, JSON shape, tables).",
  '2. STRICTLY follow that requested structure.',
  '3. Synthesize the gathered evidence into the final answer and output it DIRECTLY in the requested structure. Provide NO preamble, NO apologies, NO "Here is the summary", and NO internal thinking or narrative notes.',
  '',
  'If some details remain unverified, integrate an "Unknown" element ONLY if it is compatible with the parsed output shape (e.g., adds a row to a table, a field to a JSON object, a sub-bullet under a heading); never add extraneous keys or sections that would invalidate the requested format. Cite specific `file:line` for the claims you can support — but ONLY where the requested format provides a compatible place to put citations (e.g., a sub-bullet, an additional column, embedded inside an existing string field); never break the requested structure to add citations.',
].join('\n');

// ---------------------------------------------------------------------------
// Function declarations — these get serialised and sent to Gemini so the
// model knows which tools it may invoke + what arguments each takes.
//
// Schemas use the SDK's Upper-Case type enum values (`STRING`, `INTEGER`,
// `OBJECT`). Each declaration is built fresh per call, so no request shares
// an object with another.
// ---------------------------------------------------------------------------

const stringProp = (description: string): Schema => ({ type: GeminiType.STRING, description });
const intProp = (description: string): Schema => ({ type: GeminiType.INTEGER, description });

function listDirectoryDeclaration(): FunctionDeclaration {
  return {
    name: 'list_directory',
    description:
      'List the immediate children (files + subdirectories) of a workspace-relative directory path. Does NOT recurse. Excluded directories (node_modules, .git, .next, etc.) and denylisted filenames (lockfiles, .env, etc.) are silently filtered out.',
    parameters: {
      type: GeminiType.OBJECT,
      properties: {
        path: stringProp(
          'Workspace-relative directory path. Use "." for the workspace root. No leading `/`.',
        ),
      },
      required: ['path'],
    } as Schema,
  };
}

function findFilesDeclaration(): FunctionDeclaration {
  return {
    name: 'find_files',
    description:
      'Recursive glob search for files under the workspace root. Supports `*` (match any character except `/`) and `**` (match any character including `/`). Examples: `**/*.ts`, `src/**/index.*`, `README.md`. Respects the same default excludes as list_directory.',
    parameters: {
      type: GeminiType.OBJECT,
      properties: {
        pattern: stringProp(
          'Glob pattern relative to workspace root. Uses `*` and `**` only (no `?`, no character classes, no `{a,b}`). Match is anchored — the pattern must match the whole relative path.',
        ),
      },
      required: ['pattern'],
    } as Schema,
  };
}

function readFileDeclaration(): FunctionDeclaration {
  return {
    name: 'read_file',
    description:
      'Read a file from the workspace, optionally a line-range slice. Responses are hard-capped at 200 KB; if the file is larger you get a head-truncated slice with `truncated: true` and `totalLines` metadata. Call again with `startLine` / `endLine` to page through. Rejects binary / non-source extensions.',
    parameters: {
      type: GeminiType.OBJECT,
      properties: {
        path: stringProp('Workspace-relative file path.'),
        startLine: intProp('1-indexed inclusive start line. Omit for line 1.'),
        endLine: intProp(
          '1-indexed inclusive end line. Omit to read until the default or byte cap kicks in.',
        ),
      },
      required: ['path'],
    } as Schema,
  };
}

function grepDeclaration(): FunctionDeclaration {
  return {
    name: 'grep',
    description:
      'Regular-expression search through source files in the workspace. Pattern is compiled as a JavaScript RegExp (standard metacharacters). Each match line is capped at 500 characters. At most 100 matches per call.',
    parameters: {
      type: GeminiType.OBJECT,
      properties: {
        pattern: stringProp('JavaScript regular-expression pattern (unanchored, no flags).'),
        pathPrefix: stringProp(
          'Optional: limit search to files under this workspace-relative directory prefix.',
        ),
      },
      required: ['pattern'],
    } as Schema,
  };
}

export function buildFunctionDeclarations(): FunctionDeclaration[] {
  return [
    listDirectoryDeclaration(),
    findFilesDeclaration(),
    readFileDeclaration(),
    grepDeclaration(),
  ];
}
