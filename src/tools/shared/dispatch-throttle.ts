/**
 * The per-minute input throttle of one `ask` / `code` call (`GEMINI_CODE_CONTEXT_TPM_THROTTLE_LIMIT`).
 *
 * Each request of the call's decode holds its own reservation, made just before the request is sent and settled
 * when it ends at the input it reported — so every request of a long decode, each of which sends the prompt again
 * plus everything decoded before it, is counted in the window of the minute it was sent in. At most one reservation
 * is held at a time; the call's failure path drops it.
 */

import { abortableSleep } from '../../gemini/retry.js';
import type { TpmThrottle } from './throttle.js';

export interface DispatchThrottleOptions {
  readonly throttle: TpmThrottle;
  /** `false` when the throttle is off (a limit of 0 or less): nothing is reserved. */
  readonly enabled: boolean;
  /** The call's abort signal: a wait for the window ends with it (`timeoutMs`). */
  readonly signal: AbortSignal;
  /** Says a wait for the window on the call's progress channel. */
  readonly emit: (message: string) => void;
}

/** No reservation held. */
const NONE = -1;

export class DispatchThrottle {
  private releaseId = NONE;
  private heldTokens = 0;

  constructor(private readonly opts: DispatchThrottleOptions) {}

  /**
   * Reserve the input of the next request of `model`, waiting out the window when it is full. A reservation still
   * held (a request that was never sent) is dropped first.
   */
  async reserve(model: string, inputTokens: number): Promise<void> {
    if (!this.opts.enabled) return;
    this.cancel();
    const reservation = this.opts.throttle.reserve(model, inputTokens);
    this.releaseId = reservation.releaseId;
    this.heldTokens = inputTokens;
    if (reservation.delayMs <= 0) return;
    this.opts.emit(`throttle: waiting ${Math.ceil(reservation.delayMs / 1000)}s for TPM window…`);
    await abortableSleep(reservation.delayMs, this.opts.signal);
  }

  /**
   * The request ended: its reservation settles at the input it reported (cached and uncached alike count against
   * the per-minute quota), or at the reserved estimate when it reported none.
   */
  settle(promptTokens: number | undefined): void {
    if (this.releaseId === NONE) return;
    this.opts.throttle.release(this.releaseId, promptTokens ?? this.heldTokens);
    this.releaseId = NONE;
  }

  /** The call failed: the reservation it holds is dropped. */
  cancel(): void {
    if (this.releaseId === NONE) return;
    this.opts.throttle.cancel(this.releaseId);
    this.releaseId = NONE;
  }
}
