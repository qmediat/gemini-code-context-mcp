# Configuration

All configuration is environment-variable-driven. Secrets live in `~/.config/qmediat/credentials` (chmod 0600), not in the MCP host config.

## Auth resolution order

The server picks the highest-trust source available, in this order:

1. **Vertex AI** — `GEMINI_USE_VERTEX=true` + `GOOGLE_CLOUD_PROJECT` (+ optional `GOOGLE_CLOUD_LOCATION`, default `us-central1`). Auth relies on ADC (`gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`).
2. **Credentials file** — `GEMINI_CREDENTIALS_PROFILE` env (default: `default`) names a profile in `~/.config/qmediat/credentials`. Written by `npx @qmediat.io/gemini-code-context-mcp init`.
3. **Raw env key** — `GEMINI_API_KEY`. Works, but logs a warning. Prefer #2 unless you're running in CI.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_CREDENTIALS_PROFILE` | `default` | Profile name in the credentials file (Tier 2) |
| `GEMINI_API_KEY` | — | Raw key fallback (Tier 3; emits a warning) |
| `GEMINI_USE_VERTEX` | `false` | Set `true` + `GOOGLE_CLOUD_PROJECT` to use Vertex AI |
| `GOOGLE_CLOUD_PROJECT` | — | GCP project for Vertex |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Region for Vertex |
| `GEMINI_CODE_CONTEXT_DEFAULT_MODEL` | `latest-pro-thinking` | Alias (`latest-pro`, `latest-pro-thinking`, `latest-flash`, `latest-lite`) or literal model ID. Default picks the newest Pro model with reasoning support; override to `latest-pro` if you want non-thinking variants, or to a flash alias for cost-sensitive workloads. |
| `GEMINI_DAILY_BUDGET_USD` | unlimited | Hard cap; refuses calls over the cap until UTC midnight |
| `GEMINI_CODE_CONTEXT_CACHE_TTL_SECONDS` | `3600` | Context Cache TTL (Gemini enforces ≥ 60 s) |
| `GEMINI_CODE_CONTEXT_CACHE_MIN_TOKENS` | `1024` | Minimum estimated tokens required before attempting `caches.create`. Below this we skip the cache build and use inline parts. Gemini currently enforces 1024; expose this knob so operators can adjust without a patch release if Google changes the floor. |
| `GEMINI_CODE_CONTEXT_MAX_FILES` | `2000` | Soft upper bound on files indexed per workspace |
| `GEMINI_CODE_CONTEXT_MAX_FILE_SIZE` | `1000000` | Skip files bigger than this (bytes) |
| `GEMINI_CODE_CONTEXT_TPM_THROTTLE_LIMIT` | `80000` | Client-side tokens-per-minute ceiling per resolved model. Delays `ask` / `code` calls that would push the last 60 seconds of input-token usage past this cap — cheaper than burning a 429 round-trip. Default leaves ~20% headroom under Gemini's observed Tier 1 paid limit of 100k tokens/min for Gemini 3 Pro; raise it if your key is on a higher tier or lower it if you share the quota pool with another app. Set `0` to disable the throttle entirely (relies on Gemini's 429 behaviour and `retryInfo.retryDelay` alone). Cached tokens count toward this limit — empirically confirmed against Gemini 3 Pro. |
| `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT` | `false` | When `true`, every `ask` / `code` call sends `maxOutputTokens = modelOutputLimit` on the wire (currently 65,536 for Gemini 3.x / 2.5 Pro per [Google docs](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)) so the model runs at its full output capacity. Primary use case: code-review workloads that routinely produce long OLD/NEW diff blocks. Default `false` means the field is omitted from the `generateContent` config and Gemini uses its own model-default (which per Google docs equals the model's advertised limit — so default behaviour is already "auto = full capacity" without explicitly setting it). Per-call `input.maxOutputTokens` always overrides this env var — callers who want to cap a specific call lower can still do so. Budget reservation always uses the effective cap (explicit OR model limit) as worst-case, so `GEMINI_DAILY_BUDGET_USD` remains a true upper bound regardless of this setting. |
| `GEMINI_CODE_CONTEXT_FORCE_RESCAN` *(v1.13.0+)* | `false` | When `true`, every `ask` / `code` call bypasses the v1.13.0 scan memo and re-hashes every file in the workspace. The scan memo (default behaviour) skips per-file SHA256 when `mtime_ms` and `size` match the previously-stored values — typically ~95% of files on a warm rescan, cutting scan wall-clock by ≥10× on large workspaces. Enable this if you've observed scan results going stale after filesystem mutations outside the dev workflow (NTP clock-skew, archives unpacked over an existing tree, `git checkout` on a dir with unchanged mtimes, etc.). Per-call `input.forceRescan: true` is ORed with this flag — either being `true` forces a fresh hash. The `reindex` tool always passes `forceRescan: true` regardless of this env var. |
| `GEMINI_CODE_CONTEXT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. **At `debug` level, the agentic dispatcher writes a one-liner per refused tool call that includes the full path the model asked for** (e.g. `agentic dispatch refused: tool=read_file code=EXCLUDED_FILE requestedPath=internal-secrets/api-key.ts`) — useful for diagnosing "why is my file being blocked?" but means paths your `excludeGlobs` is intentionally hiding from the model become visible in stderr. Don't enable `debug` if you ship stderr to environments (centralized log analyzers, audit pipelines) that shouldn't see those paths. Untrusted-source values in every log line are escaped (`\n`/`\r`/control chars → printable form, max 2 000 chars per value) so a model-controlled string cannot forge a fake log record. |
| `GEMINI_CODE_CONTEXT_TELEMETRY` | `false` | Set `true` to opt into anonymous usage counts (nothing happens yet — reserved for future public dashboard) |
| `GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE` | `false` | Set `true` to bypass the `validateWorkspacePath` guard that rejects paths outside the MCP host's cwd unless they contain a recognised workspace marker. Only set this for genuinely unconventional roots (CI sandboxes, generated build dirs). Do NOT set it to work around a prompt-injection vector — the guard is the security control. |
| `GEMINI_PRICING_OVERRIDES` | — | JSON map of `model → {inputPerMillion, outputPerMillion, cachedInputPerMillion?}`. See example below. |
| `XDG_CONFIG_HOME` | — | Override the config directory (defaults to `~/.config`) |
| `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS` *(v1.6.0+)* | disabled | Wall-clock timeout in ms for `ask`. Bounded `[1000, 1_800_000]` (1 s to 30 min). Aborts the in-flight `generateContent` request via `AbortController` when exceeded. Empty / `0` / negative = disabled. Per-call `ask({ timeoutMs })` always wins. **Caveat:** `AbortSignal` is client-only — Gemini may still finish server-side and bill for completed work (per `@google/genai` SDK docs). |
| `GEMINI_CODE_CONTEXT_CODE_TIMEOUT_MS` *(v1.6.0+)* | disabled | Same shape as the `ask` variant, applied to the `code` tool. Per-call override: `code({ timeoutMs })`. |
| `GEMINI_CODE_CONTEXT_AGENTIC_ITERATION_TIMEOUT_MS` *(v1.6.0+)* | disabled | Per-iteration cap for `ask_agentic`. Bounds each loop iteration (one `generateContent` + possible tool calls) independently. A single hung iteration aborts the whole agentic call with `errorCode: "TIMEOUT"` — continuing with partial state would leave the conversation structurally incomplete (the failed iteration's function-call results never came back). Per-call override: `ask_agentic({ iterationTimeoutMs })`. |
| `GEMINI_CODE_CONTEXT_ASK_STALL_MS` *(v1.12.0+)* | disabled | Heartbeat-aware stall watchdog for `ask`. Bounded `[1000, 600000]` (1 s to 10 min). Resets on every chunk (text or thought) — fires only when the stream goes silent for this long. Does NOT fire while the model is actively thinking; the streaming heartbeat (~1500 ms via thought chunks) keeps the watchdog reset. Recommended setting: `60000` (60 s) — Gemini Pro can pause 15-30 s mid-reasoning between thought chunks under heavy thinking; 60 s absorbs that jitter while still killing dead sockets ~30× faster than the wall-clock alternative. Independent of `..._TIMEOUT_MS` — both can be set; whichever fires first wins. Returns `errorCode: "TIMEOUT"` with `timeoutKind: "stall"`. Per-call override: `ask({ stallMs })`. |
| `GEMINI_CODE_CONTEXT_CODE_STALL_MS` *(v1.12.0+)* | disabled | Same shape as the `ask` variant, applied to the `code` tool. Per-call override: `code({ stallMs })`. |
| `GEMINI_CODE_CONTEXT_SHUTDOWN_DRAIN_MS` *(v1.8.0+)* | `5000` | On `SIGINT`/`SIGTERM`, the server waits up to this many milliseconds for in-flight `tool.execute(...)` calls to settle before tearing down the transport — so a long `ask`/`code`/`ask_agentic` already running when Claude Code restarts the server can return its response. Range `[0, 60000]`; values outside the range emit a startup warning and fall back to the default. Set `0` to revert to the v1.7.x "exit immediately" behaviour. Abandoned calls (calls that didn't drain in time) are logged at WARN — Gemini may still finish server-side and bill for the request, but the response stream is not delivered to the client. |

## Per-call overrides

Every tool accepts runtime overrides that beat the defaults:

- `ask({ model: "latest-flash" })` — force a cheaper model for this one question
- `ask({ noCache: true })` — bypass the context cache and send files inline
- `ask({ thinkingBudget: 0 })` — disable reasoning for a shallow lookup-style question (rejected by Gemini 3 Pro with 400; fine on Gemini 2.5 / Flash)
- `ask({ thinkingBudget: 8000 })` — explicit cap; use on Gemini 2.5 for cost-bounded deep-dives. On Gemini 3 Pro prefer `thinkingLevel` or omit reasoning params entirely
- `ask({ thinkingLevel: "LOW" })` — discrete reasoning tier for Gemini 3 (Google's recommended knob on 3.x). Values: `MINIMAL` (Flash-Lite only), `LOW`, `MEDIUM`, `HIGH` (Gemini 3 Pro's default when the field is omitted). Rejected by Gemini 2.5 family — use `thinkingBudget` there. Mutually exclusive with `thinkingBudget` — schema refuses both-set with a clear error
- `code({ thinkingBudget: 32000, codeExecution: true })` — harder problem, let Gemini verify with Python
- `code({ thinkingLevel: "HIGH" })` — discrete reasoning tier on Gemini 3 (Google's recommended knob there); mutually exclusive with `thinkingBudget`. `code` still defaults to `thinkingBudget: 16384` when neither is passed — a stronger default than `ask`'s "omit entirely" because coding genuinely benefits from reasoning
- `code({ maxOutputTokens: 8192 })` — cap a specific call's response length (defaults to auto = model-full 65,536 per Google docs for Gemini 3.x / 2.5 Pro). Values above the resolved model's limit are clamped. Operators who want EVERY call at full capacity set `GEMINI_CODE_CONTEXT_FORCE_MAX_OUTPUT=true` at MCP-host level; this per-call field still beats the env override
- `ask({ includeGlobs: [".proto"], excludeGlobs: ["legacy"] })` — extend the indexer
- `ask({ timeoutMs: 60_000 })` *(v1.6.0+)* — wall-clock cap for this call (1 s–30 min). Aborts via `AbortController` if Gemini takes longer; returns `errorCode: "TIMEOUT"`. Combine with `withNetworkRetry` (auto-on since v1.5.1) for a closed reliability loop: pre-response retry + bounded wall-clock.
- `code({ timeoutMs: 120_000 })` *(v1.6.0+)* — same on `code`. Coding tasks tolerate longer timeouts because thinking budgets are higher; 2-min default is a reasonable starting point.
- `ask_agentic({ iterationTimeoutMs: 90_000 })` *(v1.6.0+)* — bounds each loop iteration. Single-iteration hangs abort the whole agentic call (`maxIterations` × `maxTotalInputTokens` separately bound the whole loop). Bound covers BOTH the per-iteration TPM throttle wait AND the SDK call — a wait that exceeds the deadline aborts cleanly, releases its budget + throttle reservations, and surfaces as `errorCode: 'TIMEOUT'`.
- `ask({ stallMs: 60_000 })` / `code({ stallMs: 60_000 })` *(v1.12.0+)* — heartbeat-aware liveness watchdog. Resets on every chunk (text or thought); fires only when the stream goes silent for this long. Does NOT fire while the model is actively thinking. Independent of `timeoutMs`; both can be set, whichever fires first wins. Error metadata distinguishes via `timeoutKind: "total" | "stall"` so orchestrators can apply different retry policies. Recommended for long HIGH-thinking calls where the wall-clock cost ceiling needs to be more permissive than the dead-socket detector.
- `ask({ preflightMode: "exact" })` / `code({ preflightMode: "exact" })` *(v1.10.0+)* — `"heuristic"` (`bytes/4` fast estimate, no API round-trip), `"exact"` (always call `countTokens`, cached per `(filesHash + prompt + model)`), or `"auto"` (default — heuristic when the workspace is well under 50% of the model's input limit; exact when near the cliff). `"exact"` is the right choice in CI / tests where you want predictable behaviour regardless of repo size; `"auto"` is recommended for interactive use.
- `ask({ onWorkspaceTooLarge: "fallback-to-agentic" })` *(v1.11.0+, `ask` only)* — when the v1.5.0 preflight detects the workspace exceeds the model's `inputTokenLimit × workspaceGuardRatio`, transparently re-route through `ask_agentic` (sandboxed file-access loop — no eager upload, scales to arbitrarily large repos). Default `"error"` preserves the v1.5.0 behaviour of returning `errorCode: "WORKSPACE_TOO_LARGE"`. Wrapped result carries `fallbackApplied: "ask_agentic"`, `fallbackReason: "WORKSPACE_TOO_LARGE"`, plus `iterTimeoutMs` / `iterTimeoutSource` (v1.12.2+) showing which timeout knob bound the agentic call. Semantic divergence: `timeoutMs` becomes a per-iteration cap on the agentic path, so total wall-clock can reach `maxIterations × timeoutMs`. `code` does not support this field — its OLD/NEW edit format is load-bearing for Claude's Edit pipeline and `ask_agentic` returns prose only.
- `ask({ cachingMode: "implicit" })` / `code({ cachingMode: "implicit" })` *(v1.13.0+)* — opt into Gemini 2.5+/3 Pro's automatic implicit caching instead of building an explicit Context Cache. **`"explicit"`** (default) builds a `caches.create` cache for guaranteed ~75 % discount on cached input tokens but pays a 60–180 s rebuild cost when files change. **`"implicit"`** skips `caches.create` entirely; file content is sent inline every call and Gemini's automatic implicit cache discounts the prefix when it matches across calls. Best fit for review→edit→review workflows (no rebuild wait when files change between queries); the trade-off is that implicit caching has no cost-saving guarantee per [ai.google.dev/gemini-api/docs/caching](https://ai.google.dev/gemini-api/docs/caching). Hit rate is observable via `status.structuredContent.caching.implicitHitRate`; the `status` tool warns inline if your hit rate falls below 50 %. The default may flip to `"implicit"` in v1.14.0 pending dogfood telemetry.
- `ask({ forceRescan: true })` / `code({ forceRescan: true })` *(v1.13.0+)* — bypass the v1.13.0 scan memo and re-hash every file in the workspace. The scan memo skips per-file SHA256 when `mtime_ms` and `size` match the previously-stored values; ~95 % of files on a warm rescan, cutting scan wall-clock by ≥10× on large workspaces. Set this when you suspect the manifest is stale — operator-equivalent of `reindex` (which always force-rescans) but scoped to a single call. Equivalent to setting `GEMINI_CODE_CONTEXT_FORCE_RESCAN=true` for the single call; either source being `true` forces a fresh hash.

## Live thinking heartbeat *(v1.7.0+)*

`ask` and `code` use Gemini's `generateContentStream` under the hood. Whenever the model emits a thought-flagged chunk (Gemini's reasoning trace, enabled by `includeThoughts: true`), the server forwards a truncated preview to the MCP host as a progress notification — `"thinking: <first ~120 chars>…"`. Throttled at ~1500 ms by default to avoid flooding the host. Visible in Claude Code's UI during long HIGH-thinking calls; replaces what used to be silent 60–180 s pauses with continuous evidence the call is alive.

The stream collector preserves all existing behaviour — `text`, `usageMetadata`, `candidates`, `thoughtsSummary`, `withNetworkRetry`, stale-cache retry, `timeoutMs` — only the response-assembly path changes. A mid-stream failure cannot be retried (Gemini's stream API has no resume); pre-response failures still get the full 3-attempt retry budget.

## Status output *(v1.7.0+ adds settled vs in-flight breakdown)*

`status` returns workspace cache state, available models, daily/lifetime usage, and the active model registry. v1.7.0 added two new field pairs that separate finalised cost from in-flight reservations:

- `spentTodaySettledUsd` / `usage.settledCostUsd` — cost from completed calls only
- `inFlightReservedTodayUsd` / `usage.inFlightReservedUsd` — sum of reservations whose `generateContent` is still running

`spentTodayUsd` and `usage.totalCostUsd` keep their existing semantics (settled + in-flight) so daily-budget enforcement remains a true upper bound. The human-readable line appends `"(settled $X + $Y in-flight reserved)"` only when in-flight ≠ 0 — no noise on the common path. Streaming made the in-flight window much more observable on long HIGH-thinking calls; the breakdown closes that perception gap.

### Caching telemetry *(v1.13.0+)*

The new `cachingMode` field surfaces a `caching` block on `status` so operators can see how their workspace is being served:

- `caching.mode` — dominant caching strategy in the last 24 h (`"explicit"` / `"implicit"` / `"mixed"` / `null`).
- `caching.callCount` — `ask` + `code` calls in the window. `ask_agentic` is excluded from this aggregation (it doesn't use a workspace cache); `cache.create` infrastructure rows are tallied separately under `explicitRebuildCount`.
- `caching.implicitCallsTotal` / `caching.implicitCallsWithHit` — coverage-style hit rate at the call level (Gemini's automatic implicit cache fired at all on this call vs not at all).
- `caching.implicitHitRate` — token-weighted hit rate: `cachedContentTokenCount / (cachedContentTokenCount + uncachedTokens)` across implicit-mode calls. The status tool's human text renders this as a percentage and warns inline if it's < 50 %.
- `caching.explicitRebuildCount` — number of `caches.create` calls that fired in the window. The v1.13.0 implicit-mode pivot's whole point is to drive this number toward zero for review→edit→review workflows.

The block is hidden when there are no calls in the window — fresh installs / unused workspaces don't see noise.

## Model aliases

The server enumerates models available to your API key at startup, classifies each by functional **category** (`text-reasoning`, `text-fast`, `text-lite`, `image-generation`, `audio-generation`, `video-generation`, `embedding`, `agent`, `unknown`), and only matches aliases within the correct category. When Google ships a new Pro text-gen model that your key can reach, `latest-pro` picks it up automatically; when they ship a new image-gen family that shares the `pro` token, it stays out of `latest-pro`'s path.

| Alias | Category | Picks |
|---|---|---|
| `latest-pro` | `text-reasoning` | Newest pro-tier text model |
| `latest-pro-thinking` | `text-reasoning` + `supportsThinking` | Newest pro model with reasoning support (default for `code`) |
| `latest-flash` | `text-fast` | Newest flash-tier text model |
| `latest-lite` | `text-lite` | Newest lite-tier (cheapest) text model |
| `latest-vision` | `text-reasoning` ∪ `text-fast` + `supportsVision` | Newest vision-capable text model |

Literal IDs always work too: `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, etc. They're category-checked too — passing e.g. `nano-banana-pro-preview` to `code` throws `ModelCategoryMismatchError` with an actionable message (image-gen models have 10× pricing and a different API shape; we refuse to dispatch silently).

**Full category table, alias contract, failure-mode examples, and the "what happens when Google ships a new family" walkthrough** — see [`docs/models.md`](./models.md).

## Credentials file format

`~/.config/qmediat/credentials` is an INI-like file. You *can* edit it by hand, but `init` is less error-prone:

```ini
# qmediat credentials — keep this file private (chmod 0600)

[default]
gemini_api_key = AIza...
default_model = latest-pro
daily_budget_usd = 10.00

[work]
vertex_project = my-gcp-project
vertex_location = europe-west1
default_model = latest-pro
daily_budget_usd = 50.00
```

Switch profiles per host by setting `GEMINI_CREDENTIALS_PROFILE` in the MCP host config:

```json
"env": { "GEMINI_CREDENTIALS_PROFILE": "work" }
```

## Pricing override example

Gemini prices change; our estimator ships with defaults verified at build time. Override them without a reinstall:

```json
"env": {
  "GEMINI_PRICING_OVERRIDES": "{\"gemini-3-pro-preview\":{\"inputPerMillion\":3.00,\"outputPerMillion\":9.00,\"cachedInputPerMillion\":0.75},\"gemini-3-flash-preview\":{\"inputPerMillion\":0.25,\"outputPerMillion\":2.00}}"
}
```

All three rate fields are in USD per million tokens. `cachedInputPerMillion` is optional — when omitted, the estimator charges cached tokens at 25 % of the `inputPerMillion` rate.

Use this to:
- Keep cost estimates accurate after a Google price change before we publish a patch.
- Model your own Vertex pricing if it differs from Gemini Developer API rates.
