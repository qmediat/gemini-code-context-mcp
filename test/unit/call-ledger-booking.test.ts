/** `recordBilledCall`: the one booking rule of `ask`, `code` and `ask_agentic`. */

import { describe, expect, it, vi } from 'vitest';
import type { ManifestDb } from '../../src/manifest/db.js';
import { billedUsage, recordBilledCall } from '../../src/tools/shared/call-ledger.js';
import { logger } from '../../src/utils/logger.js';

const ENTRY = {
  workspaceRoot: '/w',
  toolName: 'ask_agentic',
  model: 'gemini-3-pro-preview',
  serviceTier: undefined,
  cachingMode: null,
} as const;
const BILLED = billedUsage(
  { promptTokenCount: 100, candidatesTokenCount: 1, thoughtsTokenCount: 0 },
  ENTRY.model,
  undefined,
);

describe('recordBilledCall', () => {
  it('books a pass under 1 ms as 1 ms, for the usage row and the finalised reservation', () => {
    const insertUsageMetric = vi.fn();
    const finalizeBudgetReservation = vi.fn();
    const manifest = { insertUsageMetric, finalizeBudgetReservation } as unknown as ManifestDb;

    recordBilledCall(manifest, null, ENTRY, BILLED, 0);
    recordBilledCall(manifest, 5, ENTRY, BILLED, 0);

    expect(insertUsageMetric.mock.calls[0]?.[0]).toMatchObject({ durationMs: 1 });
    expect(finalizeBudgetReservation.mock.calls[0]?.[1]).toMatchObject({ durationMs: 1 });
  });

  it('logs a booking it cannot write and returns, with a daily cap and without one', () => {
    const busy = (): never => {
      throw new Error('SQLITE_BUSY');
    };
    const manifest = {
      insertUsageMetric: vi.fn(busy),
      finalizeBudgetReservation: vi.fn(busy),
    } as unknown as ManifestDb;
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      recordBilledCall(manifest, null, ENTRY, BILLED, 5);
      recordBilledCall(manifest, 7, ENTRY, BILLED, 5, 'ask_agentic finalization');

      expect(logged.mock.calls.map(([line]) => line)).toEqual([
        expect.stringMatching(
          /^ask_agentic: insertUsageMetric failed; no usage row was written, the billed \d+ micros were not written\. Error: .*SQLITE_BUSY/,
        ),
        expect.stringMatching(
          /^ask_agentic finalization: finalizeBudgetReservation failed for id=7; the row keeps its reserved estimate, the billed \d+ micros were not written/,
        ),
      ]);
    } finally {
      logged.mockRestore();
    }
  });
});
