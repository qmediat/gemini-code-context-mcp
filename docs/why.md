# Why this server

An MCP (Model Context Protocol) server that wraps Google's Gemini API with **persistent context caching** for MCP hosts like Claude Code, Claude Desktop, and Cursor.

|  | [jamubc/gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool) | **`@qmediat.io/gemini-code-context-mcp`** |
|---|---|---|
| Maintenance | npm `gemini-mcp-tool@1.1.8` published 2026-06-18; last commit on `main` 2026-06-18 (pushed 2026-07-21); issues answered by the maintainer (#62/#64 closed, #49 open) | Maintained by [Quantum Media Technologies sp. z o.o.](https://www.qmediat.io/) (qmediat.io); release dates in [CHANGELOG.md](../CHANGELOG.md) |
| Default model | Hardcoded `gemini-2.5-pro` (`src/constants.ts`) — no runtime override | Dynamic `latest-pro-thinking` alias — resolved per call against the models your key lists (cached 1 h in-process); `GEMINI_CODE_CONTEXT_DEFAULT_MODEL` or a per-call `model` overrides |
| Quota fallback | Hardcoded to `gemini-2.5-flash` | Generic `models.list()` → pick best available |
| Tool names | `ask-gemini`, `brainstorm`, `fetch-chunk`, `ping`, `Help`, `timeout-test` | `ask`, `ask_agentic`, `code`, `status`, `reindex`, `clear` ([tools.md](tools.md)) |
| Backend | Shells out to `gemini` CLI (subprocess per call) | Direct `@google/genai` SDK |
| Repeat queries | No caching layer — each call re-tokenises referenced files | One workspace scan reused across questions; implicit prefix caching by default, or an explicit Context Cache (`cachingMode: "explicit"`) with Google's cached-input price |
| Coding delegation | Prompt-injection `changeMode` (OLD/NEW format in system text) | Native `thinkingConfig` + optional `codeExecution` |
| Auth | Inherits `gemini` CLI auth (browser OAuth via `gemini auth login`, or env var) | 3-tier: Vertex ADC / credentials file (chmod 0600 atomic write) / env var (+ warning) |
| Cost control | — | Daily budget cap in USD (`GEMINI_DAILY_BUDGET_USD`) |

> *Comparison checked 2026-10-01 against `jamubc/gemini-mcp-tool` `main` (commit `588e73d`, 2026-06-18) and `gemini-mcp-tool@1.1.8` on npm: the hardcoded `gemini-2.5-pro` default (`src/constants.ts`) and the `gemini` CLI subprocess backend (`geminiExecutor.ts`) hold at that revision. Re-check before relying on any row; a project changes.*

Switching from `gemini-mcp-tool`: [migration-from-jamubc.md](migration-from-jamubc.md).
