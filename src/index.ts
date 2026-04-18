#!/usr/bin/env node
/**
 * @qmediat.io/gemini-code-context-mcp
 *
 * MCP server entry point. stdio transport. Real implementation lands in Phase 1+.
 */

async function main(): Promise<void> {
  // Placeholder — Phase 1 replaces this with real MCP server bootstrap.
  process.stderr.write('[gemini-code-context-mcp] v0.0.0 pre-release — implementation pending.\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[gemini-code-context-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
