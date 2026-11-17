/**
 * The one clock of an `ask_agentic` pass (a loop iteration or the forced-finalization pass): every phase of the pass
 * reads its bound from it (`docs/DESIGN-agentic-time-bounds.md`). `iterationTimeoutMs` is the pass's wall clock, armed
 * at creation over every phase; `stallMs` bounds the gaps of the stream only — armed at the first chunk, re-armed per
 * chunk, cleared when the pass leaves the stream; a phase's default (`phase-defaults.ts`) applies only where no knob
 * bounds that phase — the tools phase's is a bound on silence, which executor progress (`recordProgress`) defers. At
 * most two timers are alive at once: the pass deadline and the current phase's.
 */

import {
  type TimeoutKind,
  getTimeoutKind,
  timeoutReason,
  unrefTimer,
} from '../shared/abort-timeout.js';
import { PHASE_DEFAULTS, type PhaseDefaults } from './phase-defaults.js';

/** The phases of one pass, in order. The forced pass has `tpm-wait` and `finalization` only. */
export type PassPhase = 'tpm-wait' | 'opening' | 'stream' | 'tools' | 'finalization';

/** The phases a default bounds: every phase but the TPM wait, whose throttle delay is finite and known at its start. */
export type DefaultedPhase = Exclude<PassPhase, 'tpm-wait'>;

/** The knobs of a call that the clock keeps as bounds. */
export type KnobSource = 'iterationTimeoutMs' | 'stallMs';

/** Where a bound the clock keeps comes from. */
export type ClockSource = KnobSource | 'default';

/** Where the timeout that ended a pass comes from: a bound of the clock, or `external` — a `TimeoutError` the clock did
 * not raise (an SDK's own), which no bound of this call set. */
export type BoundSource = ClockSource | 'external';

/** The call's two knobs, resolved once per call (per call, else the environment); `null` when unset. */
export interface AgenticKnobs {
  readonly iterationMs: number | null;
  readonly stallMs: number | null;
}

/** A bound one timer keeps; an `idle` bound counts silence: executor progress defers it. */
interface BoundShape {
  readonly kind: TimeoutKind;
  readonly limitMs: number;
  readonly idle: boolean;
}

/** A knob's bound: it fires in whichever phase the pass is in. */
interface KnobBound extends BoundShape {
  readonly source: KnobSource;
}

/** A phase's default: armed for that phase and cleared when the pass leaves it, so it fires in that phase. */
interface DefaultBound extends BoundShape {
  readonly source: 'default';
  readonly phase: DefaultedPhase;
}

type Bound = KnobBound | DefaultBound;

/** A knob of the call fired, in the phase the pass was in: read from the clock, never parsed from a message. */
export interface KnobTimeout {
  readonly phase: PassPhase;
  readonly kind: TimeoutKind;
  readonly source: KnobSource;
  readonly limitMs: number;
}

/** A phase's default fired: never in the TPM wait, which has none. */
export interface DefaultTimeout {
  readonly phase: DefaultedPhase;
  readonly kind: TimeoutKind;
  readonly source: 'default';
  readonly limitMs: number;
}

/** A bound of the clock fired. */
export type ClockTimeout = KnobTimeout | DefaultTimeout;

/** A `TimeoutError` the clock did not raise ended the pass: no bound of this call fired; `message` is the error's own. */
export interface ExternalTimeout {
  readonly phase: PassPhase;
  readonly kind: TimeoutKind;
  readonly source: 'external';
  readonly limitMs: null;
  readonly message: string;
}

/** What ended a pass on a timeout. */
export type PassTimeout = ClockTimeout | ExternalTimeout;

export interface PassClock {
  /** Fires when a bound of the pass fires; its reason is a `TimeoutError` carrying `timeoutPhase` / `timeoutSource`. */
  readonly signal: AbortSignal;
  /** The pass's wall clock (`iterationTimeoutMs`), `null` when unset. */
  readonly timeoutMs: number | null;
  /** The stream's gap watchdog (`stallMs`), `null` when unset. */
  readonly stallMs: number | null;
  readonly phase: PassPhase;
  /** The bound that fired, `null` while none has. */
  readonly timedOut: ClockTimeout | null;
  /** How long, after the tools phase's bound fired, the executors still running are given to settle. */
  readonly settleGraceMs: number;
  /** Leave the current phase: its timer is cleared and the next phase's armed. Entering the phase the pass is in arms
   * its default afresh. A no-op after a fire and after `dispose`: the clock's phase is then the one it stopped in. */
  enter(phase: PassPhase): void;
  /** A chunk arrived: the first one moves `opening` to `stream`; each one re-arms the gap timer. A no-op after a fire
   * and after `dispose`. */
  recordChunk(): void;
  /** An executor made progress: in phase `tools` the silence its default counts starts again; a no-op in every other
   * phase, under `iterationTimeoutMs` (no phase timer: the deadline stays a wall clock), after a fire and after
   * `dispose`. A tick writes one timestamp; the timer is re-armed only when it expires. */
  recordProgress(): void;
  /** Clear both timers. Idempotent; nothing is armed afterwards. */
  dispose(): void;
}

/** The default of a phase no knob bounds; `null` while `iterationTimeoutMs` bounds the pass. */
const unlessDeadline =
  (phase: DefaultedPhase, defaultMs: (d: PhaseDefaults) => number, idle = false) =>
  (knobs: AgenticKnobs, d: PhaseDefaults): Bound | null =>
    knobs.iterationMs === null
      ? { kind: 'total', source: 'default', phase, limitMs: defaultMs(d), idle }
      : null;

/** A stream gap: `stallMs`, else the default when no knob bounds the stream. Each chunk re-arms it (`recordChunk`). */
function streamGapBound(knobs: AgenticKnobs, d: PhaseDefaults): Bound | null {
  if (knobs.stallMs !== null) {
    return { kind: 'stall', source: 'stallMs', limitMs: knobs.stallMs, idle: false };
  }
  if (knobs.iterationMs !== null) return null;
  return { kind: 'stall', source: 'default', phase: 'stream', limitMs: d.streamGapMs, idle: false };
}

/** The bound of each phase's own timer. The TPM wait has none: the throttle's delay is finite and known at its start. */
const PHASE_BOUND: Readonly<
  Record<PassPhase, (knobs: AgenticKnobs, d: PhaseDefaults) => Bound | null>
> = {
  'tpm-wait': () => null,
  opening: unlessDeadline('opening', (d) => d.openingMs),
  stream: streamGapBound,
  tools: unlessDeadline('tools', (d) => d.toolsIdleMs, true),
  finalization: unlessDeadline('finalization', (d) => d.finalizationMs),
};

/** What a fired bound reports: a default the phase it was armed for, a knob the phase the pass is in. */
function timeoutOf(bound: Bound, current: PassPhase): ClockTimeout {
  const { kind, limitMs } = bound;
  if (bound.source === 'default') return { phase: bound.phase, kind, source: 'default', limitMs };
  return { phase: current, kind, source: bound.source, limitMs };
}

/** One pass's clock: one `AbortController`, the pass deadline's timer and the current phase's. */
class Clock implements PassClock {
  readonly signal: AbortSignal;
  readonly timeoutMs: number | null;
  readonly stallMs: number | null;
  private readonly controller = new AbortController();
  private current: PassPhase = 'tpm-wait';
  private fired: ClockTimeout | null = null;
  /** When the current phase's silence started: its timer's arming, or the last executor progress since. */
  private quietSince = 0;
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
      const deadline: KnobBound = {
        kind: 'total',
        source: 'iterationTimeoutMs',
        limitMs: knobs.iterationMs,
        idle: false,
      };
      this.passTimer = unrefTimer(deadline.limitMs, () => this.fire(deadline));
    }
  }

  get phase(): PassPhase {
    return this.current;
  }

  get timedOut(): ClockTimeout | null {
    return this.fired;
  }

  get settleGraceMs(): number {
    return this.defaults.toolSettleGraceMs;
  }

  enter(phase: PassPhase): void {
    if (this.stopped()) return;
    this.current = phase;
    this.armPhase();
  }

  recordChunk(): void {
    if (this.stopped()) return;
    if (this.current === 'opening') this.current = 'stream';
    if (this.current === 'stream') this.armPhase();
  }

  recordProgress(): void {
    if (this.current === 'tools' && this.phaseTimer !== null) this.quietSince = performance.now();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  /** A fired or disposed clock arms nothing and its phase stays where it stopped. */
  private stopped(): boolean {
    return this.disposed || this.signal.aborted;
  }

  private armPhase(): void {
    this.clearPhaseTimer();
    const bound = PHASE_BOUND[this.current](this.knobs, this.defaults);
    if (bound === null) return;
    this.quietSince = performance.now();
    this.phaseTimer = unrefTimer(bound.limitMs, () => this.phaseExpired(bound));
  }

  /** The phase's timer ran out: an idle bound with progress since its arming waits out the rest of its silence. */
  private phaseExpired(bound: Bound): void {
    const quietMs = performance.now() - this.quietSince;
    if (bound.idle && quietMs < bound.limitMs) {
      this.phaseTimer = unrefTimer(bound.limitMs - quietMs, () => this.phaseExpired(bound));
      return;
    }
    this.fire(bound);
  }

  private fire(bound: Bound): void {
    if (this.signal.aborted) return;
    const fired = timeoutOf(bound, this.current);
    this.fired = fired;
    this.clearTimers();
    const extra = { timeoutPhase: fired.phase, timeoutSource: fired.source };
    this.controller.abort(timeoutReason(fired.limitMs, fired.kind, extra));
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

/**
 * What ended a pass that failed on a timeout: the bound the clock fired, else an `external` timeout — the error's own
 * kind and message, in the phase the pass was in, no bound of this call named.
 */
export function passTimeoutOf(clock: PassClock, err: unknown): PassTimeout {
  if (clock.timedOut !== null) return clock.timedOut;
  return {
    phase: clock.phase,
    kind: getTimeoutKind(err) ?? 'total',
    source: 'external',
    limitMs: null,
    message: err instanceof Error ? err.message : String(err),
  };
}
