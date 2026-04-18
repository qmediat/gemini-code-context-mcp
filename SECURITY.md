# Security Policy

## Supported versions

Until v1.0.0 is released, this project is in pre-release and not yet recommended for production use.

| Version | Supported |
|---|---|
| < 1.0.0 | ❌ pre-release, no security guarantees |

## Reporting a vulnerability

Please report security vulnerabilities privately to **contact@qmt.email** with the subject line `[SECURITY] gemini-code-context-mcp`.

Do not open public GitHub issues for security reports. We will acknowledge receipt within 48 hours and aim to publish a fix within 7 days for high-severity issues.

## Security design

- **No telemetry by default** — the server does not send usage data anywhere unless the user explicitly opts in via env var.
- **Local manifest only** — workspace state (file hashes, cache IDs) is stored in a local SQLite DB at `~/.qmediat/gemini-code-context-mcp/`. Never transmitted.
- **API keys** — read from env vars. Never logged, never persisted.
- **No arbitrary code execution** — the server does not execute user code locally. The optional `codeExecution` feature runs inside Google's sandboxed Python environment, not on the user's machine.
- **Path traversal protection** — workspace paths are resolved and bounded to the requesting directory.
