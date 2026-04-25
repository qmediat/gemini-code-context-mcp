# Known deficits

Issues that are partially addressed or have known edge cases left open for future work. Each entry links to the review finding that raised it and explains what we did, what remains, and when it's worth revisiting.

Entries marked **WATCH** are not actively painful today but would become so under specific load patterns or on a specific platform.

---

## Reviewer / code-review workflows broken without client-side TPM throttle + wire-format fix

**Source:** 2026-04-20 session — PR #17 three-way code review aborted three times on Gemini-side 429s plus missing `content[0].text` in sub-agent tool results.

**Status:** Blocker for reviewer workflows. Tracked as T22 (throttle) + T23 (wire format) in [`FOLLOW-UP-PRS.md`](./FOLLOW-UP-PRS.md). Both must ship before the MCP is reliable for `/coderev`-style sub-agent pipelines. Direct main-context use of `ask`/`code` still works fine (Claude Code renders `content[0].text` in the UI).

**What is the issue?** Two compounding problems:

1. **No client-side TPM preflight.** Google enforces ~100_000 input tokens/minute on paid Tier 1 Gemini 3 Pro (empirically confirmed via 429 payload's `quotaValue`). Workspaces with a large Context Cache (~108k cached tokens is typical for a modest repo) saturate that limit on the FIRST follow-up call — cached tokens count toward the input-TPM quota. We discover the limit only when Gemini returns 429, at which point the billable round-trip has already happened. Sub-agents defensively sleep 70 s and retry, which works but eats ~2 minutes per call plus burns extra 429 round-trips. See `.claude/local-gemini-rate-limits.md` (gitignored) for the empirical dump.

2. **`content[0].text` is invisible to sub-agents.** `textResult()` in `src/tools/registry.ts:51` emits `{content: [{type: 'text', text}], structuredContent: {...}}`. Claude Code's sub-agent tool-result parser consumes ONLY `structuredContent` when present, treating `content[]` as display-only. So our reviewer output is generated + billed, but the sub-agent cannot read it to write a review file. Three Gemini-review agents in this session returned "API success but text not surfaced" for exactly this reason.

**Impact today:** Any MCP workflow that depends on reading the narrative response inside a sub-agent (coderev pattern, synth pattern, fix-planner pattern) silently fails. The response comes back as "ok, 0 findings" because the agent can't extract the text. Main-context direct use is fine — Claude Code renders `content[0]`.

**Why not fixing immediately:** Each fix is ~2-4 hours and they pair well together as a "reviewer-workflow fixes" PR. Landing them alongside the already-ready v1.2.0 (PR #17 T21 + PR #18 home-reject) would inflate scope; sequencing them as v1.3.x keeps per-release review quality high. Priority is HIGH — this is the next PR to open after v1.2.0 ships.

**Revisit trigger:** Immediate — schedule T22 + T23 as the next PR after v1.2.0 publish.

---

## `ask({ thinkingBudget })` — Gemini 3 Pro hangs on low values with cached content

**Source:** Smoke testing the `ask({ thinkingBudget })` PR, April 2026.

**Status:** Default path sidesteps the issue (we OMIT `thinkingBudget` on the wire when the caller didn't supply one, letting Gemini use its native HIGH-dynamic default — Google's recommended approach per ai.google.dev/gemini-api/docs/gemini-3). The hang is still reachable if a caller explicitly passes a low positive `thinkingBudget`; schema description warns about this. No client-side timeout guard in v1.1.

**What is the issue?** Empirically reproduced against `gemini-pro-latest` (Gemini 3 Pro) using the MCP `ask` tool with an active Context Cache hit:

- `thinkingBudget: -1` (dynamic) — responds in ~10 s ✅
- `thinkingBudget: 4096` — responds in ~14 s ✅
- `thinkingBudget: 256` — **request hangs with no response**, no `400`, no `429`, no progress. Only resolved by SIGTERM at 90 s. ❌
- `thinkingBudget: 0` — Gemini returns `400 INVALID_ARGUMENT: "Budget 0 is invalid. This model only works in thinking mode."` ✅ (graceful)

Root cause is on Google's side: Gemini 3 Pro is a "thinking-only" model with an undocumented minimum thinking budget, and the API fails to reject requests below that minimum — it just stalls. The behaviour does not reproduce on `gemini-2.5-pro` (which honours any non-zero budget) or on fresh cache builds (only `cachedContent + low thinkingBudget` together trip it). We cannot observe the minimum from the model registry: `supportsThinking: true` does not imply "low budgets are fine", and `thinkingTokenLimit` is not exposed.

**Impact today:** Any caller who explicitly passes `thinkingBudget` below Gemini 3 Pro's internal floor experiences a 90-180 s hang that looks like a server issue on our side. The default path (omitting `thinkingBudget` entirely — v1.2+ behaviour) and explicit values ≥1024 are unaffected. Most users never set the knob — default-path users are unaffected.

**Why we're not fixing fully in v1.1 / v1.2:**
1. We don't know the true minimum — it could change model-by-model and release-to-release. A hard-coded floor (e.g. "clamp `0 < N < 1024` up to 1024") would be brittle and would surprise callers who intended `256` on a 2.5 model.
2. **Client-side timeouts are deliberately NOT shipped** in v1.1 or v1.2. Gemini 3 Pro on HIGH reasoning can legitimately run 2–3 minutes on complex code questions — we empirically observed a clean 178 s call during v1.2 smoke testing. A default timeout in that range would kill legitimate long-thinking sessions; a longer default wouldn't actually bound anything useful. And `@google/genai`'s `AbortSignal` is client-only (*"Using it to cancel an operation will not cancel the request in the service. You will still be charged usage for any applicable operations"* — SDK d.ts:1425-1427) — so aborting only hides the response, we still pay. **Per-call timeout will ship as env-var opt-in in a follow-up PR (T19 in [`FOLLOW-UP-PRS.md`](./FOLLOW-UP-PRS.md)), default disabled.**
3. **We also don't have in-flight thinking progress signal today.** Gemini API has no formal heartbeat; the SDK's `generateContentStream` returns progressive chunks (including `thought: true` parts during reasoning) which would serve as a de facto heartbeat, but `ask`/`code` use the non-streaming `generateContent` call. **Stream migration tracked as T20 in [`FOLLOW-UP-PRS.md`](./FOLLOW-UP-PRS.md)** — it pairs naturally with T19 (stream heartbeat + optional timeout abort = closes the loop).
4. The default path (omit `thinkingBudget`, or use `thinkingLevel` on Gemini 3) already avoids the hang entirely — explicit `thinkingBudget` values are opt-in. Schema descriptions on both `ask` params warn about the Gemini 3 caveat. v1.2 adds first-class `thinkingLevel` (MINIMAL/LOW/MEDIUM/HIGH) as Google's recommended knob on Gemini 3, replacing the problematic low-budget path for callers who want discrete reasoning control.

**Revisit trigger:** (a) user reports of `ask` hanging with explicit `thinkingBudget` values, or (b) Gemini publishes the per-model thinking minimums in the model registry. At that point we can add either a registry-driven floor or an adaptive timeout.

**Tracking:** `docs/FOLLOW-UP-PRS.md` — add a "gemini thinking budget timeout guard" item when concrete numbers are available.

---

## Zod `.refine()` cross-field constraints don't round-trip through `zod-to-json-schema`

**Source:** April 2026 three-way code review on PR #16 (Gemini P2 finding).

**Status:** WATCH. Not fixed; documented in schema descriptions instead.

**What is the issue?** Our `askInputSchema` enforces `thinkingBudget ⊕ thinkingLevel` (mutually exclusive) via a `.refine()` at the root (`src/tools/ask.tool.ts:114-118`). Runtime Zod validation catches any caller that sets both and returns a clear `"Cannot specify both ... mutually exclusive"` error before we hit Gemini. However, `zod-to-json-schema` (used in `src/tools/registry.ts:92` to expose `inputSchema` in MCP `tools/list`) does **not** emit `.refine()` constraints into the generated JSON Schema — it has no canonical mapping from an arbitrary refinement predicate to JSON Schema's `not`/`oneOf`/`dependentSchemas` keywords. The schema surface visible to MCP clients therefore shows both fields as independent optionals, and clients that rely on the schema alone (not on description docs or runtime probes) will allow a caller to set both.

**Impact today:** LLM-based clients (Claude, GPT) read field descriptions before constructing a call — both `thinkingBudget` and `thinkingLevel` descriptions explicitly state the mutual-exclusion rule, so these clients avoid the combination. Form-rendering MCP clients that only consume the JSON Schema can present both fields as checkable, then get a runtime error. The error path (`path: []` after finding F6 fix) renders at the schema root, which is the correct spot for a cross-field violation. Net effect: minor UX wart on non-LLM clients; clear error message; no safety or cost consequence.

**Why not fixing fully:** The alternative is a `z.discriminatedUnion` / `z.union` schema shape, which generates `oneOf` in JSON Schema but significantly complicates the inferred `AskInput` TypeScript type and forces call-site code to narrow by discriminator. For a constraint this simple, the ergonomic cost outweighs the JSON Schema fidelity gain — especially since our primary consumers are LLMs reading descriptions.

**Revisit trigger:** A non-LLM MCP client ships that renders tools with hydra-form UIs and can't preview cross-field constraints, AND a user reports frustration with the runtime-only error.

**Tracking:** no follow-up PR — revisit only on the trigger above.

---

## TTL watcher — multi-instance coordination

**Source:** Grok code review, April 2026 — "Stale workspace snapshot race across multiple MCP instances".

**Status:** WATCH. Not fixed in v1.0.

**What is the issue?** When two MCP servers run simultaneously against the same `~/.qmediat/` manifest (e.g. two Claude Code windows on the same laptop), both servers' `ttl-watcher` tick at the 5-minute interval. Both read the workspace row, both call `caches.update` on Gemini's side, both write the updated `cacheExpiresAt` back to SQLite. Result: the cache TTL gets extended correctly, but Gemini charges for two `caches.update` requests instead of one, and the SQLite rows race with last-writer-wins semantics (no data corruption — we use `INSERT ... ON CONFLICT DO UPDATE` which is atomic per statement).

A related but distinct race lives in `prepareContext` itself: if both instances take a cache-miss at the same time, both upload files (benign — dedup by content-hash in the shared `files` table) and both call `caches.create`, then both `upsertWorkspace`. Last writer wins, and the *losing* instance's `cacheId` is orphaned on Gemini's side until its TTL expires. Today this is rare (requires two servers hitting the same cold workspace within the upload window) but the cost per orphan is real (cache storage + cache token-hour rate).

**Impact today:** Minimal. `caches.update` is cheap (undocumented micro-fee at most, no noticeable delay). Billing surprise on the order of cents per day even at heavy usage. No correctness issue.

**Why we're not fixing in v1.0:** The obvious fix — `SELECT FOR UPDATE`-style versioned updates with `BEGIN IMMEDIATE` — adds SQLite contention that could worsen single-instance latency for a benefit that most users never see. Better to gather real telemetry from multi-instance users before investing. The `caches.create` race needs a different tool (cross-process `workspace_locks` table with conditional `cache_id` updates), so the full fix is bigger than the `last_refresh_at` throttle sketched in T3.

**Revisit trigger:** Any user report of "my Gemini bill has unexplained `caches.update` charges" or ≥5 users running multi-instance setups. We'll add either a `last_refresh_at` + client-side throttle (simpler) or a proper versioned-update (cleaner).

**Tracking:** `docs/FOLLOW-UP-PRS.md#ttl-watcher-multi-instance-coordination`.

---

## Symlinked directories — silently skipped

**Source:** Post-release bug hunt, April 2026 (B9).

**Status:** Documented; not fixed in v1.0.

**What is the issue?** `src/indexer/workspace-scanner.ts` iterates `fs.readdir(..., { withFileTypes: true })` and recurses only when `entry.isDirectory()` is true. `Dirent.isDirectory()` returns `false` for symbolic links pointing at directories — it does NOT follow. `entry.isFile()` is likewise `false` for symlinks. Net effect: symlinks are **entirely skipped**, in both directions. Workspaces that rely on symlinks — pnpm `node_modules/.pnpm/*` (already excluded, moot), yarn workspaces with `packages/*` symlinks, monorepo root layouts with `apps/web → ../services/web`, dev-env fixtures — appear to Gemini as if those directories were absent, producing "file not found" responses for code the user thinks is in the workspace.

**Impact today:** Security-neutral (we don't follow symlinks into e.g. `/etc`). Correctness cost: degraded answers for users whose repo structure uses symlinked packages. No diagnostic warning is emitted when a symlink is skipped — users currently debug this by staring at `status` output and noticing the `filesIndexed` count is lower than expected.

**Why we're not fixing fully:** Following symlinks requires cycle-detection via canonical-path (`realpath`) tracking + same-filesystem checks + a per-workspace config knob for users who deliberately want to skip symlinks. Correct handling is ~30-60 lines with tests; we want to make sure we get it right rather than bolt it onto a security PR.

**Workaround for affected users:** Replace symlinked package dirs with hardlinks or direct subdirs, or add the symlink target's real path to `includeGlobs` at the tool call. Neither is discoverable without reading this note — hence the tracked follow-up.

**Revisit trigger:** ≥3 user reports of "Gemini doesn't see my packages/* code" or explicit demand from a known monorepo user.

**Tracking:** `docs/FOLLOW-UP-PRS.md` — planned T-number TBD when a maintainer picks it up.

---

## Credentials dir — chmod follows symlinks (Unix TOCTOU window)

**Source:** Post-release bug hunt, April 2026 (B10), complements the existing Windows ACL entry below.

**Status:** WATCH. Partial mitigation (warn on chmod failure) shipped in v1.0.3; full hardening deferred.

**What is the issue?** `saveProfile()` in `src/auth/credentials-store.ts` does `mkdirSync(dir, { mode: 0o700 })` only if the dir doesn't yet exist, then unconditionally `chmodSync(dir, 0o700)`. `chmodSync` follows symbolic links (POSIX `chmod(2)`, not `lchmod`). A local attacker who controls write access to `$XDG_CONFIG_HOME` can pre-plant `~/.config/qmediat → /tmp/evil`; the chmod then adjusts permissions on `/tmp/evil`, not on our intended directory. The subsequent `writeFileSync(tmpPath, content, { mode: 0o600, flag: 'wx' })` uses `O_EXCL` so it cannot overwrite an attacker-planted target file, but the tmp path ends up inside the attacker-controlled directory — the content is protected by 0o600 on the file itself, but the file's location is not where the user expects.

**Impact today:** Narrow. Exploitation requires a local attacker who already has write access to the user's config directory — at which point they have many other attack vectors. The credentials file is still written with 0o600, so its *contents* remain protected from other local users even in the attack scenario.

**Why we're not fixing fully:** Proper defense is `fs.lstatSync(dir).isSymbolicLink()` + refuse-if-symlink *before* any chmod/write. That's 10 lines, but it rejects a legitimate setup on systems where `$XDG_CONFIG_HOME` is itself a symlink (common on servers with separate `/home` vs `/var/config` layouts). We'd need a config knob to allow intentional symlinks. Tracked for a dedicated security-hardening PR.

**Revisit trigger:** Any report of unexpected credentials file location, or a concrete symlink-attack path against the MCP server.

---

## ~~Budget reservation rows inflate `status` cost while a call is in flight~~ ✅ CLOSED v1.7.0

**Original source:** Self-review of v1.0.3 atomic-budget implementation, April 2026 (SR3).

**Closed by D#7 in v1.7.0:** `status` now surfaces in-flight reservations as a separate field. `spentTodayUsd` and `usage.totalCostUsd` keep their conservative-upper-bound semantics (settled + in-flight, so daily-budget enforcement stays a true cap). New companion fields `spentTodaySettledUsd`, `inFlightReservedTodayUsd`, `usage.settledCostUsd`, and `usage.inFlightReservedUsd` give operators the breakdown. Human-readable output appends `"(settled $X + $Y in-flight reserved)"` only when in-flight is non-zero — no noise on the common path.

The original "duration_ms = 0 conflates with sub-ms calls" objection is moot in practice: every call goes through `withNetworkRetry → generateContentStream` which guarantees a measurable wall-clock duration (the round-trip alone exceeds 1 ms by orders of magnitude). The flag stays load-bearing.

**Implementation:** `ManifestDb.todaysInFlightReservedMicros(nowMs)` + `inFlightReservedMicros` on `workspaceStats()` use a `WHERE duration_ms = 0` filter on `usage_metrics`. 3 unit tests in `manifest-db.test.ts` pin the contract.

---

## TTL watcher — rolling-window edge case

**Source:** Gemini code review, April 2026 — "TTL watcher breaks rolling-window expectation".

**Status:** WATCH. Not fixed in v1.0.

**What is the issue?** The watcher only refreshes a cache's TTL when it's within 15 minutes of expiry AND the workspace was used in the last 10 minutes. A user who queries at t=0, again at t=20m, then pauses 35 minutes and returns at t=55m will find the cache expired even though they were "still working on it" from their perspective.

**Impact today:** Edge case — most users either query often (kept hot) or step away for long enough that cache expiry is the right call. The only users hurt are those who pause 20-40 minutes between queries on a single workspace.

**Why we're keeping current behavior:** The alternative — refresh on every tick regardless of expiry runway — doubles the `caches.update` API traffic for marginal benefit. Current rolling-window is a deliberate cost/reliability trade-off documented in [`how-caching-works.md`](./how-caching-works.md).

**Workaround for affected users:** Lower `GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS` matters less here — the issue is the REFRESH threshold, not the base TTL. Longer-running sessions benefit from explicit `reindex` after idle periods, which forces a fresh cache.

**Revisit trigger:** Telemetry or user reports showing a meaningful fraction of queries hit cold caches due to this specific pattern.

---

## Windows — credential file ACLs

**Source:** Grok code review, April 2026 — "chmodSync is a no-op on Windows (silent security downgrade)".

**Status:** Partial. Warning emitted; no programmatic ACL lockdown.

**What is the issue?** `chmodSync(path, 0o600)` has no effect on NTFS — the credential file inherits ACLs from its parent directory (`%USERPROFILE%\.config\qmediat\`). On default single-user Windows installs this is owner-only and safe; on shared machines with "Users" or "Everyone" on the profile it's readable by other local users.

**What v1.0 does:** On Windows, `saveProfile` emits a warning at write time directing the user to verify ACLs via `icacls "<path>"`. We do not run `icacls` ourselves because it adds a shell-out dependency and the enterprise-machine case (where ACLs matter) typically has group-policy-enforced ACLs already.

**Why we're not fixing fully:** Proper NTFS ACL manipulation requires either (a) a native module (`node-windows-acl`), which bloats the npm package with platform binaries, or (b) shelling to `icacls` with its own failure modes. Neither is justified by observed Windows user volume in v1.0.

**Revisit trigger:** Windows users reaching ≥10 % of installs, or any user report of accidental credential exposure on a shared Windows machine.

---

## Token estimation heuristic (4 bytes/token)

**Source:** Grok + prior `/6step` analysis.

**Status:** Documented caveat, not a bug.

**What is the issue?** We estimate workspace tokens as `size / 4 bytes` to decide whether to attempt `caches.create` (Gemini requires ≥1024 tokens). Minified JavaScript and CJK source tokenize denser (1 token per 2-3 bytes), so our estimate under-counts — a genuinely large workspace may look "too small" and skip caching.

**Why it's OK:** The defensive direction is correct — we err on the side of "skip cache, use inline". If we were to overestimate instead, we'd hit the 400-response fallback path and log noise, which is strictly worse UX.

**Workaround:** Operators can lower the floor via `GEMINI_CODE_CONTEXT_CACHE_MIN_TOKENS=700` (or similar) to make the server attempt caching on workspaces our estimate says are borderline. The SDK try/catch still catches real rejections.

**Revisit trigger:** First real-world benchmark showing the estimator systematically blocking caching for workspaces that would benefit.

---

## `@google/genai` SDK retry path cannot recognise Node undici `TypeError: fetch failed`

**Source:** v1.5.1 root-cause investigation — transient `fetch failed` in `ask_agentic` surfaced twice in production on a real-world large-repo review, with no SDK-level retry kicking in despite the availability of `httpOptions.retryOptions`.

**Status:** Mitigated at the application layer (`src/gemini/retry.ts` → `withNetworkRetry`), which wraps every `generateContent` call in `ask`, `code`, and `ask_agentic`. Upstream dependency limitation documented here so the application retry can be scoped down once the SDK fixes it.

**What is the issue?** `@google/genai` 1.50.x delegates its optional retry wrapper to `p-retry` 4.6.2 (pinned via the SDK's own `package.json`). `p-retry` 4.6.2's `isNetworkError` whitelist is browser-era only:

```js
const networkErrorMsgs = [
    'Failed to fetch',                                    // Chrome
    'NetworkError when attempting to fetch resource.',    // Firefox
    'The Internet connection appears to be offline.',     // Safari
    'Network request failed',                             // cross-fetch
];
```

Any `TypeError` whose message is outside this list is routed to `operation.stop()` → immediate reject, zero retries. Node 18+ undici (Node's built-in `fetch`) emits `TypeError: fetch failed` for EVERY pre-response failure — TCP reset, DNS hiccup, TLS handshake timeout, connection aborted mid-stream, upstream brief connection drop. That string is NOT in the whitelist, so the SDK cannot retry it even when the caller opts into `httpOptions.retryOptions`.

**Why we do not enable `httpOptions.retryOptions` in `createGeminiClient`:** Briefly tried during v1.5.1 development. The SDK's retry path wraps responses through `p-retry`, and for non-retryable HTTP statuses (400 / 401 / 403 …) it replaces the informative Gemini error body (`ApiError: {"error":{"code":400,"status":"INVALID_ARGUMENT", …}}`) with `"Non-retryable exception Bad Request sending request"` — stripping the structured details our integration smoke test and user-visible error messages rely on. Since `p-retry` 4.6.2 also fails to address the actual transient case (`TypeError: fetch failed`), turning SDK retry on costs error clarity for zero benefit.

**Impact today:** None for users running v1.5.1+ — `withNetworkRetry` covers the gap. Older releases would drop a long `ask_agentic` run on a single transient network blip (empirical ~18–26 % per invocation at 20–30 iterations with 1 % per-call transient rate).

**Revisit trigger:** `@google/genai` bumps its `p-retry` dependency to 6.x (which uses the `is-network-error` package and recognises Node undici errors natively). At that point the app-layer retry can be narrowed — either to HTTP status codes the SDK still misses, or removed entirely. Track upstream via `@google/genai` release notes.
