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
  /** Path resolution and the tool batch of one iteration. */
  readonly toolsMs: number;
  /** The forced-finalization pass's call. */
  readonly finalizationMs: number;
  /** How long, after the tools bound fired, the executors still running are given to settle. */
  readonly toolSettleGraceMs: number;
}

/**
 * Silence longer than the longest stall watchdog a caller may set (`stallMs` ≤ 600 000 ms) is a hang, not a slow
 * model: a request's opening, a stream gap and the forced pass end there. The executors bound what they return (200 KB
 * per read, 100 grep matches, 200 entries, a walk depth of 20), not how long they run, and a healthy batch of at most
 * ten parallel calls over a local file system ends in seconds: 120 000 ms ends a batch that hangs. An executor that
 * reads the abort signal settles in well under the 1 000 ms grace.
 */
export const PHASE_DEFAULTS: PhaseDefaults = Object.freeze({
  openingMs: STALL_ABSOLUTE_MAX_MS,
  streamGapMs: STALL_ABSOLUTE_MAX_MS,
  toolsMs: 120_000,
  finalizationMs: STALL_ABSOLUTE_MAX_MS,
  toolSettleGraceMs: 1_000,
});
