# Follow-up PRs

Real improvements surfaced by `/6step` and `/coderev` analysis that are out of scope for the v1.0 core PR. Each entry is sized, scoped, and ready to split off once a maintainer picks it up.

---

## T1. Unit test coverage for `cache-manager`, `files-uploader`, `ttl-watcher`, `profile-loader`

**Source:** GPT + Gemini + Grok reviews, April 2026.

**Why:** These files contain the product's core logic (caching, upload, auth resolution) and have only integration-test coverage today. A fast-to-run unit layer with mocked SDK would catch regressions in CI without needing a real `GEMINI_API_KEY`.

**Scope:**
- `cache-manager.test.ts` — mock `@google/genai` client; verify cache-key fingerprint matching, reuse path, rebuild-on-mismatch, inline-fallback threshold, pre-rebuild cache deletion, in-process mutex coalescing.
- `files-uploader.test.ts` — mock SDK; verify dedup by hash, safety-margin re-upload when `expires_at` < now+2h, parallel pool respects concurrency, failures collected in `UploadResult.failures` without throwing.
- `ttl-watcher.test.ts` — fake timers; verify refresh trigger (hot + within-window), skip conditions, manifest writeback.
- `profile-loader.test.ts` — env sandbox; verify priority chain (Vertex → credentials-file → env-var → throw).

**Sizing:** ~3 hours, 4 test files, adds no production deps. Pairs well with a follow-up Vitest mock-setup helper.

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
