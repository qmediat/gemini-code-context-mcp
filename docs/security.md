# Security model

## What we're protecting

Your Gemini API key and your workspace content. We treat them with different threat models.

### API key

- **Never logged.** Only the first 4 and last 4 characters appear in logs (`AIza...xyz9`).
- **Never stored in MCP host config.** Your `~/.claude.json` (or equivalent) references the profile name, not the key itself.
- **Stored at rest with `chmod 0600`.** `~/.config/qmediat/credentials` is enforced file-only readable. The parent directory (`~/.config/qmediat`) is enforced `chmod 0700`.
- **Budget-capped.** `GEMINI_DAILY_BUDGET_USD` stops calls if someone exfiltrates the key and uses it. Combined with Google's per-key usage dashboard, leaks have a bounded blast radius.

### Workspace content

- **Uploaded to Google's Files API on first `ask`/`code`.** Google auto-deletes after 48 h. Re-uploaded on next use if needed.
- **Not sent anywhere else.** The manifest (cache IDs, hashes) stays local in `~/.qmediat/gemini-code-context-mcp/manifest.db`.
- **No telemetry by default.** Setting `GEMINI_CODE_CONTEXT_TELEMETRY=true` is reserved for future opt-in anonymous usage counts (not implemented in v1.0).

## Threat model

| Threat | Mitigation |
|---|---|
| Accidental commit of API key to git | Key lives in `~/.config/qmediat/credentials`, not in project files. `init` warns if the config dir is inside a git repo. |
| `~/.claude.json` synced to a dotfiles repo | We intentionally don't put the key there. The config references the profile name only. |
| Other local processes reading `/proc/<pid>/environ` | Prefer Tier 1 (Vertex/ADC) or Tier 2 (credentials file) over Tier 3 (env var). The env-var path logs a warning at startup. |
| API key exfiltrated, attacker runs up usage | `GEMINI_DAILY_BUDGET_USD` caps daily spend. Rotate the key in Google AI Studio. |
| Sensitive files accidentally indexed | `includeGlobs`/`excludeGlobs` on every tool call. Default excludes cover `node_modules`, `.git`, build outputs, lockfiles. |
| Malicious MCP host | Users trust their MCP host (Claude Code/Desktop). If you don't, don't install MCP servers. |
| Path traversal via `workspace` arg | Paths resolved via `path.resolve(cwd)` then used in `readdir(withFileTypes)` — we never execute paths. |
| Arbitrary code execution via `code` tool | The `codeExecution` flag enables **Gemini's** sandboxed Python env, not local exec. Nothing runs on your machine. |
| Supply-chain compromise of a dependency | Only 5 runtime deps (`@modelcontextprotocol/sdk`, `@google/genai`, `better-sqlite3`, `zod`, `zod-to-json-schema`). CI runs `npm audit`. Dependabot alerts on. |

## What we do NOT protect against

- **Anyone with shell access on your machine.** Root, another user with access to `~/.config/qmediat/`, or a compromised shell can read the credentials file. Use full-disk encryption.
- **A malicious MCP host reading your workspace.** If you don't trust Claude Code/Desktop/Cursor, an MCP server running underneath them is not your largest threat.
- **Compromised `npm` registry.** We can't prevent a supply-chain attack on our own package. Mitigations: (a) lockfile-based installs (`npm ci`), (b) optional npm provenance (post-v1.0 via GitHub Actions), (c) public signed release tags.

## Incident response (if your key leaks)

1. **Revoke the key immediately** at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. **Generate a new key** in the same console.
3. **Run `npx @qmediat.io/gemini-code-context-mcp init`** and paste the new key.
4. **Check Google's billing dashboard** for unexpected usage.
5. **If you stored the key in `~/.claude.json`**, also remove it from any dotfile repo and rewrite git history (`git filter-repo` or similar).

## Reporting vulnerabilities

Email **contact@qmt.email** with subject `[SECURITY] gemini-code-context-mcp`. Please don't open a public GitHub issue for a security report — we'd rather respond and coordinate disclosure first.

Response SLA for the first 30 days post-release: acknowledgement within 48 h, triage within 72 h, patch for high-severity within 7 days.
