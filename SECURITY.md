# Security Policy

## Supported versions

Only the latest published version on npm receives security fixes.

| Version | Supported |
|---|---|
| latest 1.x | ✅ |
| older 1.x | ❌ upgrade to the latest release |

## Reporting a vulnerability

Preferred: open a private report through GitHub's **[Report a vulnerability](https://github.com/qmediat/gemini-code-context-mcp/security/advisories/new)** form (Security tab → Advisories). It reaches the maintainers privately and tracks the fix and the disclosure.

Alternatively email **contact@qmt.email** with the subject line `[SECURITY] gemini-code-context-mcp`.

Do not open public GitHub issues for security reports. We acknowledge receipt within 48 hours and aim to publish a fix within 7 days for high-severity issues.

## Dependencies and supply chain

- Dependabot security updates are enabled; vulnerable transitive dependencies are refreshed in patch releases.
- CI refuses a build with a known high-severity advisory (`npm audit --audit-level=high`).
- Releases are published to npm from GitHub Actions with provenance attestations (`npm publish --provenance`); the npm page of every version links the workflow run that built it.

## Security design

- **No telemetry by default** — the server does not send usage data anywhere unless the user explicitly opts in via env var.
- **Local manifest only** — workspace state (file hashes, cache IDs) is stored in a local SQLite DB at `~/.qmediat/gemini-code-context-mcp/`. Never transmitted.
- **API keys** — read from env vars. Never logged, never persisted.
- **No arbitrary code execution** — the server does not execute user code locally. The optional `codeExecution` feature runs inside Google's sandboxed Python environment, not on the user's machine.
- **Path traversal protection** — workspace paths are resolved and bounded to the requesting directory.
