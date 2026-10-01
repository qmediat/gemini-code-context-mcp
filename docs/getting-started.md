# Getting started

This guide takes you from zero to a working Gemini-powered Claude Code session in ~3 minutes.

## Prerequisites

- **Node.js ≥ 22** (`node --version`)
- A Gemini API key — grab one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (the free tier works; the models your key lists decide the alias resolution)
- Any MCP host: **Claude Code**, **Claude Desktop**, **Cursor**, **Cline**, **Continue.dev**, or the **MCP Inspector** for testing

## 1. Secure setup (recommended)

Run the guided setup — no API key ever leaves your machine:

```bash
npx @qmediat.io/gemini-code-context-mcp init
```

You'll be asked to:

1. Pick an auth method (**API key** or **Vertex AI**)
2. Paste the key (hidden input, never echoed)
3. Set a default model (just press enter for `latest-pro-thinking`)
4. Set a daily budget cap in USD (recommended)

Credentials land in `~/.config/qmediat/credentials` with `chmod 0600`. The server reads them at startup; your MCP host config only references the profile name.

## 2. Wire it into your MCP host

### Claude Code

One command:

```bash
claude mcp add --scope user gemini-code-context -e GEMINI_CREDENTIALS_PROFILE=default -- npx -y @qmediat.io/gemini-code-context-mcp
```

or edit `~/.claude.json` and add:

```json
{
  "mcpServers": {
    "gemini-code-context": {
      "command": "npx",
      "args": ["-y", "@qmediat.io/gemini-code-context-mcp"],
      "env": {
        "GEMINI_CREDENTIALS_PROFILE": "default"
      }
    }
  }
}
```

Restart Claude Code. You should see `gemini-code-context` in the MCP tools list with five tools: `ask`, `code`, `status`, `reindex`, `clear`.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) with the same `mcpServers` block.

### Cursor

Edit `~/.cursor/mcp.json` with the same block. See [examples/cursor.json](../examples/cursor.json).

## 3. Try it

In Claude Code, ask:

> Use `gemini-code-context.ask` to summarize the architecture of this codebase.

On a fresh workspace this will take ~30–45 s (scan + upload + cache build). Every follow-up question with the same codebase will be ~2–3 s.

Check what you've spent and how much context is cached:

> Use `gemini-code-context.status`.

## Next steps

- **Configuration reference** — all env vars and their defaults: [configuration.md](configuration.md)
- **How caching works** — the two caching modes and what was measured: [how-caching-works.md](how-caching-works.md)
- **Security model** — threat model + incident response: [security.md](security.md)
- **Cost model** — what you actually pay for and how to control it: [cost-model.md](cost-model.md)
