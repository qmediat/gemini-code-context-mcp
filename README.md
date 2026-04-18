# `@qmediat.io/gemini-code-context-mcp`

> **Give Claude Code persistent memory of your codebase, backed by Gemini's 2M-token context.**
> Turn repeat code-review queries from **45 seconds into 2 seconds** — same codebase, same answers, a fraction of the cost.

[![npm version](https://img.shields.io/npm/v/@qmediat.io/gemini-code-context-mcp.svg)](https://www.npmjs.com/package/@qmediat.io/gemini-code-context-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)

---

## Status: 🚧 Pre-release (v0.0.0)

This repository is under active development. First public release targeted for **v1.0.0** within 2 weeks. See [PLAN.md](./PLAN.md) for the full roadmap.

---

## Why this server?

An MCP server that wraps Google's Gemini API with **persistent context caching** for Claude Code users.

| | jamubc/`gemini-mcp-tool` | **`@qmediat.io/gemini-code-context-mcp`** |
|---|---|---|
| Maintenance | Abandoned (last release 2025-07) | ✅ Actively maintained |
| Model selection | Hardcoded `gemini-3.1-pro-preview` | ✅ Dynamic `latest-pro` alias + per-call override |
| Backend | Shells out to `gemini` CLI | ✅ Direct `@google/genai` SDK (no subprocess) |
| Repeat queries | Re-sends entire codebase every call (~45s) | ✅ **Files API + Context Cache** (~2s) |
| Coding delegation | Legacy prompt-injection `changeMode` | ✅ Native Gemini **thinking budget** + optional **code execution** |
| Dead deps | 5 unused packages (`ai`, `chalk`, `d3-shape`, ...) | ✅ Zero dead deps |
| Types | Loose | ✅ TypeScript strict mode |

## Planned tools

| Tool | Purpose |
|---|---|
| `ask` | Q&A / long-context analysis with workspace context cache |
| `code` | Dedicated coding delegation — uses Gemini's thinking budget + optional code execution |
| `status` | Inspect cache state, available models, cost savings |
| `reindex` | Force rebuild of workspace cache |
| `clear` | Clear cache + manifest for a workspace |

## License

MIT © Quantum Media Technologies sp. z o.o. — see [LICENSE](./LICENSE).
