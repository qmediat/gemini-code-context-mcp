import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTpmThrottle } from '../../src/tools/shared/throttle.js';

describe('tpm throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('disabled (limit = 0)', () => {
    it('reserve returns zero-delay, no-op release/cancel tokens', () => {
      const throttle = createTpmThrottle(0);
      const a = throttle.reserve('gemini-3-pro', 1_000_000);
      expect(a.delayMs).toBe(0);
      // Disabled path must still accept release/cancel without throwing.
      throttle.release(a.releaseId, 900_000);
      throttle.cancel(a.releaseId);
    });

    it('shouldDelay always returns 0', () => {
      const throttle = createTpmThrottle(0);
      throttle.reserve('gemini-3-pro', 500_000);
      expect(throttle.shouldDelay('gemini-3-pro', 500_000)).toBe(0);
    });

    it('recordRetryHint is a no-op when disabled', () => {
      const throttle = createTpmThrottle(0);
      throttle.recordRetryHint('gemini-3-pro', 30_000);
      expect(throttle.shouldDelay('gemini-3-pro', 0)).toBe(0);
    });
  });

  describe('single-entry window math', () => {
    it('returns 0 delay on an empty window', () => {
      const throttle = createTpmThrottle(80_000);
      const r = throttle.reserve('gemini-3-pro', 50_000);
      expect(r.delayMs).toBe(0);
    });

    it('returns 0 delay when sum + estimate fits under the limit', () => {
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 30_000);
      throttle.release(a.releaseId, 30_000);
      expect(throttle.reserve('gemini-3-pro', 40_000).delayMs).toBe(0);
    });

    it('delays when sum + estimate exceeds the limit', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.release(throttle.reserve('gemini-3-pro', 60_000).releaseId, 60_000);
      const r = throttle.reserve('gemini-3-pro', 30_000);
      expect(r.delayMs).toBeGreaterThanOrEqual(60_000);
      expect(r.delayMs).toBeLessThanOrEqual(63_000);
    });

    it('post-delay invariant: sleeping the returned delay brings the window under the limit', () => {
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 60_000);
      throttle.release(a.releaseId, 60_000);

      const r = throttle.reserve('gemini-3-pro', 30_000);
      vi.advanceTimersByTime(r.delayMs);
      // After sleeping, a read-only peek for the same estimate must see
      // no additional delay. r's provisional entry is already in the
      // window, so peek uses estimate=0 to avoid double-counting.
      expect(throttle.shouldDelay('gemini-3-pro', 0)).toBe(0);
    });

    it('proceeds with 0 delay when the estimate alone exceeds the cap', () => {
      // No amount of waiting makes a 120k call fit under 80k/min. We prefer
      // "let Gemini 429 and feed recordRetryHint" over deadlocking the tool.
      const throttle = createTpmThrottle(80_000);
      expect(throttle.reserve('gemini-3-pro', 120_000).delayMs).toBe(0);
    });

    it('returns 0 delay once the sole entry ages out of the window', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.release(throttle.reserve('gemini-3-pro', 60_000).releaseId, 60_000);
      vi.advanceTimersByTime(61_000);
      expect(throttle.reserve('gemini-3-pro', 60_000).delayMs).toBe(0);
    });
  });

  describe('multi-entry eviction (regression test for naïve oldest-only math)', () => {
    it('waits long enough to evict all entries needed to fit the estimate', () => {
      // Three 40k entries at t=0,5s,10s. Limit=80k. Estimate=30k.
      // Sum = 120k; after evicting oldest (t=0), remaining 80k + 30k = 110k > 80k.
      // Must evict the t=5s entry too → wait until t=5000+60000+jitter=65000,
      // which from nowMs=10000 is ~55000ms.
      const throttle = createTpmThrottle(80_000);
      throttle.release(throttle.reserve('gemini-3-pro', 40_000).releaseId, 40_000);
      vi.advanceTimersByTime(5_000);
      throttle.release(throttle.reserve('gemini-3-pro', 40_000).releaseId, 40_000);
      vi.advanceTimersByTime(5_000);
      throttle.release(throttle.reserve('gemini-3-pro', 40_000).releaseId, 40_000);

      const r = throttle.reserve('gemini-3-pro', 30_000);
      // Sanity: delay must cover evicting at least two entries, NOT just one.
      // Naïve "oldest-only" math would compute (60000 - 10000) + 2000 = 52000.
      // Correct math must compute (5000 + 60000 - 10000) + 2000 = 57000.
      expect(r.delayMs).toBeGreaterThanOrEqual(55_000);
      expect(r.delayMs).toBeLessThanOrEqual(58_000);

      // Post-delay invariant: after sleeping, the window fits the call.
      vi.advanceTimersByTime(r.delayMs);
      expect(throttle.shouldDelay('gemini-3-pro', 0)).toBe(0);
    });

    it('evicts just enough entries, not more', () => {
      // Five 20k entries at t=0,1,2,3,4s. Limit=80k. Estimate=30k.
      // Sum=100k + 30k = 130k > 80k. Evict oldest (t=0): 80k + 30k = 110k > 80k.
      // Evict second (t=1): 60k + 30k = 90k > 80k.
      // Evict third (t=2): 40k + 30k = 70k <= 80k ✓
      // Wait time = (2000 + 60000 - 4000) + 2000 = 60000ms from nowMs=4000.
      const throttle = createTpmThrottle(80_000);
      for (let i = 0; i < 5; i++) {
        throttle.release(throttle.reserve('gemini-3-pro', 20_000).releaseId, 20_000);
        vi.advanceTimersByTime(1_000);
      }
      // nowMs = 4000 (after 5 records and 4 advances).
      const r = throttle.reserve('gemini-3-pro', 30_000);
      expect(r.delayMs).toBeGreaterThanOrEqual(58_000);
      expect(r.delayMs).toBeLessThanOrEqual(61_000);
    });
  });

  describe('reservation race — TOCTOU fix', () => {
    it('second concurrent caller sees the first caller’s provisional entry', () => {
      // Empty window, limit 80k. Both callers estimate 50k. Without
      // provisional reservation, both see empty window and both proceed
      // (this is the exact bug the reserve/release API was designed to fix).
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 50_000);
      expect(a.delayMs).toBe(0);
      // A has NOT released yet — simulating the TOCTOU window.
      const b = throttle.reserve('gemini-3-pro', 50_000);
      // B must back off, because A's provisional 50k is in the window.
      expect(b.delayMs).toBeGreaterThan(0);
    });

    it('cancel frees up the provisional slot for the next caller', () => {
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 50_000);
      const b = throttle.reserve('gemini-3-pro', 50_000);
      expect(b.delayMs).toBeGreaterThan(0);
      throttle.cancel(a.releaseId);
      // Also cancel B so the next peek sees a clean window.
      throttle.cancel(b.releaseId);
      const c = throttle.reserve('gemini-3-pro', 50_000);
      expect(c.delayMs).toBe(0);
    });

    it('release with actual < estimate frees headroom for subsequent callers', () => {
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 60_000); // estimate
      throttle.release(a.releaseId, 10_000); // actual much smaller
      // Window now reflects 10k, not 60k. A 60k call should fit.
      expect(throttle.reserve('gemini-3-pro', 60_000).delayMs).toBe(0);
    });

    it('release with actual > estimate pushes the window up for subsequent callers', () => {
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 30_000); // under-estimate
      throttle.release(a.releaseId, 70_000); // actual much larger
      // Window now reflects 70k. A 20k call should delay.
      expect(throttle.reserve('gemini-3-pro', 20_000).delayMs).toBeGreaterThan(0);
    });

    it('release of an unknown id is a no-op (idempotent)', () => {
      const throttle = createTpmThrottle(80_000);
      expect(() => throttle.release(9999, 1000)).not.toThrow();
      expect(() => throttle.release(-1, 1000)).not.toThrow();
    });

    it('cancel of an unknown id is a no-op (idempotent)', () => {
      const throttle = createTpmThrottle(80_000);
      expect(() => throttle.cancel(9999)).not.toThrow();
      expect(() => throttle.cancel(-1)).not.toThrow();
    });

    it('releaseIds are unique across reservations', () => {
      const throttle = createTpmThrottle(80_000);
      const ids = new Set<number>();
      for (let i = 0; i < 100; i++) {
        ids.add(throttle.reserve('gemini-3-pro', 100).releaseId);
      }
      expect(ids.size).toBe(100);
    });

    it('release after cancel is a no-op — idempotent lifecycle', () => {
      // Real-world failure mode: ask.tool.ts catches an error, calls cancel,
      // but a late-landing response also triggers release on the same id.
      // Must not resurrect the cancelled entry or throw.
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 50_000);
      throttle.cancel(a.releaseId);
      expect(() => throttle.release(a.releaseId, 50_000)).not.toThrow();
      // The cancelled slot must not have been resurrected — a fresh 50k
      // reserve should see an empty window.
      expect(throttle.reserve('gemini-3-pro', 50_000).delayMs).toBe(0);
    });

    it('release accepts explicit nowMs and prunes against it', () => {
      // release(id, tokens, nowMs?) takes an nowMs parameter used for the
      // opportunistic prune that amortises cleanup. Tests without this
      // parameter implicitly rely on Date.now(); exercise the explicit path
      // so an accidental signature change surfaces.
      const throttle = createTpmThrottle(80_000);
      const baseMs = Date.now();
      const a = throttle.reserve('gemini-3-pro', 60_000, baseMs);
      // Advance wall clock past WINDOW_MS but pass an explicit stale nowMs.
      // prune should still run against baseMs + 61_000 and evict the entry.
      vi.advanceTimersByTime(61_000);
      throttle.release(a.releaseId, 60_000, baseMs + 61_000);
      // Entry aged out; a fresh 60k reserve must fit immediately.
      expect(throttle.reserve('gemini-3-pro', 60_000).delayMs).toBe(0);
    });
  });

  describe('shouldDelay is non-inflating', () => {
    it('repeated shouldDelay calls do not grow the window', () => {
      // shouldDelay is a read-only peek — it may prune/clamp (normalisation)
      // but must NEVER insert a provisional WindowEntry. Otherwise every
      // diagnostic/test-helper call would silently consume throttle budget.
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 30_000);
      throttle.release(a.releaseId, 30_000);

      // 10 peek calls at 20k each. If any of them inserted an entry, by
      // the 10th call sum would be 30k + N*20k; the final reserve below
      // would then delay. Invariant: after peeks, the real window is
      // still just {30k}, so a 40k reserve fits immediately (30+40=70).
      for (let i = 0; i < 10; i++) {
        throttle.shouldDelay('gemini-3-pro', 20_000);
      }
      expect(throttle.reserve('gemini-3-pro', 40_000).delayMs).toBe(0);
    });
  });

  describe('oversize-estimate lockout (deliberate)', () => {
    it('reserve with estimate >= limit returns delay 0 but still consumes a window slot', () => {
      // Intentional semantics: a single call whose estimate alone exceeds
      // the cap proceeds immediately (we let Gemini 429 and feed
      // recordRetryHint rather than deadlock the tool), but the provisional
      // entry IS inserted with the oversize tokens. A subsequent caller
      // sees sum >= limit and must wait the full window — a ~60s "lockout"
      // following any oversize call. This test locks the behaviour in so
      // future refactors don't silently swap it for either (a) refusing
      // oversize reserves or (b) inserting with tokens=0.
      const throttle = createTpmThrottle(80_000);
      const oversize = throttle.reserve('gemini-3-pro', 120_000);
      expect(oversize.delayMs).toBe(0);
      throttle.release(oversize.releaseId, 120_000);

      // Next call: window holds 120k > limit; even a tiny estimate waits.
      const next = throttle.reserve('gemini-3-pro', 1_000);
      expect(next.delayMs).toBeGreaterThanOrEqual(60_000);
    });
  });

  describe('per-model isolation', () => {
    it('saturating pro does not delay flash calls', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.release(throttle.reserve('gemini-3-pro', 70_000).releaseId, 70_000);
      expect(throttle.reserve('gemini-3-pro', 30_000).delayMs).toBeGreaterThan(0);
      expect(throttle.reserve('gemini-3-flash', 30_000).delayMs).toBe(0);
    });

    it('retry hint for pro does not affect flash', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.recordRetryHint('gemini-3-pro', 15_000);
      expect(throttle.reserve('gemini-3-pro', 10_000).delayMs).toBeGreaterThanOrEqual(15_000);
      expect(throttle.reserve('gemini-3-flash', 10_000).delayMs).toBe(0);
    });
  });

  describe('retry hints', () => {
    it('uses hint delay when it exceeds the computed window delay', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.recordRetryHint('gemini-3-pro', 15_000);
      expect(throttle.reserve('gemini-3-pro', 10_000).delayMs).toBe(15_000);
    });

    it('uses the larger of (window, hint)', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.release(throttle.reserve('gemini-3-pro', 70_000).releaseId, 70_000);
      throttle.recordRetryHint('gemini-3-pro', 5_000);
      // Window requires ~60s + jitter; hint asks for only 5s. Window wins.
      expect(throttle.reserve('gemini-3-pro', 20_000).delayMs).toBeGreaterThanOrEqual(60_000);
    });

    it('hint expires after its retryDelayMs', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.recordRetryHint('gemini-3-pro', 5_000);
      vi.advanceTimersByTime(6_000);
      expect(throttle.reserve('gemini-3-pro', 10_000).delayMs).toBe(0);
    });

    it('ignores non-positive or non-finite hints', () => {
      const throttle = createTpmThrottle(80_000);
      throttle.recordRetryHint('gemini-3-pro', 0);
      throttle.recordRetryHint('gemini-3-pro', -1);
      throttle.recordRetryHint('gemini-3-pro', Number.NaN);
      expect(throttle.reserve('gemini-3-pro', 10_000).delayMs).toBe(0);
    });
  });

  describe('non-monotonic clock', () => {
    it('does not over-delay when nowMs jumps backwards', () => {
      const throttle = createTpmThrottle(80_000);
      // Record at t=10s, then pretend clock jumped back to t=5s.
      const baseMs = Date.now();
      throttle.release(throttle.reserve('gemini-3-pro', 70_000, baseMs + 10_000).releaseId, 70_000);
      const r = throttle.reserve('gemini-3-pro', 20_000, baseMs + 5_000);
      // Backwards clock is clamped to max observed tsMs. Delay should be
      // the proper window eviction delay (~60s + jitter), not a runaway
      // > WINDOW_MS figure that the naïve formula would produce.
      expect(r.delayMs).toBeGreaterThanOrEqual(60_000);
      expect(r.delayMs).toBeLessThanOrEqual(65_000);
    });
  });

  describe('input validation', () => {
    it('throws on a negative or non-finite limit', () => {
      expect(() => createTpmThrottle(-1)).toThrow(/non-negative finite/);
      expect(() => createTpmThrottle(Number.NaN)).toThrow();
      expect(() => createTpmThrottle(Number.POSITIVE_INFINITY)).toThrow();
    });

    it('sanitises non-finite estimates without crashing', () => {
      const throttle = createTpmThrottle(80_000);
      expect(throttle.reserve('gemini-3-pro', -1).delayMs).toBe(0);
      expect(throttle.reserve('gemini-3-pro', Number.NaN).delayMs).toBe(0);
    });

    it('sanitises non-positive actuals in release', () => {
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 60_000);
      throttle.release(a.releaseId, -5); // coerced to 0
      // The reservation's token count is now 0, so the window is effectively
      // empty. A 70k call should fit without delay.
      expect(throttle.reserve('gemini-3-pro', 70_000).delayMs).toBe(0);
    });

    it('sanitises non-finite nowMs — poisoning guard', () => {
      // A caller passing Number.NEGATIVE_INFINITY (or NaN, or +Infinity) as
      // `nowMs` would otherwise poison `lastObservedNowMs` and cause every
      // subsequent call to compute delays of +Infinity / NaN. Consistent
      // with `sanitizeTokens`' "coerce rather than crash" philosophy, we
      // fall back to Date.now() on non-finite input.
      const throttle = createTpmThrottle(80_000);
      // Poison attempt with -Infinity, +Infinity, NaN.
      throttle.reserve('gemini-3-pro', 10_000, Number.NEGATIVE_INFINITY);
      throttle.reserve('gemini-3-pro', 10_000, Number.POSITIVE_INFINITY);
      throttle.reserve('gemini-3-pro', 10_000, Number.NaN);
      // A subsequent legitimate reserve must not return a non-finite delay.
      const r = throttle.reserve('gemini-3-pro', 10_000);
      expect(Number.isFinite(r.delayMs)).toBe(true);
      expect(r.delayMs).toBeGreaterThanOrEqual(0);
    });
  });
});
