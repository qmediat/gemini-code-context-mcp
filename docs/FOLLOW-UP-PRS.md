# Follow-up PRs

Real improvements surfaced by `/6step` and `/coderev` analysis that are out of scope for the v1.0 core PR. Each entry is sized, scoped, and ready to split off once a maintainer picks it up.

## Release sequencing — post-v1.2.0 roadmap

**v1.2.0 shipped 2026-04-20** with T21 (`thinkingLevel` parity on `code`) and a security fix (home-workspace reject + expanded excludes). See `CHANGELOG.md` `[1.2.0]` for the complete delta. Remaining thinking-related + reviewer-workflow follow-ups ship as **four small, sequential publishes** rather than one big batch, for the same reasons that held for the v1.2.0 sequencing:

- **Bug attribution:** each release hits npm in isolation — regression maps to exactly one PR.
- **Rollback surface:** reverting one focused commit is cheaper than unwinding a multi-PR merge.
- **Review quality:** T20 is a ~1-day structural refactor. Landing it together with smaller fixes inflates reviewer load and delays work that's already 100 % ready.
- **External testing velocity:** external users get incremental upgrades to test rather than waiting for a big-bang drop.

Each step must fully merge + publish before the next opens:

| Phase | Release | PRs | Scope | Expected size |
|-------|---------|-----|-------|--------------|
| ~~A~~ | ~~**v1.2.0**~~ ✅ SHIPPED | ~~#15, #16, #17, #18~~ | ~~`ask`/`code` thinkingLevel + alias fix + home-reject security~~ | ~~done~~ |
| **B** | **v1.3.0** | T22 + T23 bundled | **Reviewer-workflow unblockers:** TPM preflight throttle (T22, `GEMINI_CODE_CONTEXT_TPM_THROTTLE_LIMIT` env) + MCP wire-format fix (T23, surface text as `structuredContent.responseText`). Without these the MCP is effectively unusable for `/coderev`-style sub-agent pipelines (text invisible to agents) and suffers 429 cascades on back-to-back reasoning calls. Ship together because they're both "make the MCP usable for review workflows" and each is tiny in isolation. | ~6 h combined |
| C | **v1.4.0** | T19 | Opt-in `GEMINI_CODE_CONTEXT_*_TIMEOUT_MS` env var (default disabled). Complements T22's preflight with a post-call bounded-wait for stuck connections. | ~2 h |
| D | **v1.5.0** | T20 | Migrate `ask` / `code` to `generateContentStream` for in-flight thinking heartbeat. Pairs with T19's `AbortController` for real stall detection — stream heartbeat + timeout abort = closed loop. | ~1 day |

**Why T22+T23 bundled (not separate releases):** both fix a single concern ("reviewer workflows don't work today") and each PR alone doesn't deliver user-visible value — TPM throttle without wire-format fix still can't extract review text; wire-format fix without throttle still 429s on back-to-back calls. Bundling keeps the release-note story coherent for external users.

**Why v1.3.0 before v1.4.0/v1.5.0:** T22+T23 unblock code-review workflows we ALREADY use internally for `/coderev`. T19/T20 are polish on top of a working pipeline. Unblocking comes first.

**Why T19 precedes T20:** T20's stall detector needs T19's `AbortController` plumbing already in place.

**Non-goal:** skipping a minor version to collapse two features into one release. Keeping 1:1 PR-set : release ratio preserves review/rollback properties.

---

## T1. Unit test coverage for `cache-manager`, `files-uploader`, `ttl-watcher`, `profile-loader`

**Source:** GPT + Gemini + Grok reviews, April 2026.

**Why:** These files contain the product's core logic (caching, upload, auth resolution) and have only integration-test coverage today. A fast-to-run unit layer with mocked SDK would catch regressions in CI without needing a real `GEMINI_API_KEY`.

**Scope:**
- `cache-manager.test.ts` — mock `@google/genai` client; verify cache-key fingerprint matching, reuse path, rebuild-on-mismatch, inline-fallback threshold, pre-rebuild cache deletion, in-process mutex coalescing.
- `files-uploader.test.ts` — mock SDK; verify dedup by hash, safety-margin re-upload when `expires_at` < now+2h, parallel pool respects concurrency, failures collected in `UploadResult.failures` without throwing.
- `ttl-watcher.test.ts` — fake timers; verify refresh trigger (hot + within-window), skip conditions, manifest writeback.
- `profile-loader.test.ts` — env sandbox; verify priority chain (Vertex → credentials-file → env-var → throw).
- **`ask.tool.buildConfig.test.ts`** — mock `GoogleGenAI.models.generateContent`; verify the THREE mutually-exclusive `thinkingConfig` wire shapes actually leave the tool: (a) `thinkingLevel` set → `{ thinkingLevel, includeThoughts: true }` sent, no `thinkingBudget`; (b) `thinkingBudget` set (non-null) → `{ thinkingBudget, includeThoughts: true }` sent, no `thinkingLevel`; (c) neither set → `{ includeThoughts: true }` only. Added in response to PR #16 self-review finding F7 — schema tests alone don't catch drift between the Zod boundary and the `buildConfig` branch logic. Same mocking pattern applies to `code.tool.buildConfig.test.ts` once T21 lands.

**Sizing:** ~4 hours, 5 test files, adds no production deps. Pairs well with a follow-up Vitest mock-setup helper.

---

## T2. Unit tests for `parseEdits` / `parseCodeBlocks` regex in `code.tool.ts`

**Source:** GPT code review.

**Why:** The OLD/NEW diff regex is load-bearing for Claude Code's ability to apply Gemini's output via its Edit tool. Silent parse failures produce an empty `edits: []` array without any signal to the user.

**Scope:** Fixture-driven tests covering: happy path, empty OLD (new file), nested backticks, CRLF line endings, adjacent edits, malformed FILE header, multiple files in one response.

**Sizing:** ~1 hour.

---

## T3. TTL watcher — multi-instance coordination

**Source:** Grok code review (see [`KNOWN-DEFICITS.md`](./KNOWN-DEFICITS.md)).

**Why:** Two MCP servers on the same manifest double `caches.update` traffic. Currently WATCH status — low today, could compound with scale.

**Scope:** Add `last_refresh_at` column to `workspaces`; watcher checks `now - last_refresh_at > TICK_MS/2` before issuing `caches.update`. Soft throttle, no distributed lock needed.

**Sizing:** ~30 min.

**Trigger:** User reports of unexpected `caches.update` billing, or multi-instance usage telemetry.

---

## T4. Windows — native ACL lockdown for credentials file

**Source:** Grok code review (see [`KNOWN-DEFICITS.md`](./KNOWN-DEFICITS.md)).

**Why:** Current v1.0 emits a warning on Windows but doesn't actually restrict ACLs. Enterprise / shared-machine users silently exposed.

**Scope:** Option A — shell out to `icacls` with `/inheritance:r /grant:r "%USERNAME%:F"`. Option B — add `node-windows-acl` native module (platform binary bloat). Prefer A for smaller footprint.

**Sizing:** ~2 hours including a Windows CI job.

**Trigger:** Windows users reaching ≥10 % of installs.

---

## T5. `server.ts` CallToolResult cast cleanup

**Source:** Prior `/6step` self-review.

**Why:** Four `as CallToolResult` casts in `src/server.ts` work around the MCP SDK's union type (which includes `task` variant we don't emit). Loses type safety if the SDK ever adds required fields to our content variant.

**Scope:** Define a local `ContentToolResult` type that tightly matches the SDK's content-variant shape; use that as the handler return type; remove casts.

**Sizing:** ~20 min.

---

## T6. SIGTERM graceful-drain for in-flight tool calls

**Source:** Prior `/6step` self-review.

**Why:** `server.close()` in shutdown doesn't await outstanding `generateContent` promises. Users doing a long `ask` during Claude Code restart lose the response.

**Scope:** Track in-flight promises; `Promise.race` against 5 s timeout before closing the transport.

**Sizing:** ~30 lines.

---

## T7. `schema.sql` / inline `SCHEMA_SQL` drift

**Source:** Prior `/6step` self-review.

**Why:** The `.sql` file in `src/manifest/` exists as human-readable documentation; the authoritative copy is inlined as a const in `db.ts`. Nothing pilots synchronization.

**Scope:** Delete the `.sql` file; add a single "source of truth: SCHEMA_SQL in db.ts" comment there explaining intent, OR delete entirely.

**Sizing:** trivial.

---

## T8. Spread-pattern helper

**Source:** Prior `/6step` self-review.

**Why:** `...(input.x !== undefined ? {x: input.x} : {})` appears 5+ times across tools. Helper `pickDefined(obj, keys)` would reduce repetition and prevent "forgot one tool" regressions.

**Scope:** Add `src/utils/objects.ts` with `pickDefined`; refactor call sites.

**Sizing:** ~30 min.

---

## T9. Retry loop-limit configurability for stale-cache self-heal

**Source:** This PR's `#8` fix (stale cache retry).

**Why:** Today the ask/code retry on stale cache is hard-coded to ONE retry. Pathological cases (Gemini service glitch during rebuild) could benefit from limited retries. Or a config knob for users to disable the retry.

**Scope:** Add `GEMINI_CODE_CONTEXT_STALE_CACHE_RETRIES` env var (default 1, max 3). Emit metadata in tool response when a retry was consumed.

**Sizing:** ~1 hour.

**Trigger:** User reports of "stale cache retry loop" or Gemini outages causing repeated rebuilds.

---

## T10. Auth-profile file — encrypted-at-rest option

**Source:** Long-term hardening, not from any specific finding.

**Why:** `~/.config/qmediat/credentials` is chmod 0600 plaintext. Full-disk encryption is the first line of defense, but some organisations require app-level secret storage.

**Scope:** Optional `GEMINI_CODE_CONTEXT_KEYCHAIN=macos|libsecret|dpapi` to store keys in OS keychain instead of plaintext file. Adds native deps (`keytar`-family).

**Sizing:** ~1 day. Delay until someone asks.

---

## T11. Narrow `ToolDefinition.schema` to an object-rooted Zod type

**Source:** Gemini + Grok code review of PR #5 (Apr 2026), partial finding.

**Why:** `ToolDefinition<TInput = unknown>` currently declares `schema: z.ZodSchema<TInput>`, which accepts non-object-rooted Zod schemas (`z.union`, `z.discriminatedUnion`, primitives, `ZodEffects` over non-objects) at compile time. `zod-to-json-schema` then emits `{anyOf: [...]}` or primitive-typed output, and MCP clients reject the `tools/list` response (same failure mode as the v1.0.0 / v1.0.1 ship-blocker). The PR-#5 runtime assert in `buildToolInputSchema` + the SDK round-trip test catch this at server startup, but `tsc` does not.

**Scope:** Constrain `schema` to `z.ZodObject<z.ZodRawShape, …, TInput, TInput>` (or an equivalent helper alias). Each concrete tool already uses `z.object({...})`, so no runtime change — this is pure TypeScript tightening. Complication: the current `src/tools/index.ts` has `as unknown as ReadonlyArray<ToolDefinition<unknown>>` because `ToolDefinition<AskInput>` is not assignable to `ToolDefinition<unknown>` (contravariance on `execute`). The fix should either (a) accept the cast and keep the narrower `schema` bound, or (b) redesign the registry to avoid the heterogeneous-array problem (e.g. a `defineTool<TInput>()` factory that registers through a side-channel).

**Sizing:** ~1 hour for option (a); half a day for option (b) including migrating all 5 tools.

---

## T12. Extract `buildToolsListResponse()` as a pure function

**Source:** GPT code review of PR #5 (Apr 2026), partial finding.

**Why:** `test/unit/tool-input-schema.test.ts` reproduces the shape of the `tools/list` response (`{name, title, description, inputSchema}`) inline rather than calling the actual `server.ts` handler. If a future refactor adds post-processing to the handler — extra metadata, per-tool annotations, a wrapper around `inputSchema` — the test would pass while the handler ships a broken payload. The current handler is 5 lines, so the drift risk is small, but it grows with every additional field MCP adds (`outputSchema`, `annotations`, etc.).

**Scope:** Extract `buildToolsListResponse(tools: ReadonlyArray<ToolDefinition<unknown>>): ListToolsResult` (or its inferred type) in `src/tools/registry.ts` or a new `src/tools/list-response.ts`. The server handler and the conformance test both call it. Keeps a single source of truth for the on-the-wire shape.

**Sizing:** ~30 min. Touches `src/server.ts`, the new helper, and `test/unit/tool-input-schema.test.ts`.

---

## T13. Pedagogical mock-schema tests for non-object roots

**Source:** Gemini + Grok code review of PR #5 (Apr 2026).

**Why:** The PR-#5 conformance test loops over the five current production tools, which all use `z.object({...})`. The SDK round-trip assertion catches any future non-object root, but there is no explicit test that documents *which* Zod constructs are forbidden at the root and *why*. New contributors don't get a compiled-in "here's the boundary" when they add a tool with `z.union` or `z.discriminatedUnion`. Adding synthetic test fixtures — "this Zod shape SHOULD be rejected, this one SHOULD pass" — makes the spec surface self-teaching.

**Scope:** In the same test file, add a block that feeds each of `z.union([...])`, `z.discriminatedUnion('k', [...])`, `z.string()`, `z.record(z.string(), z.number())`, `z.object({}).strict()`, `z.object({}).passthrough()`, and a `ZodEffects`-wrapped object to `ListToolsResultSchema.safeParse`, asserting success / failure per the MCP spec.

**Sizing:** ~20 min, ~15 lines of test code. No production code changes. Pairs well with T11.

---

## T14. Biome rule — restrict `zod-to-json-schema` imports to `registry.ts`

**Source:** Gemini code review of PR #5 (Apr 2026), accepted but low-priority.

**Why:** `buildToolInputSchema` exists specifically to centralise the `zod-to-json-schema` call with the mandatory `$refStrategy: 'none'` and NO `name` option. A careless refactor could re-inline `zodToJsonSchema(...)` in `server.ts` (or elsewhere), bypassing the helper and re-introducing the v1.0.0 / v1.0.1 ship-blocker. The SDK round-trip test catches the regression at test time; the import graph is the current preventive barrier (only `registry.ts` imports the library). A Biome `noRestrictedImports` rule (allowed only in `src/tools/registry.ts`) would close the loophole at lint time.

**Scope:** Add a `noRestrictedImports` rule in `biome.json` with a per-file override for `src/tools/registry.ts`. Biome's override syntax at the time of writing is still evolving — may need to wait for Biome ≥ 1.10 to express per-file exceptions cleanly.

**Sizing:** ~15 min once Biome override support is mature. Low priority — the test catches the regression; this is belt-and-suspenders.

---

## T15. Migrate from `zod-to-json-schema` to Zod 4's built-in `z.toJSONSchema()`

**Source:** Dependabot PR #13 closure (April 2026). Zod 4 is a type-internals rewrite: the `$ZodTypeInternals` shape replaces `ZodTypeDef`, and `zod-to-json-schema@3.x` rejects the new type with `TS2345: Argument of type 'ZodType<unknown, unknown, $ZodTypeInternals<unknown, unknown>>' is not assignable to parameter of type 'ZodType<any, ZodTypeDef, any>'` at the call site in `src/tools/registry.ts`.

**Why:** The MCP SDK (`@modelcontextprotocol/sdk@1.29.x`) already imports `zod/v4` internally; long-term we want our own schemas on Zod 4 too so there's one version of Zod in the runtime. Zod 4 also has a native `z.toJSONSchema()` that produces MCP-compatible output directly — migrating lets us drop the `zod-to-json-schema` dependency entirely.

**Scope:** (1) Bump `zod` to `^4.x` in `package.json`. (2) Replace `zodToJsonSchema(tool.schema, { $refStrategy: 'none' })` in `buildToolInputSchema` with `z.toJSONSchema(tool.schema, { target: 'draft-7', unrepresentable: 'any' })` (or whatever the final v4 API is — check docs at migration time). (3) Re-run the SDK round-trip conformance test in `test/unit/tool-input-schema.test.ts` to confirm the emitted shape still passes `ListToolsResultSchema`. (4) Drop `zod-to-json-schema` from `package.json`. (5) Remove the `zod` major-ignore entry in `.github/dependabot.yml`.

**Sizing:** ~1 hour. Low runtime risk (our 5 tool schemas are all plain `z.object({...})`), but touches the hot `tools/list` path so the SDK validator is the must-pass gate.

**Trigger:** No external signal needed — routine dependency hygiene once a maintainer has the hour.

---

## T16. Drop the vestigial `workspaces.file_ids` column

**Source:** Post-release 6-step bug hunt (B6 and B12, April 2026).

**Why:** The `file_ids` column on the `workspaces` table is written by `upsertWorkspace` (from `prepareContext`) but **never read** in the runtime path — consumers look up file IDs via `findFileRowByHash` against the `files` table. The column carries three latent costs: (1) silent desynchronisation after model-switch rebuilds (operator-visible but functionally irrelevant); (2) a try/catch around its `JSON.parse` that previously swallowed corruption silently (now logs, per B12 in v1.0.3); (3) confusing reviewers into reasoning about "orphan uploads" that aren't actually orphaned.

**Scope:** (1) Add migration `schema_version = '2'` that `ALTER TABLE workspaces DROP COLUMN file_ids` — supported by recent SQLite via better-sqlite3. (2) Remove `fileIds` from `WorkspaceRow` type and `rowToWorkspace` / `upsertWorkspace` methods. (3) Drop the now-dead `JSON.parse` try/catch and the `logger.warn` added in B12. (4) Update `test/unit/manifest-db.test.ts` (the `round-trips a workspace row` assertion includes `fileIds: ['files/1', 'files/2']` that needs to go).

**Sizing:** ~30 min. Pure cleanup; no user-visible change.

**Trigger:** Combine with the next real schema migration to avoid a DB-bump for one trivial change.

---

## T17. Tokenizer-accurate pre-call cost estimate

**Source:** 2026-04-19 code review (gpt + grok, 2/3 consensus).

**Why:** The pre-call cost estimator (`src/utils/cost-estimator.ts:124-134`) currently approximates input tokens as `Math.ceil(bytes / 4)` and `Math.ceil(chars / 4)`. This is roughly accurate on ASCII source but undercounts by ~40-50% on dense UTF-8 / CJK / emoji content, so the budget-reservation "true upper bound" claim (same file, lines 115-123) can overshoot by one call on CJK-heavy repos (bounded to a single finalize write per day, not unbounded drain).

**Options:**
1. Ship an official tokenizer (e.g. `@google/generative-ai` `countTokens` call, or a local BPE) and replace the heuristic entirely. Adds a dep + pre-call latency; exact bound.
2. Keep the heuristic but tighten to `Math.ceil(bytes / 3)` (+33% padding) to cover the CJK tail; cheap, still bounded, still occasionally over-estimates on pure ASCII.
3. Document the limitation; accept the single-call overshoot as a known UX quirk.

**Sizing:** Option 1 — half a day (integration + test). Options 2 / 3 — under an hour.

**Trigger:** First user report of a CJK-heavy repo blowing through `GEMINI_DAILY_BUDGET_USD` by more than the per-call estimate.

---

## T18. Precise budget accounting during stale-cache retry

**Source:** 2026-04-19 code review (grok, 1/3 consensus).

**Why:** When `ask` / `code` hit a stale-cache error (Gemini-side cache eviction) and retry once via `markCacheStale` + `prepareContext` rebuild, the original `reservationId` is reused. Concurrent callers during the retry window see the original estimate (sized for the failed call's uncached upload) counted against the daily budget until `finalizeBudgetReservation` writes the real cost. Because the rebuild reuses the same scan and content-hash deduplication avoids re-uploading, real cost is ≤ the reservation estimate — so the bias is toward false-reject (over-reporting) rather than cap bypass. It's a UX / accounting precision issue, not a safety one.

**Scope:** Cleaner design — `cancelBudgetReservation(original)` → re-estimate for the rebuild path → re-reserve. Requires care: a transient race between cancel and re-reserve could let a concurrent call squeak past the cap it would otherwise fail. Needs design discussion on an atomic "adjust reservation" primitive vs cancel+reserve with a short-lived lock.

**Sizing:** 1-2 days including new DB primitive, migration, and tests.

**Trigger:** If a high-concurrency user reports spurious "daily budget cap would be exceeded" errors during cache-rebuild windows.

---

## T19. Opt-in per-call timeout for `ask` / `code` via env var

**Source:** April 2026 user feedback while smoke-testing the `thinkingLevel` PR — "the timeout for thinking mode should be configurable by the MCP server operator, and disabled by default" (original Polish: "timeout przy thinking mode powinien być konfigurowany przez użytkownika serwera MCP, a domyślnie powinien być wyłączony").

**Why:** Today `ask` and `code` delegate to Gemini's `generateContent` with no client-side timeout at all. For thinking-capable models (especially Gemini 3 Pro on `thinkingLevel: HIGH`) a single legitimate call can run 2–3 minutes on complex prompts — which is exactly what we WANT, and why an aggressive default timeout would be harmful. But for operators who want a hard upper bound (CI pipelines, budget-sensitive workloads where a stuck connection costs more than a failed request), there's currently no knob.

**Scope:**
- Add `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS` env var — positive integer = per-call timeout in ms, `0` or unset = disabled (today's behaviour). Mirror `GEMINI_CODE_CONTEXT_CODE_TIMEOUT_MS` for `code`.
- Thread `AbortController` through `ask.tool.ts` / `code.tool.ts` `generateContent` call sites. Schedule `controller.abort()` on timeout, clear on successful response.
- Surface timeout as a regular `errorResult("ask failed: timed out after <N>ms (override via GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS)")`.
- Default: **disabled**. Must NOT ship an aggressive default that kills legitimate long-thinking sessions.
- Document the hard caveat from `@google/genai@1.50.1` types: *"AbortSignal is a client-only operation. Using it to cancel an operation will not cancel the request in the service. You will still be charged usage for any applicable operations."* (node_modules/@google/genai/dist/genai.d.ts:1425-1427). Operators opting in must understand they pay for work Gemini finishes after we disconnect.
- Release reservation via `cancelBudgetReservation` on abort — the estimated cost is still billed server-side, but our manifest shouldn't also keep the reservation row pinned.

**Sizing:** ~2 hours. Small code change (~40 lines in each tool), schema description update, one new env var in `src/config.ts`, 3-4 unit tests mocking `AbortController`.

**Blocked on:** nothing. Can ship anytime after v1.2.

---

## T20. Migrate `ask` / `code` to `generateContentStream` for in-flight thinking progress

**Source:** April 2026 user feedback — "check the documentation to see whether there is a way to ping whether thinking is active" (original Polish: "zbadaj w dokumentacji, czy istnieje możliwość pingowania, czy thinking jest aktywne").

**Why:** Gemini API exposes no formal heartbeat/ping for in-progress requests — but `generateContentStream` (SDK: `node_modules/@google/genai/dist/genai.d.ts:8127`) returns an `AsyncGenerator<GenerateContentResponse>` whose successive chunks are a de facto heartbeat. When `includeThoughts: true`, Gemini emits `thought: true` parts progressively while it reasons. A consuming MCP server can forward these as MCP `progress` notifications — the host sees "model is thinking" updates instead of an opaque 3-minute pause.

Today we call `generateContent` (non-streaming) — single round-trip, no signal until completion. That's fine for short Q&A but hostile to long thinking sessions: the user can't tell whether the model is working or the connection is dead, and our `progress` emitter falls silent at the exact moment where the user most wants reassurance.

**Scope:**
- Replace `ctx.client.models.generateContent({...})` with `ctx.client.models.generateContentStream({...})` in `ask.tool.ts` and `code.tool.ts`.
- Iterate the `AsyncGenerator`, accumulating `text` + `candidates` + `usageMetadata` into a single response object compatible with downstream code (parseEdits / parseCodeBlocks / thoughtsSummary extraction).
- Surface in-flight thought chunks as MCP progress notifications via the existing `emitter` (use `emitter.emit('thinking: <first-N-chars>…')` on each thought part, throttled so we don't flood the host).
- Combine with T19: a stall detector ("no chunk for M seconds, abort") is only meaningful on a stream. Document that timeout + stream together give both heartbeat detection AND bounded wall-clock.
- Preserve stale-cache retry (`isStaleCacheError` → `markCacheStale` → rebuild → retry ONCE) — must still work over the streaming API.
- Preserve the response shape we expose to callers — the `textResult(text, metadata)` contract is stable; internals may refactor.

**Sizing:** ~1 day. Biggest wrinkle is collapsing a stream into the non-streaming response shape without losing `usageMetadata` (which typically only appears on the final chunk) and making sure the stale-cache-retry path still gets a second stream if the first dies. Unit tests need an async-iterable mock client. Integration tests already cover the happy path — re-run them.

**Blocked on:** ideally T19 first, so the stream refactor lands with the stall-detector abort path already designed in. If shipped alone, T20 gives heartbeat UX without bounded timeout; if shipped alone, T19 gives bounded timeout without heartbeat signal. Together they close the loop.

**Deliberate non-goal:** this PR does not try to cancel server-side work. Same disclaimer as T19 — `AbortSignal` is client-only.

---

## T21. `thinkingLevel` parity on `code.tool.ts`

**Source:** April 2026 three-way code review on PR #16 (Gemini consensus) + self-review finding F5.

**Why:** v1.2's `thinkingLevel` parameter (Google's recommended reasoning knob on Gemini 3 — `LOW` / `MEDIUM` / `HIGH`, plus `MINIMAL` for Flash-Lite) ships only on `ask`. The `code` tool still exposes the legacy `thinkingBudget` only, leaving callers without a discrete-tier option on Gemini 3 Pro (where explicit `thinkingBudget` is flagged as "legacy" and may produce "unexpected performance" per ai.google.dev/gemini-api/docs/gemini-3). Asymmetric MCP surface: callers can say `ask({ thinkingLevel: 'HIGH' })` but not `code({ thinkingLevel: 'HIGH' })` — forcing them back to the omit-budget workaround or the problematic low-budget path.

**Scope:**
- Mirror the v1.2 `ask.tool.ts` changes onto `code.tool.ts`:
  - Add `thinkingLevel: z.enum(['MINIMAL','LOW','MEDIUM','HIGH']).optional()` to `codeInputSchema` with a description that mirrors `ask`'s (pointing at Gemini 3 guide + Gemini 2.5 caveat + mutual exclusion).
  - Zod `.refine({ path: [] })` enforcing mutual exclusion with `thinkingBudget` (same message as `ask`).
  - Replace the always-`{ thinkingBudget, includeThoughts, maxOutputTokens }` config build with the three-branch `thinkingConfig` shape from `ask.tool.ts` (tier set → `thinkingLevel`; budget set → `thinkingBudget`; neither → `{ includeThoughts: true }` only).
  - Echo `thinkingLevel` in structured metadata alongside the existing `thinkingBudget`.
  - Reuse `THINKING_LEVEL_RESERVE` from `ask.tool.ts` (export or move to a shared module) for cost-estimate sizing; fall through to the existing `effectiveThinkingBudget` clamp when `thinkingLevel` is absent.
- Update schema tests in `test/unit/tool-input-schema.test.ts` — add cases for `code({ thinkingLevel })`, mutual exclusion, and invalid values (mirror `ask`'s coverage).
- `CHANGELOG.md` entry in `### Added`.
- `docs/configuration.md` per-call-overrides section: add `code({ thinkingLevel: "HIGH" })` example.

**Sizing:** ~1 hour. Essentially copy-paste the `ask` diff with the code-tool's existing thinkingBudget clamp preserved. Testing is quick because the schema contract is identical — reuse the same invalid-value table.

**Blocked on:** nothing. Can ship any time after v1.2.

**Open question:** should `THINKING_LEVEL_RESERVE` live in a `src/tools/shared/thinking.ts` helper (DRY + a home for T19/T20 common utilities), or stay on `ask.tool.ts` as `export const` and get imported by `code.tool.ts`? Prefer the shared module if T19 ships first (so the timeout helper has somewhere to live).

---

## T22. Client-side TPM throttle (Gemini per-minute quota preflight)

**Source:** 2026-04-20 session — empirical observation during PR #17 three-way code review. The Gemini agent attempt hit `429 RESOURCE_EXHAUSTED` on `generate_content_paid_tier_input_token_count` with `quotaValue: 100000` (tokens/minute) TWICE in succession, aborting the review after a cumulative ~10 minutes of retry waits. Full empirical dump in the gitignored `.claude/local-gemini-rate-limits.md` (not committed — per-key observations).

**Why:** Google enforces a per-minute input-token quota (paid Tier 1 Gemini 3 Pro: 100_000 tokens/minute). Our MCP currently has **zero client-side preflight** against this — we discover the limit only when Gemini returns 429, at which point the call is already wasted (we still pay for the failed generate-content API invocation per `@google/genai` d.ts:1425-1427 disclaimer). Effect on UX: code-review workflows that make 2-3 back-to-back `ask`/`code` calls against a workspace with ~108k cached tokens saturate the minute-window on the very first follow-up call. Review aborts, user waits 60 s, retries, possibly 429s again.

Empirically confirmed aggregation quirk: `gemini-pro-latest` (our `latest-pro` alias target) **shares a quota bucket with `gemini-3-pro-image`** server-side — 429s on pro-text requests report `quotaDimensions.model: "gemini-3-pro-image"` even though that's not the model we asked for. This is Google's internal accounting, not our resolver's bug.

**Scope:**
- New env var `GEMINI_CODE_CONTEXT_TPM_THROTTLE_LIMIT` (default `80_000`, `0` disables). 80k leaves ~20 % headroom under the observed Tier 1 100k limit for clock-skew and Google's own accounting noise.
- `src/tools/shared/throttle.ts` — sliding 60-second window of recent input-token usage per `resolvedModel`. Tracked in-memory; survives nothing; cleared on server restart. **Primary API is a reservation lifecycle — `reserve` / `release` / `cancel` — not a read-only `shouldDelay` peek.** A peek-only API has a TOCTOU race: between `peek()` → `await sleep()` → `await generateContent()` → `record()`, a concurrent MCP tool call observes the same pre-peek window and both callers proceed, collectively overshooting the quota. The MCP `CallToolRequestSchema` handler in `src/server.ts` is async, so this race is reachable under any workflow with parallel `ask`/`code` calls (e.g. `/coderev` sub-agent fan-out).
- `reserve(model, estimatedInputTokens, nowMs?) → { delayMs, releaseId }` inserts a provisional `WindowEntry` with the caller's estimate IMMEDIATELY (at `nowMs + delayMs`, so the entry represents the time tokens actually hit Gemini's counter). Subsequent concurrent `reserve` calls see the provisional and back off. `release(id, actualTokens)` overwrites the estimate with `promptTokenCount` (cached + uncached — both count toward Gemini's per-minute budget, empirically confirmed) post-response AND deletes the id from the reservation index so a late `cancel` on the same id becomes a safe no-op (previously the id lingered, letting a buggy caller silently remove an already-accounted entry). `cancel(id)` removes the provisional entry on any pre-dispatch failure. `shouldDelay` is preserved as a read-only peek for diagnostics / tests / progress-message rendering but is NOT the primary API for tool integration.
- Sorted-array invariant: `entries[model]` is kept sorted ascending by `tsMs` via binary-search insert in `reserve` (not naive `push`). A `delayMs = 0` reservation arriving after a future-dated provisional (hint-driven or eviction-driven delay) has a smaller `tsMs` than the provisional's — without sorted-insert, `prune`'s head-only fast-path silently skips expired entries buried mid-array and `computeWindowDelay`'s oldest-first eviction picks the wrong `entries[k].tsMs` to wait for. Empirically demonstrated during the PR #19 review (Copilot + Grok + Gemini independently flagged) — see the regression-test block "sorted-array invariant" in `test/unit/throttle.test.ts`.
- Multi-entry eviction math: when the window is over-limit, iterate oldest-first and evict entries one at a time until `sum(remaining entries) + estimate ≤ limit`, then wait for the last-evicted entry to age out of the 60s window + randomised jitter. The naïve "wait for just the oldest" implementation under-delays whenever ≥2 large entries remain after the oldest ages out (confirmed empirically: 3×40k entries at t=0/5/10s with limit=80k + estimate=30k → naïve computes 52s wait, but after 52s the t=5s and t=10s entries still sit at 80k in-window → next call busts quota).
- Randomised jitter `[1_000, 3_000]` ms (was a 2_000 ms constant). Deterministic jitter let concurrent waiters evicting the same entry compute identical waits and wake at the same millisecond — re-creating the burst the jitter was meant to prevent. Gemini flagged this during PR #19 review; docstring on `JITTER_MIN_MS` / `JITTER_MAX_MS` explains the invariant.
- `ask.tool.ts` + `code.tool.ts` call `reserve` AFTER both the daily-budget reservation AND `prepareContext` (immediately before `generateContent`). Earlier placement (before `prepareContext`) let the reservation's `tsMs` age-anchor minutes before the actual API dispatch on cold-cache calls, so our window could expire while Gemini's still ran — admitting concurrent callers that busted the per-minute quota. Trade-off: two concurrent cold-cache callers will both complete `prepareContext` before one backs off at `reserve` — mostly idempotent via file-hash dedup, minor upload duplication. If `delayMs > 0`, emit a progress message (`"throttle: waiting 23s for TPM window"`) and `await sleep(delayMs)` before proceeding. On successful response, `release(releaseId, promptTokenCount)`. On any error (including stale-cache retry branch), `cancel(releaseId)` before propagating.
- Respect `retryInfo.retryDelay` from any 429 that fires DESPITE preflight — Google's hint is more accurate than our clock; prefer it. `recordRetryHint(model, retryDelayMs)` is **extend-only**: a shorter new hint replacing a longer existing one would let the next reserve compute a smaller `tsMs` than entries already appended under the longer hint — same ordering break the sorted-insert fix closes, via a different trigger. Only the longer expiry wins. `reserve` uses `max(windowDelay, hintDelay)` while the hint is active.
- Track different models in separate windows (empirically `latest-pro` vs `latest-flash` use different buckets — no reason to block flash when pro is saturated).
- Non-monotonic clock handling: maintain a `lastObservedNowMs` floor at the throttle level (not per-entry, since provisional reservations can be future-dated). Clamp each public-method `nowMs` to `max(nowMs, lastObservedNowMs)` so a backward NTP jump doesn't produce negative `ageMs` arithmetic and inflated delays. Using `entry.tsMs` for the clamp (the obvious implementation) breaks multi-entry math by pinning `now` past real-time into scheduled-call time.
- Input sanitisation: non-finite `nowMs` (NaN, ±Infinity) falls back to `Date.now()` rather than poisoning the floor — consistent with `sanitizeTokens`' "coerce bad caller input rather than crash/deadlock" philosophy. Non-finite / non-positive `estimatedInputTokens` and `actualInputTokens` coerce to 0.
- Unit tests in `test/unit/throttle.test.ts` with fake timers — 40 tests covering: disabled path, single-entry math, multi-entry eviction with post-delay invariant assertion, TOCTOU race (second concurrent caller sees first caller's provisional), release-with-actual-{less,greater}-than-estimate, cancel, idempotency of release/cancel on unknown IDs (including release-after-cancel of same id), unique release IDs, explicit-nowMs `release` prune path, `shouldDelay` non-inflation invariant, oversize-estimate lockout (deliberate 60s block after a single over-limit call), per-model isolation, retry hints, non-monotonic clock, non-finite `nowMs` poisoning guard, input validation. Plus 7 regression blocks added post-PR #19 review: **sorted-array invariant** (delay=0-after-future-dated, retry-hint downgrade, mid-array eviction), **release lifecycle** (double-release idempotent, cancel-after-release no-op), **jitter randomisation** (distinct delays across 20 samples, bounded range).

**Sizing:** ~5 hours including the reserve/release/cancel API rework surfaced during code review. Blocker for heavy-review workflows; without this the MCP is effectively single-shot for pro calls with a big cached context.

**Blocked on:** nothing. Ships cleanest alongside T23 in the same PR (both are "make the MCP usable for back-to-back reviews" fixes), or as a standalone v1.3.x if T19's timeout arrives first (the throttle's delay-before-generate is conceptually orthogonal to the timeout-after-generate).

**Do NOT include in this PR:**
- Any change to the daily-budget reservation logic — that's a $ cap, TPM throttle is a rate cap; different constraints, different code paths.
- Cross-process throttle coordination — in-memory only for v1. Two MCP servers on the same key sharing a TPM pool is T22b.
- Unbounded-map cleanup: the `windows` and `hints` maps grow only with distinct resolved-model strings (O(10) in practice via `resolveModel`'s fixed alias list). Each empty entries-array self-deletes on `prune`; each expired hint self-deletes on `activeHint`. Truly unreachable models linger until server restart — accepted as LOW (bounded by upstream's published model list). Revisit if literal user-supplied model IDs ever bypass `resolveModel`.

---

## T22a. Wire up Gemini 429 `retryInfo.retryDelay` → `recordRetryHint`

**Source:** Scope carry-over from T22 (v1.3.0). The throttle module exposes `recordRetryHint(model, retryDelayMs)` and `reserve` already prefers `max(windowDelay, hintDelay)` while a hint is active. What's missing is wiring the hint up from the `ask`/`code` catch branches when Gemini returns a 429.

**Why:** Even with the T22 preflight throttle correct and honest, a misestimate (under-counted UTF-8 / CJK tokens, new model with different cached-token accounting, tier-boundary drift) can still fire a 429. Google's 429 body includes `retryInfo.retryDelay` (typically 2–16 s — shorter than our 60 s window math, because Google's quota counter is more granular than a simple sliding window). Preferring Google's hint over our clock gets retries right faster and avoids the 60 s worst-case wait our pure-window fallback computes.

**Scope:**
- In `ask.tool.ts` + `code.tool.ts` catch blocks (both the primary `generateContent` catch AND the stale-cache-retry catch), detect 429 from `@google/genai`'s `ApiError` (has a `.status: number` field; check `err.status === 429` with an `instanceof` narrowing on `ApiError`).
- Extract `retryInfo.retryDelay` from the error body. `@google/genai`'s ApiError surfaces the body as part of `err.message` (JSON-encoded). A regex on `/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/` reliably captures the "2s" / "15.7s" string form Google uses. Convert to ms, clamp to `[1_000, 60_000]` so a malformed / future-format value can't deadlock.
- Call `ctx.throttle.recordRetryHint(resolved.resolved, retryDelayMs)` before propagating the error (already-cancel-the-reservation path stays).
- Expose the parsing helper as an exported function in `src/tools/shared/throttle.ts` or a sibling module (e.g. `retry-hint.ts`) so tests can validate it without going through Gemini. Ship with fixture-driven unit tests for: happy-path "2s" / "15.7s" / "0.5s", missing field, malformed JSON, non-429 errors.
- Consider: if the response body can be obtained *without* a 429 (some paths surface structured error info on non-429 too), no-op; the hint path is 429-specific.

**Sizing:** ~1–2 hours including tests. Small PR, shippable in a v1.3.x patch.

**Blocked on:** nothing. Ships any time after v1.3.0.

---

## T23. Surface tool response text as a first-class structured field (wire-format fix)

**Source:** 2026-04-20 session — empirical observation during PR #17 Gemini review retries. Three separate agent attempts reported `"API success but content[0].text not surfaced to sub-agent"` despite Gemini returning full review text in the MCP response. Root cause traced to how Claude Code (and likely other MCP hosts) parse tool results when `structuredContent` is present.

**Why:** `src/tools/registry.ts:51` `textResult(text, structured)` returns the MCP-spec-compliant shape `{content: [{type: 'text', text}], structuredContent: {...}}`. Claude Code's tool-result parser — both for the main conversation UI and for sub-agent tool-use results — consumes **only** `structuredContent` when it's present, treating `content[]` as display-only noise. Effect: our reviewer output gets GENERATED and billed (we count tokens, pay for thinking), but the consumer cannot programmatically read the text. This broke the coderev orchestration pattern three times in one session — each agent got "ok with no extractable findings" because the text was unreachable.

Matters more than it looks: the MCP is **fundamentally useless for code review** while this holds, because every reviewer workflow depends on the reviewer's agent being able to read the answer text to write the review file or emit the `top3` JSON. Users can call `ask`/`code` directly in the main conversation and see the text (because Claude Code DOES render `content[0]` in the main UI) — but any workflow that hands off through a sub-agent silently loses the response.

**Scope:**
- Add `responseText: text` as a first-class field in the `structuredContent` object emitted by `textResult()`. Canonical location both hosts and sub-agents can rely on; zero interpretation ambiguity. Exported as a named constant (`RESPONSE_TEXT_KEY`) from `src/tools/registry.ts` so consumers can import the canonical key rather than hard-coding the string.
- Keep existing `content: [{type: 'text', text}]` — required for MCP spec compliance and for hosts that DO render it (main conversation UI). Duplicating a few-KB string across both fields costs essentially nothing vs losing the whole response.
- `textResult` always emits `structuredContent` (never omits it, even when the caller passes no structured arg) — the invariant sub-agents rely on is "every tool response has `.structuredContent.responseText`", not "only tools that pass metadata do". A tool that emits only a narrative string (e.g. `clear`'s "Cleared cache and manifest for X.") used to produce a response with no structured payload → invisible to sub-agent parsers; now always visible.
- **`errorResult` also mirrors its message into `structuredContent.responseText`.** Same wire-format gap afflicts error paths — a sub-agent seeing `isError: true` but empty structured content could not extract the failure detail. After the fix: `isError: true` signals failure, `structuredContent.responseText` carries detail, parallel to success responses.
- Caller's `responseText` key (if any) is overridden by the canonical text. Tools must not shadow the wire-format contract — the test `test/unit/registry-text-result.test.ts` locks this in.
- Automatically propagates across every tool using `textResult`/`errorResult` — `ask`, `code`, `status`, `reindex`, `clear`. No per-tool edits needed.
- New file `test/unit/registry-text-result.test.ts` — 8 tests covering: mirror invariant when no structured arg, preservation of caller metadata alongside `responseText`, `structuredContent.responseText === content[0].text` across sample text sizes (empty / short / multiline / 10k chars), caller-override semantics, always-emit-structuredContent regression guard, and matching invariants for `errorResult`.
- Document in module header in `src/tools/registry.ts` — rationale, the 2026-04-20 empirical observation (three reviewer-agent runs returning "API success but text not surfaced"), and the "sub-agents depend on a single predictable extraction path" constraint.

**Sizing:** ~2 hours — ~15 lines in `registry.ts` plus named export, 8 tests, comment in module header. Easy to verify: re-run the PR #17 coderev after publish and watch agents successfully extract review text.

**Blocked on:** nothing. Ship ASAP — this is blocking code-review workflows today. Good candidate to pair with T22 in a "reviewer-workflow fixes" PR.

**Do NOT include in this PR:**
- Redesigning the tool-result schema — the fix is purely additive; the current shape stays valid.
- Per-field annotations or content-block metadata tricks — option 3 in the original design doc; less clear than the chosen additive field.
- A separate dedicated `docs/wire-format.md` — the rationale lives in `src/tools/registry.ts` comments where the code lives; a standalone doc would drift from the implementation.

---
