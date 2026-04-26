import { describe, expect, it, vi } from 'vitest';
import { isTransientNetworkError, withNetworkRetry } from '../../src/gemini/retry.js';

describe('isTransientNetworkError', () => {
  it('recognises Node undici TypeError: fetch failed', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true);
  });

  it('recognises transient errno codes surfaced via err.cause.code', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = Object.assign(new Error('ECONNRESET'), {
      code: 'ECONNRESET',
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('recognises transient errno codes in the message even without a cause', () => {
    expect(isTransientNetworkError(new Error('connect ETIMEDOUT 142.250.0.1:443'))).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isTransientNetworkError(new Error('getaddrinfo EAI_AGAIN generativelanguage'))).toBe(
      true,
    );
  });

  it('rejects HTTP status errors (handled by the SDK retry path)', () => {
    const err = new Error('500 Internal Server Error');
    (err as { status?: number }).status = 500;
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('rejects user-initiated AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('rejects non-network errors (validation, assertion, plain Error)', () => {
    expect(isTransientNetworkError(new Error('validation failed'))).toBe(false);
    expect(isTransientNetworkError(new TypeError('Cannot read properties of undefined'))).toBe(
      false,
    );
    expect(isTransientNetworkError(new Error('invalid_argument: schema mismatch'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isTransientNetworkError('fetch failed')).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError({ message: 'fetch failed' })).toBe(false);
  });
});

describe('withNetworkRetry', () => {
  it('returns on first success without retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withNetworkRetry(fn, { baseMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient failure and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    await expect(withNetworkRetry(fn, { baseMs: 0, attempts: 3 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates non-transient errors immediately without retry', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('validation failed'));
    await expect(withNetworkRetry(fn, { baseMs: 0, attempts: 5 })).rejects.toThrow(
      'validation failed',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts the budget on persistent transient failure', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(withNetworkRetry(fn, { attempts: 3, baseMs: 0 })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('clamps `attempts` to [1, 10]', async () => {
    const bigFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(withNetworkRetry(bigFn, { attempts: 999, baseMs: 0 })).rejects.toThrow(
      'fetch failed',
    );
    expect(bigFn).toHaveBeenCalledTimes(10);

    const smallFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(withNetworkRetry(smallFn, { attempts: 0, baseMs: 0 })).rejects.toThrow(
      'fetch failed',
    );
    expect(smallFn).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry before each retry with the failed attempt number', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    await withNetworkRetry(fn, { attempts: 3, baseMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(TypeError));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(TypeError));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('applies exponential backoff with factor 3', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    await withNetworkRetry(fn, { attempts: 3, baseMs: 100 });
    // Two retries → two setTimeout calls at 100ms and 300ms.
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(100);
    expect(delays).toContain(300);
    setTimeoutSpy.mockRestore();
  });
});

describe('withNetworkRetry — AbortSignal integration (T19, v1.6.0)', () => {
  it('throws immediately if signal is already aborted before first attempt', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('pre-aborted', 'TimeoutError'));
    const fn = vi.fn(async () => 'should not run');
    await expect(withNetworkRetry(fn, { signal: controller.signal })).rejects.toThrow(
      /pre-aborted/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('short-circuits the backoff sleep when signal fires during retry wait', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    });
    const controller = new AbortController();
    const promise = withNetworkRetry(fn, {
      signal: controller.signal,
      attempts: 5,
      baseMs: 5_000,
    });
    // Wait for first attempt to land + start sleeping.
    await new Promise((r) => setImmediate(r));
    controller.abort(new DOMException('cancel', 'TimeoutError'));
    await expect(promise).rejects.toThrow(/cancel/);
    // Only the first attempt ran; the abort interrupted the backoff before
    // the retry even dispatched.
    expect(calls).toBe(1);
  });

  it('after a transient failure, an aborted signal short-circuits the loop', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      // Fire abort after the first failure has been thrown.
      if (calls === 1) {
        controller.abort(new DOMException('mid-loop abort', 'TimeoutError'));
      }
      throw new TypeError('fetch failed');
    });
    await expect(
      withNetworkRetry(fn, { signal: controller.signal, attempts: 5, baseMs: 0 }),
    ).rejects.toThrow(/mid-loop abort/);
    // Should NOT proceed to attempt 2 — abort wins over transient retry.
    expect(calls).toBe(1);
  });

  it('completes normally when signal is provided but never fires', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => 'ok');
    const result = await withNetworkRetry(fn, { signal: controller.signal });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('synthesises an AbortError when signal aborts without a reason', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'unused');
    // Without a reason, the controller's `abort()` sets `signal.reason` to a
    // synthesised DOMException(AbortError) per spec — verify that propagates.
    await expect(withNetworkRetry(fn, { signal: controller.signal })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
