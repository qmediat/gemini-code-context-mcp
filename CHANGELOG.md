# Changelog

All notable changes to `@qmediat.io/gemini-code-context-mcp` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
