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
