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
claude mcp add --scope user gemini-code-context -- npx -y @qmediat.io/gemini-code-context-mcp
```

The server reads the profile named `default` when `GEMINI_CREDENTIALS_PROFILE` is unset; for another profile add
`-e GEMINI_CREDENTIALS_PROFILE=<name>` before the `--`.

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

Restart Claude Code. You should see `gemini-code-context` in the MCP tools list with six tools: `ask`, `ask_agentic`, `code`, `status`, `reindex`, `clear`.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) with the same `mcpServers` block.

### Cursor

Edit `~/.cursor/mcp.json` with the same block. See [examples/cursor.json](../examples/cursor.json).

### Other ways to install

| Method | Config |
|---|---|
| **npx (recommended)** | `"command": "npx", "args": ["-y", "@qmediat.io/gemini-code-context-mcp"]` — the blocks above |
| **Global install** | `npm install -g @qmediat.io/gemini-code-context-mcp` → `"command": "gemini-code-context-mcp"` |
| **Local dev** | `git clone …; npm install; npm run build` → `"command": "node", "args": ["/path/to/dist/index.js"]` |

**Supported platforms.** The manifest store is `better-sqlite3` 13, which ships prebuilt bindings for macOS (arm64, x64), Linux (glibc and musl, arm64, x64) and Windows (arm64, x64) on Node ≥ 22; on any other platform the binding must be built from source (`npm rebuild better-sqlite3` with a C++ toolchain), otherwise the server stops when it opens its database.

### Upgrading to a new release

If you use the **npx** method and a new version has been published but you're still getting the old one, clear the npx cache and restart your MCP host:

```bash
rm -rf ~/.npm/_npx
```

`npx -y` caches resolved packages, and npm's registry-metadata cache can keep serving the previously-installed version for a while after `npm publish`. The command above forces a fresh fetch on next MCP startup. Global-install and local-dev users upgrade via `npm update -g @qmediat.io/gemini-code-context-mcp` and `git pull && npm run build` respectively.

## 3. Try it

In Claude Code, ask:

> Use `gemini-code-context.ask` to summarize the architecture of this codebase.

The first question scans the workspace; every follow-up reuses the scan. In the default implicit mode each question sends the workspace text and Gemini's automatic prefix cache decides any discount; with `cachingMode: "explicit"` the first question also uploads the workspace and builds a Context Cache (125 s measured on a 670 k-token workspace, repeats ~14 s).

Check what you've spent and how much context is cached:

> Use `gemini-code-context.status`.

## Next steps

- **Configuration reference** — all env vars and their defaults: [configuration.md](configuration.md)
- **How caching works** — the two caching modes and what was measured: [how-caching-works.md](how-caching-works.md)
- **Security model** — threat model + incident response: [security.md](security.md)
- **Cost model** — what you actually pay for and how to control it: [cost-model.md](cost-model.md)
