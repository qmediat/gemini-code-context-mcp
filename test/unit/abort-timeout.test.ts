/**
 * `createTimeoutController` — env-var fallback, per-call override, abort
 * semantics, dispose hygiene, never-firing disabled controller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTimeoutController,
  getTimeoutKind,
  isTimeoutAbort,
} from '../../src/tools/shared/abort-timeout.js';

/** Test-side helper that lets the v1.6.0–v1.11.0 test fixtures keep their
 * concise call shape after the v1.12.0 API change (single-API
 * structured-options form). Behaviour-equivalent to the retired 2-arg
 * signature; production code now uses the structured-options form
 * directly. */
function totalOnlyController(perCallMs: number | undefined, envVar: string) {
  return perCallMs !== undefined
    ? createTimeoutController({ totalMs: perCallMs, totalEnvVar: envVar, stallEnvVar: '' })
    : createTimeoutController({ totalEnvVar: envVar, stallEnvVar: '' });
}

// File-level hard floor: every test in this file starts with real timers and a
// clean env-stub state regardless of the previous test's exit path. The first
// describe (`createTimeoutController`) and the third (`abortableSleep`) both
// call `vi.useFakeTimers()`; without a file-level afterEach, the third
// describe was unprotected — a future contributor appending a real-timer
// test below it would have hit the same fake-timer leak cascade documented in
// `ask-agentic.test.ts` for v1.7.2. Hoisting the cleanup here closes that gap
// (CHANGELOG `[1.7.3]`, /6step Finding #1).
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('createTimeoutController', () => {
  beforeEach(() => {
    // Hermetic env — no real GEMINI_CODE_CONTEXT_*_TIMEOUT_MS bleeds through.
    vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', undefined);
  });

  describe('disabled (no env, no per-call)', () => {
    it('returns a controller whose signal never fires', () => {
      const c = totalOnlyController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
      expect(c.signal.aborted).toBe(false);
      // Calling dispose on a disabled controller is safe.
      c.dispose();
      c.dispose();
    });

    it('treats `0` as disabled', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '0');
      const c = totalOnlyController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });

    it('treats negative values as disabled', () => {
      const c = totalOnlyController(-100, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });

    it('treats non-numeric env as disabled', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', 'not-a-number');
      const c = totalOnlyController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });

    it('treats empty env as disabled', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '');
      const c = totalOnlyController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });
  });

  describe('env-var fallback', () => {
    it('reads timeout from env when per-call is undefined', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '5000');
      const c = totalOnlyController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(5000);
      c.dispose();
    });

    it('per-call wins over env var', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '60000');
      const c = totalOnlyController(10_000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(10_000);
      c.dispose();
    });
  });

  describe('clamping', () => {
    it('clamps below the 1s minimum', () => {
      const c = totalOnlyController(50, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(1_000);
      c.dispose();
    });

    it('clamps above the 30min maximum', () => {
      const c = totalOnlyController(7_200_000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(1_800_000);
      c.dispose();
    });

    it('floors fractional values', () => {
      const c = totalOnlyController(1500.7, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(1500);
      c.dispose();
    });
  });

  describe('abort semantics', () => {
    it('signal fires after the timeout elapses', async () => {
      vi.useFakeTimers();
      const c = totalOnlyController(2000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1999);
      expect(c.signal.aborted).toBe(false);
      vi.advanceTimersByTime(2);
      expect(c.signal.aborted).toBe(true);
      // Reason is a TimeoutError DOMException (or polyfill).
      expect((c.signal.reason as Error).name).toBe('TimeoutError');
      c.dispose();
    });

    it('dispose() before timeout prevents signal from firing', async () => {
      vi.useFakeTimers();
      const c = totalOnlyController(2000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      c.dispose();
      vi.advanceTimersByTime(5000);
      expect(c.signal.aborted).toBe(false);
    });
  });
});

describe('isTimeoutAbort', () => {
  it('returns true for a TimeoutError', () => {
    const err = new DOMException('timed out', 'TimeoutError');
    expect(isTimeoutAbort(err)).toBe(true);
  });

  it('returns true for an error whose cause is a TimeoutError', () => {
    const inner = new DOMException('timed out', 'TimeoutError');
    const wrapped = new Error('wrapped', { cause: inner });
    expect(isTimeoutAbort(wrapped)).toBe(true);
  });

  it('walks the full cause chain (depth ≥ 2) — SDK paths can wrap multiple times', () => {
    const inner = new DOMException('timed out', 'TimeoutError');
    const mid = new Error('fetch failed', { cause: inner });
    const outer = new Error('SDK wrapped fetch', { cause: mid });
    expect(isTimeoutAbort(outer)).toBe(true);
  });

  it('handles even deeper chains (3 levels)', () => {
    const a = new DOMException('timed out', 'TimeoutError');
    const b = new Error('layer 1', { cause: a });
    const c = new Error('layer 2', { cause: b });
    const d = new Error('layer 3', { cause: c });
    expect(isTimeoutAbort(d)).toBe(true);
  });

  it('is cycle-safe: does not infinite-loop on a self-cyclic cause', () => {
    const cyclic = new Error('cyclic') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isTimeoutAbort(cyclic)).toBe(false);
  });

  it('is cycle-safe: handles two-error cycle', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isTimeoutAbort(a)).toBe(false);
  });

  it('returns false for a regular AbortError', () => {
    const err = new DOMException('aborted by user', 'AbortError');
    expect(isTimeoutAbort(err)).toBe(false);
  });

  it('returns false for a generic Error', () => {
    expect(isTimeoutAbort(new Error('plain'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTimeoutAbort('a string')).toBe(false);
    expect(isTimeoutAbort(null)).toBe(false);
    expect(isTimeoutAbort(undefined)).toBe(false);
    expect(isTimeoutAbort({ name: 'TimeoutError' })).toBe(false);
  });
});

describe('abortableSleep — exported for tool-side throttle waits (T19 H1 fix)', () => {
  it('resolves normally after `ms` when signal never fires', async () => {
    vi.useFakeTimers();
    const { abortableSleep } = await import('../../src/gemini/retry.js');
    const controller = new AbortController();
    const promise = abortableSleep(50, controller.signal);
    vi.advanceTimersByTime(60);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects immediately when signal already aborted (pre-flight check)', async () => {
    const { abortableSleep } = await import('../../src/gemini/retry.js');
    const controller = new AbortController();
    controller.abort(new DOMException('pre-aborted', 'TimeoutError'));
    await expect(abortableSleep(60_000, controller.signal)).rejects.toThrow(/pre-aborted/);
  });

  it('rejects when signal fires DURING the sleep (interrupts long wait)', async () => {
    vi.useFakeTimers();
    const { abortableSleep } = await import('../../src/gemini/retry.js');
    const controller = new AbortController();
    const promise = abortableSleep(60_000, controller.signal);
    // Fire abort while sleeping.
    setTimeout(() => controller.abort(new DOMException('mid-sleep', 'TimeoutError')), 100);
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow(/mid-sleep/);
  });

  it('handles undefined signal (treated as no abort capability)', async () => {
    vi.useFakeTimers();
    const { abortableSleep } = await import('../../src/gemini/retry.js');
    const promise = abortableSleep(50, undefined);
    vi.advanceTimersByTime(60);
    await expect(promise).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Phase 4 (v1.12.0) — heartbeat-aware stall detector + composite controller.
//
// Real timers throughout — fake timers can't simulate the chunk-arrival
// stream events the stall watchdog resets on. Per the v1.7.2 lesson
// (real `realpath` I/O racing fake timers), this whole describe block uses
// real timers and short (50-300ms) durations to keep the suite fast.
// ===========================================================================

describe('createTimeoutController — composite (Phase 4)', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', undefined);
    vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_STALL_MS', undefined);
  });

  describe('structured-options API', () => {
    it('returns a never-firing controller when both totalMs and stallMs disabled', () => {
      const c = createTimeoutController({
        totalEnvVar: 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS',
        stallEnvVar: 'GEMINI_CODE_CONTEXT_TEST_STALL_MS',
      });
      expect(c.timeoutMs).toBeNull();
      expect(c.stallMs).toBeNull();
      expect(c.signal.aborted).toBe(false);
      // recordChunk is a no-op when stall disabled.
      c.recordChunk();
      c.recordChunk();
      expect(c.signal.aborted).toBe(false);
      c.dispose();
    });

    it('reports both totalMs and stallMs when both are set', () => {
      const c = createTimeoutController({
        totalMs: 5_000,
        totalEnvVar: 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS',
        stallMs: 2_000,
        stallEnvVar: 'GEMINI_CODE_CONTEXT_TEST_STALL_MS',
      });
      expect(c.timeoutMs).toBe(5_000);
      expect(c.stallMs).toBe(2_000);
      c.dispose();
    });

    it('per-call stallMs wins over env var', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_STALL_MS', '999');
      const c = createTimeoutController({
        totalEnvVar: 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS',
        stallMs: 30_000,
        stallEnvVar: 'GEMINI_CODE_CONTEXT_TEST_STALL_MS',
      });
      expect(c.stallMs).toBe(30_000);
      c.dispose();
    });

    it('clamps stallMs to [1_000, 600_000]', () => {
      const tooSmall = createTimeoutController({
        totalEnvVar: 'TOTAL',
        stallMs: 100,
        stallEnvVar: 'STALL',
      });
      expect(tooSmall.stallMs).toBe(1_000);
      tooSmall.dispose();

      const tooLarge = createTimeoutController({
        totalEnvVar: 'TOTAL',
        stallMs: 9_999_999,
        stallEnvVar: 'STALL',
      });
      expect(tooLarge.stallMs).toBe(600_000);
      tooLarge.dispose();
    });
  });

  describe('stall watchdog firing', () => {
    it('does NOT fire BEFORE the first recordChunk() call (preflight latency safety)', async () => {
      // v1.12.0 design fix: stall timer arms on the FIRST recordChunk(),
      // not on controller creation. This prevents preflight latency
      // (workspace scan + countTokens + Files API upload + TLS handshake)
      // from being counted as "stall budget" — that latency is local
      // I/O / SDK setup, not Gemini-side stall.
      const c = createTimeoutController({
        totalEnvVar: 'TOTAL',
        stallMs: 1_000,
        stallEnvVar: 'STALL',
      });
      // Wait > stallMs without ever calling recordChunk — must NOT fire.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(c.signal.aborted).toBe(false);
      c.dispose();
    });

    it('fires after `stallMs` of silence FOLLOWING the first recordChunk()', async () => {
      const c = createTimeoutController({
        totalEnvVar: 'TOTAL',
        stallMs: 1_000, // 1s — minimum allowed; lowest test value
        stallEnvVar: 'STALL',
      });
      // Arm the stall watchdog by recording the first chunk.
      c.recordChunk();
      const start = Date.now();
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          c.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        c.signal.addEventListener('abort', onAbort);
      });
      const elapsed = Date.now() - start;
      // Tolerate a 5% lower-bound flake margin per v1.7.2 timer-precision policy.
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(c.signal.aborted).toBe(true);
      expect(c.signal.reason).toBeInstanceOf(DOMException);
      expect(getTimeoutKind(c.signal.reason)).toBe('stall');
      expect(isTimeoutAbort(c.signal.reason)).toBe(true);
      // Property-based dispatch (not message string-matching) — pin
      // the v1.12.0 robustness improvement.
      expect((c.signal.reason as { timeoutKind?: unknown }).timeoutKind).toBe('stall');
      c.dispose();
    });

    it('does NOT fire when `recordChunk` is called within stallMs', async () => {
      const c = createTimeoutController({
        totalEnvVar: 'TOTAL',
        stallMs: 1_000,
        stallEnvVar: 'STALL',
      });
      // Record a chunk every 200ms for 1.5s — total elapsed > stallMs but
      // each gap < stallMs, so the watchdog should NOT fire.
      const interval = setInterval(() => c.recordChunk(), 200);
      await new Promise((r) => setTimeout(r, 1_500));
      clearInterval(interval);
      expect(c.signal.aborted).toBe(false);
      c.dispose();
    });

    it('fires when chunks stop after some activity', async () => {
      const c = createTimeoutController({
        totalEnvVar: 'TOTAL',
        stallMs: 1_000,
        stallEnvVar: 'STALL',
      });
      // 2 chunks 200ms apart → gap → silence > stallMs → abort.
      c.recordChunk();
      await new Promise((r) => setTimeout(r, 200));
      c.recordChunk();
      // Now wait for the stall to fire.
      const start = Date.now();
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          c.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        c.signal.addEventListener('abort', onAbort);
      });
      const elapsed = Date.now() - start;
      // Stall fires ~1s after the last recordChunk.
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(getTimeoutKind(c.signal.reason)).toBe('stall');
      c.dispose();
    });
  });

  describe('total wall-clock firing (still works alongside stall)', () => {
    it('fires after `totalMs` even when chunks are flowing', async () => {
      const c = createTimeoutController({
        totalMs: 1_500,
        totalEnvVar: 'TOTAL',
        stallMs: 5_000, // stall is much longer — total wins
        stallEnvVar: 'STALL',
      });
      // Keep the stall watchdog reset so ONLY total can fire.
      const interval = setInterval(() => c.recordChunk(), 200);
      const start = Date.now();
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          c.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        c.signal.addEventListener('abort', onAbort);
      });
      clearInterval(interval);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
      expect(getTimeoutKind(c.signal.reason)).toBe('total');
      c.dispose();
    });
  });

  describe('dispose() hardens against post-cleanup re-arming (defense-in-depth)', () => {
    it('recordChunk() after dispose() does NOT re-arm the stall timer', async () => {
      const c = createTimeoutController({
        totalEnvVar: 'TOTAL',
        stallMs: 1_000,
        stallEnvVar: 'STALL',
      });
      // Arm + then dispose.
      c.recordChunk();
      c.dispose();
      // recordChunk after dispose must be a no-op — must not create a
      // new setTimeout. Wait > stallMs to confirm no spurious abort.
      c.recordChunk();
      await new Promise((r) => setTimeout(r, 1_500));
      expect(c.signal.aborted).toBe(false);
    });
  });

  describe('whichever fires first wins', () => {
    it('stall fires first when totalMs is far in the future and chunks stop after activity', async () => {
      const c = createTimeoutController({
        totalMs: 60_000, // 60s — way out
        totalEnvVar: 'TOTAL',
        stallMs: 1_000, // 1s — fires first (after first recordChunk)
        stallEnvVar: 'STALL',
      });
      // Arm the stall watchdog by recording one chunk, then go silent.
      c.recordChunk();
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          c.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        c.signal.addEventListener('abort', onAbort);
      });
      expect(getTimeoutKind(c.signal.reason)).toBe('stall');
      c.dispose();
    });
  });
});

describe('getTimeoutKind', () => {
  it("returns 'total' for total wall-clock timeout", () => {
    const reason = new DOMException('Timed out after 5000 ms (total wall-clock)', 'TimeoutError');
    expect(getTimeoutKind(reason)).toBe('total');
  });

  it("returns 'stall' for stall watchdog timeout", () => {
    const reason = new DOMException(
      'Timed out after 1000 ms (stall — no chunk received)',
      'TimeoutError',
    );
    expect(getTimeoutKind(reason)).toBe('stall');
  });

  it("returns 'total' for legacy/pre-v1.12.0 TimeoutError messages without suffix (backward compat)", () => {
    const reason = new DOMException('Timed out after 5000 ms', 'TimeoutError');
    expect(getTimeoutKind(reason)).toBe('total');
  });

  it('returns null for non-timeout errors', () => {
    expect(getTimeoutKind(new Error('regular error'))).toBeNull();
    expect(getTimeoutKind('not an error')).toBeNull();
    expect(getTimeoutKind(null)).toBeNull();
  });

  it('walks the cause chain', () => {
    const inner = new DOMException(
      'Timed out after 1000 ms (stall — no chunk received)',
      'TimeoutError',
    );
    const outer = new Error('SDK error', { cause: inner });
    expect(getTimeoutKind(outer)).toBe('stall');
  });
});
