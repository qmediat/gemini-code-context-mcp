# Contributing

Thank you for considering a contribution to `@qmediat.io/gemini-code-context-mcp`.

## Development setup

Requires **Node.js >= 22** and a Google Gemini API key (for integration tests; unit tests can run without).

```bash
git clone https://github.com/qmediat/gemini-code-context-mcp.git
cd gemini-code-context-mcp
npm install
npm run typecheck
npm test
```

## Local MCP setup (testing your changes)

If you want to test your local changes inside an MCP host (Claude Code, Claude Desktop, Cursor, …), **do not** copy the README's `npx -y @qmediat.io/gemini-code-context-mcp` invocation as-is. That command pulls the **published** version from npm — it ignores your working tree — and additionally fails with `command not found` when launched from inside this repo (the local `package.json` collides with the published name during `npx` resolution).

Two working options:

**Option A — point at your local build (recommended for active development)**

```jsonc
{
  "mcpServers": {
    "gemini-code-context-dev": {
      "command": "node",
      "args": ["/absolute/path/to/gemini-code-context-mcp/dist/index.js"],
      "env": { "GEMINI_CREDENTIALS_PROFILE": "default" }
    }
  }
}
```

Workflow: edit code → `npm run build` → restart your MCP host → test.

**Option B — point at the published version (for verifying a release)**

```jsonc
{
  "mcpServers": {
    "gemini-code-context": {
      "command": "npx",
      "args": ["-y", "@qmediat.io/gemini-code-context-mcp"],
      "cwd": "/path/outside/this/repo",
      "env": { "GEMINI_CREDENTIALS_PROFILE": "default" }
    }
  }
}
```

The `cwd` field tells the MCP host to spawn `npx` from a directory that doesn't contain a same-named `package.json`, sidestepping the resolution conflict. End users never need this — only contributors who keep their MCP host's `cwd` set to the repo do.

## Workflow

1. **Fork + branch** — create a feature branch from `main`.
2. **Write tests** — every new utility gets unit tests; every new tool gets integration tests (mocked SDK is fine for PR CI; real API for local development).
3. **Keep the diff small** — one logical change per PR. If you need to refactor in the process, submit the refactor as a separate PR first.
4. **Run `npm run lint` and `npm run typecheck`** before pushing.
5. **Add a changeset** — `npx changeset` and pick the appropriate semver bump.
6. **Open a PR** against `main` with a clear description and link to any relevant issue.

## Code style

- TypeScript strict mode is non-negotiable.
- No `any` — use `unknown` and narrow.
- Prefer named exports over default exports.
- Biome formats on save; CI enforces `biome check`.

## Questions

Open a GitHub Discussion or email **contact@qmt.email**.
