/**
 * Unit tests for `drainInFlight` (T6, v1.8.0). Boots no real server — the
 * helper is exported from `server.ts` precisely so its semantics can be pinned
 * in isolation. Real-timer based: `setTimeout` race + microtask scheduling
 * is what we're verifying, fake timers would mask the actual failure modes
 * (see `ask-agentic.test.ts` top-of-file note for the fake-timer hazard
 * pattern).
 */

import { describe, expect, it } from 'vitest';
import { drainInFlight } from '../../src/server.js';

describe('drainInFlight (T6 graceful-shutdown drain)', () => {
  it('returns immediately when the in-flight set is empty', async () => {
    const result = await drainInFlight(new Set(), 5_000);
    expect(result).toEqual({ settled: 0, abandoned: 0 });
  });

  it('waits for all promises that resolve within the budget', async () => {
    const inFlight = new Set([
      new Promise<void>((r) => setTimeout(r, 10)),
      new Promise<void>((r) => setTimeout(r, 30)),
      new Promise<void>((r) => setTimeout(r, 50)),
    ]);

    const startedAt = Date.now();
    const result = await drainInFlight(inFlight, 5_000);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ settled: 3, abandoned: 0 });
    // Must have waited for the slowest (≥ ~50ms) but not stalled to the
    // budget. 5% slack on the lower bound for timer precision.
    expect(elapsedMs).toBeGreaterThanOrEqual(48);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('abandons promises that exceed the budget', async () => {
    // Two promises: one fast, one that hangs longer than the budget.
    const fast = new Promise<void>((r) => setTimeout(r, 10));
    const hung = new Promise<void>(() => {
      // Never resolves. The drain budget must abandon it.
    });
    const inFlight = new Set([fast, hung]);

    const startedAt = Date.now();
    const result = await drainInFlight(inFlight, 100);
    const elapsedMs = Date.now() - startedAt;

    // Fast one settled before the timeout; hung one was abandoned.
    expect(result).toEqual({ settled: 1, abandoned: 1 });
    // Drain returned at ~100ms (budget) — not the hung promise's never.
    expect(elapsedMs).toBeGreaterThanOrEqual(95);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('counts a rejected promise as settled (not abandoned)', async () => {
    // From the drain's perspective, a tool call that throws is just as
    // "settled" as one that resolves — both mean the handler returned
    // and is no longer holding the manifest / transport. The catch-all in
    // the production handler converts thrown errors to errorResult anyway.
    const ok = new Promise<void>((r) => setTimeout(r, 10));
    const rejected = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('boom')), 20),
    );
    const inFlight = new Set([ok, rejected]);

    const result = await drainInFlight(inFlight, 5_000);
    expect(result).toEqual({ settled: 2, abandoned: 0 });
  });

  it('returns immediately with all abandoned when budget is 0', async () => {
    const inFlight = new Set([new Promise<void>((r) => setTimeout(r, 100))]);
    const startedAt = Date.now();
    const result = await drainInFlight(inFlight, 0);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ settled: 0, abandoned: 1 });
    // Must NOT have waited — 0-budget is the operator's "abort drain" signal.
    expect(elapsedMs).toBeLessThan(50);
  });

  it('returns immediately with all abandoned when budget is negative', async () => {
    // Defense-in-depth: shouldn't be possible (resolveDrainBudgetMs clamps
    // negative env values to the default), but the helper is exported and
    // a future caller might pass through user input. Treat negative the same
    // as 0 — abandon everything, don't `setTimeout(-1)`.
    const inFlight = new Set([new Promise<void>((r) => setTimeout(r, 100))]);
    const result = await drainInFlight(inFlight, -1);
    expect(result).toEqual({ settled: 0, abandoned: 1 });
  });
});
