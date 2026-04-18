/**
 * `clear` tool — delete cache and manifest entries for a workspace.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { invalidateWorkspaceCache } from '../cache/cache-manager.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';

export const clearInputSchema = z.object({
  workspace: z.string().optional().describe('Workspace path (default: cwd).'),
});

export type ClearInput = z.infer<typeof clearInputSchema>;

export const clearTool: ToolDefinition<ClearInput> = {
  name: 'clear',
  title: 'Clear workspace cache',
  description:
    'Delete the cached context and manifest entries for a workspace. The Gemini-side cache is also released. Useful before switching projects or when you want to reset state deliberately.',
  schema: clearInputSchema,

  async execute(input, ctx) {
    try {
      const workspaceRoot = resolve(input.workspace ?? process.cwd());
      await invalidateWorkspaceCache({
        client: ctx.client,
        manifest: ctx.manifest,
        workspaceRoot,
      });
      return textResult(`Cleared cache and manifest for ${workspaceRoot}.`, { workspaceRoot });
    } catch (err) {
      return errorResult(`clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
