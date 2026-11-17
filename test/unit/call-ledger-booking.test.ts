/** `recordBilledCall`: the one booking rule of `ask`, `code` and `ask_agentic`. */

import { describe, expect, it, vi } from 'vitest';
import type { ManifestDb } from '../../src/manifest/db.js';
import { billedUsage, recordBilledCall } from '../../src/tools/shared/call-ledger.js';

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
});
