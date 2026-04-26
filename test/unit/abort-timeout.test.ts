/**
 * `createTimeoutController` — env-var fallback, per-call override, abort
 * semantics, dispose hygiene, never-firing disabled controller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTimeoutController, isTimeoutAbort } from '../../src/tools/shared/abort-timeout.js';

describe('createTimeoutController', () => {
  beforeEach(() => {
    // Hermetic env — no real GEMINI_CODE_CONTEXT_*_TIMEOUT_MS bleeds through.
    vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe('disabled (no env, no per-call)', () => {
    it('returns a controller whose signal never fires', () => {
      const c = createTimeoutController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
      expect(c.signal.aborted).toBe(false);
      // Calling dispose on a disabled controller is safe.
      c.dispose();
      c.dispose();
    });

    it('treats `0` as disabled', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '0');
      const c = createTimeoutController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });

    it('treats negative values as disabled', () => {
      const c = createTimeoutController(-100, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });

    it('treats non-numeric env as disabled', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', 'not-a-number');
      const c = createTimeoutController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });

    it('treats empty env as disabled', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '');
      const c = createTimeoutController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBeNull();
    });
  });

  describe('env-var fallback', () => {
    it('reads timeout from env when per-call is undefined', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '5000');
      const c = createTimeoutController(undefined, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(5000);
      c.dispose();
    });

    it('per-call wins over env var', () => {
      vi.stubEnv('GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS', '60000');
      const c = createTimeoutController(10_000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(10_000);
      c.dispose();
    });
  });

  describe('clamping', () => {
    it('clamps below the 1s minimum', () => {
      const c = createTimeoutController(50, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(1_000);
      c.dispose();
    });

    it('clamps above the 30min maximum', () => {
      const c = createTimeoutController(7_200_000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(1_800_000);
      c.dispose();
    });

    it('floors fractional values', () => {
      const c = createTimeoutController(1500.7, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
      expect(c.timeoutMs).toBe(1500);
      c.dispose();
    });
  });

  describe('abort semantics', () => {
    it('signal fires after the timeout elapses', async () => {
      vi.useFakeTimers();
      const c = createTimeoutController(2000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
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
      const c = createTimeoutController(2000, 'GEMINI_CODE_CONTEXT_TEST_TIMEOUT_MS');
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
