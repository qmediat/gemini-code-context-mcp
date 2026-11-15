# Maintenance and support

**Built and maintained by [Quantum Media Technologies sp. z o.o.](https://www.qmediat.io/) — a registered Polish technology company (qmediat.io).** Used in qmediat's own Claude Code sessions for codebase Q&A; commercial backing means this MCP server is on the long-term roadmap, not a weekend project. Every release and its date is in [CHANGELOG.md](../CHANGELOG.md). The practical consequences for users:

- **Bugs that affect real coding sessions get fixed first.** Examples: v1.5.1 retry on transient Node `fetch failed` (caught during a real `/coderev` run on a large repo), v1.7.0 streaming heartbeat (silent 60-180 s pauses on HIGH thinking were friction for our own team), v1.7.2 fake-timer race in CI (broke the release pipeline — diagnosed via 3-tool model consult, fixed and shipped same day).
- **Long-term roadmap, not a weekend project.** Commercial backing means the project sits on qmediat.io's product roadmap with allocated engineering time. We are not going to disappear.
- **Issues and PRs welcome.** File at [github.com/qmediat/gemini-code-context-mcp/issues](https://github.com/qmediat/gemini-code-context-mcp/issues) — we aim to answer within 48 hours. For commercial inquiries (custom integrations, support contracts, on-prem deployments): [contact@qmediat.io](mailto:contact@qmediat.io).
- **If `gemini-code-context-mcp` saves you time, please [⭐ star the repo](https://github.com/qmediat/gemini-code-context-mcp).** It is the simplest signal you can send that the work is worth continuing, and it directly helps us justify continued investment.

Part of qmediat's [open-source portfolio](https://www.qmediat.io/open-source?utm_source=oss-readme&utm_medium=gemini-code-context-mcp&utm_campaign=open-source) · [more open source from qmediat](https://github.com/qmediat).
