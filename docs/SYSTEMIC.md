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
typescript-eslint); jscpd counts repeats of ≥ 10 lines over `src` and `test`; the ratchet holds the lines each file has in a repeat to
`jscpd-baseline.json` (more is a new repeat, fewer asks for `node lint/baseline-ratchet.mjs --write-duplicates
.jscpd-report/jscpd-report.json`) and refuses any baseline that grew against the base branch (CI and the release
verification check out with `fetch-depth: 0`).

**The exemplars** — read before writing, not the nearest file:

| layer | file |
|---|---|
| module | `src/indexer/hasher.ts` |
| module with typed results | `src/utils/cost-estimator.ts` |
| test | `test/unit/hasher.test.ts` |
| test helper | `test/helpers/stream-mock.ts` — a stream mock by its shape: one chunk, several chunks, a failure after some chunks, a `generateContent` mock forwarded as a stream (eight suites; a stream with timing — a hang, a heartbeat — is written where it is read) |



**Rule 2 — the baselines at adoption.** `eslint-suppressions.json`: 146 violations in 36 files (53 nesting over 3, 46
functions over 40 lines, 41 over the complexity of 10, 4 bare `toThrow()`, 2 tests without an assertion);
duplicates: 3 455 lines in a repeat across 26 files (123 repeats, both sides counted). A baseline only shrinks: a function a PR changes leaves it in that PR, the
rest of a touched file in the next PR; after a rebase a conflicting `eslint-suppressions.json` is regenerated (the
base's file, then `npx eslint --prune-suppressions`) and a conflicting `jscpd-baseline.json` re-recorded (the base's file, then `--write-duplicates`), never merged by hand; the ratchet refuses whatever grew. A jscpd version bump can move the measured lines: that PR re-records the baseline with `--write-duplicates`, reviewed like a baseline cleanup.

`npm run lint` takes no arguments: ESLint's own flags (`--fix`, a file list) go to `npx eslint`. A suppression is a count per file and rule: a new violation of a rule in a file that already has suppressed ones
passes while another is fixed in the same PR — the count is the only guard there, so the self-review reads the
touched functions. `eslint-suppressions.json` is marked `linguist-generated` (a review packet carries it as data,
last): the ratchet holds it after adoption, and the adoption PR names its counts. Biome ignores `lint/**`: the
copies are not reformatted on save.

**Enforcement.** `npm run lint` in CI (Node 22 and 24) and in the release's verification job, whose ratchet compares
the tag's tree with itself (`BASELINE_RATCHET_BASE: HEAD`): the tree was checked on its pull request, and a later
`main` that lowered a baseline must not fail a re-release of an older tag.

## §2 — A cache's TTL goes through one function (2026-11-18)

**Rule — the one definition.** A TTL reaches Google, and becomes a stored expiry, only through `effectiveTtlSeconds`
(`src/cache/ttl.ts`: whole seconds, at least 60): the create request and the expiry it stores (`createCache` in
`src/cache/cache-manager.ts`), and the TTL watcher's `caches.update` and the expiry it stores when the answer carries
none (`src/cache/ttl-watcher.ts`, which shapes the TTL once per hot entry). The setting
`GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS` stays as the operator wrote it (`src/config.ts`); a new place that sends or
counts a cache TTL reads the function.

**Enforcement.** The unit tests of the create (`test/unit/cache-manager.test.ts`: a TTL of 30 is created and stored
as 60 s) and of the watcher (`test/unit/ttl-watcher.test.ts`: refreshed as 60 s, the fallback expiry 60 s from now);
the self-review.

## §3 — No cache id is `null` (2026-11-18)

**Rule — the one definition.** A workspace row read from the manifest names a cache or has `cacheId: null`. An empty
stored id (`''`) reads as `null` in `rowToWorkspace` (`src/manifest/db.ts`), on the one read path of the row
(`ManifestDb.getWorkspace`), so no reader tests for `''`: the reuse test, the rebuild's delete of the previous cache,
the purge, `markCacheStale`, the TTL watcher and `status` all see `null`. A create that answers without a cache name
is a failed create (`createCache` throws), so no writer stores `''`.

**Enforcement.** `test/unit/manifest-db.test.ts` (a row stored with `''` reads as `null`) and
`test/unit/cache-manager.test.ts` (a rebuild over such a row deletes nothing).
