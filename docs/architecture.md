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
- `retry.ts` wraps `generateContent` / `generateContentStream` calls in `withNetworkRetry` to ride out Node undici's `TypeError: fetch failed` — a pre-response failure shape the SDK's pinned `p-retry` 4.6.2 treats as non-retryable. Exponential backoff (1s → 3s → 9s, 3 attempts); non-transient errors (`.status`-bearing, `AbortError`, validation) propagate on the first failure. *(v1.6.0+)* `withNetworkRetry` accepts an `AbortSignal` so a tool-level `timeoutMs` can short-circuit the retry loop; `abortableSleep` makes the inter-attempt backoff itself abortable. See [`./KNOWN-DEFICITS.md`](./KNOWN-DEFICITS.md) for the upstream-dependency rationale.

### `src/tools/shared/`

- `abort-timeout.ts` *(v1.6.0+)* — `createTimeoutController(perCallMs, envVarName)` returns a `{ signal, dispose, timeoutMs }` triple. Resolution: per-call schema parameter > tool-specific env var > disabled. Bounded `[1000, 1_800_000]` ms. Disabled controllers return a never-firing signal so call sites pass it unconditionally. `isTimeoutAbort(err)` walks `error.cause` chains (depth-bounded, cycle-safe) to map a `DOMException('TimeoutError')` from the SDK back to `errorCode: 'TIMEOUT'`.
- `stream-collector.ts` *(v1.7.0+)* — `collectStream(stream, opts)` consumes the SDK's `AsyncGenerator<GenerateContentResponse>` and accumulates chunks into a `CollectedResponse` with the same surface area as the old `generateContent` return: `text` concatenated across all chunks, `usageMetadata` last-write-wins (Gemini sends only on the final chunk), `candidates` last-non-empty-wins, `thoughtsSummary` joined and capped at 1200 chars. Throttled `onThoughtChunk` callback fires for each `thought: true` part — `ask`/`code` wire this into the MCP progress emitter as `"thinking: <truncated>…"` notifications (default throttle 1500 ms). Pre-flight + mid-stream abort checks; closes the generator and rethrows the signal's reason. `withNetworkRetry` wraps the stream OPENING (not chunks); a mid-stream failure is unrecoverable per Gemini's API (no resume).

### `src/indexer/`

Walks a workspace directory:

- `globs.ts` holds curated include/exclude patterns (source-code extensions in, `node_modules`/`.git`/etc. out).
- `hasher.ts` produces sha256 per file with an in-memory cache keyed by `(path, mtime, size)` to avoid re-reading unchanged files.
- `workspace-scanner.ts` recursively walks, filters, hashes, and returns a `ScanResult` with a stable `filesHash`.

### `src/cache/`

The magic:

- `files-uploader.ts` uploads scanned files to the Gemini Files API, deduping by content hash against the manifest. Files API enforces a 48 h auto-delete; we track `expires_at = uploaded_at + 47 h` for a safety margin.
- `cache-manager.ts` creates Gemini Context Caches keyed by `(workspaceRoot, filesHash, model, systemPromptHash)`. Falls back to inline file parts when caching isn't supported or the API rejects the build.
- `ttl-watcher.ts` runs a 5-minute tick. Hot workspaces (used in the last 10 minutes) get their cache TTL refreshed via `caches.update`. Cold workspaces expire.

### `src/manifest/`

`better-sqlite3` in WAL mode. Single-file schema with workspaces / files / usage_metrics tables. Transactional, no daemon, no network. The schema is inlined in `db.ts`; `schema.sql` is the human-readable source of truth.

### `src/tools/`

Five MCP tools, each validated by a Zod schema and wired into the registry:

- **`ask`** — Q&A, long-context analysis. Uses cache.
- **`code`** — coding delegation. Enables `thinkingConfig` + optional `codeExecution`. Parses OLD/NEW diff output so Claude Code can apply edits.
- **`status`** — inspection tool. Lists available models, cache state, usage/cost.
- **`reindex`** — force rebuild the cache (skip hash-diff optimization).
- **`clear`** — drop cache + manifest for a workspace.

### `src/server.ts` + `src/index.ts`

Standard MCP stdio bootstrap:

- `ListToolsRequestSchema` → returns `TOOLS.map(t => { name, title, description, inputSchema: zodToJsonSchema(t.schema) })`
- `CallToolRequestSchema` → parses args through Zod, constructs a `ToolContext`, awaits `tool.execute`
- SIGINT/SIGTERM → graceful shutdown: stop TTL watcher, close DB, close MCP server
- Entrypoint dispatches `init` subcommand vs server mode

## Design choices worth calling out

- **SDK over CLI.** Original plan wrapped the `gemini` CLI. Three LLM consultations (GPT-5.3-codex, Gemini 3.1 Pro, Grok 4.20-reasoning) agreed this was fragile: subprocess overhead, brittle headless auth, no connection pooling, and `@file` syntax we'd have to replicate anyway. SDK gives us direct access to Files API + Caches primitives which are the actual moat.
- **Local-only state.** The manifest DB never leaves the user's machine. Zero telemetry by default.
- **exactOptionalPropertyTypes.** TypeScript strict mode including `exactOptionalPropertyTypes` is on. Optional fields are either present or omitted, never `undefined`. Surfaces real bugs at the cost of more precise type gymnastics at the SDK boundary.
- **No Dockerfile.** Node 22 + better-sqlite3 native module + MCP stdio transport do not play well inside a container from Claude Code's perspective. `npx` installs in one line; that's the right primitive.
- **Zod at the boundary, not internally.** We trust our own types once they've crossed the MCP boundary.
