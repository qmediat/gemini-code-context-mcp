# Changelog

All notable changes to `@qmediat.io/gemini-code-context-mcp` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] — 2026-04-20

**Model taxonomy — allowlist-first category system.** The v1.2.0–v1.3.2 defence against `nano-banana-pro-preview` (image-gen) resolving to `latest-pro-thinking` was a reactive substring blocklist (`NON_TEXT_GEN_MARKERS = ['banana', 'lyria', 'research', ...]`). Every new non-text-gen family Google shipped under a `pro` / `flash` token required a patch release. v1.4.0 flips the model: each model ID is matched against an explicit rule set that assigns one of nine functional categories (`text-reasoning`, `text-fast`, `text-lite`, `image-generation`, `audio-generation`, `video-generation`, `embedding`, `agent`, `unknown`). Tools declare a required category; the resolver refuses to dispatch outside that set. Unknown families land in `unknown` and are excluded from every alias until the taxonomy is extended — forcing a conscious patch release rather than silent admission.

**Why this is a minor bump (1.4.0 not 1.3.3)**: the `ResolvedModel` type exported from `src/types.ts` gains two required fields (`category`, `capabilities`). Internal consumers compile cleanly; external TS consumers (none documented) would see the addition as type-surface widening. Runtime behaviour is strictly safer — existing aliases work identically for legitimate use, and the only callers that see new behaviour are those passing an image-gen / audio-gen model ID where a text-gen model was expected (pre-v1.4.0 silently dispatched; now throws `ModelCategoryMismatchError` with an actionable message).

### Added

- **`src/gemini/model-taxonomy.ts`** — new module with `ModelCategory` type, `CATEGORY_RULES` ordered pattern-allowlist, `categorizeModel(id)`, `extractCapabilityFlags(id, sdkMeta)`, `costTierOf(id)`, `isTextGenCategory(cat)`, and the exported `ModelCategoryMismatchError` class with actionable message pointing at `docs/models.md`.
- **`latest-vision` alias** — picks the newest vision-capable text model (prefers `text-reasoning`, falls back to `text-fast`). Previously users needed to know a specific Gemini 2.5 / 3 Pro model ID for screenshot analysis.
- **New response metadata fields** on `ask` / `code` structured content: `modelCategory` (string) and `modelCostTier` (`premium` | `standard` | `budget` | `unknown`). Use these for billing dashboards or to verify that an alias resolved to what you expected.
- **New docs — [`docs/models.md`](./docs/models.md)** — complete guide: category table with descriptions, alias contract, usage examples (code review, quick Q&A, vision analysis, explicit model IDs), failure-mode walkthroughs (wrong category error, unknown future family error), and the "when to extend the taxonomy" maintainer note.
- **48 new unit tests** (`test/unit/model-taxonomy.test.ts`) covering every current Gemini model's expected categorisation, precedence rules (the core invariant — `nano-banana-pro-preview` must resolve to `image-generation`, not `text-reasoning`), `unknown` fallback for future families, `costTierOf` + `extractCapabilityFlags` paths, and `ModelCategoryMismatchError` shape.
- **9 new resolver tests** in `test/unit/models.test.ts` covering v1.4.0 contract: `ResolvedModel` carries `category` + `capabilities`, `requiredCategory` rejects literal model IDs in the wrong category, alias path enforces category too, `latest-vision` picks vision-capable, `latest-lite` binds strictly to budget tier, unknown-category explicit ID throws under required-category gate, + `describeAlias` / `listAliases` public API tests.

### Changed

- **`ResolvedModel` interface** (`src/types.ts`) gains `category: ModelCategory` and `capabilities: CapabilityFlags` required fields. Populated by `src/gemini/models.ts`'s `resolveModel` via `src/gemini/model-taxonomy.ts`.
- **`resolveModel(requested, client, opts?)`** (`src/gemini/models.ts`) accepts `opts.requiredCategory: readonly ModelCategory[]` — the set of categories this call-site accepts. Throws `ModelCategoryMismatchError` if the resolved model (alias-picked or literal) falls outside that set. Tools pass this parameter:
  - `ask.tool.ts` → `['text-reasoning', 'text-fast', 'text-lite']` (any text tier)
  - `code.tool.ts` → `['text-reasoning']` (strictest; coding benefits from reasoning tokens and we refuse to dispatch to fast/lite tiers for correctness)
- **Literal model ID fallback removed** — pre-v1.4.0, passing a literal ID that wasn't in the API-key's registry silently swapped to `latest-pro`, which could resolve to an image-gen model. v1.4.0 throws a clear error instead: `Model 'X' is not available for this API key. Pass an alias (…) or a literal ID available on your tier (…). See docs/models.md.`
- **Alias fallback across categories removed** — pre-v1.4.0, if `latest-pro-thinking` found nothing, it fell back to `latest-pro` → `latest-flash` → `latest-lite` → first model. This meant a registry with only image-gen pro models would return an image model for a code-review alias. v1.4.0 throws a clear error naming the required category and listing available categories for the API key.
- **Existing blocklist `NON_TEXT_GEN_MARKERS`** retained as belt-and-suspenders defence — runs AFTER categorisation. If a taxonomy rule erroneously classifies a model as text-gen but its ID matches a blocklist marker, the resolver logs and demotes it to `unknown`. Empirically fired once during testing for `gemini-2.5-flash-native-audio-preview-09-2025` (flash-token + audio-suffix combo); that pattern has since been added to the primary taxonomy rule set, so the belt-and-suspenders should no longer fire under the current model lineup.
- **New native-audio rule** in the taxonomy: `gemini-*-native-audio-*` → `audio-generation`. Surfaced by the belt-and-suspenders path during Phase 3 integration testing.
- **`docs/configuration.md`** alias table updated with category column and a link to the new `docs/models.md`.
- **`README.md`** gains an "Model aliases (v1.4.0+)" block explaining the category safety property.

### Reviewer notes (not a code change)

- Implemented in five phases (taxonomy → resolver refactor → tool integration → docs → validate/PR), each locked behind user review checkpoint per global `CLAUDE.md` phase-by-phase rule.
- The allowlist-first design was chosen explicitly over the v1.2.0–v1.3.2 reactive blocklist after the user flagged the core concern: "never let `nano-banana` do my code review". Blocklists catch *known* offenders; allowlists refuse *everything unknown*. Google shipping a new `pro`-token image-gen family that we haven't classified is now a `HARD ERROR` with a clear upgrade path, not a silent pricing surprise.
- Belt-and-suspenders `NON_TEXT_GEN_MARKERS` blocklist retained even though the taxonomy is primary — shouldn't fire in practice, catches taxonomy bugs before they reach production.

## [1.3.2] — 2026-04-20

Security-flavoured hotfix closing hint-poisoning attack surface flagged in PR #20 (v1.3.1) multi-round review. **Two review rounds on this hotfix itself** (PR #21 round-1 + round-2) refined the gate design — the initial substring fallback was itself bypassable and got tightened to prototype-based SDK provenance. `/6step` verified all findings closed end-to-end against a real `@google/genai` `ApiError` instance.

### Fixed

- **Retry-hint poisoning closed via SDK-provenance gate.** `parseRetryDelayMs` was called on EVERY `Error.message` that reached `ask`/`code` catch blocks in v1.3.1 — not gated to confirmed Gemini 429s. A user-controlled prompt containing the literal substring `"retryDelay":"60s"` echoed into any non-429 error body (safety filter, validation rejection, log re-serialisation) would seed the per-model throttle at the clamp ceiling and self-DoS the MCP server for the rest of its process lifetime. v1.3.2 gates the parser behind a new exported `isGemini429(err)` type-guard that requires BOTH `err instanceof ApiError` (prototype-chain identity — class only instantiated by `@google/genai`'s `throwErrorIfNotOK` from real HTTP responses) AND `err.status === 429` (typed field, strict equality — rejects stringified `"429"` from buggy wrappers). User-controlled content cannot forge either marker from prompt-string input. An earlier draft with a `/RESOURCE_EXHAUSTED/` substring fallback was itself flagged by GPT + Grok as bypassable (attacker injects both markers) and removed before merge. GPT + Grok both CRITICAL on round-1, both confirmed closed on round-2.
- **Escaped-JSON form now extracted.** `parseRetryDelayMs` previously required bare-quoted `"retryDelay":"Ns"` in the error message. Empirically verified that the common `@google/genai` SDK path produces bare quotes via `JSON.stringify(errorBody)` in `throwErrorIfNotOK`, so real 429s from `generativelanguage.googleapis.com` / Vertex `aiplatform.googleapis.com` match directly — regardless of which auth tier constructed the client (`apiKey` vs `vertexai` paths share the same error-handling code). BUT: the non-JSON content-type branch of `throwErrorIfNotOK` wraps raw text body into `{error: {message: "<raw-text>"}}` before stringifying, ESCAPING any literal `"retryDelay":"Ns"` substring inside — a narrow path hit when a corporate proxy / MITM / Cloudflare edge returns an HTML 429 page instead of the upstream JSON. The parser now unescapes once on fallback (`errorMessage.replace(/\\"/g, '"')`) when `\\"` is present, and re-runs the regex. Bare-form common path unchanged (no allocation). `/6step` verdict: LOW TP — safe direction even if missed (falls back to pure-window math, no quota overshoot). With the prototype gate above, user-controlled content can't reach the parser regardless of escape form.
- **Test comment correctness** — `"returns null on negative / zero values"` now documents that `"-1s"` fails at the regex stage (the `\d+` class rejects leading `-`) while `"0s"` fails via the `seconds <= 0` guard. Two different reject paths converging on `null`. Grok NIT.

### Added

- **`isGemini429(err): err is ApiError`** — type-guard exported from `src/tools/shared/throttle.ts`. Imports `ApiError` from `@google/genai`. Narrows `err` to `ApiError` in call-site catch blocks, eliminating the `(err as Error).message` cast that appeared in an earlier draft.
- **11 new unit tests** covering: `parseRetryDelayMs` escaped form + mixed bare/escaped tie-break, 7 `isGemini429` cases (real ApiError-429, non-ApiError wrapper with forged status=429, plain Error with RESOURCE_EXHAUSTED substring, ApiError with non-429 status, user-controlled poisoning attempt with both markers, non-Error values, ApiError with non-number status).
- **8 new integration tests across `ask` + `code`** — both tool files now cover the full bypass-guard surface: real ApiError 429 → hint seeded; plain Error with RESOURCE_EXHAUSTED substring → NO hint (gate tightened, substring path removed); combined-marker poisoning attempt (RESOURCE_EXHAUSTED + retryDelay substring in non-429 error) → NO hint; custom Object.assign wrapper with forged status=429 → NO hint; ApiError with non-429 status + retryDelay in body → NO hint.

### Tests

- 77 throttle-family tests (up from 56 in v1.3.1: 9 `parseRetryDelayMs` + 11 `parseRetryDelayMs` extended cases + 7 `isGemini429` + 40 core throttle + 15 integration = 77). Exact count may vary with jitter randomness.
- 221 total PR tests (up from 205 in v1.3.1). Lint + typecheck + build all green on Node 22.

### Reviewer notes (not a code change)

**Round-1 on PR #21** (tightening's first draft): GPT `gpt-5.3-codex` + Grok `grok-4.20-beta-0309-reasoning` both flagged the `RESOURCE_EXHAUSTED` substring fallback as itself bypassable — attacker injecting BOTH markers (`RESOURCE_EXHAUSTED` + `"retryDelay":"60s"`) reopened the same poisoning class the gate was meant to close. Grok additionally flagged missing word boundaries, brittle escape-fallback on double-escape, and the type-guard regression risk from the `(err as Error)` cast.

**Round-2 response**: tightened `isGemini429` to require `err instanceof ApiError` (class imported from `@google/genai`) AND `err.status === 429`. Substring fallback REMOVED entirely. Cast eliminated via type-guard signature. Prototype check is not forgeable from user-controlled string input — closes both bypass classes. Copilot's round-2 queue did not return in the review window; 2-of-2 available reviewers (GPT + Grok) on round-1 + `/6step` on round-2 tightening provided sufficient signal.

**Not fixed (documented as accepted)**:
- Numeric / protobuf retry-delay forms (`"retryDelay":5`, `{"seconds":5,"nanos":0}`). Not observed in Gemini REST API output per AIP-140 (`"Ns"` string form mandated). Future-proof; defer.
- Integration mock fidelity drift. Hand-written shapes for `scanWorkspace` / `resolveModel` / `prepareContext` leaf mocks. Follow-up: replace `as Type[...]` casts with `satisfies` to force compile-time drift detection.
- `TextToolResult` type narrowing as minor API surface change. Runtime-safe; external TS consumers (none known) get narrower field type, not break.
- Disabled-throttle path still runs `parseRetryDelayMs` on every catch — `recordRetryHint` itself no-ops when disabled so the result is discarded. Perf: microseconds. Not worth conditionalizing.

## [1.3.1] — 2026-04-20

Patch release closing the three LOW/NIT follow-ups deferred from v1.3.0's multi-round review cycle (T22a retry-hint wiring, T22b ask/code integration tests, T23a helper return-type narrowing). No user-visible API breaks; smallest possible diff that moves GPT's round-2 "still live" findings to closed.

### Added

- **T22a — Gemini 429 `retryInfo.retryDelay` feeds the TPM throttle.** New exported helper `parseRetryDelayMs(errorMessage: string): number | null` in `src/tools/shared/throttle.ts` extracts the retry-delay hint from `@google/genai`'s `ApiError.message` body (regex-based, tolerant of schema drift). Both `ask.tool.ts` and `code.tool.ts` catch blocks now call it and, on a successful parse, `ctx.throttle.recordRetryHint(resolvedModel, retryDelayMs)` BEFORE cancelling the reservation. Google's hint is typically 2–16s — shorter than our pure-window math would compute (up to 60s) — so honouring it shortens the next caller's wait when Gemini actually 429'd under our preflight. Clamped to `[1s, 60s]` for safety against malformed or future-format values.
- **T22b — ask/code throttle call-sequence regression tests.** New `test/unit/ask-throttle-integration.test.ts` (6 tests) and `test/unit/code-throttle-integration.test.ts` (5 tests). Mock the leaf dependencies (workspace-scanner, workspace-validation, cache-manager, resolveModel, Gemini client, manifest) and exercise `execute()` end-to-end to assert `ctx.throttle` call ordering for: happy path (`reserve → release`), non-stale error (`reserve → cancel`), stale-cache retry (`reserve → cancel → reserve → release` — the round-3 regression fix), 429 with retry-info (`reserve → recordRetryHint → cancel`), and disabled-throttle (no throttle calls). Locks in the v1.3.0 round-2/round-3 integration invariants so a future refactor can't silently regress them.

### Changed

- **T23a — `textResult` / `errorResult` return narrower `TextToolResult`** type (`ToolResult & { structuredContent: Record<string, unknown> }`). `ToolResult.structuredContent` stays optional on the interface (for any future caller that legitimately omits it), but the two standard helpers now advertise what they actually deliver. Consumers doing `result.structuredContent.responseText` no longer need an optional-chain to satisfy the type checker. Purely additive at the type level — runtime behaviour unchanged.
- `resolvedModelKey` is now captured in `ask.tool.ts` / `code.tool.ts` immediately after `resolveModel` so the outer catch's `recordRetryHint` call uses the SAME canonical model string that `reserve` used. Using the request alias (`"latest-pro-thinking"`) instead of the resolved ID (`"gemini-3-pro-preview"`) would seed the hint into a different per-model bucket than the one `reserve` consulted.

### Tests

- 50 throttle tests (up from 41 — 9 new `parseRetryDelayMs` tests covering integer-seconds, fractional-seconds, floor/ceil clamp, missing field, malformed body, negative/zero, empty/non-string input, and end-to-end seeding via `recordRetryHint`).
- 11 new integration tests across the two new test files above.
- Total PR tests: 196 (up from 185 in v1.3.0). Lint + typecheck + build all green on Node 22 (matching CI).

## [1.3.0] — 2026-04-20

Reviewer-workflow unblock release. Two fixes that turn the MCP from "works on the happy path" into "actually usable for back-to-back `/coderev`-style pipelines": a client-side TPM (tokens-per-minute) throttle preflight, and a wire-format fix that lets MCP sub-agents extract tool output text.

Without these, a second `ask` or `code` call against a workspace with ~100k cached tokens hit Gemini's Tier 1 paid quota of 100_000 input tokens/minute and 429'd the call after Google had already billed for it (per `@google/genai` SDK: "AbortSignal is a client-only operation … you will still be charged"). And any sub-agent orchestration that made decisions on tool response text silently saw empty output, because Claude Code (and other MCP hosts) consume only `structuredContent` when present — `content[0].text` was invisible on the sub-agent path, even though the main conversation UI rendered it fine.

### Added

- **`GEMINI_CODE_CONTEXT_TPM_THROTTLE_LIMIT` env var** (default `80_000`, `0` disables). Client-side tokens-per-minute ceiling per resolved model. `ask` and `code` now call `throttle.reserve(model, estimatedInputTokens)` after the daily-budget reservation but BEFORE `generateContent`; if the call would push the rolling 60-second window past the cap, the tool sleeps (emitting a `throttle: waiting Ns for TPM window…` progress message) before issuing the request. Default leaves ~20% headroom under the observed Tier 1 paid limit of 100_000 tokens/min for Gemini 3 Pro. Raise it on higher tiers, lower on shared quota pools, or set `0` to disable entirely (relies on Gemini's 429 behaviour alone). Cached tokens count toward this limit — empirically confirmed.
- **`src/tools/shared/throttle.ts`** — new shared module implementing the `reserve` / `release` / `cancel` reservation lifecycle. The primary API is reservation-based, not a read-only `shouldDelay` peek, because MCP's async `CallToolRequestSchema` handler dispatches concurrent tool calls — a peek-only API lets two callers observe the same pre-peek window and both proceed, collectively overshooting the cap. `reserve` inserts a provisional `WindowEntry` immediately at `now + delayMs` so concurrent reserves see each other's footprint. Multi-entry eviction math iterates oldest-first until remaining sum + estimate ≤ limit, then waits for the last-evicted entry to age out (the naïve "wait for just the oldest" implementation under-delays whenever ≥2 large entries remain in-window). Backward clock handled via a throttle-level `lastObservedNowMs` floor (using `entry.tsMs` for the clamp breaks multi-entry math when a future-dated provisional exists). Tests in `test/unit/throttle.test.ts` (33 cases, fake timers).
- **`RESPONSE_TEXT_KEY` constant** exported from `src/tools/registry.ts` — canonical key (`"responseText"`) under which MCP clients consuming `structuredContent` can reliably find the tool's primary narrative response. Consumers can `import { RESPONSE_TEXT_KEY }` rather than hard-coding the string.

### Fixed

- **Sub-agent tool-result extraction via `structuredContent.responseText`.** `textResult()` and `errorResult()` now always emit `structuredContent` with a `responseText` field mirroring the narrative string. The primary `content: [{type:'text', text}]` path stays for MCP spec compliance and for hosts (Claude Code's main conversation UI) that render it — duplicating a few-KB string across both surfaces costs effectively nothing vs losing the whole response on sub-agent paths that read only `structuredContent`. Before this fix, three reviewer-agent runs of `/coderev` against PR #17 returned "API success but text not surfaced" because Gemini generated the review text and we billed for it, but every downstream consumer (`reindex`, `clear`, `status`, `ask`, `code`) whose response shape included `structuredContent` shadowed `content[].text` on the sub-agent tool-result parser. 8 tests in `test/unit/registry-text-result.test.ts` lock in the invariant (both success and error paths, mirror-equality, caller-override semantics).
- **Error responses now surface detail to sub-agents.** `errorResult(message)` additionally sets `structuredContent.responseText = message` so orchestrations that make decisions on error text (e.g. "did the tool say `daily budget cap exceeded` vs `Gemini 500`?") can extract it. `isError: true` still signals failure; `responseText` carries detail. Parallel to the success-path fix.

### Changed

- **`ToolContext` gained a `throttle: TpmThrottle` field.** Per-server-process singleton instantiated in `runServer()` from `config.tpmThrottleLimit`. No caller-visible change — consumers that build a `ToolContext` directly (internal tests only) must add the field.

### Reviewer notes (not a code change)

- **Phase 1 of this PR was rewritten in response to a 3-way code review.** The original throttle design was a peek-only `shouldDelay` API with single-entry-eviction math. Grok (`grok-4.20-beta-0309-reasoning`) flagged two HIGH findings in `/coderev` + `/6step` analysis: (1) multi-entry eviction under-delays when ≥2 large entries remain in-window; (2) TOCTOU race between `shouldDelay` and `record` across the `await sleep()` + `await generateContent()` boundary. Both fixed before the module ever integrated with `ask`/`code`.
- **A second round of review on the integrated PR (Copilot + GPT `gpt-5.3-codex` + Grok + Gemini `gemini-3.1-pro-preview`) surfaced four more correctness fixes shipped in this release:**
  - **Sorted-array invariant** (Copilot + Grok + Gemini — HIGH). `reserve` previously used `push` to append; a `delayMs = 0` reservation arriving after a future-dated provisional (hint-driven or eviction-driven delay) produced a smaller `tsMs` than the provisional, leaving the array unsorted. `prune`'s head-only fast-path silently skipped expired entries buried mid-array (empirically demonstrated: `reserve(79999)` returned `delayMs=46000` when the correct answer was `0`). Fixed via binary-search `insertSortedByTsMs`. Three regression tests lock it in.
  - **Reserve timing pre-prepareContext** (GPT + Grok — MEDIUM). `reserve` was called BEFORE `prepareContext`, so on cold-cache calls (30–60s upload + `caches.create`) the reservation's `tsMs` aged out of our window before Gemini's per-minute quota counter caught up. Gap of ~30–60s where our throttle said "clear" but Gemini's didn't. Fixed by moving `reserve` to immediately before `generateContent`. Trade-off: two concurrent cold-cache callers both finish `prepareContext` before one backs off at `reserve` — mostly idempotent via file-hash dedup, minor upload duplication.
  - **Retry-hint extend-only** (Gemini — MEDIUM). `recordRetryHint` used to blindly overwrite any existing hint. A shorter hint replacing a longer one let the next reserve compute a smaller `tsMs` than entries appended under the longer hint — same ordering break as the sorted-insert fix, different trigger. `recordRetryHint` now keeps the longer expiry when both exist.
  - **Release lifecycle** (GPT — LOW). `release` previously left the reservation id in `reservationIndex`, so a late `cancel` on an already-released id silently removed an accounted entry from the window. `release` now deletes the id at the end, making double-`release` and `cancel`-after-`release` safe no-ops.
  - **Randomised jitter** (Gemini — LOW). The `JITTER_MS` constant was 2_000 ms — every concurrent waiter evicting the same entry computed an identical wait and woke at the same millisecond, re-creating the thundering herd the jitter was meant to avoid. Now randomised in `[1_000, 3_000]` ms via `computeJitterMs()`.
  - 7 new regression tests (40 total, up from 33) covering each of the above paths.
  - Disputed severity on the wire-format `structuredContent` always-emit (Grok CRITICAL / Gemini acceptable / GPT nit / self-review LOW). No observable MCP-host break was constructed; shipping as-is with the additive-only semantics called out in `### Fixed` above.
- **Retry-hint parsing from Gemini 429 response bodies (`retryInfo.retryDelay`) is a follow-up (T22a).** The throttle module exposes `recordRetryHint(model, retryDelayMs)` but this PR does NOT wire it up from the `ask`/`code` catch blocks — the preflight `reserve` path delivers ~95% of the value, and parsing the retry hint out of `@google/genai`'s error message text is unstructured and brittle without a dedicated harness.
- **A third round of review (same 4 reviewers, commit `c097ad9`) surfaced one more correctness fix and four cosmetic cleanups — all shipped in this release:**
  - **Stale-cache retry re-reservation** (GPT — MEDIUM). The round-2 fix moved `reserve` to after `prepareContext` for first dispatch, but the stale-cache retry branch was still reusing the original reservation — whose `tsMs` was stamped before the first (failed) dispatch. After the ~15s rebuild, the retry's tokens hit Gemini's quota counter at a time our window already had tagged as "expired soon". 15s gap re-introduced. Fixed by extracting `reserveForDispatch()` helper and calling `cancel + reserveForDispatch` inside the stale-cache retry branch before the second `generateContent`. Symmetric in `ask.tool.ts` and `code.tool.ts`. New throttle-level regression test locks it in.
  - **`shouldDelay` pure vs jittered split** (Gemini — LOW). Previously `shouldDelay` inherited the random jitter from `computeWindowDelay`, so diagnostic polling saw bouncing values for unchanged state. Split into `computeWindowDelayPure` (used by `shouldDelay`) and `computeWindowDelay` (used by `reserve`, applies jitter only when actual waiting is needed).
  - **`computeJitterMs()` range now `[1000, 3000]` inclusive** (Copilot — NIT). Previous formula `Math.floor(Math.random() * (MAX - MIN))` capped at 2999; `+ 1` in the multiplier width makes `JITTER_MAX_MS` reachable. Docstring + test comment aligned.
  - **Explicit shorter-hint no-op assertion** (Grok — NIT). Added a direct `expect(r2.delayMs).toBeGreaterThan(5_000)` to the existing downgrade test so the extend-only semantics are guarded by a boolean invariant, not just an implicit delay range.
  - Deferred to follow-ups (T22b, T23a — see `docs/FOLLOW-UP-PRS.md`): ask/code integration tests + `ToolResult.structuredContent` type narrowing. Both are LOW/NIT; no blockers.
  - Disputed-severity items held as-shipped: wire-format `textResult` always-emit `structuredContent` (Grok CRITICAL vs 3-of-4 acceptable — no observable MCP-host break, ship additive-only with CHANGELOG callout); reserve-after-prepareContext cold-cache duplication (Grok CRITICAL vs documented trade-off — `prepareContext` coalesces via per-workspace mutex, so real duplication is minor).
  - FPs confirmed by `/6step`: forward NTP leaps (Grok agrees FP), early-validation cancel leak (`-1` sentinel covers all paths), `sanitizeTokens` daily-budget path (scan + Zod + reserve-internal sanitize suffice), `finally` around cancel (no unguarded `return` between reserve and release).
  - 41 throttle tests total (up from 40 in round-2) — new stale-cache-retry regression. 185 total PR tests (up from 184). Lint + typecheck + build all green.

## [1.2.0] — 2026-04-20

Reasoning-control release. Two big additions + one security fix. The `ask` and `code` tools now support Google's full Gemini 3 reasoning surface: discrete-tier `thinkingLevel` (MINIMAL/LOW/MEDIUM/HIGH, Google's recommended knob on 3.x) alongside the existing `thinkingBudget` integer. The two knobs are mutually exclusive at the schema boundary (Gemini rejects the combination with 400 anyway). `ask` also gets dynamic-thinking by default — omitting both fields makes the model use its native default path (HIGH on Gemini 3 Pro) rather than the "legacy" explicit-budget path Google flags as "may result in unexpected performance". And the model-alias resolver now rejects non-text-gen `pro` families (nano-banana image-gen, lyria music-gen, deep-research agent, customtools variant) that were sneaking in under the `latest-pro` alias and routing text requests through the image-tier quota bucket.

Security-critical fix: `validateWorkspacePath` now refuses the user's home directory as a workspace. Previously, a tool call omitting the `workspace` argument fell through to `process.cwd() === $HOME` (the canonical MCP launch pattern sets cwd to home) and passed the cwd-ancestry check — so the scanner would recursively walk `Desktop`, `Documents`, `Downloads`, `.Trash`, and upload matched files to the Gemini Files API. Home is now explicitly rejected with an actionable error, and `DEFAULT_EXCLUDE_DIRS` expanded with home-level user directories as defense in depth.

### Security

- **`validateWorkspacePath` now refuses the user's home directory as a workspace.** The canonical MCP launch pattern sets `cwd: $HOME` (to sidestep an `npx`-in-same-repo conflict documented in the README). Before this fix, an `ask`/`code`/`reindex` call that omitted the `workspace` argument fell through to `process.cwd() === $HOME` and PASSED the existing cwd-ancestry check — so the scanner would recursively walk `Desktop`, `Documents`, `Downloads`, `.Trash`, and everything else under `$HOME`, uploading matched files to the Gemini Files API. The guard now canonicalises both `workspaceRoot` and `os.homedir()` via `realpathSync` and refuses any path whose canonical form equals the canonical home directory — regardless of whether home happens to contain a `.git` or other workspace marker, and regardless of symlink bypass attempts. Error message tells the caller explicitly to pass `workspace` with a real project root. Orthogonal defense in depth: `DEFAULT_EXCLUDE_DIRS` now excludes `.Trash`, `Trash` (Linux), `Library` (macOS), `Downloads`, `Desktop`, `Documents`, `Movies`, `Music`, `Pictures`, `Videos`, and `Public` — so even an edge-case path that bypasses the root guard can't exfiltrate those directories' contents. 4 regression tests added under `test/unit/workspace-validation.test.ts` → "refuses the user's home directory as a workspace".

### Added

- **`code({ thinkingLevel })` parameter** — T21 ships `thinkingLevel` (`MINIMAL` / `LOW` / `MEDIUM` / `HIGH`) on the `code` tool, matching the `ask` surface from v1.2. Google's recommended reasoning knob on Gemini 3 (ai.google.dev/gemini-api/docs/gemini-3); `thinkingBudget` remains the legacy/Gemini-2.5 path, and the two are mutually exclusive (Zod `.refine()` refuses both-set at the schema root with the same cross-field error ask uses). `code` keeps its pre-existing `thinkingBudget` default of 16_384 — coding tasks benefit from strong reasoning out of the box, and changing that default would be a behavioural break for existing callers.
- **`src/tools/shared/thinking.ts`** — new shared module hosting `THINKING_LEVELS` and `THINKING_LEVEL_RESERVE`, moved out of `ask.tool.ts`. Single source of truth for both tools. When Google publishes per-tier token budgets (or ships a new level), one edit propagates to `ask` + `code` and any future reasoning-capable tool we add (e.g. when T19/T20 land).

### Changed

- **`code`'s structured metadata now echoes `thinkingLevel`** (null when the caller used `thinkingBudget` instead), alongside the existing `thinkingBudget` field. Callers can audit which path the request took — mirrors `ask`'s metadata shape.

### Fixed (post-review on PR #17)

- **`code` metadata `thinkingBudget` now reports `null` on the `thinkingLevel` path** (was `0`). Three reviewers flagged this: GPT, Copilot, and self-review all noted that `0` is the wire sentinel for "thinking disabled" and emitting it for a level-path call misleads audit / dashboard consumers who aggregate by `thinkingBudget === 0`. The fix mirrors `ask`'s behaviour — when `usingThinkingLevel` is true, the metadata field is `null`, consistent with the `thinkingLevel` sibling field's null-when-unused convention.
- **Tier-reserve defensive clamp against `maxOutputTokens - 1024`** — fixed-value tier reserves (MINIMAL=512, LOW=2048, MEDIUM=4096) now clamp against the dynamic output headroom before being passed into `estimatePreCallCostUsd`. No impact on today's Gemini model lineup (all current text-gen models have `outputTokenLimit ≥ 8_192`), but prevents a future small-cap model from producing an over-reserved budget estimate that could false-reject calls on `GEMINI_DAILY_BUDGET_USD`. PR #17 self-review F2.

### Reviewer notes (PR #17, not a code change)

- **Grok flag "unsafe `input.thinkingLevel as ThinkingLevel` cast" — confirmed FALSE POSITIVE by three exploit attempts in `/6step` analysis.** The cast preserves the literal string all the way to Gemini's wire. If `@google/genai` renames an enum member in a future release, TypeScript rejects the cast at `tsc` time (string-enum value mismatch); if Google silently changes the backend enum encoding (e.g. string → numeric), Gemini returns a 400 with a clear message. No scenario produces silent `undefined`. The rationale is documented in an inline comment at `src/tools/code.tool.ts:303-307` — kept as-is. This is the SAFER pattern vs runtime `ThinkingLevel[key]` lookup, which the `ask` tool adopted in v1.2 for the same reason.

### Changed (post-review polish on PR #16, `ask({ thinkingLevel })`)

- **Tier-aware cost-estimate reservations for `thinkingLevel`** — `MINIMAL` now reserves 512 thinking tokens, `LOW` 2_048, `MEDIUM` 4_096, `HIGH` the full `maxOutputTokens - 1024` dynamic cap. Replaces the previous always-worst-case behaviour that could false-reject long sequences of `MINIMAL`/`LOW` calls against `GEMINI_DAILY_BUDGET_USD` when the real spend was ≤1% of the reservation. Values are heuristic upper bounds (Google does not publish per-tier budgets). Exported as `THINKING_LEVEL_RESERVE` from `src/tools/ask.tool.ts` for testing and future reuse in `code.tool.ts` (tracked as T21).
- **`thinkingLevel` send-path uses a string cast, not an enum bracket lookup** — passing `input.thinkingLevel as ThinkingLevel` survives a future `@google/genai` enum-member rename: Gemini will 400 the literal string with a clear error instead of our code silently serialising `undefined`. Equivalent runtime behaviour on the current pinned `1.50.1`.
- **Mutual-exclusion error attaches at schema root** — `.refine()` now emits `path: []` (root-level) rather than `path: ['thinkingLevel']`, so MCP clients rendering per-field errors don't misattribute the cross-field violation to one of the two fields.
- **Single source of truth for `thinkingLevel` detection** — extracted `const usingThinkingLevel` to replace three identical `input.thinkingLevel !== undefined` checks (cost estimate, emitter, thinkingConfig build). Prevents future drift between the three branches.
- **Explicit `ThinkingConfig` type annotation on the built config** — catches a hypothetical future SDK field-shape change at `tsc` time rather than at runtime.

### Fixed

- **Model-alias resolution no longer picks up Google's non-text-gen `pro` families.** `nano-banana-pro-preview` (image generation) and `lyria-3-pro-preview` (music generation) both share the `pro` substring our `latest-pro` / `latest-pro-thinking` aliases matched on, and the live registry returns them *before* `gemini-pro-latest`. Pre-fix: `.find()` grabbed banana first, so every `ask`/`code` call resolved to an image-gen model — image-tier pricing (~10× text rates), 128k input cap, and hitting the `gemini-3-pro-image` quota after three calls. The exclude list now filters `banana`, `lyria`, `research` (Deep Research is a specialised agent, not a drop-in conversational model), and `customtools` (variant that errors without a `tools` param) across all four aliases. Existing `image`/`tts`/`vision`/`audio` filters kept. Extracted into a single `NON_TEXT_GEN_MARKERS` source of truth so future Google families land in one edit.

### Added

- **`ask({ thinkingBudget })` parameter** — optional integer in `[-1, 65_536]`. OMIT it (the default) to let each model use its native thinking tier — the recommended path, and the only one Google supports without caveats on Gemini 3 (which defaults to HIGH dynamic thinking on Pro). Pass an explicit value only when you need a specific cap: `-1` = legacy dynamic (Gemini 2.5 and older), `0` = disable thinking (rejected by Gemini 3 Pro), positive integer = fixed cap. Per Google's Gemini 3 guide, explicit `thinkingBudget` is "legacy" on the 3 family and "may result in unexpected performance"; our implementation therefore omits the field on the wire when the caller didn't supply one, sidestepping empirical hangs we reproduced on Gemini 3 Pro + cached content at low positive budgets (see `docs/KNOWN-DEFICITS.md`). Mirrors the knob `code` already exposed; closes the gap where `ask` had no way to control thinking at all.
- **Thinking summary surfaced on the MCP response** — `ask` always sets `includeThoughts: true` on the Gemini request, so when the model emits parts flagged `thought: true` we include a trimmed (~1.2 KB) `thinkingSummary` field in structured metadata. Works with or without an explicit `thinkingBudget`.
- **`ask({ thinkingLevel })` parameter** — discrete reasoning tier (`MINIMAL` | `LOW` | `MEDIUM` | `HIGH`) matching Gemini 3's native `thinking_level` API (ai.google.dev/gemini-api/docs/gemini-3). This is **Google's recommended knob** on the Gemini 3 family; `thinkingBudget` is the legacy escape hatch for Gemini 2.5 compatibility. The two parameters are **mutually exclusive** — Gemini rejects requests that set both with `400 ("cannot use both thinking_level and the legacy thinking_budget parameter")`, so we refuse the combination at the schema boundary with a clear Zod error. Callers now have three ways to control reasoning: omit both (model-native default, recommended), set `thinkingLevel` (discrete tier for Gemini 3), or set `thinkingBudget` (fine-grained cap for Gemini 2.5 or cost-bounded sessions). The `thinkingLevel` field is surfaced in structured metadata alongside `thinkingBudget` so callers can audit which path was taken. Unsupported values on a given model (e.g. `MINIMAL` on Gemini 3 Pro, any level on Gemini 2.5) are rejected by Gemini at request time — we deliberately do not hard-code per-model validation so the MCP surface stays stable across model rollouts.

### Changed

- **Default model is now `latest-pro-thinking`** (was `latest-pro`). The alias resolver already preferred the newest Pro-class model with `supportsThinking: true`, but the server default didn't opt into it — so `ask` landed on non-thinking models unless callers passed `model: "latest-pro-thinking"` explicitly. New default means `ask` and `code` both reason at full strength out of the box. Override via `GEMINI_CODE_CONTEXT_DEFAULT_MODEL=latest-pro` if you need the non-thinking variant, or set a flash alias for cost-sensitive workloads.
- **Budget reservation is thinking-aware** — `ask` now passes `thinkingTokens` into `estimatePreCallCostUsd`, mirroring `code`. Because Gemini 3 Pro always spends thinking tokens (cannot be disabled per Google's docs), reservations for callers who omit `thinkingBudget` still reserve the full `maxOutputTokens - 1024` as reasoning headroom — so `GEMINI_DAILY_BUDGET_USD` stays a TRUE upper bound regardless of which thinking tier the model picks. Without this, a high-thinking call could silently overshoot the cap; now it fails fast with the standard budget-cap message.

## [1.0.3] — 2026-04-19

Security + cost-correctness release. Closes a HIGH-severity prompt-injection vector that let a malicious MCP client exfiltrate local files via the `workspace` argument, and a MEDIUM-severity TOCTOU race that let concurrent tool calls collectively overshoot `GEMINI_DAILY_BUDGET_USD`. Also bundles drift-guards and hardening surfaced by a full 3-way code review (GPT, Gemini, Grok) plus three Copilot review rounds. No breaking changes — all existing workspace paths under the MCP host's cwd continue to work without any config.

### Security

- **Workspace-path validation** — tools that scan the filesystem (`ask`, `code`, `reindex`) now require the `workspace` argument to either be a descendant of the MCP host's cwd OR contain a recognised workspace marker (`.git`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, …). Without this, a prompt-injected MCP client could redirect the indexer at `$HOME` or `/etc` and exfiltrate local files through the Files API upload path. Escape hatch: `GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE=true` for genuinely unconventional roots.
- **Secret-bearing directories excluded by default** — `DEFAULT_EXCLUDE_DIRS` now refuses to traverse `.ssh`, `.aws`, `.gnupg`, `.gpg`, `.kube`, `.docker`, `.1password`, `.pki`, `.gcloud`, `.azure`, `.config/gcloud`, `.config/azure`, and macOS `Keychains`. `DEFAULT_EXCLUDE_FILE_NAMES` adds `.netrc`, `.pypirc`, `.npmrc`, `.pgpass`, `.git-credentials`, and `credentials`. Defense in depth on top of workspace validation — even if a caller bypasses the root check, these directories never get walked.

### Fixed

- **Files API uploads released on cache invalidation** — `invalidateWorkspaceCache` (`reindex` and `clear` tool paths) now walks the `files` table and calls `client.files.delete` on each uploaded `fileId` through a bounded parallel pool before dropping the manifest rows. Previously the uploads lingered for 48 h on Google's side as billable storage invisible to our `status` cost report. Gemini's 48 h auto-delete remains the backstop for individual `files.delete` failures.
- **Budget cap is now atomic under concurrent calls** — the pre-v1.0.3 flow was a classic read-then-act race: N concurrent tool calls could all read the same "spent" snapshot, all pass the cap check, all proceed, and collectively overshoot by N × per-call cost. `ManifestDb.reserveBudget()` now runs the SUM-then-INSERT inside a `BEGIN IMMEDIATE` transaction; concurrent reservers are serialised by SQLite's reserved lock. Reservation happens after workspace scan (so the estimate is scan-accurate) and before any Files API upload (so over-budget calls don't burn bandwidth). On success, `finalizeBudgetReservation` overwrites the estimate with the measured cost; on failure, `cancelBudgetReservation` frees the headroom.
- **Conservative pricing for unknown models** — the cost estimator's name-based fallback previously defaulted to FLASH rates for any model name missing the `pro`/`lite`/`flash` signals. A future Gemini "Ultra" tier would have been billed ~10× too cheap, silently letting budget-capped users overshoot. Unknown models now default to `UNKNOWN_PREMIUM_RATE` ($10.5/M input, $30/M output) so the cap blocks loudly instead of slipping.
- **Stale-cache retry preserves file dedup** — when `generateContent` returns "cachedContent not found" and the ask/code tools retry, they now call a new `markCacheStale()` helper that nulls only the cache pointer. Previously the retry went through `invalidateWorkspaceCache`, which dropped the `files` rows too, forcing every retry to re-upload all files. The cache itself is already dead on Google's side at that point (that's what triggered the retry), so skipping `caches.delete` is correct and saves the re-upload.
- **TTL watcher re-entrancy guard** — a slow Gemini round-trip (>5 minutes) would let the next interval firing iterate the same hot map and issue concurrent `caches.update` calls on the same cacheName. Now guarded by a `tickInProgress` flag; overlapping firings log at debug and return.
- **TTL watcher evicts externally-deleted caches** — when `caches.update` returns 404 / NOT_FOUND (cache deleted externally by admin action or quota), the watcher now drops the hot entry and nulls the manifest's `cacheId` / `cacheExpiresAt`, instead of retrying the same 404 every 5 minutes forever.
- **Credentials-dir chmod failure surfaced** — `saveProfile` previously swallowed `chmodSync(dir, 0o700)` failures silently. The credentials file is still written with `0o600` (content protected), but on a dir with looser perms other local users can list the dir and learn the filename. A warn log with the dir path and the underlying error now gives operators a signal to investigate.
- **Manifest `file_ids` corruption now logged** — `rowToWorkspace` previously swallowed `JSON.parse` errors on the `workspaces.file_ids` column into an empty array. The column is currently write-only in the runtime path (consumers read from the `files` table), so this had no correctness consequence, but hid corruption from operators debugging manifest state. The column itself is slated for removal in a follow-up migration (see `docs/FOLLOW-UP-PRS.md#t16`).

### Changed

- **Dependabot config hardened** — `@types/node`, `zod`, and `@biomejs/biome` are now pinned to their current major via `ignore: version-update:semver-major`. `@types/node` is capped to our Node runtime target (`engines.node >= 22`) to prevent typings for newer Node APIs from compiling cleanly against a runtime that doesn't support them. `zod` and `@biomejs/biome` majors each require a deliberate migration PR (tracked as T15 and a separate Biome-2 migration PR respectively).
- **`maxOutputTokens` capped on every Gemini call** — `ask` (8 192) and `code` (32 768) now set an explicit `maxOutputTokens` on the `generateContent` config, derived from the same value used in the budget reservation estimate. Without this, a runaway response could exceed the reserved estimate and silently overshoot `dailyBudgetUsd`. Both values clamp to the resolved model's advertised `outputTokenLimit` if smaller.

### Hardening (post-Copilot review)

- **Workspace path canonicalised before validation** — `validateWorkspacePath` now resolves the input via `realpathSync` before checking cwd ancestry. Without this, a symlink under cwd pointing at `$HOME` or `/etc` would pass the cwd-descendant test even though the actual scan target is outside cwd — defeating the purpose of the guard. `realpath` failures (`ENOENT`, `EACCES`, `ELOOP`) now produce specific error messages instead of being collapsed into a single "does not exist or is not a directory".
- **Workspace-validation errors handled as regular tool errors** — `ask`, `code`, and `reindex` now catch `WorkspaceValidationError` inside their tool-level try/catch and return a normal `errorResult` ("ask: …", "code: …", "reindex: …") instead of letting the throw bubble to the server-level handler (which logged a noisy `tool 'ask' threw` error and returned an inconsistent message prefix).
- **Files API delete deduplicates by upload ID** — `invalidateWorkspaceCache` now wraps the file-id list in a `Set` before issuing `client.files.delete` calls. The `files` table can have multiple `(workspace_root, relpath)` rows pointing at the same `fileId` when the uploader reused an existing upload via content-hash dedup; without the `Set`, every duplicate generated a redundant `files.delete` API call (plus 404 noise after the first delete actually removed the file).
- **`.projectile` removed from `WORKSPACE_MARKERS`** — editor-only scratch files are too weak a signal for a security guard. The remaining markers are VCS dirs, build/dependency manifests with structure, and load-bearing single-file project markers (`Dockerfile`, `Makefile`, `flake.nix`, `build.zig`).
- **Defensive finalize on budget reservation** — if `finalizeBudgetReservation` throws (disk-full / lock-contention edge), `ask` and `code` now log the error and KEEP the reservation row (estimate stays billed; slight overcharge) instead of letting the outer catch cancel it (which would erase any record of a billable, completed call).
- **`files.delete` uses the resource-name form, not the stored URI** — the uploader deliberately stores `.uri` (`https://…/files/<id>`) because Gemini's `fileData.fileUri` at cache-build time rejects the bare `files/<id>` form. But the `files.delete` endpoint wants the resource name. `toFileResourceName()` in `cache-manager.ts` normalises `https://…/files/<id>` → `files/<id>` before each delete, so B3's cost-leak fix actually hits instead of silently 4xx-ing for every orphan file.
- **`validateWorkspacePath` canonicalises cwd too** — on macOS, `process.cwd()` commonly returns a path under `/var/folders/…` while `realpathSync('/var')` is `/private/var`. The cwd-ancestry check was comparing a canonicalised workspace path to a non-canonicalised cwd, so `relative()` saw them as divergent and rejected legitimate workspaces under `tmpdir()` or other symlinked trees. Now `realpathSync(process.cwd())` is applied before the `relative()` check (with a fall-through to raw `process.cwd()` if `realpath` itself fails, to preserve the previous behaviour rather than introduce a new hard failure).
- **`DEFAULT_EXCLUDE_DIRS` doc comment clarifies that excludes are unconditional** — the previous comment implied users could "override via tool-level `includeGlobs`", but `isFileIncluded` runs `isPathExcluded` first and `defaultMatchConfig` only ever APPENDS to the exclude list. The doc now states that excludes here are final — repos that legitimately name a dir `.ssh` need to rename or fork the list.

## [1.0.2] — 2026-04-19

Ship-blocker patch. v1.0.0 and v1.0.1 silently failed to register tools in strict MCP clients (Claude Code, Claude Desktop): the server appeared connected but none of its five tools were callable. Every Claude Code user of those releases was affected.

### Fixed

- **`tools/list` response now has spec-compliant `inputSchema`** — every tool's `inputSchema` emits `type: "object"` at the root instead of a `{ $ref, definitions }` envelope. MCP clients that strictly validate the spec rejected the previous shape with `Failed to fetch tools: Invalid input: expected "object"` and dropped every tool from their namespace. Root cause: the `name` option on `zod-to-json-schema` triggers a named-wrapper envelope that lacks the spec-mandated root `type`. Fix: drop the `name` option; centralise the serialisation in `buildToolInputSchema()` so the `tools/list` handler and the new conformance test share one source of truth. Added `test/unit/tool-input-schema.test.ts` that also round-trips the whole payload through `@modelcontextprotocol/sdk`'s own `ListToolsResultSchema`, so any future regression is caught by the SDK's authoritative validator.

### Operators / forks

- If you published a fork based on 1.0.0 or 1.0.1, the same silent-tool-registration failure affects your users. Upgrade the `zod-to-json-schema` call to omit `name`, or rebase onto 1.0.2.
- 1.0.0 and 1.0.1 are now deprecated on npm.

## [1.0.1] — 2026-04-19

Docs-only patch. No behavioural changes. Triggered by user spotting an inaccurate claim about the incumbent `jamubc/gemini-mcp-tool` in the README comparison table.

### Fixed

After empirical verification against both the published npm v1.1.4 tarball AND the project's `main` branch on GitHub, four comparison-table claims were corrected. All structural points (hardcoded default, no caching, CLI backend, unreleased improvements) still hold; wording was imprecise.

- **Default model** — was stated as hardcoded `gemini-3.1-pro-preview`. That's true of npm v1.1.4, but on GitHub `main` (which is what anyone browsing the repo sees — last commit 2025-07-23) the hardcoded value is `gemini-2.5-pro`. Table now anchors to `main` and a footnote calls out the npm-vs-main drift.
- **Repeat queries** — "Re-sends entire codebase every call" was misleading; jamubc doesn't auto-index the workspace. Users control what's sent via `@file` syntax. The accurate delta is **no caching layer**: each call re-tokenises referenced files regardless of whether they've been tokenised before.
- **Auth** — "Key in `~/.claude.json` env var" was wrong for typical jamubc setups. The server inherits the `gemini` CLI's own auth — browser OAuth via `gemini auth login`, or `GEMINI_API_KEY` env var.
- **Dead deps** — numerical correction. On GitHub `main` the unused-in-src deps are five (`ai`, `chalk`, `d3-shape`, `inquirer`, `prismjs`). In the shipped npm `v1.1.4` tarball only three (`ai`, `d3-shape`, `prismjs`) are unused — `chalk` and `inquirer` are imported in `dist/` for that version. Table anchors to `main`; footnote acknowledges the npm-side count.
- Added table footnote explaining that all comparisons reference jamubc on GitHub `main` and acknowledging the ~9-month drift between that and the published npm version.

Same corrections applied in `docs/migration-from-jamubc.md`.

### Why this matters

The v1.0.0 README was the first public artefact advertising the project on npm. Claims about a competing project must be defensible line-by-line. One reader's spot-check caught the drift, which triggered a full empirical audit of the table. The corrections don't change our value proposition — they just describe the incumbent accurately.

## [1.0.0] — 2026-04-19

First public release. An MCP server that wraps Google's Gemini API with persistent Context Caching so Claude Code (and other MCP hosts) can query large codebases with cached input tokens instead of re-sending the entire workspace on every prompt.

### Added

- **Five core MCP tools**: `ask` (Q&A / long-context analysis), `code` (dedicated coding delegation with thinking budget + optional code execution), `status` (cache + cost telemetry), `reindex` (force cache rebuild), `clear` (drop cache and manifest).
- **Direct `@google/genai` SDK integration** with Files API + Context Cache. Uploads deduped by SHA-256 content hash; cache keyed by `(workspaceRoot, filesHash, model, systemPromptHash)`. Bounded concurrent upload pool (default 10 parallel) + same-batch hash dedup.
- **Dynamic model registry** with alias resolution (`latest-pro`, `latest-pro-thinking`, `latest-flash`, `latest-lite`). Resolves against the live `models.list()` at startup so new Gemini models are picked up without code changes. Filters out `image`, `tts`, `vision`, `audio` variants.
- **3-tier authentication**: Vertex AI via ADC → credentials file (chmod 0600 via atomic tmp+rename with random suffix, O_EXCL) → env var (with startup warning). `init` subcommand runs a guided interactive setup with hidden password input (SS3/OSC/CSI escape handling) and validates profile names against INI-injection while allowing Unicode.
- **Daily budget cap** (`GEMINI_DAILY_BUDGET_USD`) with hard-stop enforcement based on recorded usage metrics in SQLite.
- **TTL watcher** for background Context Cache refresh on "hot" workspaces (used within 10 minutes). Respects per-cache TTL; configurable via `GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS`.
- **SQLite manifest** (`better-sqlite3` WAL mode) tracking workspaces, file uploads, and usage metrics. FK cascades from workspaces → files on delete.
- **Workspace scanner** with SHA-256 content hashing (deterministic `localeCompare` sort for cache-key stability), POSIX path normalisation for Windows, gitignore-aware default excludes (`node_modules`, `.git`, build dirs), and dual include/exclude patterns supporting extensions (`*.go`, `.kt`) and literal filenames (`Dockerfile`, `Makefile`).
- **Self-healing on stale cache**: ask/code tools auto-invalidate and rebuild once on Gemini 404/NOT_FOUND against cached content. Retry preserves original error via `Error.cause` and reports `retriedOnStaleCache` in tool metadata.
- **In-process coalescing mutex** keyed on full cache fingerprint (workspaceRoot + filesHash + model + systemPromptHash + allowCaching + cacheMinTokens) prevents duplicate cache creation under concurrent tool calls.
- **Cost estimator** with per-model pricing defaults and runtime override via `GEMINI_PRICING_OVERRIDES` (JSON). Full-precision micros-to-dollars conversion so sub-cent calls are visible in `status`.
- **Configurable cache minimum tokens** (`GEMINI_CODE_CONTEXT_CACHE_MIN_TOKENS`) so users can adjust the 1024-token floor if Gemini changes it.
- **XDG compliance**: state files honour `XDG_STATE_HOME`; config files honour `XDG_CONFIG_HOME`. Falls back to `~/.qmediat/` and `~/.config/qmediat/` respectively.
- **Full docs**: getting-started, configuration, how-caching-works, migration-from-jamubc, architecture, security, cost-model, KNOWN-DEFICITS, ACCEPTED-RISKS, FOLLOW-UP-PRS.
- **Examples** for Claude Code, Claude Desktop, Cursor, and Vertex AI setups.
- **CI** matrix on Node 22 + Node 24 with TypeScript strict (including `exactOptionalPropertyTypes`), Biome lint/format, Vitest 4.x with real-Gemini integration tests (skipped without `GEMINI_API_KEY`).

### Fixed (during v1.0 review cycle)

Integration-test-surfaced and review-surfaced fixes landed before the v1.0.0 release:

- **Gemini API incompatibility** — `generateContent({cachedContent, systemInstruction})` returns 400; the system instruction is baked into the cache at build time and must NOT be repeated on the generate call. Similarly `tools: [{codeExecution: {}}]` cannot coexist with `cachedContent` — `code({codeExecution: true})` now force-bypasses the cache. Integration test locked as regression anchor.
- **Windows path separator mismatch** — `path.relative()` returns `\` on Windows but our glob checks used `/`. Scanner now normalises every relpath to POSIX separators. Windows users would have silently over-indexed node_modules.
- **Cache URI format** — Files API returns `.name` (`files/abc123`) and `.uri` (full HTTPS URL); `fileData.fileUri` requires the full URI. Preferring `.uri` eliminates a 400 "Cannot fetch content from the provided URL".
- **FK constraint on first-time upload** — workspace row is upserted before file rows.
- **Cache reuse ordering** — reuse check runs before the token-floor check so small workspaces with valid caches keep them.
- **In-flight mutex scope** — keyed on full fingerprint instead of just workspaceRoot.
- **Post-retry telemetry** — `activePrep` tracks the context used for the final successful call so `cacheHit`, `cacheRebuilt`, `retriedOnStaleCache` reflect reality.
- **Credentials atomic write** — `crypto.randomBytes(8)` suffix + `O_EXCL` (`flag:'wx'`) defeats symlink-race attacks.
- **ANSI escape handling** — `askHidden` now correctly skips SS3 (F1-F4), OSC, DCS sequences instead of leaking bytes into the API key.
- **Process listener leak** — `SIGINT`/`exit` handlers removed on resolve/reject paths.
- **Windows cross-platform** — `execFileSync` replaces shell-redirection `execSync('git … 2>/dev/null')`.
- **Dotfiles-in-git detection** — git walk-up finds enclosing repo on fresh install.
- **Inline async reads** — `readFile` instead of `readFileSync`, with 20 MB aggregate size cap.
- **Sort stability** — `localeCompare` replaces the non-zero-returning comparator.
- **FK cascade** — redundant `DELETE FROM files` removed (cascade handles it).
- **Double stat** — scanner passes pre-fetched `Stats` into hasher.
- **SERVER_VERSION from package.json** at runtime.

### Security

- API keys never logged in full (only `AIza...xyz9` fingerprint at first 4 + last 4 chars).
- Daily budget cap limits blast radius of leaked keys.
- Atomic write with `O_EXCL` on credentials file.
- INI profile names sanitised against syntax chars + control chars.
- Threat model documented in [`docs/security.md`](docs/security.md).

### Performance

- Parallel Files API uploads (10 concurrent by default).
- Hash cache keyed on `(path, mtime, size)` avoids re-reading unchanged files.
- In-process mutex coalesces concurrent same-workspace prepareContext calls.
- Context Cache reduces repeat-query input tokens to ~25 % of uncached rate and latency from ~45 s to ~2 s on typical workspaces.

### Known deficits (by design or deferred)

- TTL watcher cross-process coordination (documented in [`docs/KNOWN-DEFICITS.md`](docs/KNOWN-DEFICITS.md)).
- Pre-rebuild `caches.delete` loses cache on transient create failures ([`docs/ACCEPTED-RISKS.md`](docs/ACCEPTED-RISKS.md)).
- Key fingerprint format (accepted as industry standard).
- MIME type simplified to `text/plain` for all files.
- Unit test coverage gaps for cache-manager / files-uploader / ttl-watcher / profile-loader / parseEdits tracked in [`docs/FOLLOW-UP-PRS.md`](docs/FOLLOW-UP-PRS.md).

[Unreleased]: https://github.com/qmediat/gemini-code-context-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/qmediat/gemini-code-context-mcp/releases/tag/v1.0.0
