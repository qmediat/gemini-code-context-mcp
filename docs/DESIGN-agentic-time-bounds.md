# Design — the time bounds of an `ask_agentic` call

Status: implemented ([FOLLOW-UP-PRS.md T44](./FOLLOW-UP-PRS.md), closed 2026-11-17); the open questions are
[decisions](#decisions-on-the-open-questions). Three patches to these bounds inside PR #134 each moved a phase of the
call from one bound to none, and the PR went back to the bounds of 1.24.0. This note writes the bounds as one table and
one mechanism, so that a reviewer can check the code against the table. The sections "Today" and "The defects" describe
1.24.0 + T42, the code this design replaced.

## Notation

| | |
|---|---|
| `S` | `stallMs` (per call, else `GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS`) |
| `T` | `iterationTimeoutMs` (per call, else `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS`) |
| `∞` | unbounded: no timer ends the phase |
| **Tt** / **Ts** | `errorCode: 'TIMEOUT'`, `timeoutKind: 'total'` / `'stall'`, `retryable: true` |
| **Rt** | the forced pass timed out: `errorCode: 'UNKNOWN'`, `subReason: 'AGENTIC_MAX_ITERATIONS'`, `rescueErrorCode: 'TIMEOUT'`, `retryable: false` |
| b0 / bk | the pass is booked 0, both reservations released / booked at what it billed ([§ Money](#money)) |
| ✓ | confirmed: a test of the repository, a scenario of the differential probe used on PR #134, or `[name]` — a one-off run of that probe's harness on `main` at `fbccfaf` (2026-11-17) with a 3–3.5 s watch timer |
| (r) | read from the code, not run |

## Today, measured from the code (`main`, 1.24.0 + T42)

One `TimeoutController` per pass (`src/tools/shared/abort-timeout.ts:145-264`), created before the TPM wait
(`src/tools/agentic/loop.ts:79-87`, `:231`), disposed when the pass ends (`loop.ts:181-183`). Its stall timer arms at the
first chunk (`abort-timeout.ts:180-199`) and is never paused in `ask_agentic` — `pauseStall` has one caller, the long
decode of `ask` / `code` (`src/tools/shared/context-decode.ts:161`). The forced pass builds its own controller without
a stall timer (`src/tools/agentic/rescue.ts:281-287`).

### Direct `ask_agentic` call

| Phase | Code | none | only `S` | only `T` | both |
|---|---|---|---|---|---|
| Setup: workspace open, model resolution | `ask-agentic.tool.ts:191-199` | ∞ (r) | ∞ (r) | ∞ (r) | ∞ (r) |
| TPM wait | `loop.ts:100-108`, `ledger.ts:91-104` | the throttle's delay ✓ `[tpm-stall]` | the throttle's delay — `S` not armed ✓ `[tpm-stall]` | `T` → Tt b0 ✓ `ask-agentic.test.ts:2156`, probe `iter-timeout-wait` | `T` → Tt b0 (r) |
| Opening, network retries (3 attempts, 1 s + 3 s backoff) | `iteration.ts:121-138`, `retry.ts:108-149` | ∞ ✓ `[open-none]` | ∞ ✓ `[open-stall]` | `T` → Tt b0 ✓ `[open-total]`, probe `iter-retry-timeout-in-backoff` | `T` → Tt b0 ✓ probe `iter-timeout-call-nobudget` |
| Wait for the first chunk | `stream-collector.ts:187`, `abort-timeout.ts:195-199` | ∞ (r) | ∞ (r) | `T` → Tt b0 (r) | `T` → Tt b0 (r) |
| Gaps inside the stream | `stream-collector.ts:187-210` | ∞ ✓ `[gap-none]` | `S` → Ts b0 ✓ `[gap-stall]`, `agentic-tool-batch.test.ts:169` | `T` → Tt b0 ✓ `[gap-total]` | first of `S`, `T` ✓ `ask-agentic.test.ts:2343`, `:2402` |
| Path resolution (`planDispatch`; awaits `resolveInsideWorkspace` at the `maxFilesRead` cap) | `iteration.ts:189-240`, `:341` | ∞ (r) | ∞ — `S` fires, nobody reads it (r) | ∞ — `T` fires, nobody reads it (r) | ∞ (r) |
| Tool batch | `iteration.ts:342-348`, `dispatch.ts:190-210` | ∞ ✓ `[batch-none-hang]` | slower than `S`: **false stall** Ts bk, at the batch's end ✓ `[batch-stall-slow]`, `agentic-tool-batch.test.ts:143`; hung: ∞ ✓ `[batch-stall-hang]` | slower than `T`: Tt bk **at the batch's end** ✓ `[batch-total-slow]`, `ask-agentic.test.ts:2207`; hung: ∞ ✓ `[batch-total-hang]` | slower: the first fired, at the batch's end (r); hung: ∞ ✓ `[batch-both-hang]` |
| Synchronous steps: reading the response, between iterations, settling | `iteration.ts:329-337`, `loop.ts:240-249`, `ledger.ts:131-179` | no `await`: nothing to bound (r) | same | same | same |
| Forced pass: TPM wait | `rescue.ts:253-263` | the throttle's delay (r) | the throttle's delay (r) | `T` → Rt b0 (r) | `T` → Rt b0 ✓ probe `rescue-timeout-wait` |
| Forced pass: the unary call, retries included | `rescue.ts:144-172`, `:266` | ∞ ✓ `[rescue-none-hang]` | ∞ — no stall on this pass ✓ `[rescue-stall-hang]` | `T` → Rt b0 ✓ probe `rescue-timeout-call`, `ask-agentic.test.ts:1470` | `T` → Rt b0 (r) |

**Unbounded today: 19 of 40 cells** (15 of 36 without the setup row). Every ∞ after the TPM wait holds the pass's
daily-budget and TPM reservations in flight: the runs above show `finalizeBudget` and `cancelBudget` uncalled at the
watch timer. The throttle's delay is finite and known when the wait starts (`throttle.ts:273-345`); it grows with
concurrent waiters.

### `ask` → `ask_agentic` fallback

`ask` maps its knobs once (`ask.tool.ts:627-663`): `iterationTimeoutMs = timeoutMs | stallMs | min(timeoutMs,
stallMs)`; the agentic `stallMs` is never set (the agentic env vars still apply, `loop.ts:79-87`). Only the per-call
values are read — `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS` / `_STALL_MS` are not (r). `ask`'s own controller
(`ask.tool.ts:388-393`) keeps counting through the fallback, its signal passed to nothing, disposed only when `ask`
returns (`:1160-1161`) (r). The mapping of `timeoutMs` is ✓ `preflight-guard.test.ts:292`; the lift of `errorCode` /
`retryable` ✓ `:386`; the cells are the direct ones under that mapping (r).

| Phase | none | only `S` | only `timeoutMs` | both |
|---|---|---|---|---|
| Setup (after `ask`'s own phases) | ∞ | ∞ | ∞ | ∞ |
| TPM wait | the throttle's delay | `S` → Tt b0 | `timeoutMs` → Tt b0 | min → Tt b0 |
| Opening, retries | ∞ | `S` → Tt b0 | → Tt b0 | min → Tt b0 |
| Wait for the first chunk | ∞ | `S` → Tt b0 | → Tt b0 | min → Tt b0 |
| Gaps inside the stream | ∞ | **a healthy stream longer than `S` → Tt b0** (a false total) | → Tt b0 | min → Tt b0 |
| Path resolution | ∞ | ∞ | ∞ | ∞ |
| Tool batch | ∞ | slower than `S`: Tt bk at its end (a false total); hung: ∞ | slower: Tt bk at its end; hung: ∞ | as only `S` with min |
| Synchronous steps | nothing to bound | same | same | same |
| Forced pass: TPM wait | the throttle's delay | `S` → Rt b0 | → Rt b0 | min → Rt b0 |
| Forced pass: the call | ∞ | `S` → Rt b0 | → Rt b0 | min → Rt b0 |

**Unbounded today: 16 of 40 cells.** `ask` lifts `errorCode`, `retryable` and a `timeoutKind` of `total | stall`
(`ask.tool.ts:729-738`); the message it passes on names `iterationTimeoutMs` (`results.ts:143-145`), a knob `ask` does
not take; `iterTimeoutSource` says which knob was mapped (`ask.tool.ts:715-720`).

## The defects

| # | Defect | Cells | Findings it answers |
|---|---|---|---|
| D1 | The stall timer stays armed after the stream ended: a tool batch longer than `S` ends the call as a false `stall`, booked (`iteration.ts:139-143`; no `pauseStall` in the loop) | direct, tool batch, `S` / both | PR #134 first reading X2; T44 Why (1) |
| D2 | `T` does not end a tool batch: the abort is read only after `dispatchToolCallsParallel` returned (`iteration.ts:250-256`, `:348`); a slow batch ends late, a hung one never | tool batch, `T` / both | T44 Why (2) |
| D3 | `planDispatch` awaits path resolution with no signal read (`iteration.ts:198`, `:341`) | path resolution, every column | last reading X2 |
| D4 | The executors take no signal (`dispatch.ts:82-86`); the workers start every queued call whatever the clock says (`dispatch.ts:198-205`); the `TIMEOUT` is `retryable: true` regardless (`results.ts:157`) | tool batch | last reading X3 |
| D5 | The fallback turns `stallMs` into a per-iteration wall clock (`ask.tool.ts:627-663`): a healthy stream or a tool batch longer than `S` ends the call as `total` | fallback, `S` / both | r1 codex R1; T44 Why (1) |
| D6 | With only `S` (direct), the opening, the first chunk, the batch and the forced pass have no bound; any fix must not lose the bound 1.24.0's fallback gives the opening | direct `S` column; fallback `S` column must stay bounded | r1 ds4pro R1, qwen d2; last reading X1 |
| D7 | The forced pass has no stall timer and no bound without `T` (`rescue.ts:281-287`) | forced pass, none / `S` | last reading X1 |
| D8 | The fallback's result names `iterationTimeoutMs` (`results.ts:145`) and `ask`'s docs name `total \| stall` only (`docs/configuration.md:65`); a new kind would be dropped by the lift (`ask.tool.ts:735-738`) | every fallback `TIMEOUT` | last reading X5 |
| D9 | No check that the fallback lifts every kind and field (`preflight-guard.test.ts:386` checks `errorCode` / `retryable`); timing tests assert elapsed time against the bound | — | last reading X6 |
| D10 | A comment that says a later stream re-arms the watchdog: true for the long decode (`abort-timeout.ts:86-91`), false for `ask_agentic`, whose controller is new per pass (`loop.ts:231`) | — | r1 qwen d3 |
| D11 | The fallback reads per-call `timeoutMs` / `stallMs` only, never `ask`'s env vars, and leaves `ask`'s controller counting unobserved (`ask.tool.ts:388`, `:627-636`, `:1161`) | fallback columns | found reading for this note |

## The target: one clock per pass, with named phases

### Decision

One `PassClock` per pass — the iteration's `TimeoutController` extended with a phase — rather than a `Deadline`
object per phase combined with `AbortSignal.any`. One clock keeps one `AbortController`, one abort reason that says
which phase and which bound fired, and at most two live timers (the pass deadline and the current phase's timer), the
same count as today's total + stall. Per-phase deadlines would need a controller per phase, a merge of their reasons,
and a second place that knows the phase order — the second mechanism T44 forbids. The forced pass uses the same clock
(phase `finalization`) instead of its own controller. `ask` / `code` keep `createTimeoutController` unchanged.

### Data model

```ts
/** The phases of one pass, in order. The forced pass has `tpm-wait` and `finalization` only. */
type PassPhase = 'tpm-wait' | 'opening' | 'stream' | 'tools' | 'finalization';
/** Where the bound that fired comes from. */
type BoundSource = 'iterationTimeoutMs' | 'stallMs' | 'default';
type TimeoutKind = 'total' | 'stall';                 // unchanged: no new value

interface AgenticKnobs { readonly iterationMs: number | null; readonly stallMs: number | null }  // resolved once per call
/** The bound of a phase no knob bounds. One module (`agentic/phase-defaults.ts`), mocked by the tests. */
interface PhaseDefaults {
  readonly openingMs: number;      // 600_000
  readonly streamGapMs: number;    // 600_000
  readonly toolsMs: number;        // 120_000
  readonly finalizationMs: number; // 600_000
  readonly toolSettleGraceMs: number; // 1_000
}
interface PassTimeout {            // what fired; read from the clock, never parsed from a message
  readonly phase: PassPhase; readonly kind: TimeoutKind; readonly source: BoundSource;
  readonly limitMs: number | null; // null only for a TimeoutError the clock did not raise, with no knob of its kind
}
interface PassClock {              // not a TimeoutController: it has no pauseStall, the stall is phase-scoped
  readonly signal: AbortSignal; readonly timeoutMs: number | null; readonly stallMs: number | null;
  readonly phase: PassPhase; readonly timedOut: PassTimeout | null;
  enter(phase: PassPhase): void;   // clears the previous phase's timer, arms this phase's
  recordChunk(): void;             // the first chunk enters `stream`; each chunk re-arms the gap timer
  dispose(): void;
}
type IterationOutcome =            // what an iteration returns to the loop
  | { readonly kind: 'done'; readonly iteration: IterationResult }
  | { readonly kind: 'tools-timed-out'; readonly running: number; readonly neverStarted: number };
```

The rules, in order: **`T` is the pass's wall clock** — armed at creation, over every phase; **`S` bounds the gaps of
the stream only** — armed at the first chunk, re-armed per chunk, cleared at `enter('tools')`; **a phase's default
applies only when no knob bounds that phase** (`T` bounds every phase; `S` bounds stream gaps). The defaults:
`openingMs` / `streamGapMs` / `finalizationMs` = 600 000 ms, the longest `stallMs` the schema accepts
(`STALL_ABSOLUTE_MAX_MS`, `abort-timeout.ts:50`) — silence longer than any watchdog a caller may set is a hang;
`toolsMs` = 120 000 ms — the executors bound what they return (200 KB per read, 100 grep matches, 200 entries, walk
depth 20; `workspace-tools.ts:80-109`), not how long they run, and a healthy batch of at most 10 parallel calls
(`dispatch.ts:34`) over a local file system ends in seconds. The abort reason keeps today's messages ("Timed out after
N ms (total wall-clock)" / "(stall — no chunk received)") and adds `timeoutPhase` / `timeoutSource` as properties, so
`getTimeoutKind` and every reader of the message stay as they are.

### How each phase reads the clock

| Phase | Enter | Observed by |
|---|---|---|
| `tpm-wait` | clock creation, before `waitForTpm` (as today) | `abortableSleep(delay, signal)` |
| `opening` | before `generateContentStream` | the SDK's `abortSignal`, `withNetworkRetry({ signal })` |
| `stream` | the first chunk (`recordChunk`) | the SDK's `abortSignal`, `collectStream` |
| `tools` | where the call is marked completed (`completeCall`), before `planDispatch` | `planDispatch` and the batch raced as one promise (`abortable`, `retry.ts:167`); workers check the signal before taking a call; executors get the signal; after the bound, the work still running gets `toolSettleGraceMs` (the shared `abortableSleep`, cleared when the work settles) |
| `finalization` | before the forced pass's unary call | the SDK's `abortSignal` |

### Target, direct `ask_agentic` call

Results: **Tt** / **Ts** now also carry `timeoutPhase` and `timeoutSource`; in `tools`, `retryable` follows
[§ Cancellation](#cancellation). Bold cells change.

| Phase | none | only `S` | only `T` | both |
|---|---|---|---|---|
| Setup | ∞ — kept, [Q5](#decisions-on-the-open-questions) | ∞ | ∞ | ∞ |
| TPM wait | the throttle's delay | the throttle's delay | `T` → Tt·tpm-wait | `T` → Tt·tpm-wait |
| Opening, first chunk | **600 s → Tt·opening·default** | **600 s → Tt·opening·default** | `T` → Tt·opening | `T` → Tt·opening |
| Gaps inside the stream | **600 s → Ts·stream·default** | `S` → Ts·stream | `T` → Tt·stream | first of `S`, `T` |
| Path resolution + tool batch (`tools`) | **120 s → Tt·tools·default** | **120 s → Tt·tools·default; a batch longer than `S` answers** | **`T` → Tt·tools, at `T`** | **`T` → Tt·tools, at `T`** |
| Synchronous steps | nothing to bound | same | same | same |
| Forced pass: TPM wait | the throttle's delay | the throttle's delay | `T` → Rt | `T` → Rt |
| Forced pass: the call | **600 s → Rt** | **600 s → Rt** | `T` → Rt | `T` → Rt |

### Target, `ask` fallback

The mapping: `ask` resolves its knobs once (per call, else `GEMINI_CODE_CONTEXT_ASK_*` — the values its own
controller holds) and forwards **`timeoutMs` → `iterationTimeoutMs`** (unchanged, [Q3](#decisions-on-the-open-questions))
and **`stallMs` → `stallMs`** (no longer a wall clock, no `min`). It disposes its own controller before the hand-off
(`src/tools/ask-agentic-fallback.ts`), and the agentic call's timeout messages name `ask`'s knobs.
The result reports `iterTimeoutMs`, `iterTimeoutSource: 'timeoutMs'` and `stallMs`; the values `'stallMs'` and
`'min(timeoutMs,stallMs)'` of `iterTimeoutSource` go (named in the CHANGELOG).

| Phase | none | only `S` | only `timeoutMs` | both |
|---|---|---|---|---|
| Setup | ∞ | ∞ | ∞ | ∞ |
| TPM wait | the throttle's delay | **the throttle's delay** | → Tt·tpm-wait | **`timeoutMs` → Tt** |
| Opening, first chunk | **600 s → Tt·opening·default** | **600 s → Tt·opening·default** (1.24.0: `S`) | → Tt·opening | **`timeoutMs` → Tt** |
| Gaps inside the stream | **600 s → Ts·default** | **`S` → Ts·stream; a healthy stream runs on** | → Tt·stream | **first of `S`, `timeoutMs`** |
| Path resolution + tool batch | **120 s → Tt·tools·default** | **120 s → Tt·tools·default; a batch longer than `S` answers** | **→ Tt·tools, at `timeoutMs`** | **→ Tt·tools, at `timeoutMs`** |
| Forced pass: TPM wait | the throttle's delay | **the throttle's delay** | → Rt | **`timeoutMs` → Rt** |
| Forced pass: the call | **600 s → Rt** | **600 s → Rt** | → Rt | **`timeoutMs` → Rt** |

**Unbounded in the target: the setup row only** (4 cells in each table) — no reservation is held there yet, and its
bound needs a signal through `resolveModel`, which serves the three tools (Q5).

### What a caller sees

| Field | Values | New? |
|---|---|---|
| `timeoutKind` | `stall` — a stream gap only; `total` — every other bound | no new value: a caller that knows `total \| stall` reads every result; `stall` no longer fires for a tool batch |
| `timeoutPhase` | `tpm-wait`, `opening`, `stream`, `tools` | new; `ask` lifts it |
| `timeoutSource` | `iterationTimeoutMs`, `stallMs`, `default` | new; `ask` lifts it, and its hint names `timeoutMs` / `stallMs` |
| `toolCallsRunning` | the executors still running when the result was built | new, `tools` only, present when > 0 |
| the message's knob hint | one table keyed by (phase, source) and the caller's knob names — `ask_agentic`'s or `ask`'s | replaces `results.ts:143-145` |

A call with no knob set now ends at a default (600 s of silence, 120 s of tools) where it hung before; the docs that
say "default disabled" (`docs/configuration.md:41`, `:43`) change with it.

### Cancellation

| The bound fires in | The request | Queued tool calls | Running executors | `retryable` |
|---|---|---|---|---|
| `tpm-wait` | not sent | — | — | true |
| `opening`, `stream` | aborted through the SDK's `abortSignal` | — | — | true |
| `tools` | completed | never started: a worker checks the signal before it takes a call | get the signal: `readFile(path, { signal })`; walks (`find_files`, `grep`, `list_directory`) check it per directory and per file; a syscall in flight (`realpath`, `stat`, `readdir` take no signal) runs to its end, its result dropped | true when every started executor settled within `toolSettleGraceMs`; else false with `toolCallsRunning` |
| `finalization` | aborted | — | — | false (Rt, unchanged) |

A late executor's result or rejection is dropped and logged at debug level, never merged: `filesReadSet` and the
conversation change only on the `done` path. A synchronous step cannot be pre-empted by any timer in Node: a model's
regex with catastrophic backtracking blocks the event loop inside `regex.test` (`workspace-tools.ts:693`) — a limit of
every design here, named in [§ Not in scope](#not-in-scope).

## Money

The rule of [cost-model.md § What is booked when a call fails](./cost-model.md#what-is-booked-when-a-call-fails) holds
unchanged: the clock decides when a pass ends, `closePass` (`ledger.ts:131-142`) decides what it books, once.

| The bound fires in | The pass's call | Booked | `apiCalls` |
|---|---|---|---|
| setup | none | nothing was reserved | 0 |
| `tpm-wait` | not sent | both reservations released | not counted (`results.ts:156`) |
| `opening`, `stream` | not completed | both released (whether Google bills it: T43) | counted |
| `tools` | completed (`iteration.ts:330`) | at what it billed, when the bound fires — not when the executors end | counted |
| forced pass, TPM wait / the call | not sent / not completed | released | not counted / counted |

The executors hold no reservation, so a `tools` timeout that returns while one still runs leaks nothing. The cost-model
table's row "Stream completed, then the iteration timed out in its tool batch … the call ends when the batch has
returned" changes to "… the call ends at the bound".

## Module map

| File | Change |
|---|---|
| `src/tools/shared/abort-timeout.ts` | `resolveStallTimeoutMs` beside `resolveTotalTimeoutMs`, `timeoutReason` (the abort reason, its message and extra properties) and `unrefTimer`, shared by `createTimeoutController` (behaviour unchanged, split into small units) and the clock; `STALL_ABSOLUTE_MAX_MS` exported |
| `src/tools/agentic/pass-clock.ts` (new) | `PassPhase`, `BoundSource`, `AgenticKnobs`, `PassTimeout`, `PassClock`, `createPassClock(knobs, defaults)`, the phase-bound dispatch table. In `agentic/`, not in `shared/`: it reads `phase-defaults.ts`, and the shared module stays `ask` / `code`'s |
| `src/tools/agentic/phase-defaults.ts` (new) | `PhaseDefaults` and its values, each with its reason |
| `src/tools/agentic/run.ts` | `resolveAgenticKnobs` (once per call), `KnobNames` and `AGENTIC_KNOB_NAMES`; `coverMs` (the reservation's rate window) stays `T` |
| `src/tools/agentic/loop.ts`, `rescue.ts` | one clock per pass; `iterationFailure` reads `clock.timedOut` |
| `src/tools/agentic/iteration.ts` | `enter('tools')` once the call completed; `runToolsPhase` (path resolution and batch raced as one); the model and user turns appended only on the `done` path; `throwIfIterationAborted` gone |
| `src/tools/agentic/dispatch.ts`, `workspace-tools.ts` | `startToolBatch` (the signal to the workers, the running count); the signal to the executors — `find_files` and `grep` share one walk that reads it |
| `src/tools/agentic/results.ts` | `iterationTimedOut` with the `PassTimeout`; the hint table keyed by source and, for a default, by phase |
| `src/tools/ask-agentic-fallback.ts` (new) | the fallback moved out of `ask.tool.ts`: the mapping, the hand-off, the lift of the new fields, `ask`'s knob names (`runAskAgentic(input, ctx, ASK_KNOB_NAMES)`) |
| docs | `configuration.md` (`:41`, `:43`, `:64-65`), `tools.md`, `cost-model.md` (the row above), CHANGELOG, T44 closed |

## Error policy

| Case | Result |
|---|---|
| any bound fires | `TIMEOUT` (loop) or `rescueErrorCode: 'TIMEOUT'` (forced pass) with `timeoutPhase`, `timeoutSource`, the limit; loud |
| executors still running after the grace | `retryable: false`, `toolCallsRunning: n`, one warn line naming the count |
| a late executor result or rejection | dropped, debug line, counted in that warn line; never an unhandled rejection |
| an abort that is not a timeout | unchanged (`ask-agentic.test.ts:2139`) |

## Test plan

No test waits on a default bound: the tests mock `agentic/phase-defaults.ts` with bounds of tens of milliseconds, a
hang is a promise that never settles, and assertions name the phase, the source, the booking and the order of events,
never an elapsed time against a bound (a runner two to three times slower changes nothing). A test of a knob's bound
(`stallMs`, `iterationTimeoutMs`) keeps the knob's 1 s minimum, so it is red on `main` too; a slow executor there is
a sleep longer than the knob. Each test is red on `main` where its cell changes.

`test/unit/agentic-time-bounds.test.ts` (call level: 1, 3–10, 13 for the agentic side) and
`test/unit/preflight-guard.test.ts` (`ask`'s side of the fallback: 2, 11, 12, 13, and the hand-off's order):

1. a batch longer than `stallMs` answers — direct and fallback (D1, D5; inverts `agentic-tool-batch.test.ts:143`);
2. the fallback with only `stallMs` lets a stream run longer than `stallMs` (D5);
3. a batch that never returns ends at `iterationTimeoutMs`, phase `tools`, the pass booked once with its fields (D2);
4. a batch that never returns ends at the default tools bound with only `stallMs`, and with no knob (D2, D6);
5. a path resolution that hangs at the `maxFilesRead` cap ends at the tools bound, the pass closed once (D3);
6. no queued tool call starts after the bound fired (concurrency 1, three calls, the first released after the bound) (D4);
7. a `tools` timeout is `retryable: true` when the executors honour the signal, false with `toolCallsRunning` when one
   ignores it (D4);
8. a request that never opens ends at the default opening bound with only `stallMs` — direct and fallback (D6);
9. a stream silent with no knob ends as a `stall` at the default gap bound, booked 0;
10. the forced pass ends at the default finalization bound with only `stallMs` (D7);
11. the fallback forwards `ask`'s resolved knobs — per call and env — and reports `iterTimeoutMs`, `iterTimeoutSource`,
    `stallMs` (D11);
12. the fallback lifts `timeoutKind`, `timeoutPhase`, `timeoutSource` for every phase, one case per phase (D8, D9);
13. the fallback's hint names `timeoutMs` / `stallMs`, never `iterationTimeoutMs` (D8).

`ask-agentic.test.ts:2207` (F2) changes to end at the timer instead of after the slow executor.
`test/unit/pass-clock.test.ts` (the clock, fake timers): at most two timers alive in any phase; the stall timer armed only between
chunks of `stream`; `enter` clears the previous phase's timer; the reason carries phase and source; `dispose` after a
fire is idempotent (D10 closes by construction: the stall is phase-scoped).

**The differential probe.** Byte-identical to `main`: every scenario that ends without a `TIMEOUT` — `organic*`,
`input-budget`, `no-progress*`, `files-cap`, every `rescue-*` but the three timeouts, `budget-reject-*`, `iter-429*`,
`iter-500`, `iter-error-nobudget`, `iter-nonerror`, `iter-*-throws`, `iter-malformed`, `iter-no-candidates`,
`iter-fc-noname`, the setup refusals, `concurrency-env`, `stall-reset-by-chunks`, `mid-stream-*`, `*-retry-then-ok`,
`last-iter-answer` — and `rescue-timeout-wait`, `rescue-timeout-call`, `rescue-retry-timeout-in-backoff` (the forced pass
keeps its result shape and the abort's message). Changed by the added fields only (`errorCode`, `timeoutKind`,
`retryable` and the booking identical): `iter-timeout-wait`, `iter-timeout-wait-2`, `iter-timeout-call`,
`iter-timeout-call-nobudget`, `iter-timeout-env`, `iter-retry-timeout-in-backoff`, `stall-fires`, `iter-timeout-tools`
(which also ends earlier — the probe's grep ignores the signal and settles inside the grace; the trace does not record
time); their messages also lose "; default disabled" (the hint table, D8). Added: the sixteen scenarios of the run on `main` above (`open-*`, `gap-*`, `batch-*`, `tpm-stall`, `rescue-*-hang`,
`retry-backoff-stall`), each with a watch timer, so that every ∞ cell of today has a trace that changes.

## Performance budget

At most two timers per pass at any moment (today: two); per chunk one `clearTimeout` + `setTimeout`, as today; at most
five `enter` calls per pass; one abort listener per `tools` phase; one boolean read per tool call taken and per directory
or file walked. No `AbortSignal.any`, no timer per chunk beyond the stall timer that exists.

## Not in scope

- `ask` / `code` outside the fallback: `createTimeoutController` and the long decode's `pauseStall` keep their bounds.
- T43 — whether Google bills a request aborted after its stream opened.
- The setup phase's bound (Q5) and a whole-call bound for `ask_agentic` (Q3).
- Streaming the forced pass so that a stall timer can watch it.
- A time bound on the model's regex in `grep` (synchronous: no timer fires while it runs) and `grep`'s walk going on
  past its match cap: [FOLLOW-UP-PRS.md T45](./FOLLOW-UP-PRS.md) (D12).

## Decisions on the open questions

Each recommendation was accepted (2026-11-17); the fact that would flip it stays beside it.

| # | Question | Decision and reason | The fact that would flip it |
|---|---|---|---|
| Q1 | The defaults: 120 s for `tools`, 600 s for the opening, a stream gap and the forced pass | taken (`phase-defaults.ts`): 600 s is the longest `stallMs` the schema accepts — silence longer than any watchdog a caller may set is a hang; a healthy batch of at most ten parallel calls over a local file system ends in seconds. Each is set only through the existing knobs: no new env var | a measured `grep` / `find_files` batch over a large workspace — the tool's own use case — above 60 s, or a healthy first chunk later than 600 s |
| Q2 | With only `stallMs`, bound the opening by a value derived from `S` (1.24.0's fallback ended it at `S`) instead of 600 s? | no: `stallMs` bounds a stream's gaps only. A stall is a gap between chunks; the opening holds the prefill of a conversation that grows every iteration, and `ask` / `code` exempt it too (`docs/tools.md:50`) | measured first-chunk latency of agentic iterations far under common `S` values (p99 < 15 s at 500 K prompt tokens) |
| Q3 | The fallback's `timeoutMs`: keep it per iteration, or make it a deadline over the whole agentic call (its meaning in `ask`)? | kept per iteration — a public contract since 1.11.0 (`ask.tool.ts`'s `onWorkspaceTooLarge` description); a whole-call deadline is its own entry | the operator wants `ask`'s total semantics on the fallback now |
| Q4 | A `tools` timeout with an executor still running after the grace: `retryable: false`, or true with `toolCallsRunning`? | `retryable: false` with `toolCallsRunning`: a retry stacks file-system calls on the same thread pool | a measurement that executors always settle within the grace once they read the signal |
| Q5 | Bound the setup (workspace open, `resolveModel`)? | not bounded: no reservation is held there, and `resolveModel` takes no signal and serves the three tools; the docs say the setup has no bound (`docs/tools.md`) | a reported hang in model resolution |

D11 (the fallback read only per-call knobs and left `ask`'s timer counting) is fixed as the fallback table says. D12
(the model's regex in `grep` blocks the event loop) is not: [FOLLOW-UP-PRS.md T45](./FOLLOW-UP-PRS.md).
