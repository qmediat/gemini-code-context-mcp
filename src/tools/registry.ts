/**
 * Tool registry — each MCP tool implements this common contract.
 */

import type { GoogleGenAI } from '@google/genai';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TtlWatcher } from '../cache/ttl-watcher.js';
import type { Config } from '../config.js';
import type { ManifestDb } from '../manifest/db.js';

export interface ToolContext {
  server: Server;
  config: Config;
  client: GoogleGenAI;
  manifest: ManifestDb;
  ttlWatcher: TtlWatcher;
  progressToken: string | number | undefined;
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

export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * Build the `inputSchema` payload for a tool's entry in a `tools/list`
 * response. Two non-negotiable constraints on the serialisation:
 *
 *   1. The `name` option is deliberately omitted. With `name` set,
 *      `zod-to-json-schema` wraps its output in `{ $ref, definitions }` — a
 *      shape that lacks the `type: "object"` the MCP spec mandates at the
 *      root. Strict clients (Claude Code, Claude Desktop) reject that with
 *      `Invalid input: expected "object"` and silently drop every tool from
 *      their namespace. This was the v1.0.0 / v1.0.1 ship-blocker fixed in
 *      PR #5.
 *
 *   2. `$refStrategy: 'none'` is required. MCP clients do not dereference
 *      `$ref` inside `inputSchema`, so any internal reference would leave
 *      the schema unresolvable on the client side. The trade-off is payload
 *      size when heavily-reused sub-schemas appear — acceptable for our
 *      workload, forced by spec anyway.
 *
 * The runtime assert is a belt-and-suspenders guard: `ToolDefinition.schema`
 * is currently typed loosely as `z.ZodSchema<TInput>`, which permits
 * non-object roots (unions, primitives, `ZodEffects`) to compile cleanly.
 * `runServer()` exercises this helper on every tool at startup, so a
 * malformed schema fails before the stdio transport accepts connections —
 * much clearer than the silent tool-list rejection the spec-violation path
 * produces. Compile-time narrowing is tracked in `docs/FOLLOW-UP-PRS.md`.
 */
export function buildToolInputSchema(tool: ToolDefinition<unknown>): McpInputSchema {
  const payload = zodToJsonSchema(tool.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  if (payload.type !== 'object') {
    throw new Error(
      `buildToolInputSchema: tool '${tool.name}' produced a non-object root schema ` +
        `(type=${JSON.stringify(payload.type)}). MCP clients require type: "object" at the root.`,
    );
  }
  return payload as McpInputSchema;
}
