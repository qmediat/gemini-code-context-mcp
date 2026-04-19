/**
 * `reindex` tool — force rebuild of the workspace cache.
 *
 * Invalidates the current cache + manifest entries, then performs a fresh scan.
 * The next `ask`/`code` call will upload + build a new cache.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { invalidateWorkspaceCache } from '../cache/cache-manager.js';
import { invalidateModelCache } from '../gemini/model-registry.js';
import { scanWorkspace } from '../indexer/workspace-scanner.js';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../indexer/workspace-validation.js';
import { createProgressEmitter } from '../utils/progress.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';

export const reindexInputSchema = z.object({
  workspace: z.string().optional().describe('Workspace path (default: cwd).'),
  alsoRefreshModels: z
    .boolean()
    .optional()
    .describe('Also invalidate the model registry cache (default: false).'),
});

export type ReindexInput = z.infer<typeof reindexInputSchema>;

export const reindexTool: ToolDefinition<ReindexInput> = {
  name: 'reindex',
  title: 'Force-rebuild workspace cache',
  description:
    'Clear the current Gemini Context Cache for a workspace and rescan the file tree. The next ask/code call will upload changed files and build a new cache. Use after a large refactor when hash-based invalidation would be slower than a full rebuild.',
  schema: reindexInputSchema,

  async execute(input, ctx) {
    const emitter = createProgressEmitter(ctx.server, ctx.progressToken);
    try {
      const workspaceRoot = resolve(input.workspace ?? process.cwd());
      try {
        validateWorkspacePath(workspaceRoot);
      } catch (err) {
        if (err instanceof WorkspaceValidationError) {
          return errorResult(`reindex: ${err.message}`);
        }
        throw err;
      }
      emitter.emit('invalidating cache…');
      await invalidateWorkspaceCache({
        client: ctx.client,
        manifest: ctx.manifest,
        workspaceRoot,
      });
      if (input.alsoRefreshModels) {
        invalidateModelCache();
      }

      emitter.emit('rescanning workspace…');
      const scan = await scanWorkspace(workspaceRoot, {
        maxFiles: ctx.config.maxFilesPerWorkspace,
        maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      });

      const structured = {
        workspace: workspaceRoot,
        filesRescanned: scan.files.length,
        skippedTooLarge: scan.skippedTooLarge,
        truncated: scan.truncated,
        filesHash: scan.filesHash,
        note: 'Next `ask`/`code` call will upload changed files and build a fresh cache.',
      };

      return textResult(
        `Workspace ${workspaceRoot} reindexed. ${scan.files.length} files tracked (${scan.skippedTooLarge} skipped as oversized${scan.truncated ? '; results were truncated by maxFiles cap' : ''}). Next ask/code call will rebuild the cache.`,
        structured,
      );
    } catch (err) {
      return errorResult(`reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      emitter.stop();
    }
  },
};
