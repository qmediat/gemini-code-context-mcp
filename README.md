# `@qmediat.io/gemini-code-context-mcp`

> **Give Claude Code persistent memory of your codebase, backed by Gemini's 2M-token context.**
> Turn repeat code-review queries into second-scale responses — same codebase, same answers, a fraction of the cost.

[![npm version](https://img.shields.io/npm/v/@qmediat.io/gemini-code-context-mcp.svg)](https://www.npmjs.com/package/@qmediat.io/gemini-code-context-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![Node ≥22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](./package.json)

---

## Why this server?

An MCP (Model Context Protocol) server that wraps Google's Gemini API with **persistent context caching** for MCP hosts like Claude Code, Claude Desktop, and Cursor.

|  | [jamubc/gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool) | **`@qmediat.io/gemini-code-context-mcp`** |
|---|---|---|
| Maintenance | Abandoned (last release 2025-07) | Actively maintained |
| Default model | Hardcoded `gemini-2.5-pro` (main) — no runtime override | Dynamic `latest-pro` alias — resolves against your API key tier at startup |
| Backend | Shells out to `gemini` CLI (subprocess per call) | Direct `@google/genai` SDK |
| Repeat queries | No caching layer — each call re-tokenises referenced files | **Files API + Context Cache** — repeat queries reuse the indexed codebase; cached input tokens billed at ~25 % of the uncached rate |
| Coding delegation | Prompt-injection `changeMode` (OLD/NEW format in system text) | Native `thinkingConfig` + optional `codeExecution` |
| Auth | Inherits `gemini` CLI auth (browser OAuth via `gemini auth login`, or env var) | 3-tier: Vertex ADC / credentials file (chmod 0600 atomic write) / env var (+ warning) |
| Cost control | — | Daily budget cap in USD (`GEMINI_DAILY_BUDGET_USD`) |
| Dead deps | 5 unused packages (`ai`, `chalk`, `d3-shape`, `inquirer`, `prismjs`) | Zero dead deps |

> *Comparison points reference `jamubc/gemini-mcp-tool` as seen on its GitHub `main` branch (most current snapshot, last commit 2025-07-23). The published npm v1.1.4 is ~9 months older and differs in a few specifics — default model is `gemini-3.1-pro-preview` there instead of `gemini-2.5-pro`, and only 3 of the 5 deps are dead in that tarball (`chalk` and `inquirer` still imported). The structural claims (hardcoded model, no caching, `gemini` CLI backend, unreleased improvements stuck behind an abandoned npm registry entry) hold for both.*

## Quick start

```bash
# 1. Secure credential setup (your key never touches ~/.claude.json)
npx @qmediat.io/gemini-code-context-mcp init

# 2. Paste this into ~/.claude.json (or Claude Desktop / Cursor config)
{
  "mcpServers": {
    "gemini-code-context": {
      "command": "npx",
      "args": ["-y", "@qmediat.io/gemini-code-context-mcp"],
      "env": { "GEMINI_CREDENTIALS_PROFILE": "default" }
    }
  }
}

# 3. Restart your MCP host. Ask Claude:
#    > Use gemini-code-context.ask to summarize this codebase
```

First query: ~30–45 s (scan + upload + cache build). Every follow-up: ~2–3 s.

See [`docs/getting-started.md`](./docs/getting-started.md) for a 3-minute walkthrough.

## Tools

| Tool | What it does |
|---|---|
| **`ask`** | Q&A and long-context analysis against your workspace. Uses persistent context cache. |
| **`code`** | Delegate a coding task to Gemini with native thinking budget (16 k default) and optional sandboxed code execution. Returns structured OLD/NEW diffs Claude Code can apply directly. |
| **`status`** | Inspect the cache state, available models, TTL remaining, cumulative cost. |
| **`reindex`** | Force a fresh cache rebuild for this workspace. |
| **`clear`** | Delete the cache and manifest for this workspace. |

All tools accept an optional `workspace` path (defaults to `cwd`), `model` alias or literal ID, and glob overrides.

## Installation methods

| Method | Config |
|---|---|
| **npx (recommended)** | `"command": "npx", "args": ["-y", "@qmediat.io/gemini-code-context-mcp"]` |
| **Global install** | `npm install -g @qmediat.io/gemini-code-context-mcp` → `"command": "gemini-code-context-mcp"` |
| **Local dev** | `git clone …; npm install; npm run build` → `"command": "node", "args": ["/path/to/dist/index.js"]` |

## How the caching works

```
         first call                         repeat calls
┌──────────────────────────┐        ┌──────────────────────────┐
│  scan workspace           │        │  scan workspace          │
│  sha256 each file         │        │  sha256 each file        │
│  merge → files_hash       │        │  merge → files_hash      │
│                           │        │                          │
│  upload changed files →   │        │  hash matches manifest   │
│    Files API              │        │  → reuse cached context  │
│                           │        │                          │
│  caches.create(model,     │        │  generateContent(         │
│    contents, ttl=1h)      │        │    cachedContent: ID,    │
│    → cache_id             │        │    contents: prompt      │
│                           │        │  )                       │
│                           │        │                          │
│  generateContent(         │        │  response in ~2 s at     │
│    cachedContent: ID,     │        │  ~25 % input cost         │
│    contents: prompt       │        │                          │
│  )                        │        │                          │
└──────────────────────────┘        └──────────────────────────┘
  ~35–45 s, full input price          ~2–3 s, cached-token price
```

Deep dive: [`docs/how-caching-works.md`](./docs/how-caching-works.md).

## Configuration

Every env var, auth tier, and per-call override lives in [`docs/configuration.md`](./docs/configuration.md).

| Key vars | Default | |
|---|---|---|
| `GEMINI_CREDENTIALS_PROFILE` | `default` | Profile name in the credentials file |
| `GEMINI_API_KEY` | — | Fallback (Tier 3; emits a warning) |
| `GEMINI_USE_VERTEX` + `GOOGLE_CLOUD_PROJECT` | — | Enable Vertex AI backend |
| `GEMINI_DAILY_BUDGET_USD` | unlimited | Hard cap on daily spend |
| `GEMINI_CODE_CONTEXT_DEFAULT_MODEL` | `latest-pro` | Alias or literal ID |
| `GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS` | `3600` | Cache TTL |
| `GEMINI_CODE_CONTEXT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Migrating from `gemini-mcp-tool`

One-line change in `~/.claude.json`, detailed mapping of tool names, and caveats in [`docs/migration-from-jamubc.md`](./docs/migration-from-jamubc.md).

## Security

- API key stored in `~/.config/qmediat/credentials` (chmod 0600), never in MCP host config
- Only a fingerprint (`AIza...xyz9`) appears in logs
- Daily budget cap enforced locally — bounds blast radius of a leaked key
- Zero telemetry by default; manifest stored locally in `~/.qmediat/`
- `code` tool's `codeExecution` runs in Google's sandbox, not on your machine

Full threat model + incident response: [`docs/security.md`](./docs/security.md).

## Cost model

Projected savings vs uncached usage on a 500 k-token repo with 20 queries/day: up to **~60 % lower spend** with cache enabled, with repeat-query latency typically an order of magnitude lower than the first (uncached) call. Actual numbers depend on repo size, TTL, and query volume — we'll publish measured benchmarks after the first real-world deployments.

Per-tool cost breakdown, free-tier guidance, and all the knobs: [`docs/cost-model.md`](./docs/cost-model.md).

## Architecture

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

More: [`docs/architecture.md`](./docs/architecture.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Short version: TypeScript strict, `npm run lint && npm run typecheck && npm test`, add a changeset, open a PR.

## License

MIT © [Quantum Media Technologies sp. z o.o.](https://www.qmediat.io) — see [LICENSE](./LICENSE).

Part of qmediat's [open-source portfolio](https://www.qmediat.io/open-source).
