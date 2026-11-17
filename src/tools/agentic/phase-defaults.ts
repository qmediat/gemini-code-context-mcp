/**
 * The bound of each phase of an `ask_agentic` pass that no knob bounds (`docs/DESIGN-agentic-time-bounds.md`):
 * `iterationTimeoutMs` bounds every phase of a pass, `stallMs` the gaps of a stream, and a default applies only where
 * neither does. The tests replace this module with bounds of milliseconds.
 */

import { STALL_ABSOLUTE_MAX_MS } from '../shared/abort-timeout.js';

export interface PhaseDefaults {
  /** A request's opening, until its first chunk. */
  readonly openingMs: number;
  /** A gap between two chunks of a stream (reported as a `stall`). */
  readonly streamGapMs: number;
  /** The silence of an iteration's tools phase (path resolution and the tool batch): how long it may go without
   * executor progress (`PassClock.recordProgress`). */
  readonly toolsIdleMs: number;
  /** The forced-finalization pass's call. */
  readonly finalizationMs: number;
  /** How long, after the tools bound fired, the executors still running are given to settle. */
  readonly toolSettleGraceMs: number;
}

/**
 * Silence longer than the longest stall watchdog a caller may set (`stallMs` ≤ 600 000 ms) is a hang, not a slow
 * model: each request's opening, a stream gap and each request of the forced pass end there. The tools phase is bounded
 * by silence too, never by its length: the executors bound what they return (200 KB per read, 100 grep matches, 200
 * entries, a walk depth of 20), not how long they run, and a healthy batch of `grep` calls over a large workspace runs
 * for minutes (ten in parallel over 80 000 files: 32 s; forty: 133 s) while it reports progress at every directory and
 * file — 120 000 ms without any ends a batch that hangs. An executor that reads the abort signal settles in well under
 * the 1 000 ms grace.
 */
export const PHASE_DEFAULTS: PhaseDefaults = Object.freeze({
  openingMs: STALL_ABSOLUTE_MAX_MS,
  streamGapMs: STALL_ABSOLUTE_MAX_MS,
  toolsIdleMs: 120_000,
  finalizationMs: STALL_ABSOLUTE_MAX_MS,
  toolSettleGraceMs: 1_000,
});
