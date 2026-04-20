# Changelog

All notable changes to `@qmediat.io/gemini-code-context-mcp` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
