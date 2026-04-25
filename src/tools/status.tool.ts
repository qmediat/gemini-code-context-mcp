/**
 * `status` tool — snapshot of cache state and cost savings for a workspace.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { listAvailableModels } from '../gemini/model-registry.js';
import { microsToDollars } from '../utils/cost-estimator.js';
import { type ToolDefinition, errorResult, textResult } from './registry.js';

export const statusInputSchema = z.object({
  workspace: z.string().optional().describe('Workspace path (default: cwd).'),
});

export type StatusInput = z.infer<typeof statusInputSchema>;

function formatTtl(expiresAt: number | null): string {
  if (expiresAt === null) return '—';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'expired';
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  return hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;
}

export const statusTool: ToolDefinition<StatusInput> = {
  name: 'status',
  title: 'Context cache status',
  description:
    'Inspect the cache state for a workspace: file count, cache ID, TTL remaining, cumulative cost, and savings from cache hits. Also lists models available to the current API key.',
  schema: statusInputSchema,

  async execute(input, ctx) {
    try {
      const workspaceRoot = resolve(input.workspace ?? process.cwd());
      const now = Date.now();
      const ws = ctx.manifest.getWorkspace(workspaceRoot);
      const files = ctx.manifest.getFiles(workspaceRoot);
      const stats = ctx.manifest.workspaceStats(workspaceRoot);
      const todayTotalMicros = ctx.manifest.todaysCostMicros(now);
      const todayInFlightMicros = ctx.manifest.todaysInFlightReservedMicros(now);
      // D#7 (v1.7.0): split settled vs in-flight so users running `status`
      // mid-call see why total looks higher than completed work would
      // suggest. Total still includes in-flight (so it's a true budget cap
      // proxy), but the breakdown surfaces what's provisional.
      const todaySettledMicros = Math.max(0, todayTotalMicros - todayInFlightMicros);
      const wsSettledMicros = Math.max(0, stats.totalCostMicros - stats.inFlightReservedMicros);
      const models = await listAvailableModels(ctx.client).catch(() => []);

      const structured: Record<string, unknown> = {
        workspace: workspaceRoot,
        auth: {
          source: ctx.config.auth.source,
          keyFingerprint: ctx.config.auth.keyFingerprint,
        },
        defaultModel: ctx.config.defaultModel,
        dailyBudgetUsd: Number.isFinite(ctx.config.dailyBudgetUsd)
          ? ctx.config.dailyBudgetUsd
          : null,
        spentTodayUsd: microsToDollars(todayTotalMicros),
        // D#7: backward-compatible split. `spentTodayUsd` stays as the
        // conservative upper bound (settled + in-flight); new fields show
        // the breakdown.
        spentTodaySettledUsd: microsToDollars(todaySettledMicros),
        inFlightReservedTodayUsd: microsToDollars(todayInFlightMicros),
        availableModels: models.map((m) => ({
          id: m.id,
          inputTokenLimit: m.inputTokenLimit,
          supportsThinking: m.supportsThinking,
        })),
        workspaceState: ws
          ? {
              filesHash: ws.filesHash,
              model: ws.model,
              cacheId: ws.cacheId,
              cacheExpiresAt: ws.cacheExpiresAt,
              cacheTtlRemaining: formatTtl(ws.cacheExpiresAt),
              trackedFiles: files.length,
              createdAt: ws.createdAt,
              updatedAt: ws.updatedAt,
            }
          : null,
        usage: {
          callCount: stats.callCount,
          totalCachedTokens: stats.totalCachedTokens,
          totalUncachedTokens: stats.totalUncachedTokens,
          totalCostUsd: microsToDollars(stats.totalCostMicros),
          // D#7: workspace-scoped split. Same semantics as the daily fields.
          settledCostUsd: microsToDollars(wsSettledMicros),
          inFlightReservedUsd: microsToDollars(stats.inFlightReservedMicros),
          last24hCostUsd: microsToDollars(stats.last24hCostMicros),
        },
      };

      // Render the in-flight delta only when there IS one; mid-call status
      // queries are the only situation where it's non-zero, and showing
      // "$0.0000 in-flight" on every call would just be noise.
      const todayInFlightSuffix =
        todayInFlightMicros > 0
          ? ` (settled $${microsToDollars(todaySettledMicros).toFixed(4)} + $${microsToDollars(todayInFlightMicros).toFixed(4)} in-flight reserved)`
          : '';
      const wsInFlightSuffix =
        stats.inFlightReservedMicros > 0
          ? ` (settled $${microsToDollars(wsSettledMicros).toFixed(4)} + $${microsToDollars(stats.inFlightReservedMicros).toFixed(4)} in-flight reserved)`
          : '';

      const human = [
        `workspace:       ${workspaceRoot}`,
        `auth source:     ${ctx.config.auth.source} (${ctx.config.auth.keyFingerprint})`,
        `default model:   ${ctx.config.defaultModel}`,
        `budget:          ${Number.isFinite(ctx.config.dailyBudgetUsd) ? `$${ctx.config.dailyBudgetUsd.toFixed(2)}/day` : 'unlimited'} (today: $${microsToDollars(todayTotalMicros).toFixed(4)}${todayInFlightSuffix})`,
        `available models (${models.length}):`,
        ...models
          .slice(0, 8)
          .map(
            (m) =>
              `  - ${m.id} (${m.inputTokenLimit?.toLocaleString() ?? '?'} in / ${m.outputTokenLimit?.toLocaleString() ?? '?'} out${m.supportsThinking ? ', thinking' : ''})`,
          ),
        '',
        ws ? 'workspace cache:' : 'workspace cache: (none yet — ask or code will create it)',
        ...(ws
          ? [
              `  cache_id:     ${ws.cacheId ?? 'none (inline fallback)'}`,
              `  ttl:          ${formatTtl(ws.cacheExpiresAt)}`,
              `  model:        ${ws.model}`,
              `  files_hash:   ${ws.filesHash.slice(0, 16)}…`,
              `  tracked_files: ${files.length}`,
            ]
          : []),
        '',
        'usage:',
        `  calls:         ${stats.callCount}`,
        `  cached tokens: ${stats.totalCachedTokens.toLocaleString()}`,
        `  input tokens:  ${stats.totalUncachedTokens.toLocaleString()}`,
        `  total cost:    $${microsToDollars(stats.totalCostMicros).toFixed(4)}${wsInFlightSuffix}`,
        `  last 24h:      $${microsToDollars(stats.last24hCostMicros).toFixed(4)}`,
      ].join('\n');

      return textResult(human, structured);
    } catch (err) {
      return errorResult(`status failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
