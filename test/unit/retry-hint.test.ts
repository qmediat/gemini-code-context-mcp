/**
 * A Gemini 429's retry hint seeds the per-minute throttle through one function, `seedRetryHint`, once per error —
 * whichever catch of a call meets the error first, and `settleFailure` (`ask`, `code`) through the same rule.
 */

import { ApiError } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import type { ManifestDb } from '../../src/manifest/db.js';
import { CompletedRequests } from '../../src/tools/shared/continuation.js';
import { DispatchThrottle } from '../../src/tools/shared/dispatch-throttle.js';
import { settleFailure } from '../../src/tools/shared/settle-call.js';
import { type TpmThrottle, seedRetryHint } from '../../src/tools/shared/throttle.js';

const MODEL = 'gemini-3-pro-preview';

const quota429 = (): ApiError => new ApiError({ status: 429, message: 'quota "retryDelay": "7s"' });

function hintRecorder(): Pick<TpmThrottle, 'recordRetryHint'> & {
  recordRetryHint: ReturnType<typeof vi.fn>;
} {
  return { recordRetryHint: vi.fn() };
}

describe('seedRetryHint', () => {
  it('seeds the hint of a 429 once, however many times the same error is met', () => {
    const throttle = hintRecorder();
    const err = quota429();

    expect(seedRetryHint(throttle, MODEL, err)).toBe(7_000);
    expect(seedRetryHint(throttle, MODEL, err)).toBe(7_000);

    expect(throttle.recordRetryHint.mock.calls).toEqual([[MODEL, 7_000]]);
  });

  it('seeds the hint of each distinct 429', () => {
    const throttle = hintRecorder();

    seedRetryHint(throttle, MODEL, quota429());
    seedRetryHint(throttle, MODEL, quota429());

    expect(throttle.recordRetryHint).toHaveBeenCalledTimes(2);
  });

  it('seeds nothing for a 429 without a hint, nor for an error that only looks like a 429', () => {
    const throttle = hintRecorder();
    const lookalike = Object.assign(new Error('"retryDelay": "60s"'), { status: 429 });

    expect(seedRetryHint(throttle, MODEL, new ApiError({ status: 429, message: 'quota' }))).toBe(
      null,
    );
    expect(seedRetryHint(throttle, MODEL, lookalike)).toBe(null);
    expect(
      seedRetryHint(throttle, MODEL, new ApiError({ status: 500, message: '"retryDelay": "9s"' })),
    ).toBe(null);
    expect(throttle.recordRetryHint).not.toHaveBeenCalled();
  });
});

describe('settleFailure — the retry hint', () => {
  function settle(err: unknown, throttle: Pick<TpmThrottle, 'recordRetryHint'>): void {
    settleFailure({
      manifest: {} as ManifestDb,
      failed: {
        toolName: 'ask',
        reservationId: null,
        entry: null,
        completed: new CompletedRequests(),
        durationMs: 5,
      },
      err,
      model: MODEL,
      throttle,
      dispatch: new DispatchThrottle({
        throttle: {} as TpmThrottle,
        enabled: false,
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    });
  }

  it('seeds the hint of a 429 it settles', () => {
    const throttle = hintRecorder();

    settle(quota429(), throttle);

    expect(throttle.recordRetryHint.mock.calls).toEqual([[MODEL, 7_000]]);
  });

  it('does not seed again a 429 whose hint another catch already seeded', () => {
    const throttle = hintRecorder();
    const err = quota429();

    seedRetryHint(throttle, MODEL, err);
    settle(err, throttle);

    expect(throttle.recordRetryHint).toHaveBeenCalledTimes(1);
  });
});
