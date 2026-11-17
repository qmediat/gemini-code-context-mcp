/**
 * The clock of an `ask_agentic` pass (`src/tools/agentic/pass-clock.ts`): `iterationTimeoutMs` over every phase,
 * `stallMs` between the chunks of a stream only, a phase's default only where no knob bounds it, at most two timers,
 * and an abort reason that says which phase and which bound fired. Fake timers: nothing here waits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgenticKnobs,
  type PassClock,
  type PassPhase,
  createPassClock,
} from '../../src/tools/agentic/pass-clock.js';
import type { PhaseDefaults } from '../../src/tools/agentic/phase-defaults.js';
import { getTimeoutKind } from '../../src/tools/shared/abort-timeout.js';

const DEFAULTS: PhaseDefaults = {
  openingMs: 1_000,
  streamGapMs: 2_000,
  toolsIdleMs: 3_000,
  finalizationMs: 4_000,
  toolSettleGraceMs: 10,
};
const NO_KNOB: AgenticKnobs = { iterationMs: null, stallMs: null };
/** The tools phase ended at its default. */
const TOOLS_AT_DEFAULT = { phase: 'tools', kind: 'total', source: 'default', limitMs: 3_000 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** The live timers after each step of a pass: creation, then each phase entered (`stream` by its first chunk). */
function timersThrough(clock: PassClock, phases: readonly PassPhase[]): number[] {
  const counts = [vi.getTimerCount()];
  for (const phase of phases) {
    if (phase === 'stream') clock.recordChunk();
    else clock.enter(phase);
    counts.push(vi.getTimerCount());
  }
  return counts;
}

const LOOP_PASS: readonly PassPhase[] = ['opening', 'stream', 'tools'];

describe('pass clock — timers', () => {
  it('keeps the pass deadline and the stall timer only, two at most, when both knobs are set', () => {
    const clock = createPassClock({ iterationMs: 10_000, stallMs: 500 }, DEFAULTS);

    expect(timersThrough(clock, LOOP_PASS)).toEqual([1, 1, 2, 1]);
  });

  it('arms a default for each phase only while no knob bounds it', () => {
    const clock = createPassClock(NO_KNOB, DEFAULTS);

    expect(timersThrough(clock, LOOP_PASS)).toEqual([0, 1, 1, 1]);
  });

  it('arms no default under iterationTimeoutMs: the deadline bounds every phase', () => {
    const clock = createPassClock({ iterationMs: 10_000, stallMs: null }, DEFAULTS);

    expect(timersThrough(clock, [...LOOP_PASS, 'finalization'])).toEqual([1, 1, 1, 1, 1]);
  });

  it('clears both timers on dispose, and arms nothing afterwards', () => {
    const clock = createPassClock({ iterationMs: 10_000, stallMs: 500 }, DEFAULTS);
    clock.enter('opening');
    clock.recordChunk();
    const unbounded = createPassClock(NO_KNOB, DEFAULTS);
    unbounded.enter('opening');

    clock.dispose();
    unbounded.dispose();
    unbounded.enter('tools');
    clock.dispose();
    clock.enter('tools');
    clock.recordChunk();

    expect(vi.getTimerCount()).toBe(0);
    expect(clock.signal.aborted).toBe(false);
  });
});

describe('pass clock — what fires', () => {
  it('arms the stall watchdog at the first chunk only: the opening is bounded by its default, not by stallMs', () => {
    const clock = createPassClock({ iterationMs: null, stallMs: 100 }, DEFAULTS);
    clock.enter('opening');
    vi.advanceTimersByTime(900);
    expect(clock.signal.aborted).toBe(false);

    clock.recordChunk();
    vi.advanceTimersByTime(99);
    clock.recordChunk();
    vi.advanceTimersByTime(99);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(clock.timedOut).toEqual({
      phase: 'stream',
      kind: 'stall',
      source: 'stallMs',
      limitMs: 100,
    });
  });

  it('ends the opening at its default with only stallMs set', () => {
    const clock = createPassClock({ iterationMs: null, stallMs: 100 }, DEFAULTS);
    clock.enter('opening');
    vi.advanceTimersByTime(1_000);

    expect(clock.timedOut).toEqual({
      phase: 'opening',
      kind: 'total',
      source: 'default',
      limitMs: 1_000,
    });
  });

  it('clears the stall watchdog when the pass leaves the stream: the tools phase has its own bound', () => {
    const clock = createPassClock({ iterationMs: null, stallMs: 100 }, DEFAULTS);
    clock.enter('opening');
    clock.recordChunk();
    clock.enter('tools');
    vi.advanceTimersByTime(2_999);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(clock.timedOut).toEqual(TOOLS_AT_DEFAULT);
  });

  it('a chunk in the tools phase re-arms nothing: the tools bound counts from the phase entry', () => {
    const clock = createPassClock({ iterationMs: null, stallMs: 100 }, DEFAULTS);
    clock.enter('tools');
    vi.advanceTimersByTime(2_000);
    clock.recordChunk();
    vi.advanceTimersByTime(1_000);

    expect(clock.phase).toBe('tools');
    expect(clock.timedOut).toEqual(TOOLS_AT_DEFAULT);
  });

  it('reports a silent stream with no knob as a stall at the gap default', () => {
    const clock = createPassClock(NO_KNOB, DEFAULTS);
    clock.enter('opening');
    clock.recordChunk();
    vi.advanceTimersByTime(2_000);

    expect(clock.timedOut).toEqual({
      phase: 'stream',
      kind: 'stall',
      source: 'default',
      limitMs: 2_000,
    });
  });

  it('reports the phase the pass was in when iterationTimeoutMs fired, and the forced pass at its default', () => {
    const loop = createPassClock({ iterationMs: 500, stallMs: null }, DEFAULTS);
    vi.advanceTimersByTime(500);
    const forced = createPassClock(NO_KNOB, DEFAULTS);
    forced.enter('finalization');
    vi.advanceTimersByTime(4_000);

    expect(loop.timedOut).toEqual({
      phase: 'tpm-wait',
      kind: 'total',
      source: 'iterationTimeoutMs',
      limitMs: 500,
    });
    expect(forced.timedOut).toEqual({
      phase: 'finalization',
      kind: 'total',
      source: 'default',
      limitMs: 4_000,
    });
  });

  it('aborts with a TimeoutError that carries the kind, the phase and the source', () => {
    const clock = createPassClock({ iterationMs: null, stallMs: 100 }, DEFAULTS);
    clock.enter('opening');
    clock.recordChunk();
    vi.advanceTimersByTime(100);

    const reason = clock.signal.reason as DOMException & Record<string, unknown>;
    expect(reason.name).toBe('TimeoutError');
    expect(reason.message).toBe('Timed out after 100 ms (stall — no chunk received)');
    expect(reason).toMatchObject({
      timeoutKind: 'stall',
      timeoutPhase: 'stream',
      timeoutSource: 'stallMs',
    });
    expect(getTimeoutKind(reason)).toBe('stall');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fires once: the first bound wins, and a fired clock arms nothing more', () => {
    const clock = createPassClock({ iterationMs: 150, stallMs: 100 }, DEFAULTS);
    clock.enter('opening');
    vi.advanceTimersByTime(150);
    clock.recordChunk();
    expect(vi.getTimerCount()).toBe(0);
    clock.enter('tools');
    vi.advanceTimersByTime(10_000);
    clock.dispose();

    expect(clock.timedOut).toEqual({
      phase: 'opening',
      kind: 'total',
      source: 'iterationTimeoutMs',
      limitMs: 150,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('moves no phase after a fire or after dispose: it stays the one the clock stopped in', () => {
    const fired = createPassClock(NO_KNOB, DEFAULTS);
    fired.enter('opening');
    vi.advanceTimersByTime(1_000);
    fired.recordChunk();
    fired.enter('tools');
    const disposed = createPassClock(NO_KNOB, DEFAULTS);
    disposed.enter('opening');
    disposed.dispose();
    disposed.recordChunk();
    disposed.enter('finalization');

    expect(fired.phase).toBe('opening');
    expect(disposed.phase).toBe('opening');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives the settle grace of its defaults', () => {
    expect(createPassClock(NO_KNOB, DEFAULTS).settleGraceMs).toBe(10);
  });
});

describe('pass clock — executor progress', () => {
  it('defers the tools bound: it fires after its silence, counted from the last progress', () => {
    const clock = createPassClock(NO_KNOB, DEFAULTS);
    clock.enter('tools');
    vi.advanceTimersByTime(2_000);
    clock.recordProgress();
    vi.advanceTimersByTime(2_999);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(clock.timedOut).toEqual(TOOLS_AT_DEFAULT);
  });

  it('keeps a progressing tools phase alive past its bound, with one timer', () => {
    const clock = createPassClock(NO_KNOB, DEFAULTS);
    clock.enter('tools');
    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(1_000);
      clock.recordProgress();
    }

    expect(clock.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('extends nothing in any other phase', () => {
    const opening = createPassClock(NO_KNOB, DEFAULTS);
    opening.enter('opening');
    vi.advanceTimersByTime(900);
    opening.recordProgress();
    vi.advanceTimersByTime(100);
    const finalization = createPassClock(NO_KNOB, DEFAULTS);
    finalization.enter('finalization');
    vi.advanceTimersByTime(3_900);
    finalization.recordProgress();
    vi.advanceTimersByTime(100);

    expect(opening.timedOut).toMatchObject({ phase: 'opening', limitMs: 1_000 });
    expect(finalization.timedOut).toMatchObject({ phase: 'finalization', limitMs: 4_000 });
  });

  it('extends nothing under iterationTimeoutMs: the deadline stays a wall clock, the only timer', () => {
    const clock = createPassClock({ iterationMs: 2_000, stallMs: null }, DEFAULTS);
    clock.enter('tools');
    vi.advanceTimersByTime(1_500);
    clock.recordProgress();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);

    expect(clock.timedOut).toMatchObject({ phase: 'tools', source: 'iterationTimeoutMs' });
  });

  it('keeps one timer in the tools phase while progress re-arms its bound, a stall knob set', () => {
    const clock = createPassClock({ iterationMs: null, stallMs: 100 }, DEFAULTS);
    clock.enter('opening');
    clock.recordChunk();
    clock.enter('tools');
    const counts: number[] = [];
    for (let tick = 0; tick < 5; tick += 1) {
      vi.advanceTimersByTime(2_500);
      clock.recordProgress();
      counts.push(vi.getTimerCount());
    }

    expect(counts).toEqual([1, 1, 1, 1, 1]);
    expect(clock.signal.aborted).toBe(false);
  });

  it('does nothing after a fire or after dispose', () => {
    const fired = createPassClock(NO_KNOB, DEFAULTS);
    fired.enter('tools');
    vi.advanceTimersByTime(3_000);
    fired.recordProgress();
    const disposed = createPassClock(NO_KNOB, DEFAULTS);
    disposed.enter('tools');
    disposed.dispose();
    disposed.recordProgress();
    vi.advanceTimersByTime(10_000);

    expect(fired.timedOut).toMatchObject({ phase: 'tools', limitMs: 3_000 });
    expect(disposed.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
