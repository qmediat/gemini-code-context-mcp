# Competitive landscape — 2026-10-01

What other tools offer that `@qmediat.io/gemini-code-context-mcp` 1.18.0 does not, with Google's own tools first. Read
from the linked pages on 2026-10-01; "unverified" marks what could not be opened.

## The provider: Google

Google ships no "whole repository as Gemini context" tool. What it ships:

- **Agent Platform remote MCP** (GA 2026-07-01, <https://cloud.google.com/blog/products/ai-machine-learning/gemini-enterprise-agent-platform-remote-mcp-server>):
  Streamable HTTP, IAM/OAuth, Model Armor, audit logs; `/mcp/generate` exposes `generate_content`, `count_tokens`,
  `embed_content` (checked with a live `tools/list`). `generate_content` accepts a `cachedContent` name but nothing
  creates a cache, and a remote server cannot read local files.
- **Gemini Docs MCP** (`https://gemini-api-docs-mcp.dev`) and **Developer Knowledge MCP**
  (`https://developerknowledge.googleapis.com/mcp`): documentation search only
  (<https://ai.google.dev/gemini-api/docs/coding-agents>, updated 2026-09-24).
- **File Search** (managed RAG, <https://ai.google.dev/gemini-api/docs/file-search>, updated 2026-09-23): code files
  supported, 100 MB per file, 1 GB–1 TB stores by tier, storage free, embedding paid at indexing, works on 3.x Flash
  and 3.1 Pro. Nobody applies it to a repository through MCP (unverified as a market gap).
- **Gemini CLI** (0.62.0, 2026-09-29, 1,602,515 npm downloads / 30 days): headless JSON / stream-json, `--acp`; it does
  not run as an MCP server. Since 2026-06-18 it serves only paid API keys and Code Assist Standard/Enterprise; AI
  Pro/Ultra users moved to the closed-source **Antigravity CLI (`agy`)**
  (<https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>). This package
  calls `@google/genai` directly and was not affected; CLI-wrapping competitors were.
- **Flex and priority service tiers** (−50 % / premium) and the **Batch API** (−50 %, works with cached content,
  <https://ai.google.dev/gemini-api/docs/batch-api>, updated 2026-09-17).
- **Interactions API**: server-side state through `previous_interaction_id`, implicit caching only
  (<https://ai.google.dev/gemini-api/docs/caching>).

## Community

| Package | Version / activity | npm 30-day | Positioning |
|---|---|---|---|
| @qmediat.io/gemini-code-context-mcp (this) | 1.18.0 (npm 1.17.1), 2026-10-01 | 963 | repo as context, explicit cache lifecycle, budget cap |
| jamubc/gemini-mcp-tool | 1.1.8, 2026-06-18 | 10,747 | wraps the `gemini` CLI (`@` files, sandbox); experimental `agy` backend |
| @ask-llm/mcp (Lykhoyda) | 1.1.0, 2026-09-29 | 2,078 | multi-provider second opinion (Codex, Claude, Grok, agy, Ollama, Gemini CLI), sessions, outputSchema, usage resource |
| @rlabs-inc/gemini-mcp | 0.8.1, 2026-01-12 | 1,579 | Gemini API toolbox: search, URL, YouTube, documents, cache tools, deep research, media |
| mcp-gemini-server (siosig) | 2.1.1, 2026-06-23 | 85 | thin `@google/genai` primitives; `service_tier` flex/priority |
| @tuannvm/gemini-mcp-server | 1.1.2, 2026-04-10 | 320 | CLI wrapper: web search, media, shell, brainstorm |
| PAL MCP (ex Zen) | 9.8.2, 2025-12-15 | not on npm | multi-model workflows, conversation threading |
| Repomix MCP | 1.18.1, 2026-09-21 | 393,013 | packs a repo for any model; tree-sitter compression, Secretlint |
| @joeytheman/gemini-mcp-tool | 1.3.0, 2026-03-04 | 21 | fork on `agy`, conversation resume, JSON envelope |

## Feature matrix

| Feature | This package | Google (official) | Best community |
|---|---|---|---|
| Local repo scan with sha256 manifest, explicit Context Cache lifecycle (upload, `caches.create`, TTL watcher, rebuild on change) | **yes** (only this package) | no | no |
| Daily USD cap with settled vs in-flight reservation, TPM throttle | **yes** | no (IAM quotas) | ask-llm (stats), RLabs (estimate) |
| Agentic on-demand reads in a realpath jail with a secret denylist and prompt-injection guard | **yes** | no | jamubc (CLI sandbox) |
| Category-safe model aliases resolved against the key's model list | **yes** | — | no |
| `WORKSPACE_TOO_LARGE` preflight with fallback to agentic | **yes** | — | no |
| Image / PDF / screenshot input | **no** (`latest-vision` alias has no input path) | `inlineData` / `fileData` | RLabs, siosig, jamubc |
| Google Search / URL grounding | **no** | `tools[]` | RLabs, siosig, jamubc |
| Flex / priority tier, Batch API | **no** | yes | siosig |
| Multi-turn sessions | **no** | Interactions API (implicit cache only) | ask-llm, PAL |
| outputSchema / resources / prompts | **no** (structuredContent only) | yes | ask-llm, jamubc |
| Streamable HTTP + OAuth | **no** (stdio) | yes | no |
| File Search mode for repos over 1M tokens | **no** | yes (not for repos) | no |
| ADC / Vertex auth | yes | yes | partial |
| Subscription auth without an API key | **no** | `agy` | jamubc, ask-llm |
| Tree-sitter compression | no | — | Repomix |

## Gaps, ranked

1. Multimodal input (an `attachments` parameter): cheap, and it removes the `latest-vision` inconsistency.
2. Grounding (Google Search, URL context).
3. Flex service tier and the Batch API: −50 %, in line with the cost-control positioning.
4. Multi-turn follow-ups by session id (design decision: the Interactions API cannot carry the explicit cache).
5. MCP surface: outputSchema, a `usage://` resource, prompts; optionally Streamable HTTP + OAuth.
6. File Search mode for repositories beyond 1M tokens.
7. A subscription path (`agy`): needs a terms-of-service and stability review first.
8. Smaller: tree-sitter compression, tool-group presets, host auto-setup and a `doctor` command.

Not worth chasing: multi-model fan-out and media generation — outside the positioning.
