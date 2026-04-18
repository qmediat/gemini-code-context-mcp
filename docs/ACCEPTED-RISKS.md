# Accepted risks

Findings from `/6step` analysis and code review that are real but consciously accepted in the current release. Each entry says **what the risk is**, **why we accept it**, and **what would change our mind**.

This list is the flip side of `docs/KNOWN-DEFICITS.md`: deficits are issues we'll fix when the trigger hits; accepted risks are issues we believe should stay as-is.

---

## API-key fingerprint format (`AIza…xyz9`)

**Source:** Grok code review, April 2026 — "Partial key exposure enables oracle attacks".

**Risk claim:** Logging the first 4 + last 4 characters of the API key plus knowing Google's fixed `AIza` prefix and 39-char length reduces the brute-force search space for an offline attacker.

**Why we accept:** Cryptographic math: a Gemini key has roughly 64^31 ≈ 10^56 possible values in the unknown middle chunk. Revealing 4 known + 4 trailing characters leaves ≈10^54 possibilities — still astronomical. No practical brute-force advantage is gained.

**Why the convention is worth keeping:** Industry-standard. AWS, Stripe, GitHub all log key fingerprints this way because auditors need to verify "is the key I see in the log the key that was leaked?" without exposing the secret. Switching to a SHA-256 prefix breaks the visual-match workflow for incident responders without improving real security.

**What would change our mind:** A published attack demonstrating practical key recovery from this kind of fingerprint. No such attack exists at the entropy levels involved.

**Mitigation if you disagree:** Set `GEMINI_CODE_CONTEXT_LOG_LEVEL=error` to suppress the `[info]` line that emits the fingerprint at startup.

---

## MIME type: all source files uploaded as `text/plain`

**Source:** Gemini code review, April 2026 — "Degraded model performance via hardcoded `text/plain`".

**Risk claim:** Uploading source files as `text/plain` bypasses Gemini's format-aware tokenization for structured formats (JSON, Markdown, YAML, XML).

**Why we accept:** Gemini requires the mime type on `fileData.fileUri` references to MATCH the mime type declared at upload. If we upload a README as `text/markdown` but reference it later as `text/plain` (or vice versa), `caches.create` returns 400 "Request contains an invalid argument" — verified empirically during the v1.0 review cycle. Supporting per-file mime properly requires threading the upload-time mime through `FileRow` and into every `buildContentFromUploaded` call, a schema change we don't want to ship reflexively.

**Also:** for source code specifically, Gemini documents no tokenization difference between `text/plain` and `text/x-typescript` / `text/x-python` / etc. The model treats source consistently. So the MIME gain is limited to a handful of structured formats (JSON, MD, YAML) where the delta, if it exists, is small.

**What we shipped:** Every upload uses `text/plain`. `fileData.fileUri` references use `text/plain`. No mismatch.

**What would change our mind:** User reports of quality degradation on markdown-heavy or JSON-heavy workspaces where MIME tuning would measurably help. We'd then implement the FileRow.mimeType thread-through (tracked in [`FOLLOW-UP-PRS.md`](./FOLLOW-UP-PRS.md) as a potential addition).

---

## Budget cap provides one-call-over protection, not hard ceiling

**Source:** GPT code review + prior `/6step`.

**Risk claim:** `GEMINI_DAILY_BUDGET_USD` checks cumulative spend BEFORE each call. A single call that exceeds the remaining budget completes (we don't estimate cost upfront), the next call is blocked.

**Why we accept:** Estimating cost upfront requires projecting tokens from scan data — the projection is lossy, and over-projecting would block legitimate calls. The current design is honest about its semantics: "stop the bleed once you realise you're bleeding". Users who need a hard ceiling should combine this with Google-side per-key quota limits (documented in `docs/security.md`).

**What would change our mind:** A concrete cost-estimation model that's accurate enough to gate pre-call without false positives.

---

## Concurrent cache creation is coalesced in-process only

**Source:** GPT + Grok code reviews.

**Risk claim:** Two MCP server processes on the same machine (two Claude Code windows) can both decide to build the same cache concurrently, resulting in one orphan cache on Google's side.

**What we did:** In-process mutex via `Map<workspaceRoot, Promise>` inside `prepareContext`. Covers the common case — parallel tool calls from a single MCP host.

**Why we don't fix cross-process:** Cross-process coordination requires file-based locking (flock, SQLite `BEGIN IMMEDIATE`), which adds complexity and a new failure mode (locks abandoned by crashed processes). The impact is one orphan cache per concurrent-build event, bounded by TTL — on the order of cents per event.

**Revisit trigger:** User reports of multi-instance orphan-cache bills, or multi-instance usage patterns becoming common.

---

## Pre-rebuild `caches.delete` loses working cache on transient create failure

**Source:** Grok code review, April 2026 — "transient Gemini outage now costs the cache".

**Risk claim:** The cache-manager deletes an existing stale cache BEFORE calling `caches.create`. If the create then fails with a transient 5xx (Gemini outage, rate limit), the user has lost their working cache and falls back to inline parts for the rest of the session.

**Why we accept:** The alternative — create-then-delete-old — leaks the old cache on Google's side when create succeeds with a new ID (the orphan keeps billing at storage rate until TTL expiry). We picked "lose-on-transient-failure" over "leak-on-success" because:
1. Transient 5xx is rare (<1% of calls) and recovers on the next `ask`/`code` (which rebuilds).
2. Orphan caches on success are COMMON (every filesHash change) and cost money every time.
3. The total expected loss from transient failures is bounded by 1h of cache-miss input token costs; orphan caches bill over 1h × N failures.

**What would change our mind:** Real observability from users showing frequent transient 5xx (e.g. >5% of rebuilds) would justify moving to a `Promise.allSettled` two-step pattern (run delete in parallel with create; if create fails, retain old cacheId).

**Mitigation available now:** Set `GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS=3600` (default) and accept that a single Gemini outage costs one cache-build worth of input tokens (~$0.5-$3 for large workspaces). Users on very large workspaces who feel this pain can report it.

---

## PLAN.md is committed to the public repo

**Source:** Prior `/6step` self-review.

**Risk claim:** The strategic planning document in the repo root contains verbatim excerpts from 3-LLM consultation with frank (sometimes blunt) language about competing MCP servers. Visible to anyone who clones.

**Why we accept:** Transparency > sanitization. The planning document demonstrates how the product was shaped; erasing the brainstorming phase makes the repo look like polished marketing output rather than honest engineering. The disclaimer at the top of `PLAN.md` makes the artefact nature explicit.

**Revisit trigger:** A specific complaint from a named party quoted in the document. We'd redact the quote in place and replace it with a paraphrase.
