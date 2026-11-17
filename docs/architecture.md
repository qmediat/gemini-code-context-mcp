# Architecture

```
┌──────────────┐   stdio   ┌────────────────────────────────────┐   HTTPS   ┌─────────────┐
│  Claude Code │◄─────────►│  @qmediat.io/gemini-code-context-… │◄─────────►│  Gemini API │
└──────────────┘           └────────────────────────────────────┘           └─────────────┘
                                        │
                            ┌───────────┼───────────┬──────────────────┐
                            ▼           ▼           ▼                  ▼
                     ┌───────────┐ ┌─────────┐ ┌──────────┐     ┌──────────────┐
                     │ Workspace │ │  Cache  │ │ Manifest │     │ TTL Watcher  │
                     │  Indexer  │ │ Manager │ │ (SQLite) │     │ (background) │
                     └───────────┘ └─────────┘ └──────────┘     └──────────────┘
```

The server is a stateless stdio MCP server from Claude Code's perspective. From the user's perspective it's a long-running indexer keeping track of their workspace state on Gemini's side (Files API + Context Cache) with a local SQLite manifest.

## Responsibilities

### `src/auth/`

Resolves the active auth profile in priority order:

1. Vertex AI (`GEMINI_USE_VERTEX=true` + `GOOGLE_CLOUD_PROJECT`)
2. Credentials file (`GEMINI_CREDENTIALS_PROFILE` → `~/.config/qmediat/credentials`)
3. Raw env var (`GEMINI_API_KEY`) — logs a warning

`credentials-store.ts` owns INI parsing/serialization with enforced `chmod 0600`. `init-command.ts` is the interactive setup; it uses Node's built-in `readline` for hidden input (no dependency on `inquirer` etc.).

### `src/gemini/`

Thin wrapper over the `@google/genai` SDK:

- `client.ts` constructs `new GoogleGenAI(...)` from the resolved profile.
- `model-registry.ts` enumerates models via `client.models.list()` with a 1-hour in-process cache.
- `models.ts` resolves aliases (`latest-pro`, etc.) to the best available model or falls back with a logged warning.
- `long-decode.ts` holds the facts of Gemini 4's long decode (1,048,576 tokens in total, 65,536 per streaming request), `resolveOutputCap` — the `maxOutputTokens` an `ask` / `code` call sends and how many requests its decode may take — `continuationInputTokens`, the input the continuation requests bill again, and `decodedTokensBound`, the most the decode produces — both read by the budget reservation — and `preflightModeFor`, which takes the exact prompt count for a decode of more than one request. `model-registry.ts` carries `longDecodeTokenLimit` beside the advertised limits.
- `retry.ts` wraps `generateContent` / `generateContentStream` calls in `withNetworkRetry` to ride out Node undici's `TypeError: fetch failed` — a pre-response failure shape the SDK's pinned `p-retry` 4.6.2 treats as non-retryable. Exponential backoff (1s → 3s → 9s, 3 attempts); non-transient errors (`.status`-bearing, `AbortError`, validation) propagate on the first failure. *(v1.6.0+)* `withNetworkRetry` accepts an `AbortSignal` so a tool-level `timeoutMs` can short-circuit the retry loop; `abortableSleep` makes the inter-attempt backoff itself abortable. See [`./KNOWN-DEFICITS.md`](./KNOWN-DEFICITS.md) for the upstream-dependency rationale.

### `src/tools/shared/`

- `abort-timeout.ts` *(v1.6.0+)* — `createTimeoutController(opts)` returns the controller of `ask` / `code` (`signal`, `dispose`, `timeoutMs`, `stallMs`, `recordChunk`, `pauseStall`); `resolveTotalTimeoutMs` / `resolveStallTimeoutMs` resolve a knob and `timeoutReason` builds the abort reason, for it and for `ask_agentic`'s pass clock. Resolution: per-call schema parameter > tool-specific env var > disabled. Bounded `[1000, 1_800_000]` ms. Disabled controllers return a never-firing signal so call sites pass it unconditionally. `isTimeoutAbort(err)` walks `error.cause` chains (depth-bounded, cycle-safe) to map a `DOMException('TimeoutError')` from the SDK back to `errorCode: 'TIMEOUT'`.
- `stream-collector.ts` *(v1.7.0+)* — `collectStream(stream, opts)` consumes the SDK's `AsyncGenerator<GenerateContentResponse>` and accumulates chunks into a `CollectedResponse` with the same surface area as the old `generateContent` return: `text` concatenated across all chunks, `usageMetadata` last-write-wins (Gemini sends only on the final chunk), `candidates` one per candidate index in index order — the parts of every chunk for that index accumulated in order, its finish reason and other metadata from that index's last chunk —, `thoughtsSummary` joined and capped at 1200 chars. Throttled `onThoughtChunk` callback fires for each `thought: true` part — `ask`/`code` wire this into the MCP progress emitter as `"thinking: <truncated>…"` notifications (default throttle 1500 ms). Pre-flight + mid-stream abort checks; closes the generator and rethrows the signal's reason. `withNetworkRetry` wraps the stream OPENING (not chunks); a mid-stream failure is unrecoverable per Gemini's API (no resume). `continuationToken` is the latest token the first candidate carried.
- `continuation.ts` — `runDecode` opens each request of `ask` / `code` through `withNetworkRetry` (only the opening is retried) with `automaticContinuation: false`, reopening a continuation request refused with 429 / 503 with the same token after its TPM reservation is taken again — the network retries and the reopenings of one request share one budget of `openAttempts` SDK calls — and `collectDecode` continues a request that stopped with `finishReason: CONTINUATION` with its token, at most `OutputCap.maxRequests` requests, until the decoded tokens reach the cap and while each request makes progress; hooks run between the requests. The requests become one `DecodedResponse` (text and thought summary in order, usage summed, `continuationHops`).
- `settle-call.ts` — how `ask` and `code` settle: `settleAnswer` books the answered call (`call-ledger.ts`) and returns the `OUTPUT_CAP` error fields of a stop at the cap with no answer, `settleFailure` seeds the throttle with a 429's retry hint (`seedRetryHint` in `throttle.ts`: once per error, the rule `ask_agentic` shares), books what the completed requests billed and drops the TPM reservation. A completed request that reported no usage is billed at the input it was estimated to send (`billedInputTokens`, the rule `ask_agentic` and the TPM settle share).
- `context-decode.ts` — `decodeOnContext`, the decode of `ask` and `code` on their prepared context: the ledger booking, the cache kept alive before every request (`TtlWatcher.keepAlive` extends one that expires within 15 minutes), the stall watchdog paused between requests, a TPM reservation per request (`dispatch-throttle.ts`), and the one stale-cache retry — only while no request of the decode has completed.
- `eager-call.ts` — the machinery of one `ask` / `code` call, opened before its first await (`openEagerCall`: the progress emitter, the timeout controller, the per-request TPM throttle, one tracking object, one completed-request accumulator and the failure trail — the reservation held and the model once resolved; the shared steps take it as `EagerMachinery`, which leaves out the model only the tool writes), a step's outcome for both tools (`StepOutcome`: the next stage or the result that ends the call), its failure path (`settleFailedEager`: settled first, then classified as a timeout or an error, from which each tool builds its own result) and its close (`closeEagerCall`: the controller disposed, then the emitter stopped).
- `eager-steps.ts` — the steps before the context that both tools run the same way: the scan (`scanForCall`, its filters read from either tool's input), the output cap, the input estimate, the preflight count (`countPreflight`) and the guard's verdict on it (`overWindow`: the values a `WORKSPACE_TOO_LARGE` refusal reports) with the count's provenance fields (`preflightFields`), and the daily-budget reservation (`reserveCallBudget`). `SizedCall` — the model, the tier, the estimate, the count, the cap that runs and its cut — is built once per call and read by the reservation, the decode and the settlement.
- `workspace-refusal.ts` — the refusal of a workspace path the validation rejects (`<tool>: <message>`), the first step of `ask`, `code`, `ask_agentic` and `reindex`.
- `eager-answer.ts` — the answer of both tools: the request builder's rule (`RequestBuilder`: on a cached context no `systemInstruction`, `tools` or `toolConfig`), the context (`prepareCallContext`, whose `prepare` the stale-cache retry calls again), the decode (`decodeEagerCall`, over `decodeOnContext`), the settlement (`settleDecoded`: the trail's reservation and the decode's entry cleared before the booking), the truncated-scan warning and the scan's result fields (`scanFields`). Every result is built by its own tool, in its own field order.
- `service-tier.ts` — the tier of a call (`serviceTierOrRefusal`: the tier, or the `ServiceTierError` each tool reports with its own fields), its `GenerateContentConfig` field, the network attempts it allows and the error codes of a refused request.

### `src/tools/ask/`

The modules of `ask`. `src/tools/ask.tool.ts` is the entry: the registration and the call — opened, its stage steps run in order (each goes on with the next stage or ends the call), the failure result, closed. The call grows through typed stages (`call.ts`); a step's outcome is the next stage, the result that ends the call, or the `ask_agentic` fallback handed back still pending, which the entry returns unawaited.

- `input.ts` — the input schema and its type (the entry re-exports both).
- `instruction.ts` — the system instruction, read by the attachments' size refusal and by the request.
- `call.ts` — the stages (`AskCall` → `AskResolved` → `AskAttached` → `AskScanned` → `AskCounted` → `AskSized`) and the attachments they carry (`PreparedAttachments`).
- `setup.ts` — `resolveAsk` (the model and its tier, written to the call's failure trail) and `scanAsk` (the scan, the thinking-budget refusal, the input estimate, the inline-size refusal).
- `attachments.ts` — `attachAsk` (the attachments inspected, read and counted before anything is reserved), the inline-size refusal and the attachments' result fields.
- `guard.ts` — `guardAsk`: the count held against the window; over it, the refusal or the fallback.
- `sizing.ts` — `sizeAsk`: the cap that runs, the thinking under it, the daily-budget reservation.
- `thinking.ts` — the caller's thinking normalised (`AskThinking`: a level, the model's default, or a budget clamped under the cap that runs), its wire config (the level's through `levelThinkingConfig`, `shared/thinking.ts`, which `code` and `ask_agentic` read too), the budget the result reports and the progress line.
- `request.ts` — the request on a prepared context, with a cache or inline.
- `answer.ts` — `answerAsk`: the context, the decode, the settlement, the result.
- `results.ts` — every result from the reservation on and the failed call's, in `ask`'s field order.

`code` runs the same shared pieces through its own steps in `src/tools/code.tool.ts` (`resolveCode`, `guardCode`, `sizeCode`, `answerCode`, `codeRequest`, `codeArtifacts`, `codeAnswerResult`, `codeFailedResult`); it parses its artefacts before the settlement.

### `src/tools/agentic/`

The modules of `ask_agentic`. `src/tools/ask-agentic.tool.ts` is the entry: the registration and the call — the workspace opened, the model resolved, the loop run, then the forced-finalization pass when the loop ran out of iterations. `src/tools/ask-agentic-fallback.ts` is `ask`'s fallback to it: `ask`'s knobs forwarded, the result wrapped.

- `input.ts` — the input schema and its type (the entry re-exports both); the question and workspace fields are `shared/question-fields.ts`, shared with `ask`.
- `run.ts` — the typed state of one call: `AgenticRun` (the model, the limits, the request config, what each pass's reservation is priced from, the knobs resolved once and the knob names its messages give) and `LoopState` (the conversation and what the loop accumulates); the defaults (20 iterations, 1,000,000 input tokens, 40 files).
- `pass-clock.ts` — the one clock of a pass (a loop iteration or the forced pass): `iterationTimeoutMs` over every phase, `stallMs` between a stream's chunks, a phase's default (`phase-defaults.ts`) where no knob bounds it — the tools phase's a bound on silence that the executors' progress defers (`recordProgress`); at most two timers; the abort reason names the phase and the bound that fired, and `passTimeoutOf` names a timeout the clock did not raise `external`.
- `phase-defaults.ts` — the default bound of each phase, each with its reason.
- `loop.ts` — the iteration loop: per iteration a daily-budget reservation, a pass clock, a TPM reservation, the iteration, its settlement, then the guards that end the loop — the answer, the cumulative input-token budget, the no-progress detector.
- `iteration.ts` — one iteration: the streamed `generateContent`, the `maxFilesRead` cap on `read_file` calls, the parallel tool batch raced as one tools phase against the clock, and the tool responses appended to the conversation in call order only when that phase answered.
- `dispatch.ts` — the dispatcher: one executor per tool name, an executor's failure returned to the model as a recoverable `response.error`, up to `GEMINI_CODE_CONTEXT_AGENTIC_TOOL_CONCURRENCY` calls at once (default 10); a worker takes no call once the pass's signal fired, and each executor gets the pass's `ToolWatch` — its signal and its progress report, read together at every `checkpoint` (`workspace-tools.ts`).
- `rescue.ts` — the forced-finalization pass: one `generateContent` with function calling disabled, its reservations sized from the last iteration, and the class of its failure (`rescueErrorCode`).
- `ledger.ts` — the budget ledger and TPM throttle calls: each pass reserves, then books what it billed through `recordBilledCall` (`shared/call-ledger.ts`, the rule of `ask` and `code`: the reservation finalised under a daily cap, a usage row without one) and releases its TPM reservation at the same input — the estimate when the response carried no usage — or cancels both when the pass never reached Google.
- `no-progress.ts` — the no-progress detector: a call signature repeated five times with no new file read between the repeats.
- `results.ts` — every result once the loop has started: the answer (organic or forced) and the errors that end the loop, each with `apiCalls`.
- `response.ts` — what a model response carries, read the same way for an iteration and for the finalization pass: its token counts and its thought summary.
- `instructions.ts` — the system instructions of the loop and of the finalization pass, and the four tool declarations.
- `sandbox.ts` and `workspace-tools.ts` — the workspace jail and the four executors (`list_directory`, `find_files`, `read_file`, `grep`); `find_files` and `grep` share one walk, which passes a checkpoint — the abort signal read, progress reported — at every directory and entry.

### `src/indexer/`

Walks a workspace directory:

- `globs.ts` holds curated include/exclude patterns (source-code extensions in, `node_modules`/`.git`/etc. out).
- `hasher.ts` produces sha256 per file with an in-memory cache keyed by `(path, mtime, size)` to avoid re-reading unchanged files.
- `workspace-scanner.ts` recursively walks, filters, hashes, and returns a `ScanResult` with a stable `filesHash`.

### `src/cache/`

The magic:

- `files-uploader.ts` (explicit `cachingMode` only) uploads scanned files to the Gemini Files API, deduping by content hash against the manifest. Files API enforces a 48 h auto-delete; we track `expires_at = uploaded_at + 47 h` for a safety margin.
- `cache-manager.ts` creates Gemini Context Caches keyed by `(workspaceRoot, filesHash, model, systemPromptHash)`. Falls back to inline file parts when caching isn't supported or the API rejects the build.
- `ttl-watcher.ts` runs a 5-minute tick. Hot workspaces (used in the last 10 minutes) get their cache TTL refreshed via `caches.update`. Cold workspaces expire. `keepAlive` refreshes before a request on the request path, best-effort: one refresh runs per cache name at a time (the tick and every keep-alive join it, each waiter under its own abort signal), the expiry the API answered is written to the row as it stands after the round-trip, and a failed refresh or manifest read or write is logged — only the calling request's abort reaches the caller.

### `src/manifest/`

`better-sqlite3` in WAL mode. Single-file schema with workspaces / files / usage_metrics tables. Transactional, no daemon, no network. The schema is inlined in `db.ts`; `schema.sql` is the human-readable source of truth.

### `src/tools/`

Six MCP tools, each validated by a Zod schema and wired into the registry ([tools.md](tools.md)):

- **`ask`** — Q&A, long-context analysis. Uses cache.
- **`ask_agentic`** — the same question answered by a sandboxed file-reading loop, for a workspace too large to send whole.
- **`code`** — coding delegation. Enables `thinkingConfig` + optional `codeExecution`. Parses OLD/NEW diff output so Claude Code can apply edits.
- **`status`** — inspection tool. Lists available models, cache state, usage/cost.
- **`reindex`** — force rebuild the cache (skip hash-diff optimization).
- **`clear`** — drop cache + manifest for a workspace.

### `src/server.ts` + `src/index.ts`

Standard MCP stdio bootstrap:

- `ListToolsRequestSchema` → returns `TOOLS.map(t => { name, title, description, inputSchema: buildToolInputSchema(t) })`
- `CallToolRequestSchema` → parses args through Zod, constructs a `ToolContext`, awaits `tool.execute`
- SIGINT/SIGTERM → graceful shutdown: stop TTL watcher, close DB, close MCP server
- Entrypoint dispatches `init` subcommand vs server mode

## Design choices worth calling out

- **SDK over CLI.** Original plan wrapped the `gemini` CLI. Three LLM consultations (GPT-5.3-codex, Gemini 3.1 Pro, Grok 4.20-reasoning) agreed this was fragile: subprocess overhead, brittle headless auth, no connection pooling, and `@file` syntax we'd have to replicate anyway. SDK gives us direct access to Files API + Caches primitives which are the actual moat.
- **Local-only state.** The manifest DB never leaves the user's machine. Zero telemetry by default.
- **exactOptionalPropertyTypes.** TypeScript strict mode including `exactOptionalPropertyTypes` is on. Optional fields are either present or omitted, never `undefined`. Surfaces real bugs at the cost of more precise type gymnastics at the SDK boundary.
- **No Dockerfile.** Node 22 + better-sqlite3 native module + MCP stdio transport do not play well inside a container from Claude Code's perspective. `npx` installs in one line; that's the right primitive.
- **Zod at the boundary, not internally.** We trust our own types once they've crossed the MCP boundary.
