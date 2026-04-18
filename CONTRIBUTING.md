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
