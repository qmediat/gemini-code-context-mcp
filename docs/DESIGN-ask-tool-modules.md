# Design — the split of `src/tools/ask.tool.ts` into modules

Status: proposed ([FOLLOW-UP-PRS.md T47](./FOLLOW-UP-PRS.md)). No behaviour change: every result, message, field, key
order, ledger and throttle call stays as it is on `main`; a differential probe proves it ([§ Proof plan](#proof-plan)).
The sections "Today" describe `main` at `074212c`; line numbers are of that tree.

`src/tools/ask.tool.ts` is 1,012 lines; one function, `executeAskBody`, runs from line 359 to the end. It holds every
structure violation the file has in `eslint-suppressions.json` (ESLint run with an empty suppressions file:
`executeAskBody` 654 lines, complexity 47, nesting 4 at `:582` and `:596`) and 213 lines in a repeat
(`jscpd-baseline.json`), all of them shared with `src/tools/code.tool.ts` (871 lines), whose `executeCodeBody` (`:307`,
565 lines, complexity 64, nesting 4 at `:714` and `:715`) holds every violation of that file and its 171 lines in a
repeat. The same job was done for `ask_agentic` in T39: the tool file is the entry, its steps are modules under
`src/tools/agentic/`.

## Notation

| | |
|---|---|
| **F** | the failure path: the outer `catch` (`ask.tool.ts:964-1007`, `code.tool.ts:826-866`) |
| booked | the daily-budget reservation finalised at what the completed requests billed, or — without a daily cap — a usage row inserted (`recordBilledCall`, `src/tools/shared/call-ledger.ts:158`); a failed write is logged, never thrown |
| released | the reservation cancelled whole (`releaseReservation`, `call-ledger.ts:208`); a no-op when none is held |
| F's rule | booked at the completed requests when a decode started and at least one request completed, else released (`settleFailedCall`, `call-ledger.ts:190`) — the rule of `docs/cost-model.md`, "What is booked when a call fails" |
| (r) | read from the code, not run |

## Today: `ask` (`executeAskBody`)

The call's state is held in locals; those that cross a step boundary are named (→ written, ← read).

| # | Step | Lines | State | Awaits | Exits and what the result carries | Ledger | TPM |
|---|---|---|---|---|---|---|---|
| 0 | Entry | 235-240 | → `started`, `workspaceRoot`, `model` (the alias as asked) | — | — | — | — |
| 1 | Call machinery | 366-396 | → `reservationId = null`, `resolvedModelKey = null`, `completed`, `tracking`, `serviceTier = undefined`, `reportedTier()` (a closure over `serviceTier`), `emitter`, `timeoutController` (timers armed before any await), `abortSignal`, `dispatch` | — | — | — | — |
| 2 | Workspace guard | 404-411 | ← `workspaceRoot` | — | **X1** `:408` `ask: <message>`, no fields; another error → F | — | — |
| 3 | Model and tier | 413-437 | → `resolved`, `resolvedModelKey` (`:422`), `serviceTier` | `resolveModel` (no signal) | **X2** `:431` `SERVICE_TIER_UNSUPPORTED` `{errorCode, retryable: false, serviceTier: 'flex', resolvedModel}`; a throw of `resolveModel` → F with no model (no retry hint seeded) | — | — |
| 4 | Attachments | 439-451 | ← `resolved`, `serviceTier`, `abortSignal`; → `attachments`, `attachmentTokens` | `inspectAttachments`, `readAttachments` (signal), `countAttachmentTokens` (signal) | **X3** `:449` `ATTACHMENTS_UNSUPPORTED` / `ATTACHMENT_INVALID` / `ATTACHMENT_TOKENS_UNCOUNTED` `{errorCode, retryable, serviceTier, resolvedModel}`; an abort → F (`attachments.ts:311` rethrows the signal's reason) | — | — |
| 5 | Scan | 453-466 | ← `manifest.getFiles`; → `scan` | `scanWorkspace` (no signal) | a throw → F | — | — |
| 6 | Output cap, budget refusal | 468-504 | → `outputCap`, `usingThinkingLevel` | — | **X4** `:504` `ask: thinkingBudget (…) …`, no fields | — | — |
| 7 | Input estimate, inline size | 506-520 | ← `scan`, `attachments`; → `workspaceBytes`, `estimatedInputTokens` | — | **X5** `:520` `REQUEST_TOO_LARGE` `{errorCode, retryable: false, serviceTier, attachments, attachmentTokens}` (only with attachments) | — | — |
| 8 | Preflight and workspace guard | 522-636 | ← `scan`, `outputCap`, `attachmentTokens`, `abortSignal`; → `preflight`, `contextWindow` | `countForPreflight` (signal; only when the model advertises an input limit), `fallBackToAgentic` | **X6** `:586` `WORKSPACE_TOO_LARGE` (fallback asked, attachments given) `{errorCode, retryable: false, serviceTier, attachments, attachmentTokens}`; **X7** `:597` the fallback's wrapped result (`ask-agentic-fallback.ts:102-140`); **X8** `:613` `WORKSPACE_TOO_LARGE` `{errorCode, serviceTier, attachments?, retryable: false, estimatedInputTokens, tokenCountMethod, rawTokenCount, tokenCountCacheHit, contextWindowTokens, thresholdTokens, guardRatio, resolvedModel, filesIndexed}`; no input limit: a warn line, on; an abort → F | — (X7: the agentic loop books its own passes) | — |
| 9 | Cap that runs, thinking | 638-675 | ← `outputCap`, `preflight`, `contextWindow`; → `runCap`, `inputWindowCut`, `effectiveThinkingBudget`, `thinkingTokensForEstimate` | — | — (a cut is said on the progress channel and the log) | — | — |
| 10 | Budget reservation | 677-717 | ← `resolved`, `serviceTier`, `attachmentTokens`, `workspaceBytes`, `runCap`, `preflight`, `thinkingTokensForEstimate`, `timeoutController.timeoutMs`; → `reservationId` | — (one SQLite transaction) | **X9** `:711` `BUDGET_REJECT` `{errorCode, retryable: false, serviceTier}` — only under a daily cap | nothing reserved; else reserved | — |
| 11 | Context | 719-753 | ← `scan`, `resolved`, `input.noCache`, `abortSignal`; → `caching`, `prepare` (a closure the stale-cache retry calls again), `ctxPrep` | `prepareContext` (signal) | a throw → F | released (no decode started) | — |
| 12 | Request | 755-830 | ← `effectiveThinkingBudget`, `runCap`, `serviceTier`, `attachments`; → `thinkingConfig`, `buildConfig`, `userTurn`, `buildContents` | — | — | — | — |
| 13 | Decode | 832-862 | ← all of the above, `completed`, `tracking`, `dispatch`; → `response`, `activePrep`, `retriedOnStaleCache`; `tracking.ledgerEntry` set when a decode starts (`context-decode.ts:140`), `tracking.streamOpened` | `decodeOnContext`: the TPM wait, the cache's keep-alive, each request's opening and stream, the stale-cache rebuild | a throw → F | F's rule; a TPM-wait timeout before the first request: released (the entry is set after the wait, `context-decode.ts:101`, `:140`) | one reservation per request, settled at its reported input when it ends (`context-decode.ts:160-163`) |
| 14 | Settle | 864-903 | ← `response`, `activePrep`, `caching`; `reservationId` and `tracking.ledgerEntry` cleared (`:879-881`) BEFORE `settleAnswer` | — | **X10** `:901` `OUTPUT_CAP` `{errorCode, retryable: false, resolvedModel, serviceTier, finishReason, usage…, outputCapCutByInputWindow?}` | booked | settled |
| 15 | Result | 905-963 | ← everything | — | **X11** `:963` the answer, text and metadata | booked | settled |
| F | Failure | 964-1007 | ← `reservationId`, `tracking`, `completed`, `resolvedModelKey`, `timeoutController`, `reportedTier()` | — | **X12** `:991` `TIMEOUT` `{errorCode, timeoutKind, timeoutMs, stallMs, retryable: true, serviceTier, usage…?}`, after the progress line `ask: aborted after <n>ms <kind>`; **X13** `:1002` `ask failed: <message>` `{errorCode: RATE_LIMIT \| OVERLOADED \| NETWORK_ERROR \| UNKNOWN, retryable?, retryAfterMs?, serviceTier, httpStatus?, usage…?}` | F's rule | the held reservation dropped; a 429's retry hint seeded once when the model had resolved (`settle-call.ts:115-123`) |
| — | `finally` | 1008-1011 | — | — | — | — | the controller disposed, then the emitter stopped |

**13 exits.** `usage…` is `cachedTokens`, `uncachedTokens`, `outputTokens`, `thinkingTokens`, `costEstimateUsd`,
`continuationHops`. The `serviceTier` of F is `reportedTier()`: the resolved tier, else the requested one. Every exit
matches the table of `docs/cost-model.md` for `ask`: nothing is reserved before step 10, a failure before a decode
started releases, a completed request stays booked, an answer whose ledger write fails is returned. One reachable
escape: a `throttle` whose `recordRetryHint` or `cancel` throws inside F would leave the function (r) — the real
`TpmThrottle` does not throw there (`throttle.ts:371-381`).

## Today: `code` (`executeCodeBody`)

| # | Step | Lines | State | Awaits | Exits and what the result carries | Ledger | TPM |
|---|---|---|---|---|---|---|---|
| 0 | Entry | 260-264 | → `started`, `workspaceRoot` | — | — | — | — |
| 1 | Call machinery | 313-354 | → `modelRequest`, `expectEdits`, `codeExecution`, `usingThinkingLevel`, `thinkingBudget` (default 16,384), `reservationId`, `resolvedModelKey`, `completed`, `tracking`, `modelAudit = {}`, `emitter`, `timeoutController`, `abortSignal`, `dispatch` | — | — | — | — |
| 2 | Workspace guard | 359-366 | | — | **Y1** `:363` `code: <message>` | — | — |
| 3 | Model and tier | 368-407 | → `choice`, `resolved`, `serviceTier`, `modelAudit` `{resolvedModel, configuredModelReplaced, serviceTier}`, `resolvedModelKey` (`:407`) | `resolveCodeModel` (one or two `resolveModel`) | **Y2** `:389` `SERVICE_TIER_UNSUPPORTED` `{errorCode, retryable: false, serviceTier: 'flex', resolvedModel, configuredModelReplaced}` | — | — |
| 4 | Scan | 409-419 | → `scan` | `scanWorkspace` | a throw → F | — | — |
| 5 | Output cap, budget refusal | 421-446 | → `outputCap` | — | **Y3** `:446` `code: thinkingBudget (…) …` | — | — |
| 6 | Input estimate | 448-455 | → `workspaceBytes`, `estimatedInputTokens` | — | — | — | — |
| 7 | Preflight and workspace guard | 457-501 | → `preflight`, `contextWindow` | `countForPreflight` (signal) | **Y4** `:480` `WORKSPACE_TOO_LARGE` `{errorCode, retryable: false, estimatedInputTokens, tokenCountMethod, rawTokenCount, tokenCountCacheHit, contextWindowTokens, thresholdTokens, guardRatio, resolvedModel, configuredModelReplaced, serviceTier, filesIndexed}` | — | — |
| 8 | Cap that runs, thinking | 503-522 | → `runCap`, `inputWindowCut`, `effectiveThinkingBudget`, `thinkingTokensForEstimate` | — | — | — | — |
| 9 | Budget reservation | 524-557 | → `reservationId` | — | **Y5** `:551` `BUDGET_REJECT` `{errorCode, retryable: false, resolvedModel, configuredModelReplaced, serviceTier}` | nothing reserved; else reserved | — |
| 10 | Context | 559-594 | → `caching`, `prepare`, `ctxPrep` (`allowCaching`: files and no `codeExecution`) | `prepareContext` | a throw → F | released | — |
| 11 | Request | 596-667 | → `userPrompt` (the OLD/NEW suffix when `expectEdits`), `thinkingConfig`, `canUseCache`, `buildConfig` (adds `tools` with `codeExecution`), `buildContents`; a warn when a cache meets `codeExecution` | — | — | — | — |
| 12 | Decode | 669-697 | as `ask` step 13 | `decodeOnContext` | a throw → F | F's rule | per request |
| 13 | Artefacts | 699-718 | → `edits`, `codeBlocks`, `executedCode`, `executionOutput`, `thinkingSummary` | — | — | — | — |
| 14 | Settle | 720-755 | as `ask` step 14 | — | **Y6** `:751` `OUTPUT_CAP` `{resolvedModel, configuredModelReplaced, serviceTier, errorCode, retryable, finishReason, usage…}` | booked | settled |
| 15 | Result | 757-825 | | — | **Y7** `:822` the answer; the text led by the truncation note when `truncated` | booked | settled |
| F | Failure | 826-866 | ← `modelAudit` | — | **Y8** `:849` `TIMEOUT` `{errorCode, timeoutKind, timeoutMs, stallMs, retryable: true, resolvedModel?, configuredModelReplaced?, serviceTier?, usage…?}` — no `serviceTier` before the model resolved; **Y9** `:860` `code failed: …` `{…tierErrorMeta, httpStatus?, serviceTier, resolvedModel?, configuredModelReplaced?, usage…?}` — `serviceTier` keeps its place and takes the resolved value from `modelAudit` | F's rule | as `ask` |

**9 exits.**

## Today: what the two repeat

`npx jscpd --config .jscpd.json` on `074212c`: ten repeats, all between the two files (no repeat of either file with a
third). The line counts are jscpd's (tokens, comments excluded); the two files' baselines (213 and 171) count the
overlapping line at `ask :870`, `:887` / `code :736` once.

| # | `ask.tool.ts` | `code.tool.ts` | What | Behaviour |
|---|---|---|---|---|
| R1 | 388-408 | 346-363 | the timeout controller, the dispatch throttle, `try`, the workspace validation | identical but the tool's name (the controller's env vars, the message prefix) |
| R2 | 451-482 | 407-428 | the scan memo, the scan, `resolveOutputCap` | identical; the fallback output cap is 65,536 in both (`ASK_MAX_OUTPUT_TOKENS_FALLBACK` `:101`, `CODE_MAX_OUTPUT_TOKENS_FALLBACK` `:428`). `code` records the resolved model at `:407`, `ask` at `:422` before the tier: nothing between the two points can throw (`resolveServiceTier` throws only `ServiceTierError`, which both return), so the failure path sees the same |
| R3 | 520-550 | 455-467 | the start of the preflight: `countForPreflight`'s arguments | `ask` passes `extraTokens: attachmentTokens` (0 without attachments) and adds them to `effectiveTokens`; `code` passes none, read as 0 (`token-counter.ts:254`): the same count. `ask` checks `REQUEST_TOO_LARGE` first |
| R4 | 703-713 | 543-553 | `reserveBudget` and the `BUDGET_REJECT` message | the message is the same; the fields differ (`ask` `serviceTier`; `code` the model audit). `ask`'s estimate adds `extraInputTokens` (read as 0 when absent, `cost-estimator.ts:400`) |
| R5 | 720-743 | 560-580 | the system-prompt hash, `cachingModeFor`, the `prepare` closure | identical but the instruction and `allowCaching` (`ask`: `!noCache && files > 0`; `code`: `files > 0 && !codeExecution`); the arguments of `prepareContext` in the same key order |
| R6 | 839-870 | 673-700 | the `decodeOnContext` call, the response's text and thought summary | identical but the tool's name and the request builder |
| R7 | 870-887 | 718-736 | `cachingRan`, `durationMs`, the reservation and the decode's entry cleared, `settleAnswer`'s start | identical but the tool's name |
| R8 | 887-902 | 736-751 | the rest of `settleAnswer`, the `OUTPUT_CAP` return | `ask` returns the stop's fields; `code` spreads its model audit first, which adds `configuredModelReplaced` and puts `resolvedModel` and `serviceTier` first |
| R9 | 934-944 | 797-805 | `excludedDirs`, `excludedDirsTotal`, `filesSkippedNonSource`, `filesUploadFailed`, `uploadFailures?` | the same five keys in the same order; around them the results differ (`ask`: `filesSkippedTooLarge` before, `workspaceTruncated` and `maxFilesCap` after; `code`: those two before `filesIndexed`, no `filesSkippedTooLarge`) |
| R10 | 971-989 | 833-847 | `settleFailure`, the start of the timeout branch | the settlement is identical; the timeout result carries `serviceTier: reportedTier()` (`ask`) or the model audit (`code`) |

Below jscpd's ten-line floor the two also repeat: the `ServiceTierError` branch, the `thinkingBudgetRefusal` call, the
level branch of `thinkingConfig`, the non-timeout branch of F (same values, other key order) and the `finally`.

## The target

### Decision

`ask.tool.ts` stays the entry: the registration and the call — open the call, run its phases, the failure result,
close. Its steps become modules under `src/tools/ask/`, beside `src/tools/agentic/`. What `ask` and `code` repeat moves
to `src/tools/shared/` once, read by both: the call's machinery and its failure trail (R1, R10), the scan and the output
cap (R2), the preflight's count (R3), the budget reservation (R4), the context (R5), the decode and the settlement (R6-R8)
and the scan's fields (R9). Money and classification are shared; every result is built by its own tool, so each keeps its
fields and their order. The long decode does not move: it already lives in `shared/continuation.ts` and
`shared/context-decode.ts`, and the tools only call `decodeOnContext`.

`code` reads the shared pieces in this PR. It must: a piece moved out of `ask` alone would leave `code`'s copy repeating
the new shared file, a new repeat the baseline ratchet refuses; and reading them changes `executeCodeBody`, the unit that
holds all of `code.tool.ts`'s suppressions, which by Rule 2 of `docs/SYSTEMIC.md` leaves the baseline in the PR that
changes it. The line is therefore drawn at the file: both files leave both baselines whole ([below](#baselines)). What
is left of `code` for the next PR is layout only — its schema, parsers and steps moved from `code.tool.ts` into
`src/tools/code/` — not structure.

### Module map

| File | Holds | Exports |
|---|---|---|
| `src/tools/ask.tool.ts` (entry) | the registration; `executeAskBody` as the orchestrator (`try` / `catch` / `finally`) over three phase functions: setup (steps 2-5), sizing (6-10), answer (11-15) | `askTool: ToolDefinition<AskInput>`; re-exports `askInputSchema`, `type AskInput` |
| `src/tools/ask/input.ts` | the input schema, moved verbatim | `askInputSchema`, `type AskInput` |
| `src/tools/ask/call.ts` | the call's stages (below) | `AskCall`, `AskResolved`, `AskAttached`, `AskScanned`, `AskSized`, `AskPrepared`, `StepOutcome<T>` |
| `src/tools/ask/setup.ts` | the model and its tier (step 3) | `resolveAsk(call: AskCall): Promise<StepOutcome<AskResolved>>` |
| `src/tools/ask/attachments.ts` | step 4 and the inline-size refusal, moved (`:243-357`) | `PreparedAttachments`; `attachAsk(call: AskResolved): Promise<StepOutcome<AskAttached>>`; `inlineRequestRefusal(prepared: PreparedAttachments, files: readonly ScannedFile[], prompt: string, serviceTier: ServiceTierName): TextToolResult \| undefined`; `attachmentMetadata(prepared: PreparedAttachments): Record<string, unknown>` |
| `src/tools/ask/guard.ts` | step 8 for `ask`: the count's verdict, the two `WORKSPACE_TOO_LARGE` results, the fallback | `guardAsk(call: AskScanned): Promise<StepOutcome<AskCounted>>` |
| `src/tools/ask/thinking.ts` | step 9's thinking: the normalised budget, the wire config, the progress line | `AskThinking`; `askThinking(input: AskInput, cap: OutputCap): AskThinking`; `thinkingConfigOf(t: AskThinking): ThinkingConfig`; `thinkingBudgetField(t: AskThinking): number \| null`; `thinkingReserveOf(t: AskThinking, cap: OutputCap): number`; `generatingLine(t: AskThinking): string` |
| `src/tools/ask/request.ts` | the system instruction; step 12 | `SYSTEM_INSTRUCTION_Q_AND_A`; `askRequest(call: AskSized): (prep: PreparedContext) => ContextRequest` |
| `src/tools/ask/results.ts` | every `ask` result from step 10 on and F's | `budgetRejectResult(call: AskSized, rejection: BudgetRejection): TextToolResult`; `outputCapResult(stop: OutputCapStop): TextToolResult`; `answerResult(call: AskPrepared, decoded: ContextDecode, settled: SettledDecode): TextToolResult`; `failedResult(failure: FailedEagerCall): TextToolResult` |
| `src/tools/shared/eager-call.ts` (new) | the machinery of one `ask` / `code` call and what its failure path reads | `EagerTool`, `ModelReached`, `FailureTrail<M>`, `EagerCall<M>`; `openEagerCall<M extends ModelReached>(tool: EagerTool, knobs: ToolTimeoutKnobs, ctx: ToolContext, workspaceRoot: string, started: number): EagerCall<M>`; `closeEagerCall(call: EagerCall<ModelReached>): void` |
| `src/tools/shared/eager-steps.ts` (new) | the steps both tools run the same way | `workspaceRefusal(tool: EagerTool, root: string): TextToolResult \| null`; `scanForCall(call: EagerCall<ModelReached>, ctx: ToolContext, filters: ScanFilters): Promise<ScanResult>`; `EAGER_OUTPUT_FALLBACK_TOKENS`; `eagerOutputCap(requested: number \| undefined, ctx: ToolContext, resolved: ResolvedModel): OutputCap`; `estimateInput(scan: ScanResult, prompt: string, extraTokens: number): InputEstimate`; `countPreflight(call: EagerCall<ModelReached>, ctx: ToolContext, req: PreflightRequest): Promise<PreflightCount \| null>`; `reserveCallBudget(call: EagerCall<ModelReached>, ctx: ToolContext, req: ReservationRequest): ReservationOutcome`; `prepareCallContext(call: EagerCall<ModelReached>, ctx: ToolContext, spec: ContextSpec): Promise<CallContext>`; `scanFields(scan: ScanResult, prep: PreparedContext): Record<string, unknown>` |
| `src/tools/shared/context-decode.ts` (extended) | the decode of an eager call: `ContextDecodeCall` built from the call | `decodeEagerCall(call: EagerCall<ModelReached>, ctx: ToolContext, spec: DecodeSpec, context: CallContext): Promise<ContextDecode>` |
| `src/tools/shared/settle-call.ts` (extended) | the answer settled with the trail cleared first; the failure settled and classified | `settleDecoded(call: EagerCall<ModelReached>, ctx: ToolContext, decoded: ContextDecode, run: DecodeRun): SettledDecode`; `settleFailedEager(call: EagerCall<ModelReached>, ctx: ToolContext, err: unknown): FailedEagerCall` |
| `src/tools/code.tool.ts` | the schema, the parsers, `resolveCodeModel` (unchanged); `executeCodeBody` as an orchestrator over the shared pieces and its own steps: `resolveCode`, `guardCode`, `codeRequest`, `codeArtifacts`, `codeAnswerResult`, `codeFailedResult` | unchanged: `codeTool`, `codeInputSchema`, `CodeInput`, `parseEdits`, `parseCodeBlocks`, `truncatedNote`, the two notes |
| `src/tools/ask-agentic-fallback.ts` | unchanged but one line: `AskInput` imported from `./ask/input.js` | unchanged |

The schema moves to `ask/input.ts`, as T39 put `ask_agentic`'s in `agentic/input.ts`: the steps and the fallback read
`AskInput` without importing the entry, which imports them. The entry re-exports both names; every test and
`src/tools/index.ts` import them from the entry as today.

### Data model

```ts
// src/tools/shared/eager-call.ts
export type EagerTool = TimedTool; // 'ask' | 'code'

/** What the failure path reports of the model: written once the model and its tier resolved. */
export interface ModelReached {
  readonly resolvedModel: string;
  readonly serviceTier: ServiceTierName;
}

/** What a call's failure path reads, written by the step named on each field. */
export interface FailureTrail<M extends ModelReached> {
  /** The daily-budget reservation held: set by the reservation, cleared before the answer is settled. */
  reservationId: number | null;
  /** Set by the model step; `null` before it (no retry hint is seeded, the requested tier is reported). */
  model: M | null;
}

/** The machinery of one `ask` / `code` call, created before its first await. */
export interface EagerCall<M extends ModelReached> {
  readonly tool: EagerTool;
  readonly workspaceRoot: string;
  readonly started: number;
  /** The tier asked for (per call, else the configured one): what a failure reports before the model resolved. */
  readonly requestedTier: ServiceTierName;
  readonly emitter: ProgressEmitter;
  readonly timeout: TimeoutController;
  readonly dispatch: DispatchThrottle;
  readonly completed: CompletedRequests;
  readonly tracking: DecodeTracking;
  readonly trail: FailureTrail<M>;
}

// src/tools/shared/eager-steps.ts
export interface ScanFilters {
  readonly includeGlobs: readonly string[] | undefined;
  readonly excludeGlobs: readonly string[] | undefined;
  readonly forceRescan: boolean | undefined;
}
export interface InputEstimate {
  readonly workspaceBytes: number;
  /** bytes/4 of the workspace and the prompt, plus the extra tokens: what the TPM reservation holds. */
  readonly tokens: number;
}
export interface PreflightRequest {
  readonly scan: ScanResult;
  readonly prompt: string;
  readonly resolved: ResolvedModel;
  readonly mode: PreflightMode | undefined;
  /** Tokens beyond the files and the prompt, counted by Gemini (`ask`'s attachments; 0 for `code`). */
  readonly extraTokens: number;
}
export interface PreflightCount {
  /** The count, the extra tokens included. */
  readonly preflight: PreflightTokenResult;
  readonly contextWindow: number;
  readonly threshold: number;
}
export interface ReservationRequest {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
  readonly estimate: InputEstimate;
  readonly promptChars: number;
  readonly extraInputTokens: number;
  readonly cap: OutputCap;               // the cap that runs
  readonly countedInputTokens: number | undefined;
  readonly thinkingTokens: number;
}
export interface BudgetRejection {
  /** "Daily budget cap would be exceeded: …" — one text for both tools. */
  readonly message: string;
}
export type ReservationOutcome =
  | { readonly kind: 'unbounded' }       // no daily cap: nothing reserved
  | { readonly kind: 'reserved' }        // `trail.reservationId` set
  | { readonly kind: 'rejected'; readonly rejection: BudgetRejection };
export interface ContextSpec {
  readonly scan: ScanResult;
  readonly resolved: ResolvedModel;
  readonly systemInstruction: string;
  readonly allowCaching: boolean;
  readonly requestedMode: 'explicit' | 'implicit';
}
export interface CallContext {
  readonly caching: CachingModeChoice;
  /** Builds the context again: the stale-cache retry calls it. */
  readonly prepare: () => Promise<PreparedContext>;
  readonly prepared: PreparedContext;
}

// src/tools/shared/context-decode.ts
export interface DecodeSpec {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
  readonly request: (prep: PreparedContext) => ContextRequest;
  readonly cap: OutputCap;               // the cap that runs
  readonly estimate: InputEstimate;
  readonly countedInputTokens: number | undefined;
}

// src/tools/shared/settle-call.ts
export interface DecodeRun {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
  readonly caching: CachingModeChoice;
  readonly bounded: BoundedOutputCap;
}
export interface SettledDecode {
  readonly settled: SettledAnswer;
  readonly ran: RanCaching;
  readonly durationMs: number;
}
export interface FailedEagerCall {
  /** What the completed requests billed; `null` when none completed. */
  readonly usage: UsageFields | null;
  /** Set when the call timed out (`isTimeoutAbort`); the progress line is already emitted. */
  readonly timedOut: TimedOutCall | null;
  readonly tierMeta: TierErrorMeta;
  readonly httpStatus: number | undefined;
  /** `<tool> failed: <message>`. */
  readonly message: string;
  /** The resolved tier, else the requested one. */
  readonly serviceTier: ServiceTierName;
}

// src/tools/ask/call.ts — the call as it grows; each stage adds what its step produced, nothing optional
export interface AskCall {
  readonly input: AskInput;
  readonly ctx: ToolContext;
  /** The alias or id as asked. */
  readonly model: string;
  readonly eager: EagerCall<ModelReached>;
}
export interface AskResolved extends AskCall {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
}
export interface AskAttached extends AskResolved {
  readonly attachments: PreparedAttachments;
}
export interface AskScanned extends AskAttached {
  readonly scan: ScanResult;
  readonly outputCap: OutputCap;
  readonly estimate: InputEstimate;
}
export interface AskCounted extends AskScanned {
  /** `null`: the model advertises no input limit; the guard did not run. */
  readonly count: PreflightCount | null;
}
export interface AskSized extends AskCounted {
  readonly bounded: BoundedOutputCap;
  readonly thinking: AskThinking;
}
export interface AskPrepared extends AskSized {
  readonly context: CallContext;
}
/** A step's outcome: the next stage, or the result that ends the call (a refusal, or the fallback's answer). */
export type StepOutcome<T> = { readonly next: T } | { readonly end: TextToolResult };

// src/tools/ask/thinking.ts
export type AskThinking =
  | { readonly kind: 'level'; readonly level: ThinkingLevelLiteral }
  | { readonly kind: 'model-default' }               // nothing sent but includeThoughts
  | { readonly kind: 'budget'; readonly budget: number }; // -1, 0, or a positive budget clamped under the cap

// src/tools/code.tool.ts
interface CodeModelReached extends ModelReached {
  readonly configuredModelReplaced: string | null;
}
```

`ResolvedModel` is `src/types.ts`'s (`resolveModel`'s return type); `ResolvedAskModel` (`ask.tool.ts:267`) goes.
The two mutable fields of `FailureTrail` replace the four mutable locals the failure paths read today
(`reservationId`, `resolvedModelKey`, `serviceTier` behind `reportedTier()`, `modelAudit`); `tracking` and `completed`
keep their shared types.

### Baselines

| Baseline | Entry | Leaves |
|---|---|---|
| `eslint-suppressions.json` | `src/tools/ask.tool.ts`: `complexity` 1, `max-depth` 2, `max-lines-per-function` 1 | all: every unit of the entry and of `ask/` within 40 lines, complexity 10, nesting 3 |
| `eslint-suppressions.json` | `src/tools/code.tool.ts`: the same three | all: they are one unit's, `executeCodeBody`, which this PR changes |
| `jscpd-baseline.json` | `src/tools/ask.tool.ts`: 213 | all: R1-R10 are gone |
| `jscpd-baseline.json` | `src/tools/code.tool.ts`: 171 | all: its repeats are R1-R10 only |

The total of `jscpd-baseline.json` falls from 2,599 to 2,215 lines. No new file enters either baseline. The test files'
entries do not move: no test changes.

### Order-sensitive points a naive extraction breaks

1. The controller is created before the first await (`:388`, the first await is `:419`): `openEagerCall` is synchronous
   and runs first, after the emitter (`:380`) as today.
2. `reservationId` and `tracking.ledgerEntry` are cleared BEFORE `settleAnswer` (`:879-881`), so a throw after it
   neither books the call again nor releases what was booked: `settleDecoded` clears the trail first.
3. The fallback disposes `ask`'s controller and runs the agentic call inside `ask`'s `try` (`:597`); `ask`'s emitter is
   stopped by the `finally` after the agentic call returned, and a throw of the fallback reaches F. `guardAsk` awaits the
   fallback and returns its result as `{ end }`; it never returns a promise for the entry to await outside the `try`.
   A second `dispose` is a no-op (`abort-timeout.ts:232-237`, `:247-250`).
4. F settles first, then classifies: the error line, `settleFailure` (the retry hint, the ledger, the TPM reservation),
   then the timeout's progress line (`:965-990`). `settleFailedEager` keeps that order.
5. `OUTPUT_CAP` returns before the truncated-scan warning (`:901` before `:905`).
6. The stale-cache retry calls the same `prepare` closure (`:736`, `context-decode.ts:204`): `CallContext.prepare` is
   that closure, with the same arguments in the same key order.
7. Result keys keep their order per tool (R8, R9, R10, F's non-timeout branch): the shared pieces return values and
   field groups, never a whole result.

### Error policy

Unchanged. No new `catch`: a step ends the call by returning `{ end }`, and every throw reaches the one failure path as
today. `recordBilledCall` and `releaseReservation` stay the only places that catch a ledger write.

### Performance budget

The same awaits in the same order. Per call about ten more object literals (the stages and the step outcomes); nothing
per file, per chunk or per request.

## What must not change

Each item is checked by the probe ([below](#proof-plan)) or by an existing test.

1. **The input schemas.** `askInputSchema` and `codeInputSchema` — fields, bounds, descriptions, the two refinements
   of `code` and the one of `ask` — byte for byte: `test/fixtures/tools-input-schema.json` through
   `test/unit/tool-input-schema.test.ts`. The tools' names, titles and descriptions.
2. **Every exit of the two tables:** the same exit for the same inputs, its message text, its `errorCode`, its
   `retryable`, every field and the order of the fields of `structuredContent`, `isError`, and `responseText`.
3. **The error codes:** `SERVICE_TIER_UNSUPPORTED`, `ATTACHMENTS_UNSUPPORTED`, `ATTACHMENT_INVALID`,
   `ATTACHMENT_TOKENS_UNCOUNTED`, `REQUEST_TOO_LARGE`, `WORKSPACE_TOO_LARGE`, `BUDGET_REJECT`, `OUTPUT_CAP`, `TIMEOUT`
   (with `timeoutKind` `total` / `stall`), `RATE_LIMIT` (with `retryAfterMs` when Google sent a hint), `OVERLOADED`,
   `NETWORK_ERROR` (`retryable` false once a stream opened), `UNKNOWN`; and the fallback's lifted codes.
4. **The order of side effects** per call: the progress lines (`resolving model`, `scanning workspace`, the cut note,
   the caching note, `generating …`, the throttle's wait, `thinking: …`, `<tool>: aborted after …`), the log lines,
   `manifest.getFiles`, `countTokens`, `reserveBudget`, `prepareContext` (its arguments), each request's TPM
   reservation, `keepAlive` and opening, `markHot`, `markCacheStale`, `finalizeBudgetReservation` /
   `insertUsageMetric` / `cancelBudgetReservation`, the throttle's `release` / `cancel` / `recordRetryHint`, the
   controller's dispose, the emitter's stop.
5. **The money table** of `docs/cost-model.md` for `ask` and `code`: nothing reserved before the reservation step; a
   failure before a decode started releases; a completed request stays booked whatever fails after it; an answer is
   booked once; a failed ledger write is logged and the answer returned; the 429's hint seeded once, and only once the
   model resolved; each request's TPM reservation settled at its reported input, the held one dropped on a failure.
6. **The requests sent to Gemini:** `contents` and `config` of every request, their keys in the same order
   (`ask` and `code` build `config` in different orders today).
7. **The exports** the tests and the fallback read: `askTool`, `askInputSchema`, `AskInput` from
   `src/tools/ask.tool.ts`; `codeTool`, `codeInputSchema`, `CodeInput`, `parseEdits`, `parseCodeBlocks`,
   `truncatedNote`, `TRUNCATED_EDITS_NOTE`, `TRUNCATED_ANSWER_NOTE` from `src/tools/code.tool.ts`.

## Proof plan

**The differential probe.** A vitest file kept outside the repository (as for T39, T42 and T44) drives `askTool` and
`codeTool` through `execute` with a scripted fake client (`models.countTokens`, `models.generateContentStream`: chunks,
usage, a refusal at the opening, a failure or a hang mid-stream), a recording manifest, throttle and TTL watcher, a
server that records the progress notifications, and the logger spied. It mocks only modules this PR does not move —
`indexer/workspace-validation`, `gemini/models`, `indexer/workspace-scanner`, `cache/cache-manager`'s `prepareContext`
(the stale-cache predicate and `markCacheStale` kept real) — so the same file runs on both trees; the fallback runs the
real `ask_agentic` loop on the fake client; attachments are real files in a temporary workspace; the token counter's
cache is cleared before each scenario. Each scenario writes one ordered trace (every call above with its arguments,
every progress and log line, the result) with the workspace path, `durationMs`, `nowMs` and `occurredAt` masked and the
key order kept (objects written as entry lists). It runs on `main` (`074212c`) and on every commit of the PR. Target:
every scenario's trace identical.

| Exit | `ask` scenarios |
|---|---|
| X1 | `ws-invalid`; `ws-validate-other-error` (→ X13) |
| X2 | `tier-vertex-flex`; `tier-vertex-default-flex` (downgraded to standard, answers) |
| X3 | `att-no-vision`, `att-bad-magic`, `att-count-400`, `att-count-503`, `att-count-403`, `att-count-no-total`, `att-timeout` (→ X12) |
| X4 | `thinking-budget-over-cap` |
| X5 | `att-request-too-large` |
| X6, X7, X8 | `too-large-error`, `too-large-error-att`, `too-large-fallback-att`, `too-large-fallback` (answers), `too-large-fallback-error` (the agentic error lifted), `too-large-fallback-flex`, `too-large-fallback-knobs` (per call and env); `preflight-heuristic`, `preflight-exact`, `preflight-auto-near-limit`, `preflight-count-fails` (method `fallback`), `preflight-no-window`, `preflight-timeout` (→ X12) |
| X9 | `budget-reject`; `budget-reserve-throws` (→ X13) |
| X10 | `output-cap-empty`, `output-cap-cut-by-window` |
| X11 | `answer`; `answer-no-budget` (usage row); `answer-no-usage` (booked at the estimate); `answer-truncated`; `answer-thoughts`; `scan-truncated`; `upload-failures`; `cap-explicit`, `cap-force-max`, `cap-default`, `cap-window-cut`; `thinking-level`, `thinking-dynamic`, `thinking-zero`, `thinking-clamped`; `cache-explicit-hit`, `cache-explicit-miss`, `cache-explicit-no-create` (Gemini 4: run implicit, note), `cache-create-failed` (note), `cache-implicit`, `no-cache`, `empty-workspace`; `stale-cache-retry`; `long-decode-2-requests`, `long-decode-reopen-429`; `att-answer-inline`, `att-answer-cached`; `tpm-wait`; `open-network-retry-then-ok`; `flex-answer`; `budget-finalize-throws` and `no-budget-insert-throws` (the failed write logged, the answer returned) |
| X12 | `timeout-total-mid-stream`, `timeout-stall`, `timeout-env-total`, `timeout-env-stall`, `timeout-tpm-wait`, `timeout-prepare`, `timeout-after-completed-request` (booked), `foreign-timeout-error` (a `TimeoutError` the controller did not raise) |
| X13 | `model-resolve-fails`, `model-resolve-429` (no hint seeded), `scan-throws`, `prepare-throws`, `open-429-hint`, `open-429-no-hint`, `open-503`, `open-network-flex` (one attempt), `mid-stream-network` (not retryable), `mid-stream-after-completed` (booked), `stale-cache-retry-429`, `stale-cache-retry-other`, `stale-cache-after-completed` (booked), `flex-503`, `failed-write-on-failure` |

`ask` takes no caller abort: `ToolContext` carries no signal (`registry.ts:13-31`); its only aborts are its timeout
controller's, which the X12 scenarios cover.

| Exit | `code` scenarios (the paths the shared pieces touch) |
|---|---|
| Y1 | `code-ws-invalid` |
| Y2 | `code-tier-vertex-flex`, `code-model-replaced-then-tier-refused` |
| Y3 | `code-thinking-budget-over-cap` |
| Y4 | `code-too-large`, `code-no-window` (answers) |
| Y5 | `code-budget-reject` |
| Y6 | `code-output-cap-empty` |
| Y7 | `code-answer-edits`, `code-answer-prose`, `code-answer-truncated-edits`, `code-answer-truncated-prose`, `code-model-replaced`, `code-thinking-level`, `code-thinking-default`, `code-exec` (inline, `tools` in the config), `code-exec-with-cache` (bypassed, warn), `code-cache-explicit-hit`, `code-stale-cache-retry`, `code-long-decode`, `code-no-budget`, `code-flex`, `code-ledger-write-fails` |
| Y8 | `code-timeout-total`, `code-timeout-stall`, `code-timeout-before-model` (no `serviceTier`) |
| Y9 | `code-model-mismatch-named`, `code-open-429-hint`, `code-mid-stream-network`, `code-prepare-throws`, `code-flex-503` |

**The existing tests, green and unchanged.** `ask`: `test/unit/ask-tool.test.ts`, `ask-attachments.test.ts`,
`ask-streaming-integration.test.ts`, `ask-throttle-integration.test.ts`, `ask-timeout-integration.test.ts`,
`preflight-guard.test.ts`, `service-tier.test.ts`, `agentic-time-bounds.test.ts` (the fallback's hand-off),
`tool-input-schema.test.ts`, `test/integration/v1.7.0-streaming-srogi.test.ts`, `v1.7.0-srogi-extras.test.ts`.
`code`: `code-tool.test.ts`, `code-parsers.test.ts`, `code-throttle-integration.test.ts`, and the `code` cases of
`ask-timeout-integration.test.ts`, `preflight-guard.test.ts`, `service-tier.test.ts`, `v1.7.0-streaming-srogi.test.ts`.
The shared modules: `call-ledger-booking.test.ts`, `continuation.test.ts`, `long-decode.test.ts`, `thinking.test.ts`.
Their `vi.mock` targets are modules this PR does not move, so a mock still applies wherever the new modules import
them. `npm run lint`, `npm run typecheck`, `npm test` on every commit.

## Order of work

Each commit keeps the suite, the lint and the probe green, and records the baselines it lowered (the emptied
suppressions pruned with `npx eslint --prune-suppressions`, the repeats re-recorded with
`node lint/baseline-ratchet.mjs --write-duplicates .jscpd-report/jscpd-report.json`). A shared piece lands with both
readers in one commit: one reader alone would leave the other's copy repeating the new file.

| # | Commit | Moves |
|---|---|---|
| 0 | — | the probe recorded on `main` (outside the tree) |
| 1 | `ask`: the input schema in `ask/input.ts` | the schema; the entry re-exports it; the fallback's type import |
| 2 | `ask`: the attachments in `ask/attachments.ts` | `:243-357` verbatim |
| 3 | shared: the eager call and its failure trail | R1, R10, the `finally`; both tools |
| 4 | shared: the scan, the output cap, the preflight's count | R2, R3; both tools |
| 5 | shared: the budget reservation | R4; both tools |
| 6 | shared: the context | R5; both tools |
| 7 | shared: the decode, the settlement, the scan's fields | R6-R9; both tools; both files leave `jscpd-baseline.json` |
| 8 | `ask`: thinking and request in `ask/thinking.ts`, `ask/request.ts` | step 9's thinking, step 12 |
| 9 | `ask`: the guard and the fallback in `ask/guard.ts` | step 8 |
| 10 | `ask`: the stages, the setup and the results; the entry as orchestrator | `ask/call.ts`, `ask/setup.ts`, `ask/results.ts`; `ask.tool.ts` leaves `eslint-suppressions.json` |
| 11 | `code`: the orchestrator over its own steps | `code.tool.ts` leaves `eslint-suppressions.json` |
| 12 | docs | `docs/architecture.md` (`src/tools/ask/`, the two new shared modules), T47 closed in `docs/FOLLOW-UP-PRS.md`, this note's status |

No CHANGELOG entry: nothing a user sees changes.

## Risks and open questions

| # | Question | Recommendation | The fact that would flip it |
|---|---|---|---|
| Q1 | Does the long-decode loop move as one unit? | Nothing of it moves: it is `shared/continuation.ts` and `shared/context-decode.ts` already, and `ask` calls `decodeOnContext` once (`:836-861`); the split wraps that call (`decodeEagerCall`) | a decode decision found inside `executeAskBody` (none: every request, reopening and continuation is in the shared modules) |
| Q2 | Is anything order-sensitive in a way a naive extraction breaks? | Yes — the seven points [above](#order-sensitive-points-a-naive-extraction-breaks); the closure `reportedTier()` over a mutable local becomes the trail's `model`, the fallback stays awaited inside the `try`, the trail is cleared before the settlement | a probe scenario that differs after a move: the move is wrong, never the trace |
| Q3 | Does `code` join `src/tools/shared/` now or only later? | Now, for every shared piece: the ratchet refuses a repeat of `code` with a new shared file, and Rule 2 takes `executeCodeBody` out of the baseline in the PR that changes it | a ratchet that admitted a repeat in a new file (it does not: `lint/baseline-ratchet.mjs`) |
| Q4 | Where do `code`'s own steps live? | In `code.tool.ts` for this PR; `src/tools/code/` (the schema, the parsers, the steps) is the next PR, layout only | `code.tool.ts` after this PR over about 600 lines, or not fitting a reviewer's packet beside this change set |
| Q5 | The schema in the entry, or in `ask/input.ts` re-exported? | `ask/input.ts`, as T39 did: the steps and the fallback read `AskInput` without importing the entry that imports them | a reviewer who wants the schema readable in the entry file; the re-export keeps every import working either way |
| Q6 | Share whole results between the tools? | No: the two tools order their fields differently (R8, R9, R10, F) and report different fields; the shared pieces return values, each tool composes its results | a decision to align the two tools' results, which is a change of the contract with its own CHANGELOG entry, not this refactor |
| Q7 | The differences the tables show — `code` reports no `filesSkippedTooLarge` and no model `fallbackApplied`, and its `TIMEOUT` before the model resolved has no `serviceTier` | Kept as they are; each is a change of a result, for a follow-up entry if wanted | the maintainers want them aligned in this PR |
| Q8 | Commit the probe as a test? | No: it pins every message and key of about 120 scenarios to golden traces, so every later wording change would regenerate them; the existing tests stay the regression suite and the PR body carries the probe's totals | a request to keep the per-commit equivalence checkable in CI |

## Not in scope

- Any change of behaviour: results, messages, field order, the requests sent, the money table, the schemas and the
  tool descriptions (Q6, Q7).
- `src/tools/code/` — moving `code`'s schema, parsers and steps out of `code.tool.ts` (Q4).
- `ask_agentic` and `src/tools/ask-agentic-fallback.ts` beyond its import of `AskInput`.
- The long decode, the stream collector, the TPM throttle and the ledger rules (`shared/continuation.ts`,
  `stream-collector.ts`, `throttle.ts`, `dispatch-throttle.ts`, `call-ledger.ts`).
- T40, T41, T43, T45.
- The test files and their baseline entries.
- The `status`, `reindex` and `clear` tools.
