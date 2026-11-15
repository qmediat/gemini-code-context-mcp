# AGENTS.md

This is a public open-source repository: everything written here ships with the package.

## Work on the code

| | |
|---|---|
| Install | `npm install` |
| Build | `npm run build` |
| Check before a commit | `npm run lint && npm run typecheck && npm test` |
| README "Supports" version | `npm run check:supports` |
| Run the local build | `node ./dist/index.js` |
| `npx` inside this repo | Fails: the repo has the package's name. Use the local build. |

`npx -y @qmediat.io/gemini-code-context-mcp` run from inside this repository answers:

```
sh: gemini-code-context-mcp: command not found
```

`npx` resolves the name to this source tree and finds no matching bin; users running it from their own directories
never see this. Any of these avoids it:

| | |
|---|---|
| Global install | `npm install -g @qmediat.io/gemini-code-context-mcp`, then `"command": "gemini-code-context-mcp"` |
| Local build in the MCP host | `node ./dist/index.js` — CONTRIBUTING.md, *Local MCP setup* |
| `npx` from elsewhere | Set the MCP host's `cwd` to a directory outside this repository |

## Where things are

| | |
|---|---|
| `src/` | The server and its six tools |
| `docs/architecture.md` | How the parts fit |
| `docs/KNOWN-DEFICITS.md` | Known limits |
| `docs/FOLLOW-UP-PRS.md` | Planned work |
| `PLAN.md` | Active work |
| `CONTRIBUTING.md` | Code style, local MCP setup |
| `.claude/local-*.md`, `.claude/INTERNAL-*.md` | Private scratch notes: gitignored, never committed |

## Rules

| | |
|---|---|
| Public repository | No private paths, names or infrastructure |
| Readers | External contributors and users who land here cold: no assumed context |
| Examples in docs | Generic placeholders (`/path/to/...`, `your-org/your-repo`) unless the example is `@qmediat.io/...` |
| TypeScript | Strict, no `any`, no default exports |
| A user-visible change | One CHANGELOG.md entry (the release notes come from it) |
| Addresses | The addresses this repository publishes for the project are in `qmediat.io` (`contact@`, `security@`, `dev@`); the qmediat team's commits are authored as `dev@qmediat.io`, a contributor's with their own address; no personal or account address in any file |
| A release | README "Supports" updated to the new version; the release check fails when its version differs |
