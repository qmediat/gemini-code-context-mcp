/**
 * Tool registry — each MCP tool implements this common contract.
 */

import type { GoogleGenAI } from '@google/genai';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { TtlWatcher } from '../cache/ttl-watcher.js';
import type { Config } from '../config.js';
import type { ManifestDb } from '../manifest/db.js';
import type { TpmThrottle } from './shared/throttle.js';

export interface ToolContext {
  server: Server;
  config: Config;
  client: GoogleGenAI;
  manifest: ManifestDb;
  ttlWatcher: TtlWatcher;
  progressToken: string | number | undefined;
  /**
   * Per-server-process TPM throttle singleton. Tools should call
   * `throttle.reserve(resolvedModel, estimatedInputTokens)` AFTER the daily-
   * budget reservation but BEFORE `generateContent`, then `release` on
   * success with the actual `promptTokenCount` or `cancel` on any pre-
   * dispatch failure. See `src/tools/shared/throttle.ts`.
   */
  throttle: TpmThrottle;
}

/**
 * MCP-compliant `tools[*].inputSchema` shape. The root MUST be `type: "object"`
 * per the MCP protocol — strict clients (Claude Code, Claude Desktop) reject
 * anything else. Extra keys (`$schema`, `additionalProperties`, `required`, …)
 * pass through the index signature.
 */
export interface McpInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [key: string]: unknown;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  title: string;
  description: string;
  schema: z.ZodSchema<TInput>;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  /** MCP-shape content blocks. */
  content: Array<{ type: 'text'; text: string }>;
  /** Optional structured payload for structured-output-aware clients. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Narrower return type for `textResult` / `errorResult`: `structuredContent`
 * is ALWAYS present (always carries at least `responseText` per T23). The
 * loose `ToolResult` interface stays for any future caller that legitimately
 * omits structured content, but consumers of the two standard helpers can
 * rely on the field without an optional-chaining dance.
 *
 * Addresses T23a follow-up from PR #19 review: the original helpers declared
 * `ToolResult` as the return type even though they always populate the
 * structured payload — a doc-through-types gap that misled readers doing
 * `if (result.structuredContent) …`.
 */
export interface TextToolResult extends ToolResult {
  structuredContent: Record<string, unknown>;
}

/**
 * Canonical key under which MCP clients consuming `structuredContent` can
 * reliably find the tool's primary narrative response. MCP hosts that
 * render `content[]` (Claude Code's main conversation UI) are unaffected;
 * hosts that consume ONLY `structuredContent` (Claude Code's sub-agent
 * tool-result parser as of 2026-04, and likely other headless pipelines)
 * otherwise silently lose the response text. Duplicating a few-KB string
 * across `content[0].text` and `structuredContent.responseText` costs
 * effectively nothing vs losing the whole response to a single-consumer
 * wire-format gap (2026-04-20: three reviewer-agent runs of `/coderev`
 * returned "API success but text not surfaced"). This mirror MUST remain
 * invariant across every tool's response — sub-agent orchestrations depend
 * on a single, predictable extraction path.
 */
export const RESPONSE_TEXT_KEY = 'responseText';

export function textResult(text: string, structured?: Record<string, unknown>): TextToolResult {
  return {
    content: [{ type: 'text', text }],
    // Always emit `structuredContent` with `responseText` even when the
    // caller didn't pass a structured payload — the invariant that
    // sub-agents rely on is "any tool response has `.structuredContent.responseText`",
    // not "only tools that pass metadata do". The caller's keys, if any,
    // spread in first so our canonical `responseText` wins on collision.
    structuredContent: { ...(structured ?? {}), [RESPONSE_TEXT_KEY]: text },
  };
}

export function errorResult(message: string, extra?: Record<string, unknown>): TextToolResult {
  return {
    content: [{ type: 'text', text: message }],
    // Mirror the error text under `responseText` for the same reason
    // `textResult` does: sub-agents extracting tool output parse
    // `structuredContent` only, so without this the failure message is
    // invisible to any orchestration that makes decisions on error text.
    // `isError: true` still signals failure; `responseText` carries detail.
    //
    // Extra fields (e.g. `errorCode` from DebugError) are spread so the
    // subagent can reason structurally about the failure class instead of
    // regexing `message`. The canonical `responseText` key is written LAST
    // so a pathological caller passing it in `extra` can't silently
    // clobber the user-facing message.
    structuredContent: { ...(extra ?? {}), [RESPONSE_TEXT_KEY]: message },
    isError: true,
  };
}

/**
 * Build the `inputSchema` payload for a tool's entry in a `tools/list`
 * response. Two non-negotiable constraints on the serialisation:
 *
 *   1. The root is `type: "object"` — the MCP spec mandates it. Strict
 *      clients (Claude Code, Claude Desktop) reject anything else with
 *      `Invalid input: expected "object"` and silently drop every tool from
 *      their namespace (the v1.0.0 / v1.0.1 ship-blocker).
 *
 *   2. No `$ref`: `reused: 'inline'`. MCP clients do not dereference `$ref`
 *      inside `inputSchema`, so any internal reference would leave the
 *      schema unresolvable on the client side. The trade-off is payload
 *      size when heavily-reused sub-schemas appear — acceptable for our
 *      workload, forced by spec anyway.
 *
 * `io: 'input'` describes what a caller sends: a field with a default is
 * optional. `target: 'draft-7'` is the dialect the tools were published in.
 *
 * The runtime assert is a belt-and-suspenders guard: `ToolDefinition.schema`
 * is currently typed loosely as `z.ZodSchema<TInput>`, which permits
 * non-object roots (unions, primitives, `ZodEffects`) to compile cleanly.
 * `runServer()` exercises this helper on every tool at startup, so a
 * malformed schema fails before the stdio transport accepts connections —
 * much clearer than the silent tool-list rejection the spec-violation path
 * produces. Compile-time narrowing is tracked in `docs/FOLLOW-UP-PRS.md`.
 */
/** How a tool's zod schema is written as the JSON Schema of `tools/list` (see `buildToolInputSchema`). */
const JSON_SCHEMA_OPTIONS = {
  target: 'draft-7',
  reused: 'inline',
  io: 'input',
  // The published contract, kept as it was: an object takes no key its schema does not name,
  // and an integer carries only the bounds its schema states (not the safe-integer ceiling).
  override: ({ jsonSchema }: { jsonSchema: Record<string, unknown> }) => {
    if (jsonSchema.type === 'object' && jsonSchema.additionalProperties === undefined) {
      jsonSchema.additionalProperties = false;
    }
    if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) jsonSchema.maximum = undefined;
    if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) jsonSchema.minimum = undefined;
  },
} as const;

export function buildToolInputSchema(tool: ToolDefinition<unknown>): McpInputSchema {
  const payload = z.toJSONSchema(tool.schema, JSON_SCHEMA_OPTIONS) as Record<string, unknown>;
  if (payload.type !== 'object') {
    throw new Error(
      `buildToolInputSchema: tool '${tool.name}' produced a non-object root schema ` +
        `(type=${JSON.stringify(payload.type)}). MCP clients require type: "object" at the root.`,
    );
  }
  return payload as McpInputSchema;
}
