# Known deficits

Issues that are partially addressed or have known edge cases left open for future work. Each entry links to the review finding that raised it and explains what we did, what remains, and when it's worth revisiting.

Entries marked **WATCH** are not actively painful today but would become so under specific load patterns or on a specific platform.

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
