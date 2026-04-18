/**
 * MCP server bootstrap — stdio transport, tool dispatch, graceful lifecycle.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TtlWatcher } from './cache/ttl-watcher.js';
import { loadConfig } from './config.js';
import { createGeminiClient } from './gemini/client.js';
import { ManifestDb } from './manifest/db.js';
import { TOOLS } from './tools/index.js';
import { type ToolContext, type ToolResult, errorResult } from './tools/registry.js';
import { logger } from './utils/logger.js';

const SERVER_NAME = '@qmediat.io/gemini-code-context-mcp';
const SERVER_VERSION = '0.0.0';

export async function runServer(): Promise<void> {
  const config = loadConfig();
  logger.info(
    `starting ${SERVER_NAME} v${SERVER_VERSION} (auth: ${config.auth.source}, key: ${config.auth.keyFingerprint}, default model: ${config.defaultModel})`,
  );

  const manifest = new ManifestDb();
  const client = createGeminiClient(config.auth.profile);
  const ttlWatcher = new TtlWatcher(client, manifest);
  ttlWatcher.start();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.schema, {
        name: `${tool.name}Input`,
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;
    const progressToken = request.params._meta?.progressToken;

    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return errorResult(`Unknown tool: ${name}`) as CallToolResult;
    }

    const parse = tool.schema.safeParse(rawArgs ?? {});
    if (!parse.success) {
      return errorResult(
        `Invalid arguments for ${name}: ${parse.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      ) as CallToolResult;
    }

    const ctx: ToolContext = {
      server,
      config,
      client,
      manifest,
      ttlWatcher,
      progressToken,
    };

    try {
      const result: ToolResult = await tool.execute(parse.data, ctx);
      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`tool '${name}' threw: ${message}`);
      return errorResult(`${name} threw: ${message}`) as CallToolResult;
    }
  });

  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down…`);
    ttlWatcher.stop();
    try {
      manifest.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await server.connect(transport);
  logger.info('connected via stdio — ready.');
}
