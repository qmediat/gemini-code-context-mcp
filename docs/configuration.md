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
- `ask({ thinkingBudget: 8000 })` — explicit cap; use on Gemini 2.5 for cost-bounded deep-dives. On Gemini 3 Pro prefer omitting the param — that triggers the model's HIGH-dynamic default, which is Google's recommended path
- `code({ thinkingBudget: 32000, codeExecution: true })` — harder problem, let Gemini verify with Python
- `ask({ includeGlobs: [".proto"], excludeGlobs: ["legacy"] })` — extend the indexer

## Model aliases

The server enumerates models available to your API key at startup. Aliases resolve dynamically, so when Google ships a new Pro model and your key can reach it, `latest-pro` picks it up without any change on your end.

| Alias | Picks |
|---|---|
| `latest-pro` | Newest non-image / non-tts Pro model |
| `latest-pro-thinking` | Newest Pro model with `thinking: true` |
| `latest-flash` | Newest Flash model |
| `latest-lite` | Newest Lite model |

Literal IDs always work too: `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, etc.

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
