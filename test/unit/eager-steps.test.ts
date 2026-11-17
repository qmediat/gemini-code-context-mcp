/**
 * The steps `ask` and `code` run the same way before their context (`src/tools/shared/eager-steps.ts`): the guard's
 * verdict at its threshold, the scan's `forceRescan`, the output cap of a model that advertises none, and the extra
 * input tokens the budget reservation charges when no preflight count ran.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanResult } from '../../src/indexer/workspace-scanner.js';
import type { ToolContext } from '../../src/tools/registry.js';
import type { EagerMachinery } from '../../src/tools/shared/eager-call.js';
import {
  type PreflightCount,
  eagerOutputCap,
  overWindow,
  reserveCallBudget,
  scanForCall,
} from '../../src/tools/shared/eager-steps.js';
import type { ResolvedModel } from '../../src/types.js';
import { GEMINI_4_ARGON } from '../helpers/models.js';
import { ONE_FILE_SCAN } from '../helpers/workspace.js';

const mocks = vi.hoisted(() => ({ scanWorkspace: vi.fn() }));

vi.mock('../../src/indexer/workspace-scanner.js', () => ({
  scanWorkspace: mocks.scanWorkspace,
  buildScanMemo: () => new Map<string, never>(),
}));

/** The machinery the shared steps read: the progress channel, the workspace, the timeout, the trail. */
function machinery(): EagerMachinery {
  return {
    tool: 'ask',
    workspaceRoot: '/ws',
    started: 0,
    requestedTier: 'standard',
    emitter: { emit: vi.fn(), stop: vi.fn() },
    timeout: { timeoutMs: null },
    trail: { reservationId: null },
  } as unknown as EagerMachinery;
}

/** A context with a daily cap, a manifest that reserves and records, and the config the steps read. */
function context(config: Partial<ToolContext['config']> = {}): ToolContext {
  return {
    config: {
      workspaceGuardRatio: 0.9,
      maxFilesPerWorkspace: 2_000,
      maxFileSizeBytes: 1_000_000,
      forceMaxOutputTokens: false,
      dailyBudgetUsd: 10,
      ...config,
    },
    manifest: {
      getFiles: vi.fn(() => []),
      reserveBudget: vi.fn(() => ({ id: 7 })),
    },
  } as unknown as ToolContext;
}

/** A count of `tokens` held against a window whose threshold is `threshold`. */
function countOf(tokens: number, threshold: number): PreflightCount {
  return {
    preflight: { effectiveTokens: tokens, rawTokens: tokens, method: 'exact', cacheHit: false },
    contextWindow: 10_000,
    threshold,
  };
}

beforeEach(() => {
  mocks.scanWorkspace.mockReset();
  mocks.scanWorkspace.mockResolvedValue(ONE_FILE_SCAN);
});

describe('overWindow', () => {
  it('a count exactly at the threshold fits the window', () => {
    expect(overWindow(countOf(2_600, 2_600), context())).toBeNull();
  });

  it('a count one token above the threshold is over the window, with the values a refusal reports', () => {
    expect(overWindow(countOf(2_601, 2_600), context())).toEqual({
      counted: countOf(2_601, 2_600).preflight,
      contextWindow: 10_000,
      threshold: 2_600,
      pctDisplay: 90,
    });
  });
});

describe('scanForCall', () => {
  it("the operator's forceRescan bypasses the scan memo when the call sets none", async () => {
    await scanForCall(machinery(), context({ forceRescan: true }), {});

    expect(mocks.scanWorkspace).toHaveBeenCalledWith(
      '/ws',
      expect.objectContaining({ forceRescan: true }),
    );
  });
});

describe('eagerOutputCap', () => {
  it('a model that advertises no output limit runs under 65,536 tokens a request', () => {
    const silent: ResolvedModel = {
      ...GEMINI_4_ARGON,
      outputTokenLimit: null,
      longDecodeTokenLimit: null,
    };

    const cap = eagerOutputCap(undefined, context(), silent);

    expect(cap.effective).toBe(65_536);
    expect(cap.perRequest).toBe(65_536);
  });
});

describe('reserveCallBudget', () => {
  /** What the reservation estimated for a call with `extraInputTokens` and no preflight count. */
  function reservedMicros(extraInputTokens: number): number {
    const ctx = context();
    const scan: ScanResult = ONE_FILE_SCAN;
    const outcome = reserveCallBudget(
      machinery(),
      ctx,
      {
        resolved: GEMINI_4_ARGON,
        serviceTier: 'standard',
        estimate: { workspaceBytes: scan.files[0]?.size ?? 0, tokens: 0 },
        count: null,
        bounded: { cap: eagerOutputCap(undefined, ctx, GEMINI_4_ARGON), cut: null },
      },
      { promptChars: 1, extraInputTokens, thinkingTokens: 0 },
    );
    expect(outcome).toEqual({ kind: 'reserved' });
    const reserveBudget = ctx.manifest.reserveBudget as unknown as ReturnType<typeof vi.fn>;
    return (reserveBudget.mock.calls[0]?.[0] as { estimatedCostMicros: number })
      .estimatedCostMicros;
  }

  it('with no preflight count, the extra input tokens are charged', () => {
    expect(reservedMicros(400_000)).toBeGreaterThan(reservedMicros(0));
  });
});
