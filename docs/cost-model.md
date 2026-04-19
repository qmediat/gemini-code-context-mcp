# Cost model

Gemini API is pay-as-you-go. This server's whole pitch is making it cheaper by caching. Here's how billing actually works and what knobs you have.

> **Rates verified 2026-04-18.** Google updates prices without notice — always cross-check at [ai.google.dev/pricing](https://ai.google.dev/pricing). You can override defaults at runtime via `GEMINI_PRICING_OVERRIDES` (see [configuration.md](configuration.md)) without waiting for a patch release.

## What Gemini bills for

| Line item | Typical rate |
|---|---|
| Input tokens (uncached) | $3.50 / M for Pro, $0.30 / M for Flash |
| Input tokens (cached) | ~$0.87 / M for Pro (≈ 25 % of uncached) |
| Output tokens | $10.50 / M for Pro, $2.50 / M for Flash |
| Thinking tokens (Pro) | Billed as output |
| Cache storage | $4.50 / M tokens / hour (Pro); prorated |
| Code execution | Bundled; no separate line item |
| Files API storage | Free; auto-deleted after 48 h |

Rates vary — always check [ai.google.dev/pricing](https://ai.google.dev/pricing). Our defaults are conservative.

## How the cache changes the math

**Scenario:** 500 k-token repo, 20 queries in a working day with `gemini-3-pro-preview`.

Without caching (what jamubc gives you):

```
20 calls × 500 k input × $3.50/M   = $35.00 on input
20 calls × ~1 k output × $10.50/M  = $0.21 on output
                                   = ~$35.21 / day
```

With this server's cache:

```
1 cache build: 500 k input × $3.50/M       = $1.75
19 cached calls: ~1 k uncached + 500 k cached
                 19 × (1 k × $3.50/M + 500 k × $0.87/M)  = $8.36
20 calls × ~1 k output                        = $0.21
Cache storage (1 h avg): 500 k × 1 h × $4.50/M/h  = $2.25
                                                = ~$12.57 / day
```

**~64 % savings**, and the first call's 45 s latency drops to 2 s on repeats.

## Tools for cost control

1. **Daily budget cap.** `GEMINI_DAILY_BUDGET_USD` — hard stop once exceeded, resets at UTC midnight. Set this.
2. **Model alias.** `latest-flash` for cheap Q&A, `latest-pro` for heavy reasoning. The alias auto-picks the best available at that tier.
3. **Pricing overrides.** If Google drops prices and we haven't pushed an update, `GEMINI_PRICING_OVERRIDES='{"gemini-3-pro-preview":{"inputPerMillion":2.5,...}}'` updates the estimator at runtime.
4. **`status` tool.** Shows today's spend, cumulative spend, cache hits.
5. **Include/exclude globs.** Smaller context = cheaper. Exclude `generated/`, `vendor/`, large test fixtures.

## What you pay per tool

| Tool | First call | Repeat call (cached) |
|---|---|---|
| `ask` | Full input price + output | Cached input rate + output (~25 % + output) |
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

`code` allocates `thinkingBudget` reasoning tokens before generation. Gemini bills these at the output rate. Default is 16 384; that's ~$0.17 per call on Pro.

Raise it (`{ thinkingBudget: 32000 }`) when the task is hard. Drop it (`{ thinkingBudget: 0 }`) when you want a quick generation without deliberation.

## Budget cap — how the enforcement actually works

`GEMINI_DAILY_BUDGET_USD` is an **atomic** reservation, not a read-then-act check. From v1.0.3 onward:

1. After the workspace is scanned and the model resolved, we compute a conservative cost estimate: `(workspace_bytes ÷ 4 bytes/token) × input_rate + prompt_chars × input_rate + maxOutputTokens × output_rate + thinkingBudget × output_rate`.
2. That estimate is inserted into the usage-metrics table inside a `BEGIN IMMEDIATE` SQLite transaction. Concurrent tool calls are serialised by SQLite's reserved lock — if the reservation would push cumulative spend over the cap, the transaction rolls back and the tool returns `Daily budget cap would be exceeded: spent $X + estimate $Y > cap $Z`.
3. The `generateContent` call carries an explicit `maxOutputTokens` matching the estimate, so a runaway response cannot exceed what was reserved.
4. On success, the estimate row is overwritten with the measured cost (typically lower — finalize corrects the over-estimate). On failure, the reservation is cancelled so its headroom comes back.

Result: N concurrent tool calls cannot collectively overshoot the cap. A single call cannot overshoot either, thanks to `maxOutputTokens`.

**Caveat:** the `bytes ÷ 4` token heuristic undercounts multibyte / CJK / emoji-dense content by ~1.3×–2×. For accurate caps on those workloads, set `GEMINI_DAILY_BUDGET_USD` ~2× lower than your true limit until the heuristic is upgraded (see [FOLLOW-UP-PRS.md T17](./FOLLOW-UP-PRS.md)).

**Transient visibility quirk:** `status` sums `usage_metrics.cost_usd_micro` including in-flight reservations. During the seconds between reserve-and-finalize, reported daily spend reads slightly higher than the real amount. It reconciles the moment the call completes. See [KNOWN-DEFICITS.md](./KNOWN-DEFICITS.md) for the schema-migration fix roadmap.

## Free tier

Gemini's free tier gives you Flash models with 1M context and per-minute rate limits. Context Caching is paid-tier only — on free tier the server falls back to inline file parts (slower, but no monthly commit).

If you're on free tier:

- Set `GEMINI_CODE_CONTEXT_DEFAULT_MODEL=latest-flash`
- Expect each call to re-send the full context (no cache)
- Set a low `GEMINI_DAILY_BUDGET_USD` to stay within the free envelope
- Skip `code` — thinking tokens aren't free
