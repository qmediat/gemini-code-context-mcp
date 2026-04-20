# Models guide

Which Gemini model gets picked when you ask for one, why the resolver sometimes
refuses to dispatch, and how to pick the right alias for the job.

## TL;DR

| If you want to… | Pass this as `model` | Resolver picks from category |
|---|---|---|
| Code review / deep analysis / long thinking | `latest-pro-thinking` (default) | `text-reasoning` with `supportsThinking=true` |
| Best available pro-tier text model | `latest-pro` | `text-reasoning` |
| Fast Q&A, moderate reasoning | `latest-flash` | `text-fast` |
| Simple / cheap lookups | `latest-lite` | `text-lite` |
| Vision (screenshots, images) + text | `latest-vision` | `text-reasoning` OR `text-fast` with `supportsVision=true` |
| Specific model you know by ID | `gemini-3-pro-preview`, `gemini-2.5-flash`, etc. | (literal — category-checked against tool requirement) |

The `ask` tool accepts any of the three text tiers; `code` requires
`text-reasoning` specifically (coding benefits from reasoning tokens).

## Why this exists

Google's `models.list()` returns every model your API key can reach — including
image-generation (`nano-banana-pro-preview`, `gemini-3-pro-image`), music
generation (`lyria-3-pro-preview`), video (`veo-3`), TTS (`*-tts`), deep
research agents, and the rest. Many of these share tokens like `pro` or
`flash` with genuine text-gen models. Naively grabbing the first `pro` match
for `latest-pro-thinking` is how a code review call ends up dispatched to an
image generator — with ~10× the pricing, a rejected request shape, and a
quota bucket shared with unrelated services.

**Taxonomy** fixes this by **allowlist-first** classification: each model ID
is matched against a known rule set and assigned a category. Tools declare a
required category; the resolver refuses to dispatch to a model outside that
category. Unknown families (Google ships something we've never seen) land in
the `unknown` bucket and are excluded from every alias — forcing either a
patch release (to extend the rules) or an explicit model ID pass (where the
caller takes responsibility).

## Categories

| Category | What it's for | Example IDs | Accepted by tools |
|---|---|---|---|
| `text-reasoning` | Deep thinking, code review, long analysis | `gemini-3-pro-preview`, `gemini-2.5-pro`, `gemini-pro-latest` | `ask`, `code` |
| `text-fast` | Quick Q&A, shallow reasoning | `gemini-3-flash-preview`, `gemini-2.5-flash` | `ask` |
| `text-lite` | Cheapest text gen, simple classification | `gemini-3-flash-lite`, `gemini-2.5-flash-lite` | `ask` |
| `image-generation` | Text → image (different pricing tier!) | `nano-banana-pro-preview`, `gemini-3-pro-image`, `imagen-4-ultra` | — (not supported by ask/code) |
| `audio-generation` | TTS, music generation, dialog-native audio | `lyria-3-pro-preview`, `*-tts`, `*-native-audio-*` | — |
| `video-generation` | Video synthesis | `veo-3`, `veo-3.1-preview` | — |
| `embedding` | Vector embeddings | `text-embedding-004`, `gemini-embedding-001` | — |
| `agent` | Specialised agents (not drop-in text models) | `gemini-deep-research-*`, `*-customtools` | — |
| `unknown` | Family we haven't classified yet | A newly-released Google model not in our rules | — (aliases refuse; explicit ID pass fails category check) |

## Capability flags

Orthogonal to category — multiple can apply to a single model:

| Flag | Meaning |
|---|---|
| `supportsThinking` | Model supports reasoning / extended thinking (Gemini 2.5+, Gemini 3.x) |
| `supportsVision` | Accepts image / screenshot input (most Gemini models except `*-lite` and embeddings) |
| `supportsCodeExecution` | Works with the `code_execution` tool (all text-gen tiers) |
| `costTier` | `premium` (pro / image-gen / music), `standard` (flash), `budget` (lite / embeddings), `unknown` |

## Aliases

| Alias | Category set | Extra filter | Notes |
|---|---|---|---|
| `latest-pro` | `text-reasoning` | — | Newest pro-tier text model |
| `latest-pro-thinking` | `text-reasoning` | `supportsThinking=true` | Default for `code`; preferred for deep work |
| `latest-flash` | `text-fast` | — | Faster + cheaper than pro; no deep thinking |
| `latest-lite` | `text-lite` | — | Cheapest tier; limited capabilities |
| `latest-vision` | `text-reasoning` or `text-fast` | `supportsVision=true` | Screenshot analysis, image Q&A |

Aliases **never** cross category boundaries. If your API key has no model in
the required category, the resolver throws a clear error rather than silently
falling to a different category.

## Examples

### Code review (the primary use case)

```jsonc
// Default — no `model` needed; code tool uses `latest-pro-thinking`.
{ "tool": "code", "task": "Review my PR for memory safety issues" }
```

Resolves to the newest pro-tier text model with thinking support.
Guaranteed to NOT pick up `nano-banana-pro-preview` even if it's in your
model list.

### Quick Q&A (cheap + fast)

```jsonc
{
  "tool": "ask",
  "model": "latest-flash",
  "prompt": "What's the purpose of this config file?"
}
```

Resolves to the latest flash-tier model. Lower cost, lower latency, no
reasoning overhead.

### Vision analysis

```jsonc
{
  "tool": "ask",
  "model": "latest-vision",
  "prompt": "What's in this screenshot?"
}
```

Picks the newest vision-capable text model — prefers pro tier but falls
back to flash if pro is unavailable.

### Explicit model ID

```jsonc
{
  "tool": "ask",
  "model": "gemini-2.5-pro",
  "prompt": "..."
}
```

Literal ID is category-checked too — passing `nano-banana-pro-preview` to
`code` throws `ModelCategoryMismatchError` with an actionable message.

### What happens when the wrong category is passed

```jsonc
// This throws:
{
  "tool": "code",
  "model": "nano-banana-pro-preview",
  "task": "..."
}
```

```
ModelCategoryMismatchError: Model 'nano-banana-pro-preview' is in
category 'image-generation', but this tool requires: text-reasoning.
Pass a model with a compatible category (e.g. 'latest-pro' or a literal
model ID from docs/models.md). If you believe 'nano-banana-pro-preview'
is mis-categorised, file an issue at
https://github.com/qmediat/gemini-code-context-mcp/issues.
```

### What happens when Google ships a new model we don't know

```jsonc
{
  "tool": "code",
  "model": "latest-pro",
  "task": "..."
}
```

If your API key has `quantum-gemini-7-supernova-2030` available (a model
our taxonomy doesn't recognise), it lands in category `unknown`.
`latest-pro` requires `text-reasoning` → no match in your available
models → the resolver throws:

```
Alias 'latest-pro' (latest pro-tier text-reasoning model) could not be
resolved — no model in category [text-reasoning] is available for this
API key. Available categories: unknown (1). Either upgrade your Gemini
API tier (https://aistudio.google.com/apikey) or pass a literal model ID
matching the tool's required category (see docs/models.md).
```

Options:
1. Upgrade the MCP server (`npm update` — a patch release adds the new
   family to the taxonomy).
2. Pass the model ID directly without `requiredCategory` enforcement
   (internal utility callers only; production tools set it).
3. Pick an already-supported model from the list above.

## Response metadata

Every `ask` / `code` response includes classification in its structured
content:

```jsonc
{
  "resolvedModel": "gemini-3-pro-preview",
  "requestedModel": "latest-pro-thinking",
  "modelCategory": "text-reasoning",
  "modelCostTier": "premium",
  "fallbackApplied": false,
  // ... other fields
}
```

Use `modelCategory` + `modelCostTier` for billing dashboards or to verify
that an alias resolved to what you expected.

## When to extend the taxonomy

Open a PR against `src/gemini/model-taxonomy.ts` whenever:

- Google announces a new family that shares tokens with existing tiers
  (add pattern before the conflicting rule).
- A `costTier` is mis-reported for an existing family.
- You want to introduce a new user-facing alias.

Rules are ordered — **first match wins** — so specific patterns go before
general ones (`nano-banana` before any `-pro` fallback). Tests in
`test/unit/model-taxonomy.test.ts` lock in the contract; add a case for
every new family you classify.

## See also

- [`docs/configuration.md`](./configuration.md) — env vars, auth tiers, per-call overrides
- [`CHANGELOG.md`](../CHANGELOG.md) — release-level taxonomy changes (search for `T24` or `taxonomy`)
- [`src/gemini/model-taxonomy.ts`](../src/gemini/model-taxonomy.ts) — the rule set itself
