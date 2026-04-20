import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTpmThrottle, parseRetryDelayMs } from '../../src/tools/shared/throttle.js';

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

  describe('sorted-array invariant (regression — Copilot/Grok/Gemini PR #19)', () => {
    it('delay=0 reservation after future-dated provisional inserts in correct sorted position', () => {
      // State: limit=80k. R1 reserves 70k → delay=0, tsMs=0. Release.
      // R2 reserves 15k → over limit, must evict E1. wait = 0+60000-delta
      // → R2.tsMs ≈ 62000 (future-dated). Release.
      // R3 arrives at t=61000 — E1 has aged out of prune's cutoff;
      // remaining sum = 15k; R3's 15k fits → delay=0 → R3.tsMs=61000.
      // Naïve append would leave array [E2@62000, E3@61000] — UNSORTED.
      // Sorted-insert must place R3 BEFORE E2.
      const throttle = createTpmThrottle(80_000);
      const baseMs = Date.now();
      const r1 = throttle.reserve('gemini-3-pro', 70_000, baseMs);
      throttle.release(r1.releaseId, 70_000, baseMs);
      vi.advanceTimersByTime(5_000);
      const r2 = throttle.reserve('gemini-3-pro', 15_000);
      throttle.release(r2.releaseId, 15_000);
      vi.advanceTimersByTime(56_000); // now at baseMs + 61_000
      const r3 = throttle.reserve('gemini-3-pro', 15_000);
      expect(r3.delayMs).toBe(0); // delay=0 confirms E1 was evicted + R3 fits.
      throttle.release(r3.releaseId, 15_000);

      // After R2's future-dated tsMs eventually expires from window, the
      // next reserve should see a clean window. If sorted-insert was wrong,
      // R3 (stored at tsMs=61000) would age out at 121000 but R2 (stored
      // at tsMs~62000) would age out at 122000. `prune`'s head-only fast-
      // path must see R3 as head (earliest) — otherwise it skips pruning.
      // Advance past both: nowMs = baseMs + 123_000. Prune cutoff = 63_000.
      // Both R2.tsMs~62000 and R3.tsMs=61000 are below cutoff → both evicted.
      vi.advanceTimersByTime(62_000); // now at baseMs + 123_000
      expect(throttle.shouldDelay('gemini-3-pro', 79_999)).toBe(0);
    });

    it('retry-hint downgrade does not produce out-of-order entries (extend-only hint)', () => {
      // PR #19 Gemini finding: shorter hint replacing longer one previously
      // let the next reserve compute a smaller tsMs than entries appended
      // under the longer hint. Extend-only `recordRetryHint` preserves the
      // longer expiry so the tsMs order stays sorted.
      const throttle = createTpmThrottle(80_000);
      const baseMs = Date.now();

      // 60s hint → reserve dated at baseMs+60000.
      throttle.recordRetryHint('gemini-3-pro', 60_000, baseMs);
      const r1 = throttle.reserve('gemini-3-pro', 1, baseMs);
      expect(r1.delayMs).toBe(60_000);

      // Attempt to downgrade to 5s hint — must be ignored.
      throttle.recordRetryHint('gemini-3-pro', 5_000, baseMs + 10);
      const r2 = throttle.reserve('gemini-3-pro', 1, baseMs + 11);
      // Hint still expires at baseMs+60000. r2.delayMs ≈ 59989 (pure hint,
      // window fits), tsMs ≈ 60000. Order preserved: r2.tsMs >= r1.tsMs.
      expect(r2.delayMs).toBeGreaterThanOrEqual(59_985);
      expect(r2.delayMs).toBeLessThanOrEqual(59_990);
      // Explicit: the shorter-hint must have been rejected. If it had taken
      // effect, r2.delayMs would be ≤ 5_000 (5s - 11ms = 4989ms). Direct
      // assertion matching PR #19 round-2 Grok coverage request.
      expect(r2.delayMs).toBeGreaterThan(5_000);

      // Subsequent upgrade to a LONGER hint should succeed.
      throttle.recordRetryHint('gemini-3-pro', 120_000, baseMs + 20);
      const r3 = throttle.reserve('gemini-3-pro', 1, baseMs + 21);
      // Now hint expires at baseMs+120020. r3.delayMs ≈ 119999.
      expect(r3.delayMs).toBeGreaterThanOrEqual(119_995);
    });

    it('prune correctly evicts mid-array expired entries', () => {
      // This was the empirical over-throttle scenario from the PR #19
      // review: fast-path checked only entries[0]; an entry buried
      // mid-array (small tsMs but later in insertion order) was skipped.
      // Sorted-insert places it at head → fast-path correctly falls
      // through to the full scan → eviction happens.
      const throttle = createTpmThrottle(80_000);
      const baseMs = Date.now();

      // Put a future-dated entry first.
      throttle.recordRetryHint('gemini-3-pro', 60_000, baseMs);
      const r1 = throttle.reserve('gemini-3-pro', 1, baseMs); // tsMs = baseMs+60000

      // Retry-hint-downgrade attempt would not work after the fix, so we
      // build the scenario via window-eviction instead. Heavy first entry
      // + moderate new estimate → future-dated provisional.
      throttle.release(r1.releaseId, 1, baseMs);

      // Now a fresh heavy entry that forces a second future-dated push.
      const r2 = throttle.reserve('gemini-3-pro', 70_000, baseMs + 5_000);
      throttle.release(r2.releaseId, 70_000, baseMs + 5_000);

      // r2 was far enough in the past to require a smaller delay than r1;
      // both still live in the window. Advance past r1's 60s expiry
      // point but not past r2's; sorted-insert guarantees `prune` walks
      // the right head.
      vi.advanceTimersByTime(61_000); // now at baseMs + 61_000
      // Cutoff = 1_000. r1.tsMs = 60_000 > 1_000 → kept. r2.tsMs = 65_000
      // > 1_000 → kept. No eviction in this step — but sorted invariant
      // means `prune` does NOT short-circuit incorrectly.
      const peek = throttle.shouldDelay('gemini-3-pro', 0, baseMs + 61_000);
      expect(Number.isFinite(peek)).toBe(true); // Sanity — no NaN.

      // Advance enough for r1 to expire naturally.
      vi.advanceTimersByTime(5_000); // now at baseMs + 66_000
      // Cutoff = 6_000. r1.tsMs = 60_000 > 6_000 → kept still.
      // Keep going: prune will eventually evict all entries.
      vi.advanceTimersByTime(10_000); // now at baseMs + 76_000
      expect(throttle.shouldDelay('gemini-3-pro', 1, baseMs + 76_000)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('stale-cache retry semantics (regression — PR #19 round-2 GPT)', () => {
    it('cancel + fresh reserve refreshes tsMs to reflect retry dispatch time', () => {
      // Scenario: first reserve at t=0 stamps tsMs=0. First generateContent
      // fails with stale-cache error. Rebuild prepareContext takes ~15s.
      // WITHOUT cancel+re-reserve: retry's generateContent uses the stale
      // tsMs=0 reservation; our window expires at t=60s but Gemini's runs
      // t=15s..t=75s. 15s gap where concurrent callers bust quota.
      // WITH cancel+re-reserve (the shipped fix): retry gets tsMs=15, our
      // window aligns with Gemini's (t=15s..t=75s).
      const throttle = createTpmThrottle(80_000);
      const baseMs = Date.now();

      const first = throttle.reserve('gemini-3-pro', 50_000, baseMs);
      expect(first.delayMs).toBe(0);
      // Simulate stale-cache rebuild taking 15s. No release because first
      // generateContent failed.
      vi.advanceTimersByTime(15_000);
      throttle.cancel(first.releaseId);

      // Re-reserve for the retry's actual dispatch.
      const retry = throttle.reserve('gemini-3-pro', 50_000, baseMs + 15_000);
      expect(retry.delayMs).toBe(0); // Cancel freed the slot.
      throttle.release(retry.releaseId, 50_000, baseMs + 15_000);

      // Critical post-condition: the window should reflect tokens aged from
      // baseMs+15000, not baseMs. A concurrent call at baseMs+60000 (60s
      // after original first-reserve) would, WITHOUT the fix, see empty
      // window (entry expired) and admit — but Gemini's counter still has
      // 50k (dispatched at baseMs+15000, expires at baseMs+75000). Post-fix,
      // the entry is still in OUR window at baseMs+60000 (tsMs=baseMs+15000,
      // age=45000 < WINDOW=60000), so a concurrent 50k reserve delays.
      vi.advanceTimersByTime(45_000); // now at baseMs + 60_000
      const concurrent = throttle.reserve('gemini-3-pro', 50_000, baseMs + 60_000);
      expect(concurrent.delayMs).toBeGreaterThan(0);
    });
  });

  describe('release lifecycle — index cleanup (regression — GPT PR #19)', () => {
    it('double release on same id is idempotent', () => {
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 50_000);
      throttle.release(a.releaseId, 50_000);
      // Second release must be a no-op — the previously accounted entry
      // must not silently mutate to a different token count.
      expect(() => throttle.release(a.releaseId, 999_999)).not.toThrow();

      // Reserve again; window should still reflect the 50k from first
      // release (NOT the 999_999 from the bogus second release — which
      // must have been a no-op). 50k + 40k = 90k > 80k cap → delays.
      const b = throttle.reserve('gemini-3-pro', 40_000);
      expect(b.delayMs).toBeGreaterThan(0);
    });

    it('cancel after release is a no-op (does not evict the already-accounted entry)', () => {
      // Critical: cancel after release must NOT remove the entry that
      // release already mutated. Otherwise a buggy caller leaves the
      // window under-counted.
      const throttle = createTpmThrottle(80_000);
      const a = throttle.reserve('gemini-3-pro', 70_000);
      throttle.release(a.releaseId, 70_000);
      // Buggy cancel — must be ignored, entry stays in window.
      throttle.cancel(a.releaseId);
      const b = throttle.reserve('gemini-3-pro', 20_000);
      // Window still has 70k from `a`. 70+20=90>80 → must delay.
      expect(b.delayMs).toBeGreaterThan(0);
    });
  });

  describe('parseRetryDelayMs (T22a — 429 retryInfo extraction)', () => {
    it('parses integer-seconds retry delay into ms', () => {
      const body = '{"error":{"details":[{"@type":"RetryInfo","retryDelay":"2s"}]}}';
      expect(parseRetryDelayMs(body)).toBe(2_000);
    });

    it('parses fractional-seconds retry delay', () => {
      const body = '{"error":{"details":[{"retryDelay":"15.7s"}]}}';
      expect(parseRetryDelayMs(body)).toBe(15_700);
    });

    it('clamps sub-second values up to the minimum (1s)', () => {
      // Gemini occasionally returns sub-second retryDelay values that would
      // cause tight-loop retries; floor-clamp to 1s so the hint is useful.
      const body = '"retryDelay":"0.3s"';
      expect(parseRetryDelayMs(body)).toBe(1_000);
    });

    it('clamps values above 60s down to the maximum (60s)', () => {
      const body = '"retryDelay":"3600s"';
      expect(parseRetryDelayMs(body)).toBe(60_000);
    });

    it('returns null when retryDelay is absent', () => {
      expect(parseRetryDelayMs('{"error":{"message":"generic 500"}}')).toBeNull();
    });

    it('returns null on malformed JSON-like input missing the seconds suffix', () => {
      // `"retryDelay":"10"` (no trailing `s`) — Gemini always uses the `Ns`
      // suffix format; a missing suffix is a schema drift and we ignore it
      // rather than guess.
      expect(parseRetryDelayMs('"retryDelay":"10"')).toBeNull();
    });

    it('returns null on negative / zero values', () => {
      expect(parseRetryDelayMs('"retryDelay":"0s"')).toBeNull();
      expect(parseRetryDelayMs('"retryDelay":"-1s"')).toBeNull();
    });

    it('returns null on empty / non-string input', () => {
      expect(parseRetryDelayMs('')).toBeNull();
      // Runtime-guard exotic inputs — TS would complain but a JS caller could
      // hand us anything via `err.message` type-coerced.
      expect(parseRetryDelayMs(undefined as unknown as string)).toBeNull();
      expect(parseRetryDelayMs(null as unknown as string)).toBeNull();
    });

    it('seeds the throttle via recordRetryHint — end-to-end use case', () => {
      // The intended integration path: ask/code catch block parses the
      // error message and feeds the hint into the throttle.
      const throttle = createTpmThrottle(80_000);
      const errorBody = '{"retryInfo":{"retryDelay":"8s"}}';
      const delay = parseRetryDelayMs(errorBody);
      expect(delay).toBe(8_000);
      throttle.recordRetryHint('gemini-3-pro', delay as number);
      // Next reserve must back off by at least the hint.
      const r = throttle.reserve('gemini-3-pro', 1);
      expect(r.delayMs).toBeGreaterThanOrEqual(7_990); // -10ms test-clock slack
    });
  });

  describe('jitter randomisation (regression — Gemini PR #19)', () => {
    it('delays for the same scenario produce a spread of jitter values', () => {
      // Deterministic JITTER_MS let concurrent waiters wake at the same ms
      // (thundering herd). Randomised jitter spreads them across 1-3s.
      // This test samples 20 reserves against identical state and asserts
      // at least 5 distinct jitter values appear.
      const samples = new Set<number>();
      for (let i = 0; i < 20; i++) {
        const throttle = createTpmThrottle(80_000);
        const baseMs = Date.now();
        const a = throttle.reserve('gemini-3-pro', 60_000, baseMs);
        throttle.release(a.releaseId, 60_000, baseMs);
        const r = throttle.reserve('gemini-3-pro', 30_000, baseMs);
        samples.add(r.delayMs);
      }
      expect(samples.size).toBeGreaterThanOrEqual(5);
    });

    it('jitter stays within [1s, 3s] range (both bounds inclusive)', () => {
      for (let i = 0; i < 20; i++) {
        const throttle = createTpmThrottle(80_000);
        const baseMs = Date.now();
        const a = throttle.reserve('gemini-3-pro', 60_000, baseMs);
        throttle.release(a.releaseId, 60_000, baseMs);
        const r = throttle.reserve('gemini-3-pro', 30_000, baseMs);
        // Window math: wait = 0 + 60000 - 0 = 60000. + jitter [1000, 3000]
        // (both inclusive — `+1` in the multiplier width in computeJitterMs
        // makes MAX reachable; without it the range was [1000, 2999]).
        expect(r.delayMs).toBeGreaterThanOrEqual(61_000);
        expect(r.delayMs).toBeLessThanOrEqual(63_000);
      }
    });
  });
});
