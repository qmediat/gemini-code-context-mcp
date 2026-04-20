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
| `GEMINI_CODE_CONTEXT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `GEMINI_CODE_CONTEXT_TELEMETRY` | `false` | Set `true` to opt into anonymous usage counts (nothing happens yet — reserved for future public dashboard) |
| `GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE` | `false` | Set `true` to bypass the `validateWorkspacePath` guard that rejects paths outside the MCP host's cwd unless they contain a recognised workspace marker. Only set this for genuinely unconventional roots (CI sandboxes, generated build dirs). Do NOT set it to work around a prompt-injection vector — the guard is the security control. |
| `GEMINI_PRICING_OVERRIDES` | — | JSON map of `model → {inputPerMillion, outputPerMillion, cachedInputPerMillion?}`. See example below. |
| `XDG_CONFIG_HOME` | — | Override the config directory (defaults to `~/.config`) |

## Per-call overrides

Every tool accepts runtime overrides that beat the defaults:

- `ask({ model: "latest-flash" })` — force a cheaper model for this one question
- `ask({ noCache: true })` — bypass the context cache and send files inline
- `ask({ thinkingBudget: 0 })` — disable reasoning for a shallow lookup-style question (rejected by Gemini 3 Pro with 400; fine on Gemini 2.5 / Flash)
- `ask({ thinkingBudget: 8000 })` — explicit cap; use on Gemini 2.5 for cost-bounded deep-dives. On Gemini 3 Pro prefer `thinkingLevel` or omit reasoning params entirely
- `ask({ thinkingLevel: "LOW" })` — discrete reasoning tier for Gemini 3 (Google's recommended knob on 3.x). Values: `MINIMAL` (Flash-Lite only), `LOW`, `MEDIUM`, `HIGH` (Gemini 3 Pro's default when the field is omitted). Rejected by Gemini 2.5 family — use `thinkingBudget` there. Mutually exclusive with `thinkingBudget` — schema refuses both-set with a clear error
- `code({ thinkingBudget: 32000, codeExecution: true })` — harder problem, let Gemini verify with Python
- `code({ thinkingLevel: "HIGH" })` — discrete reasoning tier on Gemini 3 (Google's recommended knob there); mutually exclusive with `thinkingBudget`. `code` still defaults to `thinkingBudget: 16384` when neither is passed — a stronger default than `ask`'s "omit entirely" because coding genuinely benefits from reasoning
- `ask({ includeGlobs: [".proto"], excludeGlobs: ["legacy"] })` — extend the indexer

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
