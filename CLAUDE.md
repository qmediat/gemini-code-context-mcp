# Repo guidance for AI assistants

This file is checked into a **public open-source repository**. Anything you write here ships with the package.

## Audience

Everything you produce in this repo — code, comments, commit messages, documentation, error strings, log lines — is read by external contributors and end users. Write for the world, not for an internal team.

- No references to private infrastructure, internal paths (`/Users/<name>/...`), private repos, or non-public team members.
- No assumptions about reader's prior context with the codebase. New contributors land here cold.
- Names, examples, and stack traces in docs use generic placeholders (`/path/to/...`, `your-org/your-repo`) unless the example genuinely is `@qmediat.io/...`.

## Quality bar

- TypeScript strict, no `any`, no default exports. See [CONTRIBUTING.md](./CONTRIBUTING.md).
- `npm run lint && npm run typecheck && npm test` must pass before any commit.
- Add a changeset (`npx changeset`) for any user-visible change.
- See [PLAN.md](./PLAN.md) for active work and [docs/KNOWN-DEFICITS.md](./docs/KNOWN-DEFICITS.md) / [docs/FOLLOW-UP-PRS.md](./docs/FOLLOW-UP-PRS.md) for tracked debt.

## Local dev gotcha — npx fails inside this repo

`npx -y @qmediat.io/gemini-code-context-mcp` (the invocation the README recommends to end users) **fails when run from inside this repo's working directory**:

```
sh: gemini-code-context-mcp: command not found
```

Reason: this repo's `package.json` declares the same name as the npm package. `npx` treats the source repo as the install target, finds no matching bin in local `node_modules/.bin/`, and bails. The package itself is fine — end users running from their own project dirs never see this.

**Workaround for local MCP testing:** see `CONTRIBUTING.md` → *Local MCP setup*. Point your MCP host at the local build (`node ./dist/index.js`) instead of npx, OR set `cwd` outside the repo in your MCP config.

## Internal notes

For anything that genuinely shouldn't ship publicly (private team context, machine-specific paths, scratch notes), use `.claude/local-*.md` or `.claude/INTERNAL-*.md` — both gitignored.
