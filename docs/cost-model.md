# Cost model

Gemini API is pay-as-you-go. This server's whole pitch is making it cheaper by caching. Here's how billing actually works and what knobs you have.

> **Rates read 2026-10-16** (the Gemini 4 Carbon and Hydrogen rows: 2026-11-14) from [Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing) (Standard tier). Google changes prices; cross-check there. `GEMINI_PRICING_OVERRIDES` (see [configuration.md](configuration.md)) replaces a row at run time without a release.

## The estimator's rates

USD per 1M tokens, input / output / cached input. A settled call is priced at the rate in force on the UTC day it
settles. A daily-budget reservation covers every rate the call can settle under: the dearer of the rate in force when it
is made and the rate in force when the call's timeout ends (`timeoutMs`; `ask_agentic`: each iteration's timeout, priced
per iteration). A call without a timeout reserves each component (input, output, cached) at its dearest
rate in force from now on, overrides included, so a call that crosses a price change
never settles above its reservation.

| Model | Rate | From |
|---|---|---|
| `gemini-4-carbon`, `gemini-4-argon` | 2 / 10 / 0.1 | through 2026-11-30 |
| | 4 / 20 / 0.2 | 2026-12-01 |
| `gemini-4-hydrogen` | 1.5 / 7.5 / 0.075 | |
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
  the dearest rate its category has in force on the day, `GEMINI_PRICING_OVERRIDES` rows included (an override that
  adds a dearer model lifts the bound); a model outside the text categories at the conservative rate
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

**~79 % savings** in explicit `cachingMode`. In the default implicit mode there is no cache storage charge and no guaranteed discount: a repeat costs at most the inline price (the measurement below).

## Measured on a real workspace

Measured 2026-04-22 with **explicit** `cachingMode` on `vitejs/vite@main`'s `packages/vite/` (~670 k tokens, 451 files, Gemini 3.1 Pro, `thinkingLevel: LOW`): first query 125 s (scan + Files API upload + cache build), repeat queries ~14 s and **$0.60 per cached query vs $2.35 per inline query** for the same question — about 8× faster and ~75 % cheaper on a cache hit. At 20 queries/day on this workspace that is $35/day per developer ($12 cached vs $47 inline). `HIGH` thinking adds 15–45 s per call in either mode.

The default mode since v1.14.0 is **implicit** caching: no upload and no cache build, the workspace text goes with every call and Gemini's automatic prefix cache decides the discount, so a repeat query costs at most the inline price and often less — no guaranteed discount. Check Google's current cached-input price for your model (the estimator's assumption is in the table above). Actual numbers scale with workspace tokens × queries/day × thinking budget. The `status` tool shows the ledger behind these numbers.

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

## Long decode on Gemini 4

A Gemini 4 call whose `maxOutputTokens` is above the per-request limit continues in further requests
([tools.md](tools.md#long-decode-on-gemini-4-ask-code)). Each request bills its whole input again: the prompt plus
everything decoded before it. Measured on gemini-4-hydrogen at `thinkingLevel: XHIGH` with `maxOutputTokens: 262144`
(2026-11-17, two requests each; the server's own estimate at 1.50 / 7.50 USD per 1 M):

| Prompt | Billed input | Thinking | Answer | Time | Cost |
|---|---|---|---|---|---|
| 99,712 tokens | 265,085 | 85,730 | 1,048 | 375 s | 1.0485 USD |
| 153,906 tokens | 373,458 | 99,836 | 997 | 482 s | 1.3164 USD |

The same prompts with no `maxOutputTokens` stopped at 65,533 thinking tokens with no answer (`OUTPUT_CAP`), billed.

The reservation stays an upper bound. With prompt `P`, cap `C` and per-request limit `L` (the model's advertised
`outputTokenLimit`):

```
R = ceil(C / L)                                   requests at most (the server stops there)
M = max(L, 65,536)                                the most one streaming request decodes
O = 256                                           what a continuation request bills beyond P and the decode before it
input reserved = P + Σ_{k=1..R−1} (P + min(k·M, C) + O)
output reserved = C, or min(R·M, C + M − 1) when R > 1   (+ the thinking reserve)
```

- `P` is the larger of the bytes ÷ 4 heuristic and the preflight's count. A decode that may take more than one request
  takes the exact count (`countTokens`, whatever `preflightMode` asked for): its prompt is billed once per request,
  so the heuristic's undercount would be billed `R` times.
- `O`: request 2 of the measured calls billed 125 and 89 tokens more than the prompt plus the decode before it;
  `CONTINUATION_REQUEST_OVERHEAD_TOKENS` reserves twice the larger.
- The output side rests on Google holding `maxOutputTokens` = `C` over the whole chain of requests, which the client
  cannot check. The client stops after a request ends, once the decoded tokens reached `C`; a server that held the cap
  per request would let the last request run up to one request's decode past `C`. The reservation counts that
  overshoot (`decodedTokensBound`): `C + M − 1` at most, never more than `R` requests of `M`. For a cap that is a
  multiple of `M` (262,144, 1,048,576 on Hydrogen) that is `C` itself.
- Under a cap the model's input window cut (`outputCapCutByInputWindow`), `C` is the cut value. A cut that leaves
  several requests keeps the caller's cap on the wire, above `C`, so the overshoot past `C` is certain and reserved as
  above; a cut that leaves one request sends `C` itself as `maxOutputTokens`. The thinking reserve is sized from the cut
  `C` too. The cut rests on a premise that is assumed, not measured: that the API refuses a continuation request
  whose prompt plus decoded tokens pass the input window (`docs/FOLLOW-UP-PRS.md` T41).
- A request that reports no usage is billed at the reservation's own input estimate — the larger of the heuristic and
  the preflight's count — plus what was decoded before it, so the ledger keeps the daily cap a bound.
- A request that makes no progress (it returns the token it was sent with, or decodes nothing) ends the decode, so
  a stuck stop is not re-billed up to `R` times.
- A context cache that expires after a request of the decode completed ends the call with that request billed; the
  decode is not restarted, so a call never bills more than one decode under its reservation.

`src/gemini/long-decode.ts` (`continuationInputTokens`, `decodedTokensBound`) holds the formula. Example: `P` = 100 k,
`C` = 262,144 on Hydrogen → 4 requests, 793,984 input tokens reserved.

**Time.** `timeoutMs` (at most 30 minutes) covers the whole decode. At the measured pace (375–482 s for two requests)
about 7 to 9 requests fit in it; a call that needs more ends in `errorCode: TIMEOUT`, its completed requests billed
and reported in the error (token fields, `costEstimateUsd`, `continuationHops`).

## Budget cap — how the enforcement actually works

`GEMINI_DAILY_BUDGET_USD` is an **atomic** reservation, not a read-then-act check. From v1.0.3 onward:

1. After the workspace is scanned and the model resolved, we compute a conservative cost estimate: `input_tokens × input_rate + maxOutputTokens × output_rate + thinkingBudget × output_rate`, where `input_tokens` is the larger of `workspace_bytes ÷ 4 + prompt_chars ÷ 4` and the preflight's count when it ran, plus the input every continuation request bills again on a Gemini 4 long decode ([above](#long-decode-on-gemini-4)).
2. That estimate is inserted into the usage-metrics table inside a `BEGIN IMMEDIATE` SQLite transaction. Concurrent tool calls are serialised by SQLite's reserved lock — if the reservation would push cumulative spend over the cap, the transaction rolls back and the tool returns `Daily budget cap would be exceeded: spent $X + estimate $Y > cap $Z`.
3. The `generateContent` call carries an explicit `maxOutputTokens` matching the estimate (every request of a long decode carries the same cap), so a runaway response cannot exceed what was reserved.
4. On success, the estimate row is overwritten with the measured cost (typically lower — finalize corrects the over-estimate). On failure, the reservation is cancelled so its headroom comes back — unless one or more requests of the call had completed (`ask` / `code`: a long decode whose continuation request failed, met a stale cache or timed out): those were billed, so the row is settled at their measured cost and only the rest of the reservation comes back. An `ask_agentic` pass whose model call completed is booked the same way when the pass fails afterwards ([below](#what-is-booked-when-a-call-fails)).

Result: N concurrent tool calls cannot collectively overshoot the cap with what the ledger books, and a single `ask` / `code` call cannot either, thanks to `maxOutputTokens`. Two kinds of spend sit outside that bound: [what the daily budget does not bound](#what-the-daily-budget-does-not-bound).

**Caveat:** the `bytes ÷ 4` token heuristic undercounts multibyte / CJK / emoji-dense content by ~1.3×–2×. The reservation uses the preflight's count instead whenever the preflight counted (`preflightMode: 'exact'`, `'auto'` near the input limit, and every Gemini 4 long decode); on other calls it rests on the heuristic. For accurate caps on those workloads, set `preflightMode: 'exact'`, or `GEMINI_DAILY_BUDGET_USD` ~2× lower than your true limit (see [FOLLOW-UP-PRS.md T17](./FOLLOW-UP-PRS.md)).

**`status` cost breakdown:** `spentTodayUsd` keeps its conservative-upper-bound semantics (settled + in-flight reservations), so a call is refused before what the ledger books could pass the cap ([what it does not bound](#what-the-daily-budget-does-not-bound)). *(v1.7.0+)* `status` additionally exposes `spentTodaySettledUsd` and `inFlightReservedTodayUsd` (plus workspace-scoped equivalents `usage.settledCostUsd` / `usage.inFlightReservedUsd`), and the human-readable line shows `"(settled $X + $Y in-flight reserved)"` whenever in-flight ≠ 0. Streaming made the in-flight window much more observable on long HIGH-thinking calls (60–180 s) — the breakdown closes that perception gap.

## What is booked when a call fails

One rule for `ask`, `code` and `ask_agentic`: **a request is billed once its model call completed** — its stream
reached its end, or (the `ask_agentic` forced-finalization pass) `generateContent` returned. A completed request stays
in the ledger whatever fails after it, at the usage it reported, or at the input it was estimated to send when no usage
could be read. A request that did not complete — refused, failed at its opening, failed or aborted mid-stream, even
after chunks that carried usage — is booked at 0 and its reservations come back: Google reports usage on a stream's
last chunk, and a stream is never re-sent. Whether Google bills a request aborted after its stream opened is not
measured ([below](#what-the-daily-budget-does-not-bound)). Once an answer exists, writing its ledger row is
best-effort: a failed write is logged (`finalizeBudgetReservation failed …` keeps the reservation's estimate;
`insertUsageMetric failed …` leaves no row) and the answer is returned.

An `ask_agentic` pass booked before it failed reports what it billed in the error result — `cachedTokens`,
`uncachedTokens`, `outputTokens`, `thinkingTokens`, `costEstimateUsd` of that pass, as a failed `ask` / `code` call
reports its completed requests'. The passes before it were booked when they ended; their input is in
`cumulativeInputTokens` where the result carries it.

`ask` and `code` count the requests of a call (a Gemini 4 long decode has several); an `ask_agentic` pass is one loop
iteration or the forced-finalization pass, each with its own daily-budget and TPM reservation.

`ask_agentic`'s forced-finalization pass ends the call as `subReason: 'AGENTIC_MAX_ITERATIONS'` (`errorCode:
UNKNOWN`) whenever it gives no answer; the table names its `finalizationSkipReason` / `rescueErrorCode`.

| Where the call ends | `ask` / `code`: ledger | `ask_agentic` pass: ledger and TPM | What the result carries |
|---|---|---|---|
| Daily budget refused the reservation | nothing reserved | nothing reserved | `BUDGET_REJECT`; forced pass: `finalizationSkipReason: 'daily-budget'` |
| Timeout during the TPM wait | released, unless an earlier request of the call completed: then booked at what those billed | both reservations released | `TIMEOUT`, with the completed requests' usage fields (`ask` / `code`); loop iteration: `TIMEOUT`, its `apiCalls` not counting the pass; forced pass: `rescueErrorCode: 'TIMEOUT'`, `apiCalls` not counting it |
| Refused or failed at the opening (429, 4xx, 5xx, network after retries) | as above | both released | the error, with the completed requests' usage fields (`ask` / `code`); loop iteration: `UNKNOWN`; forced pass: `rescueErrorCode` `'RATE_LIMIT'`, `'API_ERROR'` or `'NETWORK'` |
| Failed or timed out before the call completed (mid-stream; the forced pass before `generateContent` returned) | as above: the request is not booked | both released | as above, or `TIMEOUT`; forced pass: its `rescueErrorCode` |
| Call completed, then reading the response threw | booked | booked at the usage read, the estimate when none was; TPM released at that input | the error with the booked usage; loop iteration: `UNKNOWN` with the pass's fields; forced pass: `rescueErrorCode: 'INTERNAL'` with them |
| Stream completed, then the iteration timed out in its tool batch | — | booked at the reported usage; TPM released at it | `TIMEOUT` for the iteration with the pass's fields, `apiCalls` counts it |
| Forced pass answered with no text | — | booked; TPM released at the billed input | `rescueErrorCode: 'EMPTY_TEXT'` with the pass's fields |
| Answer, ledger write failed | logged, answer returned | logged, answer returned | the answer |
| Answer | booked; the rest of the reservation released | booked; TPM released at the billed input | the answer with its usage |

## What the daily budget does not bound

`GEMINI_DAILY_BUDGET_USD` and the TPM window bound what the ledger books. Two kinds of spend can sit outside them:

- **A request aborted or failed after its stream opened** (a timeout, a stall, a reset mid-stream, in all three
  tools). The server books it 0 and gives its reservations back. Whether Google bills such a request is not measured,
  and Google does not document it as far as we found ([FOLLOW-UP-PRS.md T43](./FOLLOW-UP-PRS.md)). If it does, that
  request is outside the budget and the TPM window: at most its whole input plus what it decoded before the abort —
  for `ask` / `code`, no more than its reservation. A `TIMEOUT` result is `retryable: true`, so a retried call can
  repeat it.
- **An `ask_agentic` loop iteration larger than its estimate.** Each iteration reserves a fixed 50,000 input tokens
  (and 4,096 output plus 4,096 thinking tokens that are not capped on the wire, T38), whatever the conversation's size.
  An iteration that sends more can be settled above its reservation — on Gemini 3 Pro with the default output
  reservation and little output, from about 87,000 prompt tokens — and one whose usage could not be read is booked
  at 50,000, below what it sent. The forced
  pass reserves the last iteration's prompt plus the tool responses after it (plus 5,000), so its estimate follows the
  conversation.

## Free tier

Gemini's free tier gives you Flash models with 1M context and per-minute rate limits. Context Caching is paid-tier only — on free tier the server falls back to inline file parts (slower, but no monthly commit).

If you're on free tier:

- Set `GEMINI_CODE_CONTEXT_DEFAULT_MODEL=latest-flash`
- Expect each call to re-send the full context (no cache)
- Set a low `GEMINI_DAILY_BUDGET_USD` to stay within the free envelope
- Skip `code` — thinking tokens aren't free
