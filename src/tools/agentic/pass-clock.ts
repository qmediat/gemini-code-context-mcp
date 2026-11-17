/**
 * The one clock of an `ask_agentic` pass (a loop iteration or the forced-finalization pass): every phase of the pass
 * reads its bound from it (`docs/DESIGN-agentic-time-bounds.md`). `iterationTimeoutMs` is the pass's wall clock, armed
 * at creation over every phase; `stallMs` bounds the gaps of the stream only — armed at the first chunk, re-armed per
 * chunk, cleared when the pass leaves the stream; a phase's default (`phase-defaults.ts`) applies only where no knob
 * bounds that phase. At most two timers are alive at once: the pass deadline and the current phase's.
 */

import { type TimeoutKind, timeoutReason, unrefTimer } from '../shared/abort-timeout.js';
import { PHASE_DEFAULTS, type PhaseDefaults } from './phase-defaults.js';

/** The phases of one pass, in order. The forced pass has `tpm-wait` and `finalization` only. */
export type PassPhase = 'tpm-wait' | 'opening' | 'stream' | 'tools' | 'finalization';

/** Where the bound that fired comes from. */
export type BoundSource = 'iterationTimeoutMs' | 'stallMs' | 'default';

/** The call's two knobs, resolved once per call (per call, else the environment); `null` when unset. */
export interface AgenticKnobs {
  readonly iterationMs: number | null;
  readonly stallMs: number | null;
}

/** A bound one timer keeps. */
interface Bound {
  readonly kind: TimeoutKind;
  readonly source: BoundSource;
  readonly limitMs: number;
}

/** What fired: read from the clock, never parsed from a message. */
export interface PassTimeout {
  readonly phase: PassPhase;
  readonly kind: TimeoutKind;
  readonly source: BoundSource;
  /** The bound in ms; `null` only for a `TimeoutError` the clock did not raise, with no knob of its kind set. */
  readonly limitMs: number | null;
}

export interface PassClock {
  /** Fires when a bound of the pass fires; its reason is a `TimeoutError` carrying `timeoutPhase` / `timeoutSource`. */
  readonly signal: AbortSignal;
  /** The pass's wall clock (`iterationTimeoutMs`), `null` when unset. */
  readonly timeoutMs: number | null;
  /** The stream's gap watchdog (`stallMs`), `null` when unset. */
  readonly stallMs: number | null;
  readonly phase: PassPhase;
  /** The bound that fired, `null` while none has. */
  readonly timedOut: PassTimeout | null;
  /** Leave the current phase: its timer is cleared and the next phase's armed. */
  enter(phase: PassPhase): void;
  /** A chunk arrived: the first one moves `opening` to `stream`; each one re-arms the gap timer. */
  recordChunk(): void;
  /** Clear both timers. Idempotent; nothing is armed afterwards. */
  dispose(): void;
}

const total = (source: BoundSource, limitMs: number): Bound => ({ kind: 'total', source, limitMs });

/** The default of a phase no knob bounds; `null` while `iterationTimeoutMs` bounds the pass. */
const unlessDeadline =
  (defaultMs: (d: PhaseDefaults) => number) =>
  (knobs: AgenticKnobs, d: PhaseDefaults): Bound | null =>
    knobs.iterationMs === null ? total('default', defaultMs(d)) : null;

/** A stream gap: `stallMs`, else the default when no knob bounds the stream. */
function streamGapBound(knobs: AgenticKnobs, d: PhaseDefaults): Bound | null {
  if (knobs.stallMs !== null) return { kind: 'stall', source: 'stallMs', limitMs: knobs.stallMs };
  if (knobs.iterationMs !== null) return null;
  return { kind: 'stall', source: 'default', limitMs: d.streamGapMs };
}

/** The bound of each phase's own timer. The TPM wait has none: the throttle's delay is finite and known at its start. */
const PHASE_BOUND: Readonly<
  Record<PassPhase, (knobs: AgenticKnobs, d: PhaseDefaults) => Bound | null>
> = {
  'tpm-wait': () => null,
  opening: unlessDeadline((d) => d.openingMs),
  stream: streamGapBound,
  tools: unlessDeadline((d) => d.toolsMs),
  finalization: unlessDeadline((d) => d.finalizationMs),
};

/** One pass's clock: one `AbortController`, the pass deadline's timer and the current phase's. */
class Clock implements PassClock {
  readonly signal: AbortSignal;
  readonly timeoutMs: number | null;
  readonly stallMs: number | null;
  private readonly controller = new AbortController();
  private current: PassPhase = 'tpm-wait';
  private fired: PassTimeout | null = null;
  private disposed = false;
  private passTimer: NodeJS.Timeout | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly knobs: AgenticKnobs,
    private readonly defaults: PhaseDefaults,
  ) {
    this.signal = this.controller.signal;
    this.timeoutMs = knobs.iterationMs;
    this.stallMs = knobs.stallMs;
    if (knobs.iterationMs !== null) {
      const deadline = total('iterationTimeoutMs', knobs.iterationMs);
      this.passTimer = unrefTimer(deadline.limitMs, () => this.fire(deadline));
    }
  }

  get phase(): PassPhase {
    return this.current;
  }

  get timedOut(): PassTimeout | null {
    return this.fired;
  }

  enter(phase: PassPhase): void {
    this.current = phase;
    this.armPhase();
  }

  recordChunk(): void {
    if (this.current === 'opening') this.current = 'stream';
    if (this.current === 'stream') this.armPhase();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private armPhase(): void {
    this.clearPhaseTimer();
    if (this.disposed || this.signal.aborted) return;
    const bound = PHASE_BOUND[this.current](this.knobs, this.defaults);
    if (bound !== null) this.phaseTimer = unrefTimer(bound.limitMs, () => this.fire(bound));
  }

  private fire(bound: Bound): void {
    if (this.signal.aborted) return;
    const phase = this.current;
    this.fired = { ...bound, phase };
    this.clearTimers();
    const extra = { timeoutPhase: phase, timeoutSource: bound.source };
    this.controller.abort(timeoutReason(bound.limitMs, bound.kind, extra));
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer !== null) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  private clearTimers(): void {
    if (this.passTimer !== null) clearTimeout(this.passTimer);
    this.passTimer = null;
    this.clearPhaseTimer();
  }
}

/** A new pass's clock, in phase `tpm-wait`, the pass deadline armed when `iterationTimeoutMs` is set. */
export function createPassClock(
  knobs: AgenticKnobs,
  defaults: PhaseDefaults = PHASE_DEFAULTS,
): PassClock {
  return new Clock(knobs, defaults);
}
