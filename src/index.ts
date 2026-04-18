#!/usr/bin/env node
/**
 * @qmediat.io/gemini-code-context-mcp — entrypoint.
 *
 * Subcommands:
 *   init     Interactive secure setup (writes ~/.config/qmediat/credentials).
 *   (none)   Start the MCP server on stdio.
 */

import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  if (subcommand === 'init') {
    const { runInit } = await import('./auth/init-command.js');
    await runInit();
    return;
  }

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    process.stdout.write(
      [
        '@qmediat.io/gemini-code-context-mcp — MCP server for Gemini Context Caching',
        '',
        'Usage:',
        '  npx @qmediat.io/gemini-code-context-mcp          Start the MCP server (stdio)',
        '  npx @qmediat.io/gemini-code-context-mcp init     Interactive credential setup',
        '',
        'Environment:',
        '  GEMINI_CREDENTIALS_PROFILE     Profile name from ~/.config/qmediat/credentials (default: default)',
        '  GEMINI_API_KEY                 Fallback API key (logs a warning)',
        '  GEMINI_USE_VERTEX=true         Use Vertex AI (requires GOOGLE_CLOUD_PROJECT)',
        '  GEMINI_DAILY_BUDGET_USD        Daily cost cap in USD',
        '  GEMINI_CODE_CONTEXT_DEFAULT_MODEL  Default model alias or ID (default: latest-pro)',
        '  GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS  Cache TTL in seconds (default: 3600)',
        '  GEMINI_CODE_CONTEXT_LOG_LEVEL  debug | info | warn | error (default: info)',
        '',
        'Docs: https://github.com/qmediat/gemini-code-context-mcp',
        '',
      ].join('\n'),
    );
    return;
  }

  if (subcommand && subcommand.length > 0) {
    process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
    process.exit(2);
  }

  const { runServer } = await import('./server.js');
  await runServer();

  // Prevent unused-var lint if `rest` is unused.
  void rest;
}

main().catch((err: unknown) => {
  logger.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
