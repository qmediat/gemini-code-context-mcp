<p align="left">
  <a href="https://www.qmediat.io/open-source?utm_source=oss-readme&utm_medium=gemini-code-context-mcp&utm_campaign=open-source">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/qmediat/.github/b35746f6b3c933d9eeb539033ef40ea9876349ae/assets/qmediat-wordmark-light.svg">
      <img src="https://raw.githubusercontent.com/qmediat/.github/b35746f6b3c933d9eeb539033ef40ea9876349ae/assets/qmediat-wordmark-badge.svg" alt="Quantum Media Technologies" height="40">
    </picture>
  </a>
</p>

# gemini-code-context-mcp

Ask Gemini about your whole codebase from Claude Code: one scan per workspace, reused for every next question.

## Install

```bash
npx @qmediat.io/gemini-code-context-mcp init     # stores your Gemini API key or Vertex AI project
claude mcp add --scope user gemini-code-context -- npx -y @qmediat.io/gemini-code-context-mcp
```

## Try it

```text
Use gemini-code-context.ask to summarize this codebase
```

## Tools

| Tool | What it does |
|---|---|
| `ask` | A question about the whole workspace |
| `ask_agentic` | A question about a workspace too large to send whole |
| `code` | A coding task for Gemini |
| `status` | Cache state, models, cost so far |
| `reindex` | Scan the workspace again |
| `clear` | Delete this workspace's cache |

## Supports · version 1.25.1

| | |
|---|---|
| Works in | Claude Code · Claude Desktop · Cursor |
| Models | Gemini 4 Carbon, Argon, Hydrogen · Gemini 3.x and 2.5 Pro, Flash, Flash-Lite |
| Sign-in | Gemini API key · Vertex AI |

## Docs

| Read | File |
|---|---|
| [First 3 minutes, Claude Desktop, Cursor](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/getting-started.md) | docs/getting-started.md |
| [Every tool, `ask` or `ask_agentic`](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/tools.md) | docs/tools.md |
| [Settings and parameters](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/configuration.md) | docs/configuration.md |
| [Models](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/models.md) | docs/models.md |
| [How caching works](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/how-caching-works.md) | docs/how-caching-works.md |
| [Cost and the daily budget](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/cost-model.md) | docs/cost-model.md |
| [Security](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/security.md) | docs/security.md |
| [Why this server](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/why.md) | docs/why.md |
| [Coming from gemini-mcp-tool](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/migration-from-jamubc.md) | docs/migration-from-jamubc.md |
| [Maintenance and support](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/maintenance.md) | docs/maintenance.md |
| [For AI agents](https://github.com/qmediat/gemini-code-context-mcp/blob/main/AGENTS.md) | AGENTS.md |

Node.js 22 or newer · [MIT](https://github.com/qmediat/gemini-code-context-mcp/blob/main/LICENSE) · [Quantum Media Technologies](https://www.qmediat.io/open-source?utm_source=oss-readme&utm_medium=gemini-code-context-mcp&utm_campaign=open-source) · [Trademarks](https://github.com/qmediat/gemini-code-context-mcp/blob/main/docs/TRADEMARKS.md)
