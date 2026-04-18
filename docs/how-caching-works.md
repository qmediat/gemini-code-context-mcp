# How caching works (the 45 s → 2 s story)

Gemini's 2M-token context window is useless if you re-send the whole codebase on every prompt. This server solves that by keeping a **persistent context cache** per workspace.

## The problem

Naive Gemini usage on a 500 k-token repo:

| Step | Cost |
|---|---|
| Serialize workspace → prompt | ~0.5 s |
| Upload tokens to Gemini | ~8–12 s |
| Gemini reads prompt | ~25–35 s |
| Gemini generates | ~3–5 s |
| **Per-query total** | **~35–55 s** |
| **Input billing** | full 500 k tokens every time |

Do that ten times in an afternoon and you've burned $20 in input tokens alone.

## The fix: Files API + Context Cache

```
         first call                         repeat calls
┌──────────────────────────┐        ┌──────────────────────────┐
│  scan workspace           │        │  scan workspace          │
│  sha256 each file         │        │  sha256 each file        │
│  merge into files_hash    │        │  merge into files_hash   │
│                           │        │                          │
│  upload changed files →   │        │  hash matches manifest   │
│    Files API              │        │  → reuse cached context  │
│                           │        │                          │
│  caches.create(           │        │  generateContent(         │
│    model, contents,       │        │    cachedContent: ID,    │
│    ttl: 1h                │        │    contents: prompt      │
│  ) → cache_id             │        │  )                       │
│                           │        │                          │
│  generateContent(         │        │  response in ~2 s,       │
│    cachedContent: ID,     │        │  input tokens billed at  │
│    contents: prompt       │        │  ~25 % of input rate     │
│  )                        │        │                          │
└──────────────────────────┘        └──────────────────────────┘
  ~35–45 s, full input price          ~2–3 s, cached-token price
```

On repeat queries against the same files, the 45-second upload-and-understand phase is replaced by a reference to the existing cache (`cachedContent: cachedContents/abc123`). Gemini doesn't re-tokenize the codebase — it already has it indexed.

## Cache key

A cache entry is reused when **all four** match:

1. `workspace_root` (absolute path)
2. `files_hash` — sha256 of (relpath + content-hash) for every tracked file
3. `model` (resolved model ID, not alias)
4. `system_prompt_hash` — because `ask` and `code` use different system prompts

Change any file → `files_hash` changes → new cache. Switch model → new cache. Ask vs code → different caches (they can both live for the same workspace).

## Manifest

Per-workspace state lives in `~/.qmediat/gemini-code-context-mcp/manifest.db` (SQLite, WAL mode):

- `workspaces(workspace_root, files_hash, model, system_prompt_hash, cache_id, cache_expires_at, ...)`
- `files(workspace_root, relpath, content_hash, file_id, uploaded_at, expires_at)`
- `usage_metrics(tool_name, model, cached_tokens, uncached_tokens, cost_usd_micro, duration_ms, occurred_at)`

The `files` table enables **hash-based dedup**: if you rename `utils/a.ts` → `lib/a.ts` with unchanged content, we reuse the existing Files API upload.

## TTL management

Gemini caches expire. The default TTL is 3600 s (1 hour) — configurable via `GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS`.

A background `ttl-watcher` refreshes caches for **hot workspaces** (used in the last 10 minutes). Cold workspaces are allowed to expire; the next query will rebuild automatically.

Files API uploads are auto-deleted by Google after **48 hours**. We track `expires_at = upload_time + 47 h` and re-upload when needed. The dedup path on subsequent runs keeps this cheap: unchanged files stay uploaded, only changed files hit the API.

## What invalidates the cache

| Change | Result |
|---|---|
| Edit a tracked file | New `files_hash` → rebuild on next `ask`/`code` |
| Add/remove a tracked file | New `files_hash` → rebuild |
| Switch model (alias resolution or explicit) | New cache keyed on `(workspace, hash, model, prompt)` |
| Switch tool (ask ↔ code) | New cache (different system prompts) |
| `reindex` tool called | Cache deleted, manifest cleared; next call rebuilds |
| `clear` tool called | Same as reindex, no re-scan |
| Cache TTL expires on cold workspace | Rebuild on next call |

## When caching is skipped

The server falls back to inline file parts (slower, more expensive) when:

- The user passes `noCache: true` on `ask`
- The cache build call fails (network, quota, unsupported model)
- The workspace has zero matching files

## Observability

Run `status` to see exactly what's happening:

```
workspace:       /Users/me/Projects/myapp
current cache:   cachedContents/abc123 (47m remaining)
model:           gemini-3-pro-preview
tracked files:   184
usage:
  calls:         12
  cached tokens: 6,312,400
  input tokens:  82,100
  total cost:    $0.8243
  last 24h:      $0.1120
```
