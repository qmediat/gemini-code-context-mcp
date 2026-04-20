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
import { TtlWatcher } from './cache/ttl-watcher.js';
import { loadConfig } from './config.js';
import { createGeminiClient } from './gemini/client.js';
import { ManifestDb } from './manifest/db.js';
import { TOOLS } from './tools/index.js';
import {
  type ToolContext,
  type ToolResult,
  buildToolInputSchema,
  errorResult,
} from './tools/registry.js';
import { createTpmThrottle } from './tools/shared/throttle.js';
import { logger } from './utils/logger.js';

import { readFileSync } from 'node:fs';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = '@qmediat.io/gemini-code-context-mcp';
/**
 * Read version from package.json at runtime. `server.js` lives in `dist/` after
 * compilation (or `src/` under `tsx`) so package.json is the parent directory.
 * Falls back to `0.0.0-dev` if the lookup fails (never throws).
 */
const SERVER_VERSION = ((): string => {
  try {
    const here = pathDirname(fileURLToPath(import.meta.url));
    const pkgPath = pathJoin(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
})();

export async function runServer(): Promise<void> {
  const config = loadConfig();
  logger.info(
    `starting ${SERVER_NAME} v${SERVER_VERSION} (auth: ${config.auth.source}, key: ${config.auth.keyFingerprint}, default model: ${config.defaultModel})`,
  );

  // Preflight every tool's input schema before we accept a single request.
  // If a tool has a malformed Zod schema (non-object root, etc.) we'd rather
  // crash here with a clear message than register a half-broken MCP endpoint
  // that appears healthy but rejects tool lookups on the client side.
  for (const tool of TOOLS) {
    buildToolInputSchema(tool);
  }

  const manifest = new ManifestDb();
  const client = createGeminiClient(config.auth.profile);
  const ttlWatcher = new TtlWatcher(client, manifest);
  ttlWatcher.start();
  // Singleton throttle shared across every tool invocation. State is in-memory
  // only — a server restart clears the window (acceptable: startup is rare and
  // a first 429 re-seeds `recordRetryHint`). `tpmThrottleLimit === 0` disables.
  const throttle = createTpmThrottle(config.tpmThrottleLimit);

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
      inputSchema: buildToolInputSchema(tool),
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
      throttle,
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
