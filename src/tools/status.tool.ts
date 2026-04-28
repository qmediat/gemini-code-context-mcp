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
      const cacheStats = ctx.manifest.cacheStatsLast24h(now);
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
        // v1.13.0+: caching telemetry over the last 24 h. `mode` summarises
        // dominant caching strategy in use (`'explicit'` | `'implicit'` |
        // `'inline'` | `'mixed'` | `null` if no calls). `implicitHitRate` is
        // the share of input tokens served from Gemini's automatic implicit
        // cache on implicit-mode calls — operators tracking the v1.14.0
        // default-flip gate watch this number. `inlineCallCount` (round-2 FN2
        // fix) surfaces forced-inline calls separately from `'explicit'` so
        // codeExecution traffic doesn't bias the explicit-adoption metric.
        caching: {
          mode: cacheStats.mode,
          callCount: cacheStats.callCount,
          implicitCallsTotal: cacheStats.implicitCallsTotal,
          implicitCallsWithHit: cacheStats.implicitCallsWithHit,
          implicitHitRate: cacheStats.implicitHitRate,
          implicitCachedTokens: cacheStats.implicitCachedTokens,
          implicitUncachedTokens: cacheStats.implicitUncachedTokens,
          explicitRebuildCount: cacheStats.explicitRebuildCount,
          inlineCallCount: cacheStats.inlineCallCount,
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

      // v1.13.0 caching block. Only render when there's something to say
      // (skip on a brand-new manifest with zero calls — would be an empty
      // section). Implicit hit rate < 50% on implicit-mode operators gets a
      // gentle warn so they can revisit the trade-off, but we never error.
      const cachingLines: string[] = [];
      if (cacheStats.callCount > 0 && cacheStats.mode !== null) {
        cachingLines.push('', 'caching (24h):');
        cachingLines.push(`  mode:          ${cacheStats.mode}`);
        cachingLines.push(`  calls:         ${cacheStats.callCount}`);
        if (cacheStats.implicitCallsTotal > 0) {
          const hitPct = (cacheStats.implicitHitRate * 100).toFixed(1);
          const lowHit = cacheStats.implicitHitRate < 0.5;
          cachingLines.push(
            `  implicit hits: ${cacheStats.implicitCallsWithHit}/${cacheStats.implicitCallsTotal} calls`,
          );
          cachingLines.push(
            `  implicit hit-rate (input tokens): ${hitPct}%${lowHit ? '  ← below 50%; consider explicit mode for guaranteed savings' : ''}`,
          );
        }
        if (cacheStats.explicitRebuildCount > 0) {
          cachingLines.push(`  explicit rebuilds: ${cacheStats.explicitRebuildCount}`);
        }
        if (cacheStats.inlineCallCount > 0) {
          // v1.13.0 round-2 FN2: forced-inline calls (e.g. codeExecution).
          // Surface separately so operators understand why explicit-call
          // count > explicit-rebuild count when codeExecution is in use.
          cachingLines.push(`  forced-inline calls: ${cacheStats.inlineCallCount}`);
        }
      }

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
        ...cachingLines,
      ].join('\n');

      return textResult(human, structured);
    } catch (err) {
      return errorResult(`status failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
