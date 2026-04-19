# Changelog

All notable changes to `@qmediat.io/gemini-code-context-mcp` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
