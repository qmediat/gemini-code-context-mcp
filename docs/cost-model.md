# Cost model

Gemini API is pay-as-you-go. This server's whole pitch is making it cheaper by caching. Here's how billing actually works and what knobs you have.

> **Rates read 2026-10-16** from [Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing) (Standard tier). Google changes prices; cross-check there. `GEMINI_PRICING_OVERRIDES` (see [configuration.md](configuration.md)) replaces a row at run time without a release.

## The estimator's rates

USD per 1M tokens, input / output / cached input. The estimator prices a call at the rate in force on the UTC day it is
priced: a reservation when it is made, the settled cost when the call returns.

| Model | Rate | From |
|---|---|---|
| `gemini-4-argon` | 2 / 10 / 0.1 | through 2026-11-30 |
| | 4 / 20 / 0.2 | 2026-12-01 |
| `gemini-3.1-pro-preview`, `gemini-3-pro-preview` | 4 / 18 / 0.4 (the > 200k-token tier; ≤ 200k: 2 / 12 / 0.2) | |
| `gemini-2.5-pro` | 2.5 / 15 / 0.25 (the > 200k-token tier; ≤ 200k: 1.25 / 10 / 0.125) | |
| `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash` | 0.75 / 3.75 / 0.075 | through 2026-12-31 |
| | 1.5 / 7.5 / 0.15 | 2027-01-01 |
| `gemini-3-flash-preview` | 0.5 / 3 / 0.05 | |
| `gemini-3.1-flash-image-preview` | 0.5 / 3 / 0.125 (no cached rate on the page: 0.25 × input) | |
| `gemini-3.5-flash-lite` | 0.3 / 2.5 / 0.03 | |
| `gemini-3.1-flash-lite`, `gemini-3.1-flash-lite-preview` | 0.25 / 1.5 / 0.025 | |
| `gemini-2.5-flash` | 0.3 / 2.5 / 0.03 | |
| `gemini-2.5-flash-lite` | 0.1 / 0.4 / 0.01 | |

Rules the estimator keeps, so a daily budget stays an upper bound:

- **Prompt-size tiers:** where the page prices a prompt above 200k tokens higher, the row is that dearer tier — the
  estimator does not see the prompt's size.
- **Rolling aliases** (`gemini-pro-latest`, `gemini-flash-latest`, `gemini-flash-lite-latest`) price at the dearest
  rate of their measured target's category (targets measured 2026-10-16: `gemini-3.1-pro-preview`, `gemini-3.8-flash`,
  `gemini-3.5-flash-lite`): Google may move an alias to a dearer model between two measurements.
- **An unpriced model** (`gemini-3.5-flash`, which the page does not list, or a model newer than this table) prices at
  the dearest rate its category has in force on the day; a model outside the text categories at the conservative rate
  of its cost tier (10.5 / 30 for a premium one).

## What Gemini bills for

| Line item | Typical rate |
|---|---|
| Input tokens (uncached) | $4.00 / M for 3.1 Pro (> 200k prompt), $0.75 / M for 3.8 Flash (through 2026-12-31) |
| Input tokens (cached, explicit mode) | $0.40 / M for 3.1 Pro (10 % of uncached; the estimator assumes 25 % when a row lists no cached rate) |
| Output tokens | $18.00 / M for 3.1 Pro (> 200k prompt), $3.75 / M for 3.8 Flash (through 2026-12-31) |
| Thinking tokens | Billed as output |
| Cache storage | $4.50 / M tokens / hour (Pro); prorated |
| Code execution | Bundled; no separate line item |
| Files API storage | Free; auto-deleted after 48 h |

## How the cache changes the math

**Scenario:** 500 k-token repo, 20 queries in a working day with `gemini-3.1-pro-preview` (a 500 k prompt bills
the > 200k tier).

Without caching (what jamubc gives you):

```
20 calls × 500 k input × $4.00/M   = $40.00 on input
20 calls × ~1 k output × $18.00/M  = $0.36 on output
                                   = ~$40.36 / day
```

With this server's cache:

```
1 cache build: 500 k input × $4.00/M       = $2.00
19 cached calls: ~1 k uncached + 500 k cached
                 19 × (1 k × $4.00/M + 500 k × $0.40/M)  = $3.88
20 calls × ~1 k output                        = $0.36
Cache storage (1 h avg): 500 k × 1 h × $4.50/M/h  = $2.25
                                                = ~$8.49 / day
```

**~79 % savings** in explicit `cachingMode` (latency measured 2026-04-22: first call ~125 s, repeats ~14 s on a 670 k-token workspace). In the default implicit mode there is no cache storage charge and no guaranteed discount: a repeat costs at most the inline price.

## Tools for cost control

1. **Daily budget cap.** `GEMINI_DAILY_BUDGET_USD` — hard stop once exceeded, resets at UTC midnight. Set this.
2. **Model alias.** `latest-flash` for cheap Q&A, `latest-pro` for heavy reasoning. The alias auto-picks the best available at that tier.
3. **Pricing overrides.** If Google drops prices and we haven't pushed an update, `GEMINI_PRICING_OVERRIDES='{"gemini-3.1-pro-preview":{"inputPerMillion":2,"outputPerMillion":12,"cachedInputPerMillion":0.2}}'` updates the estimator at runtime.
4. **`status` tool.** Shows today's spend, cumulative spend, cache hits.
5. **Include/exclude globs.** Smaller context = cheaper. Exclude `generated/`, `vendor/`, large test fixtures.

## What you pay per tool

| Tool | First call | Repeat call (cached) |
|---|---|---|
| `ask` | Full input price + output | explicit mode: cached input rate + output; implicit mode: at most the inline price |
| `code` | Full input + thinking + output | Cached + thinking + output |
| `status` | Free — reads SQLite only, optional `models.list()` call is 1 lightweight HTTP request |
| `reindex` | Free on our side; next `ask`/`code` rebuilds the cache at full input price |
| `clear` | Free — deletes locally + one `caches.delete` API call |

## Cache storage is the one thing that's new

Gemini bills a small amount per hour while a cache is active. If your workspace caches 500 k tokens and the cache lives 4 hours, that's roughly:

```
500 k × 4 h × $4.50/M/h = $9.00
```

For active development with many queries, this is swamped by the savings on repeat calls. For an occasional query, the math inverts — **you pay for cache lifetime regardless of usage**. The `ttl-watcher` mitigates this by only refreshing caches used in the last 10 minutes; cold caches expire on their own.

If your pattern is "one query a week on the same repo", consider running `clear` after each session and accepting the first-query latency on the next.

## Thinking tokens (`code` tool)

`code` allocates `thinkingBudget` reasoning tokens before generation. Gemini bills these at the output rate. Default is 16 384; that's ~$0.29 per call on 3.1 Pro at the estimator's 18 / M.

Raise it (`{ thinkingBudget: 32000 }`) when the task is hard. Drop it (`{ thinkingBudget: 0 }`) when you want a quick generation without deliberation.

## Budget cap — how the enforcement actually works

`GEMINI_DAILY_BUDGET_USD` is an **atomic** reservation, not a read-then-act check. From v1.0.3 onward:

1. After the workspace is scanned and the model resolved, we compute a conservative cost estimate: `(workspace_bytes ÷ 4 bytes/token) × input_rate + prompt_chars × input_rate + maxOutputTokens × output_rate + thinkingBudget × output_rate`.
2. That estimate is inserted into the usage-metrics table inside a `BEGIN IMMEDIATE` SQLite transaction. Concurrent tool calls are serialised by SQLite's reserved lock — if the reservation would push cumulative spend over the cap, the transaction rolls back and the tool returns `Daily budget cap would be exceeded: spent $X + estimate $Y > cap $Z`.
3. The `generateContent` call carries an explicit `maxOutputTokens` matching the estimate, so a runaway response cannot exceed what was reserved.
4. On success, the estimate row is overwritten with the measured cost (typically lower — finalize corrects the over-estimate). On failure, the reservation is cancelled so its headroom comes back.

Result: N concurrent tool calls cannot collectively overshoot the cap. A single call cannot overshoot either, thanks to `maxOutputTokens`.

**Caveat:** the `bytes ÷ 4` token heuristic undercounts multibyte / CJK / emoji-dense content by ~1.3×–2×. For accurate caps on those workloads, set `GEMINI_DAILY_BUDGET_USD` ~2× lower than your true limit until the heuristic is upgraded (see [FOLLOW-UP-PRS.md T17](./FOLLOW-UP-PRS.md)).

**`status` cost breakdown:** `spentTodayUsd` keeps its conservative-upper-bound semantics (settled + in-flight reservations) so daily-budget enforcement stays a true cap. *(v1.7.0+)* `status` additionally exposes `spentTodaySettledUsd` and `inFlightReservedTodayUsd` (plus workspace-scoped equivalents `usage.settledCostUsd` / `usage.inFlightReservedUsd`), and the human-readable line shows `"(settled $X + $Y in-flight reserved)"` whenever in-flight ≠ 0. Streaming made the in-flight window much more observable on long HIGH-thinking calls (60–180 s) — the breakdown closes that perception gap.

## Free tier

Gemini's free tier gives you Flash models with 1M context and per-minute rate limits. Context Caching is paid-tier only — on free tier the server falls back to inline file parts (slower, but no monthly commit).

If you're on free tier:

- Set `GEMINI_CODE_CONTEXT_DEFAULT_MODEL=latest-flash`
- Expect each call to re-send the full context (no cache)
- Set a low `GEMINI_DAILY_BUDGET_USD` to stay within the free envelope
- Skip `code` — thinking tokens aren't free
