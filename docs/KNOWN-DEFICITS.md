# Known deficits

Issues that are partially addressed or have known edge cases left open for future work. Each entry links to the review finding that raised it and explains what we did, what remains, and when it's worth revisiting.

Entries marked **WATCH** are not actively painful today but would become so under specific load patterns or on a specific platform.

---

## TTL watcher — multi-instance coordination

**Source:** Grok code review, April 2026 — "Stale workspace snapshot race across multiple MCP instances".

**Status:** WATCH. Not fixed in v1.0.

**What is the issue?** When two MCP servers run simultaneously against the same `~/.qmediat/` manifest (e.g. two Claude Code windows on the same laptop), both servers' `ttl-watcher` tick at the 5-minute interval. Both read the workspace row, both call `caches.update` on Gemini's side, both write the updated `cacheExpiresAt` back to SQLite. Result: the cache TTL gets extended correctly, but Gemini charges for two `caches.update` requests instead of one, and the SQLite rows race with last-writer-wins semantics (no data corruption — we use `INSERT ... ON CONFLICT DO UPDATE` which is atomic per statement).

**Impact today:** Minimal. `caches.update` is cheap (undocumented micro-fee at most, no noticeable delay). Billing surprise on the order of cents per day even at heavy usage. No correctness issue.

**Why we're not fixing in v1.0:** The obvious fix — `SELECT FOR UPDATE`-style versioned updates with `BEGIN IMMEDIATE` — adds SQLite contention that could worsen single-instance latency for a benefit that most users never see. Better to gather real telemetry from multi-instance users before investing.

**Revisit trigger:** Any user report of "my Gemini bill has unexplained `caches.update` charges" or ≥5 users running multi-instance setups. We'll add either a `last_refresh_at` + client-side throttle (simpler) or a proper versioned-update (cleaner).

**Tracking:** `docs/FOLLOW-UP-PRS.md#ttl-watcher-multi-instance-coordination`.

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
