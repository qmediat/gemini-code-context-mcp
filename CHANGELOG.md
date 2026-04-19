# Changelog

All notable changes to `@qmediat.io/gemini-code-context-mcp` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Five core MCP tools: `ask`, `code`, `status`, `reindex`, `clear`
- Direct `@google/genai` SDK integration with Files API + Context Cache
- Dynamic model registry with alias resolution (`latest-pro`, `latest-pro-thinking`, `latest-flash`, `latest-lite`)
- 3-tier auth: Vertex AI / credentials file (chmod 0600) / env var
- `init` subcommand for interactive secure credential setup
- Daily budget cap (`GEMINI_DAILY_BUDGET_USD`) with hard-stop enforcement
- TTL watcher for background cache refresh on hot workspaces
- SQLite manifest for workspace/file/usage tracking
- Workspace scanner with sha256 hash-based dedup
- Coding-optimized `code` tool with Gemini thinking budget + optional code execution
- Cost estimator with pricing overrides via `GEMINI_PRICING_OVERRIDES`
- Full docs: getting-started, configuration, how-caching-works, migration, architecture, security, cost-model
- Examples for Claude Code, Claude Desktop, Cursor, and Vertex AI setups
- Project scaffolding (TypeScript strict, Biome, Vitest, GitHub Actions CI)

[Unreleased]: https://github.com/qmediat/gemini-code-context-mcp/compare/main...HEAD
