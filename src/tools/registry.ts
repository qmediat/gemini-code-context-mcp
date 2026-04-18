/**
 * Tool registry — each MCP tool implements this common contract.
 */

import type { GoogleGenAI } from '@google/genai';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { z } from 'zod';
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
