# Design — the time bounds of an `ask_agentic` call

Status: implemented ([FOLLOW-UP-PRS.md T44](./FOLLOW-UP-PRS.md), closed 2026-11-17); the open questions are
[decisions](#decisions-on-the-open-questions). Three patches to these bounds inside PR #134 each moved a phase of the
call from one bound to none, and the PR went back to the bounds of 1.24.0. This note writes the bounds as one table and
one mechanism, so that a reviewer can check the code against the table. The sections "Before" and "The defects" describe
1.24.0 + T42, the code this design replaced.

## Notation

| | |
|---|---|
| `S` | `stallMs` (per call, else `GEMINI_CODE_CONTEXT_AGENTIC_STALL_MS`) |
| `T` | `iterationTimeoutMs` (per call, else `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS`) |
| `∞` | unbounded: no timer ends the phase |
| **Tt** / **Ts** | `errorCode: 'TIMEOUT'`, `timeoutKind: 'total'` / `'stall'`, `retryable: true` |
| **Rt** | the forced pass timed out: `errorCode: 'UNKNOWN'`, `subReason: 'AGENTIC_MAX_ITERATIONS'`, `rescueErrorCode: 'TIMEOUT'`, `retryable: false` (in the target also `timeoutPhase` / `timeoutSource`) |
| b0 / bk | the pass is booked 0, both reservations released / booked at what it billed ([§ Money](#money)) |
| ✓ | confirmed: a test of the repository, a scenario of the differential probe used on PR #134, or `[name]` — a one-off run of that probe's harness on `main` at `fbccfaf` (2026-11-17) with a 3–3.5 s watch timer |
| (r) | read from the code, not run |

## Before, measured from the code (1.24.0 + T42)

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

**Unbounded before: 19 of 40 cells** (15 of 36 without the setup row). Every ∞ after the TPM wait holds the pass's
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

**Unbounded before: 16 of 40 cells.** `ask` lifts `errorCode`, `retryable` and a `timeoutKind` of `total | stall`
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
same count as the previous total + stall. Per-phase deadlines would need a controller per phase, a merge of their reasons,
and a second place that knows the phase order — the second mechanism T44 forbids. The forced pass uses the same clock
(phase `finalization`) instead of its own controller. `ask` / `code` keep `createTimeoutController` unchanged.

### Data model

```ts
/** The phases of one pass, in order. The forced pass has `tpm-wait` and `finalization` only. */
type PassPhase = 'tpm-wait' | 'opening' | 'stream' | 'tools' | 'finalization';
/** The phases a default bounds: the TPM wait has none. */
type DefaultedPhase = Exclude<PassPhase, 'tpm-wait'>;
/** Where a bound the clock keeps comes from. */
type KnobSource = 'iterationTimeoutMs' | 'stallMs';
type ClockSource = KnobSource | 'default';
/** Where the timeout that ended a pass comes from: a bound of the clock, or a TimeoutError the clock did not raise. */
type BoundSource = ClockSource | 'external';
type TimeoutKind = 'total' | 'stall';                 // unchanged: no new value

interface AgenticKnobs { readonly iterationMs: number | null; readonly stallMs: number | null }  // what the clock reads
type KnobOrigin = 'call' | 'env';
interface ResolvedKnobs extends AgenticKnobs {       // resolved once per call (`run.ts`)
  readonly iterationFrom: KnobOrigin | null; readonly stallFrom: KnobOrigin | null;  // null when unset
}
/** The bound of a phase no knob bounds. One module (`agentic/phase-defaults.ts`), mocked by the tests. */
interface PhaseDefaults {
  readonly openingMs: number;      // 600_000, per request, its backoff included
  readonly streamGapMs: number;    // 600_000
  readonly toolsIdleMs: number;    // 120_000 without executor progress
  readonly finalizationMs: number; // 600_000, per request, its backoff included
  readonly toolSettleGraceMs: number; // 1_000
}
type PassTimeout =                 // what ended the pass; read from the clock, never parsed from a message
  | { readonly phase: PassPhase; readonly kind: TimeoutKind; readonly source: KnobSource; readonly limitMs: number }
  | { readonly phase: DefaultedPhase; readonly kind: TimeoutKind; readonly source: 'default'; readonly limitMs: number }
  | { readonly phase: PassPhase; readonly kind: TimeoutKind; readonly source: 'external'; readonly limitMs: null;
      readonly message: string };  // the error's own message: no bound of this call is named
interface PassClock {              // not a TimeoutController: it has no pauseStall, the stall is phase-scoped
  readonly signal: AbortSignal; readonly timeoutMs: number | null; readonly stallMs: number | null;
  readonly phase: PassPhase; readonly timedOut: ClockTimeout | null;  // the first two union members
  readonly settleGraceMs: number;  // `toolSettleGraceMs` of the clock's defaults: the tools phase reads it here
  enter(phase: PassPhase): void;   // clears the previous phase's timer, arms this phase's; no-op once fired or disposed
  recordChunk(): void;             // the first chunk enters `stream`; each re-arms the gap timer; no-op once stopped
  recordProgress(): void;          // in `tools` with its default armed: the silence starts again; else nothing
  dispose(): void;
}
interface ToolWatch {              // what an executor reports to and is stopped by (`workspace-tools.ts`)
  readonly signal?: AbortSignal; readonly onProgress?: () => void;
}                                  // `checkpoint(watch)`: throws the signal's reason once it fired, else reports progress
type IterationOutcome =            // what an iteration returns to the loop
  | { readonly kind: 'done'; readonly iteration: IterationResult }
  | { readonly kind: 'tools-timed-out'; readonly running: number };  // the warn line also names the calls never started
```

The rules, in order: **`T` is the pass's wall clock** — armed at creation, over every phase; **`S` bounds the gaps of
the stream only** — armed at the first chunk, re-armed per chunk, cleared at `enter('tools')`; **a phase's default
applies only when no knob bounds that phase** (`T` bounds every phase; `S` bounds stream gaps). The defaults:
`openingMs` / `streamGapMs` / `finalizationMs` = 600 000 ms, the longest `stallMs` the schema accepts
(`STALL_ABSOLUTE_MAX_MS`, `abort-timeout.ts:50`) — silence longer than any watchdog a caller may set is a hang; the
opening and the forced pass's bound are entered by each request and again when a retry is announced (`onRetry`, before
the backoff), so each request, its backoff included, gets the whole default: neither the backoff nor the request sent
after it runs under the default of the request that failed. `toolsIdleMs` = 120 000 ms **without executor progress** — a bound on silence like the others, not
on the batch's length: the executors bound what they return (200 KB per read, 100 grep matches, 200 entries, walk depth
20; `workspace-tools.ts`), not how long they run, and a healthy `grep` batch over a large workspace runs for minutes
([Q1](#decisions-on-the-open-questions)) while it passes a checkpoint at every directory and file. Under `T` there is
no tools timer: progress extends nothing, and the deadline stays a wall clock. The abort reason keeps the previous messages
("Timed out after N ms (total wall-clock)" / "(stall — no chunk received)") and adds `timeoutPhase` / `timeoutSource`
as properties, so `getTimeoutKind` and every reader of the message stay as they are.

### How each phase reads the clock

| Phase | Enter | Observed by |
|---|---|---|
| `tpm-wait` | clock creation, before `waitForTpm` (as before) | `abortableSleep(delay, signal)` |
| `opening` | by each request, inside the function `withNetworkRetry` calls, before `generateContentStream`, and by its `onRetry`, before the backoff | the SDK's `abortSignal`, `withNetworkRetry({ signal })` |
| `stream` | the first chunk (`recordChunk`) | the SDK's `abortSignal`, `collectStream` |
| `tools` | where the call is marked completed (`completeCall`), before `planDispatch` | `planDispatch` and the batch raced as one promise (`abortable`, `retry.ts:167`); workers check the signal before taking a call; the executors and `planDispatch` get a `ToolWatch` and pass `checkpoint(watch)` wherever they read the signal — the walk at every directory and before every entry, `list_directory` before each entry, `read_file` before and after its read (the read itself takes the signal), `grep` after each file's read, `planDispatch` after each path resolution — each checkpoint is progress (`recordProgress`); after the bound, the work still running gets `toolSettleGraceMs` (the shared `abortableSleep`, cleared when the work settles) |
| `finalization` | by each request of the forced pass, inside the function `withNetworkRetry` calls, and by its `onRetry`, before the backoff | the SDK's `abortSignal` |

### Target, direct `ask_agentic` call

Results: **Tt** / **Ts** now also carry `timeoutPhase` and `timeoutSource`; in `tools`, `retryable` follows
[§ Cancellation](#cancellation). Bold cells change.

| Phase | none | only `S` | only `T` | both |
|---|---|---|---|---|
| Setup | ∞ — kept, [Q5](#decisions-on-the-open-questions) | ∞ | ∞ | ∞ |
| TPM wait | the throttle's delay | the throttle's delay | `T` → Tt·tpm-wait | `T` → Tt·tpm-wait |
| Opening, first chunk | **600 s per request, its backoff included → Tt·opening·default** | **600 s per request, its backoff included → Tt·opening·default** | `T` → Tt·opening | `T` → Tt·opening |
| Gaps inside the stream | **600 s → Ts·stream·default** | `S` → Ts·stream | `T` → Tt·stream | first of `S`, `T` |
| Path resolution + tool batch (`tools`) | **120 s without executor progress → Tt·tools·default** | **120 s without executor progress → Tt·tools·default; a batch longer than `S` answers** | **`T` → Tt·tools, at `T`** | **`T` → Tt·tools, at `T`** |
| Synchronous steps | nothing to bound | same | same | same |
| Forced pass: TPM wait | the throttle's delay | the throttle's delay | `T` → Rt·tpm-wait | `T` → Rt·tpm-wait |
| Forced pass: the call | **600 s per request, its backoff included → Rt·finalization·default** | **600 s per request, its backoff included → Rt·finalization·default** | `T` → Rt·finalization | `T` → Rt·finalization |

### Target, `ask` fallback

The mapping: `ask` resolves its knobs once (per call, else `GEMINI_CODE_CONTEXT_ASK_*` — the values its own
controller holds) and forwards **`timeoutMs` → `iterationTimeoutMs`** (unchanged, [Q3](#decisions-on-the-open-questions))
and **`stallMs` → `stallMs`** (no longer a wall clock, no `min`). With only `stallMs` set a pass has no wall clock — a stream that keeps sending ends at the model's output cap, a tool batch that keeps reporting progress when its walk ends; a caller who wants a wall clock per iteration sets `iterationTimeoutMs` (`timeoutMs` on `ask`). It disposes its own controller before the hand-off
(`src/tools/ask-agentic-fallback.ts`), and the agentic call's timeout messages name `ask`'s knobs. Where `ask` has no
knob of a kind, the agentic env var of that kind (`GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS` /
`_STALL_MS`) applies — an operator who set it expects every agentic loop bounded — and the message names that
variable, never an `ask` variable that set nothing: the resolved knobs keep each one's origin (`ResolvedKnobs`), and
`messageKnobNames` words the hint from it. The table's columns are `ask`'s knobs with no agentic env var set.
The result reports `iterTimeoutMs`, `iterTimeoutSource: 'timeoutMs'` and `stallMs`; the values `'stallMs'` and
`'min(timeoutMs,stallMs)'` of `iterTimeoutSource` go (named in the CHANGELOG).

| Phase | none | only `S` | only `timeoutMs` | both |
|---|---|---|---|---|
| Setup | ∞ | ∞ | ∞ | ∞ |
| TPM wait | the throttle's delay | **the throttle's delay** | → Tt·tpm-wait | **`timeoutMs` → Tt** |
| Opening, first chunk | **600 s per request, its backoff included → Tt·opening·default** | **600 s per request, its backoff included → Tt·opening·default** (1.24.0: `S`) | → Tt·opening | **`timeoutMs` → Tt** |
| Gaps inside the stream | **600 s → Ts·default** | **`S` → Ts·stream; a healthy stream runs on** | → Tt·stream | **first of `S`, `timeoutMs`** |
| Path resolution + tool batch | **120 s without executor progress → Tt·tools·default** | **120 s without executor progress → Tt·tools·default; a batch longer than `S` answers** | **→ Tt·tools, at `timeoutMs`** | **→ Tt·tools, at `timeoutMs`** |
| Forced pass: TPM wait | the throttle's delay | **the throttle's delay** | → Rt·tpm-wait | **`timeoutMs` → Rt** |
| Forced pass: the call | **600 s per request, its backoff included → Rt** | **600 s per request, its backoff included → Rt** | → Rt | **`timeoutMs` → Rt** |

**Unbounded in the target: the setup row only** (4 cells in each table) — no reservation is held there yet, and its
bound needs a signal through `resolveModel`, which serves the three tools (Q5).

### What a caller sees

| Field | Values | New? |
|---|---|---|
| `timeoutKind` | `stall` — a stream gap only; `total` — every other bound | no new value: a caller that knows `total \| stall` reads every result; `stall` no longer fires for a tool batch |
| `timeoutPhase` | `tpm-wait`, `opening`, `stream`, `tools`; on the forced pass's `AGENTIC_MAX_ITERATIONS` with `rescueErrorCode: 'TIMEOUT'`: `tpm-wait`, `finalization` | new; `ask` lifts it |
| `timeoutSource` | `iterationTimeoutMs`, `stallMs`, `default`; `external` — a `TimeoutError` the clock did not raise (an SDK's own): no bound of this call fired, the limit is not reported and the message quotes the error's own | new; `ask` lifts it, and its hint names `timeoutMs` / `stallMs` |
| `toolCallsRunning` | the executors still running when the result was built | new, `tools` only, present when > 0 |
| the message's knob hint | one table keyed by (phase, source) and the knob names — `ask_agentic`'s or `ask`'s, an env var named only when it set the bound (`messageKnobNames`); the forced pass's message carries it too | replaces `results.ts:143-145` |

The forced pass keeps its result shape — `errorCode: 'UNKNOWN'`, `subReason: 'AGENTIC_MAX_ITERATIONS'`,
`rescueErrorCode: 'TIMEOUT'`, `retryable: false` — and adds `timeoutPhase` and `timeoutSource` read from its clock.

A call with no knob set now ends at a default (600 s of silence, 120 s of tools without progress) where it hung before;
the docs that say "default disabled" (`docs/configuration.md:41`, `:43`) change with it.

### Cancellation

| The bound fires in | The request | Queued tool calls | Running executors | `retryable` |
|---|---|---|---|---|
| `tpm-wait` | not sent | — | — | true |
| `opening`, `stream` | aborted through the SDK's `abortSignal` | — | — | true |
| `tools` | completed | never started: a worker checks the signal before it takes a call | get the watch: `readFile(path, { signal })`; every checkpoint (walks per directory and per entry, `read_file` around its read, `grep` per file) throws the signal's reason — a read the signal aborted is never reported as a missing or skipped file; a syscall in flight (`realpath`, `stat`, `readdir` take no signal) runs to its end, its result dropped | true when every started executor settled within `toolSettleGraceMs`; else false with `toolCallsRunning` |
| `finalization` | aborted | — | — | false (Rt, unchanged) |

A late executor's result or rejection is dropped and logged at debug level, never merged: `filesReadSet` and the
conversation change only on the `done` path. A synchronous step cannot be pre-empted by any timer in Node: a model's
regex with catastrophic backtracking blocks the event loop inside `regex.test` (`workspace-tools.ts:693`) — a limit of
every design here, named in [§ Not in scope](#not-in-scope).

## Money

The rule of [cost-model.md § What is booked when a call fails](./cost-model.md#what-is-booked-when-a-call-fails) holds
unchanged: the clock decides when a pass ends, `closePass` (`ledger.ts:131-142`) decides what it books, once. Each exit
of a loop pass calls it once: a completed pass in `runIteration`; a pass that threw in `attemptIteration`'s `catch`
(a timeout's result, or any other failure re-thrown); a tools timeout after that `try` — never inside it, where a throw
of `closePass` would reach the `catch` and close the pass a second time. The forced pass closes in its `finally`.

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
| `src/tools/agentic/run.ts` | `resolveAgenticKnobs` (once per call, each knob with its origin), `KnobNames`, `AGENTIC_KNOB_NAMES` and `messageKnobNames`; `coverMs` (the reservation's rate window) stays `T` |
| `src/tools/agentic/loop.ts`, `rescue.ts` | one clock per pass; both read what ended a pass through `passTimeoutOf(clock, err)` (`pass-clock.ts`); the forced pass reports it |
| `src/tools/agentic/iteration.ts` | `enter('tools')` once the call completed; `runToolsPhase` (path resolution and batch raced as one); the model and user turns appended only on the `done` path; `throwIfIterationAborted` gone |
| `src/tools/agentic/dispatch.ts`, `workspace-tools.ts` | `startToolBatch` (the watch to the workers, the running count); `ToolWatch` and `checkpoint` — the one place an executor reads the signal and reports progress; `find_files` and `grep` share one walk that passes it |
| `src/tools/agentic/results.ts` | `iterationTimedOut` and the forced pass's failure with the `PassTimeout`; the hint table keyed by source and, for a default, by phase; an `external` timeout's own wording |
| `src/tools/ask-agentic-fallback.ts` (new) | the fallback moved out of `ask.tool.ts`: the mapping, the hand-off, the lift of the new fields, `ask`'s knob names (`runAskAgentic(input, ctx, ASK_KNOB_NAMES)`) |
| docs | `configuration.md` (`:41`, `:43`, `:64-65`), `tools.md`, `cost-model.md` (the row above), CHANGELOG, T44 closed |

## Error policy

| Case | Result |
|---|---|
| any bound fires | `TIMEOUT` (loop) or `rescueErrorCode: 'TIMEOUT'` (forced pass) with `timeoutPhase`, `timeoutSource`, the limit in the message and the hint of the knob that raises it; loud |
| a `TimeoutError` the clock did not raise | the same results with `timeoutSource: 'external'`: no bound of this call is named, the error's own message is quoted — never a guess presented as a fact |
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
13. the fallback's hint names `timeoutMs` / `stallMs`, never `iterationTimeoutMs` (D8);
14. a batch of executors that keep reporting progress answers past the tools default; one that stops reporting ends at
    it;
15. on the fallback, an agentic env var that set a bound where `ask` set no knob of its kind is the variable the hint
    names (iteration and stall);
16. a request sent again after a network failure gets the whole opening default, a request of the forced pass the
    whole finalization default — its backoff included: a first attempt that fails just before its default does not end
    the pass in the backoff;
17. a `TimeoutError` the clock did not raise is `external`, directly and lifted by the fallback;
18. the forced pass ended by a bound carries `timeoutPhase` / `timeoutSource` and its hint (default and `T`);
19. a tools timeout whose `closePass` throws books the pass once;
20. the call whose path resolution is in flight is counted running, never also as not started.

Items 1, 2 and 8 run on the fallback through the real hand-off (`fallBackToAgentic` with `ask`'s controller), not
against a mocked `runAskAgentic`.

`ask-agentic.test.ts:2207` (F2) changes to end at the timer instead of after the slow executor.
`test/unit/agentic-tools-abort.test.ts`: each executor rejects with the signal's reason once it fired — the walks at
every directory and before every entry, `list_directory` between two entries, `read_file` and `grep` with a read in
flight that only the signal ends (never `NOT_FOUND`, never a result) — and reports progress at each checkpoint.
`test/unit/pass-clock.test.ts` (the clock, fake timers): at most two timers alive in any phase; the stall timer armed only between
chunks of `stream`; `enter` clears the previous phase's timer; a chunk in `tools` re-arms nothing; the reason carries
phase and source; `dispose` after a fire is idempotent (D10 closes by construction: the stall is phase-scoped);
`recordProgress` defers the tools default only — nothing in another phase, nothing under `T`, nothing after a fire or
`dispose`, one timer while it re-arms.

**The differential probe.** Byte-identical to `main`: every scenario that ends without a `TIMEOUT` — `organic*`,
`input-budget`, `no-progress*`, `files-cap`, every `rescue-*` but the three timeouts, `budget-reject-*`, `iter-429*`,
`iter-500`, `iter-error-nobudget`, `iter-nonerror`, `iter-*-throws`, `iter-malformed`, `iter-no-candidates`,
`iter-fc-noname`, the setup refusals, `concurrency-env`, `stall-reset-by-chunks`, `mid-stream-*`, `*-retry-then-ok`,
`last-iter-answer`. Changed by the added fields and the hint only (the forced pass keeps the rest of its result shape and
the abort's message): `rescue-timeout-wait`, `rescue-timeout-call`, `rescue-retry-timeout-in-backoff`. Changed by the
added fields only (`errorCode`, `timeoutKind`,
`retryable` and the booking identical): `iter-timeout-wait`, `iter-timeout-wait-2`, `iter-timeout-call`,
`iter-timeout-call-nobudget`, `iter-timeout-env`, `iter-retry-timeout-in-backoff`, `stall-fires`, `iter-timeout-tools`
(which also ends earlier — the probe's grep ignores the signal and settles inside the grace; the trace does not record
time); their messages also lose "; default disabled" (the hint table, D8). Added: the sixteen scenarios of the run on `main` above (`open-*`, `gap-*`, `batch-*`, `tpm-stall`, `rescue-*-hang`,
`retry-backoff-stall`), each with a watch timer, so that every ∞ cell of the tables above has a trace that changes.

## Performance budget

At most two timers per pass at any moment (before: two); per chunk one `clearTimeout` + `setTimeout`, as before; one
`enter` per phase and two more per network retry of a request (its announcement and the request); one abort listener per `tools` phase; per checkpoint
(each tool call taken, each directory and entry walked, each read, each path resolution) one boolean read and, in
`tools` with its default armed, one `performance.now()` written — never a timer: the tools timer is re-armed only when
it expires with progress since its arming, so at most once per `toolsIdleMs` (a re-arm per second would be cheap too;
this is cheaper). An 80 000-file walk passes about 160 000 checkpoints; 160 000 `performance.now()` calls took 6.24 ms
on the reviewer's 16-core machine (`node -e`, one run) — against the 32 s of I/O of ten such `grep` calls. No `AbortSignal.any`, no timer per chunk beyond the stall
timer that exists.

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
| Q1 | The defaults: 120 s for `tools`, 600 s for the opening, a stream gap and the forced pass | **revised**: the tools default is a bound on silence — 120 s without executor progress (`toolsIdleMs`), like the other defaults — not a wall clock. The fact named below happened: a reviewer measured `grep` through `startToolBatch` with the real executors on 80 000 files / 1.2 GB, warm cache, 16 cores — ×10 in parallel 32.0 s, ×20 64.9 s, ×40 133.2 s, no error — so a wall-clock default would end a healthy batch on a large workspace, the tool's own use case. The executors report progress at every checkpoint where they read the signal. 600 s stays for the opening and the forced pass — per request, its backoff included — and for a stream gap: the longest `stallMs` the schema accepts. Each is set only through the existing knobs: no new env var | for `tools`: a hang that keeps passing checkpoints (none known: each checkpoint is a finished syscall); for the 600 s defaults: a healthy first chunk later than 600 s — **not measured yet**: the first-chunk latency and the longest chunk gap at the highest thinking level on a large conversation |
| Q2 | With only `stallMs`, bound the opening by a value derived from `S` (1.24.0's fallback ended it at `S`) instead of 600 s? | no: `stallMs` bounds a stream's gaps only. A stall is a gap between chunks; the opening holds the prefill of a conversation that grows every iteration, and `ask` / `code` exempt it too (`docs/tools.md:50`) | measured first-chunk latency of agentic iterations far under common `S` values (p99 < 15 s at 500 K prompt tokens) |
| Q3 | The fallback's `timeoutMs`: keep it per iteration, or make it a deadline over the whole agentic call (its meaning in `ask`)? | kept per iteration — a public contract since 1.11.0 (`ask.tool.ts`'s `onWorkspaceTooLarge` description); a whole-call deadline is its own entry | the operator wants `ask`'s total semantics on the fallback now |
| Q4 | A `tools` timeout with an executor still running after the grace: `retryable: false`, or true with `toolCallsRunning`? | `retryable: false` with `toolCallsRunning`: a retry stacks file-system calls on the same thread pool | a measurement that executors always settle within the grace once they read the signal |
| Q5 | Bound the setup (workspace open, `resolveModel`)? | not bounded: no reservation is held there, and `resolveModel` takes no signal and serves the three tools; the docs say the setup has no bound (`docs/tools.md`) | a reported hang in model resolution |

D11 (the fallback read only per-call knobs and left `ask`'s timer counting) is fixed as the fallback table says. D12
(the model's regex in `grep` blocks the event loop) is not: [FOLLOW-UP-PRS.md T45](./FOLLOW-UP-PRS.md).
