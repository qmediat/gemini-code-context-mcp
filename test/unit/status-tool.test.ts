/**
 * `status` tool — caching telemetry surface area (v1.13.0+).
 *
 * Verifies that `cacheStatsLast24h` rolls up into both `structuredContent.caching`
 * and the human-readable text the way the rest of the MCP world expects.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestDb } from '../../src/manifest/db.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { statusTool } from '../../src/tools/status.tool.js';

vi.mock('../../src/gemini/model-registry.js', () => ({
  // listAvailableModels hits the network in production; stub it out so the
  // status tool's "available models" section doesn't drive the test.
  listAvailableModels: vi.fn(async () => []),
}));

function mkCtx(manifest: ManifestDb): ToolContext {
  return {
    config: {
      auth: { source: 'env', keyFingerprint: 'abc' },
      defaultModel: 'latest-pro-thinking',
      dailyBudgetUsd: 10,
    } as ToolContext['config'],
    client: {} as unknown as GoogleGenAI,
    manifest,
    ttlWatcher: { markHot: vi.fn() } as unknown as ToolContext['ttlWatcher'],
    progressToken: undefined,
    throttle: {} as unknown as ToolContext['throttle'],
  };
}

describe('status tool — caching block (v1.13.0+)', () => {
  let tmp: string;
  let db: ManifestDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gcctx-status-'));
    db = new ManifestDb(join(tmp, 'manifest.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('hides the caching block when nothing has been logged in 24 h', async () => {
    const result = await statusTool.execute({ workspace: '/never-used' }, mkCtx(db));
    expect(result.structuredContent?.caching).toEqual({
      mode: null,
      callCount: 0,
      implicitCallsTotal: 0,
      implicitCallsWithHit: 0,
      implicitHitRate: 0,
      implicitCachedTokens: 0,
      implicitUncachedTokens: 0,
      explicitRebuildCount: 0,
    });
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).not.toContain('caching (24h)');
  });

  it('renders implicit-mode hit rate in the human text', async () => {
    const t = Date.now();
    db.insertUsageMetric({
      workspaceRoot: '/ws',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      cachedTokens: 90_000,
      uncachedTokens: 10_000,
      costUsdMicro: 100,
      durationMs: 1_000,
      occurredAt: t,
      cachingMode: 'implicit',
      cachedContentTokenCount: 90_000,
    });

    const result = await statusTool.execute({ workspace: '/ws' }, mkCtx(db));
    const caching = result.structuredContent?.caching as Record<string, unknown>;
    expect(caching.mode).toBe('implicit');
    expect(caching.implicitCallsWithHit).toBe(1);
    // 90k / (90k + 10k) = 0.9
    expect(caching.implicitHitRate).toBeCloseTo(0.9, 3);

    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('caching (24h)');
    expect(text).toContain('mode:          implicit');
    expect(text).toContain('90.0%');
    // High hit-rate should NOT trip the warn suffix.
    expect(text).not.toContain('below 50%');
  });

  it('warns when implicit hit rate is below 50%', async () => {
    const t = Date.now();
    db.insertUsageMetric({
      workspaceRoot: '/ws',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      cachedTokens: 100,
      uncachedTokens: 9_900,
      costUsdMicro: 100,
      durationMs: 1_000,
      occurredAt: t,
      cachingMode: 'implicit',
      cachedContentTokenCount: 100,
    });

    const result = await statusTool.execute({ workspace: '/ws' }, mkCtx(db));
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('below 50%');
  });

  it('surfaces explicitRebuildCount when cache.create rows exist', async () => {
    const t = Date.now();
    db.insertUsageMetric({
      workspaceRoot: '/ws',
      toolName: 'cache.create',
      model: 'gemini-3-pro-preview',
      cachedTokens: 0,
      uncachedTokens: 0,
      costUsdMicro: 0,
      durationMs: 60_000,
      occurredAt: t,
    });
    db.insertUsageMetric({
      workspaceRoot: '/ws',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      cachedTokens: 0,
      uncachedTokens: 1_000,
      costUsdMicro: 1,
      durationMs: 1,
      occurredAt: t,
      cachingMode: 'explicit',
    });

    const result = await statusTool.execute({ workspace: '/ws' }, mkCtx(db));
    const caching = result.structuredContent?.caching as Record<string, unknown>;
    expect(caching.explicitRebuildCount).toBe(1);

    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('explicit rebuilds: 1');
  });
});
