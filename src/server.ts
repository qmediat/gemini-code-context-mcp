/**
 * MCP server bootstrap — stdio transport, tool dispatch, graceful lifecycle.
 *
 * **Shutdown drain (T6, v1.8.0):** SIGINT/SIGTERM does not immediately tear
 * down the transport. Each `CallToolRequestSchema` handler invocation is
 * tracked in `inFlightCalls` for the duration of `tool.execute(...)`. On
 * shutdown we `Promise.race` the set against `SHUTDOWN_DRAIN_MS` (default
 * 5000 ms) so a long `ask`/`code`/`ask_agentic` already in flight when
 * Claude Code restarts the server can return its response before the
 * process exits. Hard timeout: a hung call cannot block shutdown — abandoned
 * calls are logged at WARN, not silently dropped. Override the drain budget
 * with `GEMINI_CODE_CONTEXT_SHUTDOWN_DRAIN_MS=<ms>` (clamped to [0, 60000]).
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
const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;
const MAX_SHUTDOWN_DRAIN_MS = 60_000;

/**
 * Resolve the drain budget from `GEMINI_CODE_CONTEXT_SHUTDOWN_DRAIN_MS`.
 * Non-finite, negative, or out-of-range values fall back to the default —
 * an operator typo (`abc`, `-1`, `999999`) must NOT silently disable the
 * timeout (would block forever) or set it to a pathological value.
 */
function resolveDrainBudgetMs(): number {
  const raw = process.env.GEMINI_CODE_CONTEXT_SHUTDOWN_DRAIN_MS;
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_DRAIN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_SHUTDOWN_DRAIN_MS) {
    logger.warn(
      `GEMINI_CODE_CONTEXT_SHUTDOWN_DRAIN_MS='${raw}' is invalid (must be 0–${MAX_SHUTDOWN_DRAIN_MS}); using default ${DEFAULT_SHUTDOWN_DRAIN_MS}ms`,
    );
    return DEFAULT_SHUTDOWN_DRAIN_MS;
  }
  return parsed;
}

/**
 * Wait for every promise in `inFlight` to settle, but no longer than
 * `timeoutMs`. Returns the count of promises that settled in time.
 *
 * Exported for unit testing without booting a real server.
 */
export async function drainInFlight(
  inFlight: ReadonlySet<Promise<unknown>>,
  timeoutMs: number,
): Promise<{ settled: number; abandoned: number }> {
  const total = inFlight.size;
  if (total === 0) return { settled: 0, abandoned: 0 };
  if (timeoutMs <= 0) return { settled: 0, abandoned: total };

  let settled = 0;
  // Wrap each promise to count completions as they settle. We don't care
  // about resolve vs reject — both mean "the handler returned, no longer
  // in-flight". The `settled` counter is read by the caller AFTER the race
  // resolves, so it reflects the count at the moment the timeout (or
  // allSettled) fired.
  const tracked = [...inFlight].map((p) =>
    p.then(
      () => {
        settled++;
      },
      () => {
        settled++;
      },
    ),
  );

  await Promise.race([
    Promise.allSettled(tracked),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
  ]);

  return { settled, abandoned: total - settled };
}

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

  // Tracks `tool.execute(...)` calls that are still mid-flight. Used by
  // `shutdown()` to drain gracefully on SIGINT/SIGTERM (T6). Set semantics:
  // each handler invocation `add`s its own promise on entry and `delete`s
  // it in a `finally` block, regardless of resolve/reject path. A hung call
  // remains in the set until shutdown's `drainInFlight` either races it to
  // completion or times out and abandons it.
  const inFlightCalls = new Set<Promise<CallToolResult>>();

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

    const callPromise = (async (): Promise<CallToolResult> => {
      try {
        const result: ToolResult = await tool.execute(parse.data, ctx);
        return result as CallToolResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`tool '${name}' threw: ${message}`);
        return errorResult(`${name} threw: ${message}`) as CallToolResult;
      }
    })();
    inFlightCalls.add(callPromise);
    try {
      return await callPromise;
    } finally {
      inFlightCalls.delete(callPromise);
    }
  });

  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down…`);

    // Drain in-flight tool calls BEFORE closing the transport / DB. Otherwise
    // an in-progress `await tool.execute(...)` in the request handler would
    // race against `server.close()` / `manifest.close()` and either lose its
    // response (transport torn down) or hit "manifest closed" mid-write.
    if (inFlightCalls.size > 0) {
      const drainBudgetMs = resolveDrainBudgetMs();
      logger.info(
        `waiting up to ${drainBudgetMs}ms for ${inFlightCalls.size} in-flight tool call(s) to drain`,
      );
      const { settled, abandoned } = await drainInFlight(inFlightCalls, drainBudgetMs);
      if (abandoned > 0) {
        logger.warn(
          `${abandoned}/${settled + abandoned} in-flight call(s) did not drain in ${drainBudgetMs}ms — abandoning`,
        );
      } else if (settled > 0) {
        logger.info(`drained ${settled} in-flight call(s) cleanly`);
      }
    }

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
