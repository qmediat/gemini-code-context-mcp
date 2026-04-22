import { askAgenticTool } from './ask-agentic.tool.js';
import { askTool } from './ask.tool.js';
import { clearTool } from './clear.tool.js';
import { codeTool } from './code.tool.js';
import type { ToolDefinition } from './registry.js';
import { reindexTool } from './reindex.tool.js';
import { statusTool } from './status.tool.js';

// `as ToolDefinition<unknown>[]` is safe because each tool validates its own input via Zod.
export const TOOLS: ReadonlyArray<ToolDefinition<unknown>> = [
  askTool,
  askAgenticTool,
  codeTool,
  statusTool,
  reindexTool,
  clearTool,
] as unknown as ReadonlyArray<ToolDefinition<unknown>>;
