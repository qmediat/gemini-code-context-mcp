# SYSTEMIC conventions — `qmediat/gemini-code-context-mcp`

> The catalogue of this repository's cross-cutting rules: one §N per convention, the one definition each surface
> reads, and what enforces it. Present tense, current rules only; history lives in `CHANGELOG.md` and the PR bodies.

## §1 — Code structure: the preset, the baselines, the exemplars (2026-10-11)

**Rule 1 — the one definition.** Biome keeps the style and its own rules; the structure is the shared preset's.
`lint/structure.mjs` and `lint/baseline-ratchet.mjs` are copies of shared presets, byte for byte (edited where the
presets are kept, never here). `npm run lint` runs `biome check`, then ESLint with `...structure({ vitest })` —
complexity ≤ 10, nesting ≤ 3, ≤ 40 lines per function outside tests, a reason on every disable directive, no bare
`toThrow()`, no test without an assertion (a helper that asserts is named `expect*` or `assert*`), no `expect()`
without a matcher — over the TypeScript, parsed by Babel's TypeScript plugin (TypeScript 7 ships no JavaScript API for
typescript-eslint); jscpd counts repeats of ≥ 10 lines over `src` and `test`; the ratchet holds the count to
`jscpd-baseline.json` (more is a new repeat, fewer asks for `node lint/baseline-ratchet.mjs --write-duplicates
.jscpd-report/jscpd-report.json`) and refuses any baseline that grew against the base branch (CI and the release
verification check out with `fetch-depth: 0`).

**The exemplars** — read before writing, not the nearest file:

| layer | file |
|---|---|
| module | `src/indexer/hasher.ts` |
| module with typed results | `src/utils/cost-estimator.ts` |
| test | `test/unit/hasher.test.ts` |
| test helper | `test/helpers/stream-mock.ts` |

**Rule 2 — the baselines at adoption.** `eslint-suppressions.json`: 146 violations in 36 files (53 nesting over 3, 46
functions over 40 lines, 41 over the complexity of 10, 4 bare `toThrow()`, 2 tests without an assertion);
duplicates: 2 346 lines in 123 repeats. A baseline only shrinks: a function a PR changes leaves it in that PR, the
rest of a touched file in the next PR; after a rebase a conflicting `eslint-suppressions.json` is regenerated (the
base's file, then `npx eslint --prune-suppressions`), never merged by hand.

**Enforcement.** `npm run lint` in CI (Node 22 and 24) and in the release's verification job.
