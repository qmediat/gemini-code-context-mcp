# Plan: `@qmediat.io/gemini-code-context-mcp` — SDK-based MCP server with Persistent Context Caching

> **Reader note (2026-04-18):** This file is an internal planning artefact, preserved in the public repo for transparency. It captures a brainstorming session that included verbatim excerpts from three LLM consultations (GPT, Gemini, Grok), whose blunt phrasing reflects the raw advice as given — not our considered stance on any other project or team. We're grateful to jamubc and every prior MCP server author for shaping the space we build on. For the canonical, user-facing docs, start at [README](./README.md) and [docs/](./docs/).



> **Rev 2 (po konsultacji 3 modeli).** Wersja poprzednia planowała drop-in replacement dla `gemini-mcp-tool` (CLI wrapper, 6 toolów). GPT / Gemini / Grok **zgodnie** wskazali że to commodity — brak moatu, Google może to zunulować w jednym release. Pivot: SDK + Files API + Context Cache = produkt z wyraźnym differentiatorem.

---

## Context

**Dlaczego ten projekt:**
1. Używamy jamubc/`gemini-mcp-tool` do code review w `/coderev` — ma hardcoded model, upstream w stagnacji 9 miesięcy.
2. **Rynek:** 2.2k ⭐ na jamubcu dowodzi popytu na "Gemini w Claude Code", ale **rynkowi brakuje produktu, nie patcha.** Wszyscy (jamubc, centminmod, @mintmcqueen) owijają CLI lub SDK w 1:1 bridge. Żaden nie buduje trwałej warstwy kontekstu.
3. **Konsultacja 3 modeli (GPT-5.3-codex, Gemini 3.1 Pro, Grok 4.20 reasoning)** zbiegła się na trzech punktach:
   - **Nie owijaj CLI — użyj `@google/genai` SDK bezpośrednio.** CLI ma ~200ms spawn overhead, brittle headless auth, brak connection pooling, brak streamingu między callami.
   - **Moat = Persistent Context Caching.** Gemini ma 2M context. Naiwne re-wysyłanie codebase'u na każdy prompt = 45s/call. Files API + explicit Cache daje 2s/call przy znacznie niższym koszcie. Nikt w rynku MCP tego nie ma — ani jamubc, ani Google, ani centminmod.
   - **Rebrand.** `gemini-cli-mcp` to generyczny wrapper. `gemini-code-context-mcp` (lub podobne) to produkt z jasną propozycją wartości.
4. GPT dodał empiryczne constrainty z docs Google: Files API = 48h auto-delete, explicit Cache = 1h default TTL (tylko TTL mutable, nie content), Manifest DB wymaga `(workspace_root, file_hashes, model, system_prompt_hash) → {file_ids, cache_id, expire_at}`.

**Outcome:** opublikowany `@qmediat.io/gemini-code-context-mcp` na npm + `github.com/qmediat/gemini-code-context-mcp`, pozycjonowany jako *"The only MCP server that gives Claude Code transparent persistent context for Gemini's 2M window — 45s → 2s per repeat query."*

---

## Research źródłowy (3-way consult, verbatim citations)

**Gemini 3.1 Pro Preview:**
> *"Wrapping `gemini` CLI to act as an MCP server is a fragile stopgap. You shouldn't do it. (...) You are building a bridge on top of a UI instead of the foundation. (...) Persistent Context Caching for large workspaces. (...) Mount Workspace to Gemini — under the hood, use `@google/genai` SDK to upload the directory via Files API and create a Gemini Context Cache. Hold onto the Cache ID. Turn a 45-second, high-cost codebase analysis into a 2-second, low-cost query."*

**Grok 4.20 reasoning:**
> *"This is a patch, not a product. 2.2k stars = 'please Google fix your shit' with extra steps. (...) None of the incumbents do persistent context workspaces with git-aware memory. Steal from Aider + Continue.dev + Cline: auto-detect repo state on connection, maintain project memory MCP resource that survives sessions, review mode with smart chunking + hierarchical summarization, surface cost/latency/context-utilization in the MCP handshake. Call it `context-bridge` instead of generic `gemini-cli-mcp`."*

**GPT-5.3-codex** (strongest empirical grounding):
> *"SDK is better for server correctness, CLI is better for onboarding. Solve onboarding in your MCP UX. Files API uploads are transient (48h auto-delete). Explicit cache has TTL (default 1h, only TTL mutable). Manifest: `(workspace_root, file_hashes, model, system_prompt_hash) → {file_ids, cache_id, expire_at}`. On each request: fast hash diff; if changed, rebuild affected bundle/cache. Background TTL refresh only for 'hot' workspaces. Escape hatches: `status`, `reindex`, `clear`, `pin ttl`."*

---

## Decyzje projektowe

| Pozycja | Wartość | Uzasadnienie |
|---|---|---|
| **Nazwa pakietu npm** | `@qmediat.io/gemini-code-context-mcp` | "bridge" = wyraźny produkt; Grok's framing; inne niż `gemini-cli-mcp` (commodity) |
| **Repo** | `github.com/qmediat/gemini-code-context-mcp` | match |
| **Folder lokalny** | `<local-dev-checkout>` | distinct od upstream `gemini-cli/` (jamubc) |
| **Licencja** | MIT | qmediat standard |
| **Node target** | `>=22.0.0` | qmediat standard |
| **Język** | TypeScript strict mode | qmediat standard |
| **Transport** | stdio | Claude Code/Desktop standard |
| **Core lib** | `@google/genai` (NIE CLI) | 3-model consensus |
| **Auth profile** | API key (primary) + ADC + Vertex (profile) | SDK idiom; setup command w MCP UX |
| **Persistencja manifestu** | SQLite (better-sqlite3) w `~/.qmediat/context-bridge/` | local, transactional, no daemon |
| **Legal entity** | Quantum Media Technologies sp. z o.o. | w LICENSE i package.json |
| **Contact** | contact@qmt.email | qmediat standard |

---

## Architektura (v1.0)

```
Claude Code  ──stdio──▶  @qmediat.io/gemini-code-context-mcp  ──HTTPS──▶  Gemini API
                         │
                         ├── Workspace Indexer      (hash diff + Files API upload)
                         ├── Cache Manager          (explicit Cache + TTL refresh)
                         ├── Manifest DB (SQLite)   (hash→file_ids→cache_id)
                         └── Tool Router            (ask, status, reindex, clear)
```

### 2M context preservation (zachowanie kluczowej zdolności)

**Przejście CLI → SDK nie degraduje contextu.** Potwierdzone:
- `@google/genai` SDK używa identycznego backendu co gemini CLI. Context limit to **właściwość modelu, nie interfejsu** (np. `gemini-3-pro-preview` ma 2M context czy wywołany przez CLI, SDK, Vertex, cokolwiek).
- Paid tier API key (twój setup: `gen-lang-client-0639463939`) dostaje **full 2M** na modelach Pro.
- **Files API + Context Cache są *zaprojektowane* pod 2M scenariusze.** Bez nich wysyłanie 1.5M tokenów kodu na każdy prompt = astronomiczne koszty + 45s latency. Z nimi = upload raz, query wielokrotnie za ~1/4 ceny + 2-3s latency.
- Code review w `/coderev` z 2M kontekstem = **core use case** który napędza cały produkt.

### Model selection architecture (najwyższy dostępny model)

**Strategia bez hardcoded modeli:**

1. **Model registry na startupie** — wywołanie `client.models.list()` enumeruje modele dostępne dla API key.
2. **Aliasy dynamiczne** — rozwiązywane per startup:
   - `latest-pro` → najnowszy z filtrem `*-pro-preview` lub `*-pro` (sortowane po version)
   - `latest-flash` → najnowszy `*-flash*`
   - `latest-ultra` → zarezerwowane na wypadek wypuszczenia przez Google
3. **Per-call override** — `ask({ model: "..." })` akceptuje alias lub literal model ID (`gemini-3-pro-preview`, `gemini-2.5-flash`, etc.).
4. **Workspace default** — env var `GEMINI_CODE_CONTEXT_DEFAULT_MODEL` (default: `latest-pro`).
5. **Upgrade-safe** — gdy Google wypuści `gemini-4-*`, `latest-pro` auto-wybierze je (jeśli API key ma dostęp). Zero zmian w konfigu usera.
6. **Downgrade safety** — jeśli żądany model niedostępny (np. user nie ma paid tier), log warning + fallback do najwyższego dostępnego + informacja w response metadata.

**Implementacja w `gemini/models.ts`:**
```typescript
// Pseudocode
async function resolveModel(alias: string): Promise<string> {
  if (alias in ALIASES) {
    const available = await client.models.list();
    return ALIASES[alias](available);  // e.g., pickLatestPro(available)
  }
  // literal model ID — verify available, fallback if not
  return verifyOrFallback(alias);
}
```

**Wyexpozowane w `status` tool:**
```
workspace:       /Users/mikeb/Projects/ConsistencyForge
current_model:   gemini-3-pro-preview (resolved from 'latest-pro')
available_models: [gemini-3-pro-preview, gemini-3-flash, gemini-2.5-pro, gemini-2.5-flash]
context_window:  2,000,000 tokens
cache_tokens:    847,512 cached (12h TTL, pinned)
...
```

### Tool surface (v1.0) — 5 tooli

| Tool | Opis | Input (zod) | Output |
|---|---|---|---|
| **`ask`** | Zapytaj Gemini w kontekście workspace (Q&A / analysis / long-context review). Auto-uploaduje zmienione pliki, buduje/odświeża Cache. | `prompt: string`, `workspace?: string` (default: cwd), `model?: string` (alias `latest-pro` / `latest-flash` lub literal ID; default: env `GEMINI_CODE_CONTEXT_DEFAULT_MODEL` → fallback `latest-pro`), `includeGlobs?: string[]`, `excludeGlobs?: string[]`, `noCache?: boolean` | text response + metadata (resolved_model, context_window, cached_tokens, uncached_tokens, cost_estimate_usd, cache_hit: bool) |
| **`code`** ⭐ | **Dedykowane delegowanie kodowania do Gemini.** Wyższy thinking budget, coding-optimized system prompt, opcjonalne `codeExecution` (Gemini sam testuje Python), strukturalny output z code blocks + OLD/NEW diffs do zastosowania przez Claude Code Edit. | `task: string` (opis zadania), `workspace?: string`, `model?: string` (default: `latest-pro` — coding-strongest), `thinkingBudget?: number` (default: 16384, max zależny od modelu), `codeExecution?: boolean` (default: false), `expectEdits?: boolean` (default: true — zwróć OLD/NEW), `includeGlobs?: string[]`, `excludeGlobs?: string[]` | `{ code_blocks: [{lang, content}], edits: [{file, old, new}], thinking_summary?, executed_code?, execution_output? }` + metadata |
| **`status`** | Stan cache dla workspace (file count, hash, cache_id, TTL, last_refresh, estimated savings, available_models). | `workspace?: string` | structured status |
| **`reindex`** | Wymuś pełny rebuild cache (nie czekaj na hash diff). | `workspace?: string` | status + before/after |
| **`clear`** | Usuń cache + manifest dla workspace. | `workspace?: string` | ack |

### Gemini coding-dedicated features (wyzyskane w `code` tool)

Tool `code` wykorzystuje natywne Gemini capabilities dla kodowania — nie tylko wysyła prompt:

1. **Thinking / Deep Think mode** (Gemini 2.5+ Pro feature) — `thinkingConfig: { thinkingBudget: N }` alokuje dodatkowe reasoning tokens zanim Gemini wygeneruje kod. Domyślnie 16384 (default dla coding), max zależny od modelu (Gemini 3 Pro Deep Think idzie do ~32k+). Thinking tokens są rozliczane osobno, ale znacząco poprawiają jakość complex coding tasks.
2. **Code Execution tool** (opcjonalny) — `tools: [{ codeExecution: {} }]`. Gemini generuje kod Python, wykonuje go w sandboxed Google env, widzi output, iteruje. Przydatne dla: algorytmów, data manipulation, weryfikacji logiki. Koszt: dodatkowe round-tripy API. Off by default, user włącza per-call.
3. **Coding-optimized system prompt** — predefined: *"You are an expert software engineer. Generate production-quality, idiomatic code with proper error handling. Match the existing code style from workspace context. When making changes to existing code, output in OLD/NEW diff format for precise application."*
4. **Model auto-pick** — `latest-pro` domyślnie, bo Pro modele są coding-strongest (vs Flash które są szybsze ale słabsze w złożonym kodowaniu).
5. **Structured output** — response parser wyciąga `code_blocks` (fresh code) i `edits` (OLD/NEW format) osobno, żeby Claude Code mógł zaaplikować edits przez native Edit tool lub pokazać code blocks do manualnego review.

**To NIE jest `changeMode` z jamubca.** `changeMode` był legacy hackiem (injecting OLD/NEW instructions into prompt). `code` tool używa natywnych Gemini features (thinking, tools, structured output) + coding system prompt. Inna architektura, znacznie lepsza jakość.

### Cięte z v1.0 (per GPT recommendation)

- ❌ `changeMode` (OLD/NEW edit format jako legacy mechanizm) — zastąpione przez `code` tool, który robi to lepiej z natywnymi features
- ❌ chunked response protocol — SDK streaming jest natywny
- ❌ `brainstorm` — niszowy use case; user może użyć `ask` z prompt brainstorming

### v1.1+ roadmap

- `pin-ttl` — wymuszony długi TTL dla "hot" workspace
- multi-workspace profiles (np. mono-repo z sub-projektami)
- Smart partial rebuilds (rebuild tylko zmienionej ścieżki, nie całego workspace)
- Legacy compat mode (on request) — `changeMode`/`brainstorm` przywrócone jeśli będzie popyt
- Git integration (Grok) — auto-detect branch, open PRs, recent diffs jako dodatkowy kontekst
- Budżetowanie (daily cost cap, model downgrade on cap)
- HTTP transport (dla remote MCP hostów)

---

## Kluczowe detale implementacji

### Manifest schema (SQLite)

```sql
CREATE TABLE workspaces (
  workspace_root   TEXT PRIMARY KEY,
  files_hash       TEXT NOT NULL,     -- merged hash of all tracked files
  model            TEXT NOT NULL,
  system_prompt_hash TEXT,
  cache_id         TEXT,
  cache_expires_at INTEGER,           -- epoch ms
  file_ids         TEXT,              -- JSON array of Files API IDs
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE files (
  workspace_root   TEXT NOT NULL,
  relpath          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  file_id          TEXT,              -- Files API ID
  uploaded_at      INTEGER,
  expires_at       INTEGER,
  PRIMARY KEY (workspace_root, relpath),
  FOREIGN KEY (workspace_root) REFERENCES workspaces(workspace_root)
);

CREATE TABLE usage_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_root   TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  model            TEXT,
  cached_tokens    INTEGER,
  uncached_tokens  INTEGER,
  cost_usd_micro   INTEGER,           -- micros to avoid float
  duration_ms      INTEGER,
  occurred_at      INTEGER NOT NULL
);
```

### Request flow dla `ask`

1. Resolve `workspace_root` (arg or cwd).
2. Glob files matching `include/exclude` (defaults: code+markdown, skip node_modules/.git/dist).
3. Hash each file (`sha256` content, cached in-memory per session).
4. Merge into `files_hash`.
5. Query manifest: workspace row with matching `files_hash + model + system_prompt_hash + cache not expired`?
   - **Hit:** use `cache_id`, call `generateContent({ cachedContent: cache_id, contents: prompt })`.
   - **Miss:** delta-check individual `files` rows → upload only changed files → build new Cache → update manifest.
6. Stream response via MCP `notifications/progress`.
7. Insert `usage_metrics` row.

### Keepalive + cancellation

- 25s interval `notifications/progress` z statusem operacji (upload progress, cache building, generating).
- `AbortSignal` z MCP request propagowany do `@google/genai` generate call.
- SIGTERM → graceful shutdown (finish in-flight, persist manifest, exit).

---

## Struktura folderu

```
gemini-code-context-mcp/
├── PLAN.md                             # kopia tego planu
├── README.md                           # marketing (patrz niżej)
├── LICENSE                             # MIT, Quantum Media Technologies sp. z o.o.
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── package.json                        # @qmediat.io/gemini-code-context-mcp
├── tsconfig.json                       # strict, ES2022, node16 module resolution
├── vitest.config.ts
├── biome.json
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                      # test+build+lint na PR
│   │   ├── release.yml                 # changesets → npm + GH release
│   │   └── codeql.yml
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── .gitignore
├── .npmignore
├── docs/
│   ├── getting-started.md
│   ├── configuration.md
│   ├── how-caching-works.md            # content marketing (patrz niżej)
│   ├── migration-from-jamubc.md        # akwizycja userów
│   ├── architecture.md
│   ├── security.md
│   └── cost-model.md
├── src/
│   ├── index.ts                        # MCP bootstrap (stdio transport)
│   ├── config.ts                       # env vars, auth profile, paths
│   ├── server.ts                       # MCP request handlers (tools/list, tools/call, prompts/list)
│   ├── tools/
│   │   ├── index.ts                    # registry
│   │   ├── ask.tool.ts                 # Q&A / long-context analysis
│   │   ├── code.tool.ts                # ⭐ coding delegation (thinking + codeExecution + structured edits)
│   │   ├── status.tool.ts
│   │   ├── reindex.tool.ts
│   │   └── clear.tool.ts
│   ├── indexer/
│   │   ├── workspace-scanner.ts        # glob + gitignore + excludes
│   │   ├── hasher.ts                   # sha256 + in-memory cache
│   │   └── globs.ts                    # defaults + user overrides
│   ├── cache/
│   │   ├── cache-manager.ts            # build/refresh/invalidate
│   │   ├── files-uploader.ts           # Files API client
│   │   └── ttl-watcher.ts              # background refresh for hot workspaces
│   ├── manifest/
│   │   ├── db.ts                       # better-sqlite3 wrapper
│   │   ├── schema.sql
│   │   └── migrations/
│   ├── gemini/
│   │   ├── client.ts                   # @google/genai factory (auth profile: API key | ADC | Vertex)
│   │   ├── models.ts                   # dynamic aliases: latest-pro, latest-flash, resolveModel()
│   │   └── model-registry.ts           # models.list() enumeration + alias resolution
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── progress.ts                 # MCP progress notification helper
│   │   └── cost-estimator.ts           # tokens × price lookup
│   └── types.ts
├── test/
│   ├── unit/
│   │   ├── hasher.test.ts
│   │   ├── workspace-scanner.test.ts
│   │   ├── cache-manager.test.ts       # mock SDK
│   │   ├── manifest-db.test.ts
│   │   └── config.test.ts
│   ├── integration/
│   │   ├── real-gemini.smoke.test.ts   # wymaga API key — tylko lokalne / CI secret
│   │   └── mcp-inspector.test.ts
│   └── fixtures/
│       └── sample-workspaces/
├── examples/
│   ├── claude-code.json
│   ├── claude-desktop.json
│   ├── cursor.json
│   └── with-vertex.json                # Vertex AI auth profile
└── Dockerfile                          # node:22-alpine + better-sqlite3 build deps
```

---

## Dependencies (runtime, clean)

```json
{
  "@modelcontextprotocol/sdk": "^1.0.0",
  "@google/genai": "^1.0.0",
  "better-sqlite3": "^11.0.0",
  "zod": "^3.23.0",
  "zod-to-json-schema": "^3.24.0"
}
```

**Dev:**
- `typescript@^5.5`
- `vitest@^2` + `@vitest/coverage-v8`
- `@types/node@^22`
- `@types/better-sqlite3`
- `tsx@^4`
- `@changesets/cli`
- `@biomejs/biome`

**Peer (runtime host):**
- Node >= 22
- Google Gemini API key (env: `GEMINI_API_KEY`) OR
- Google Cloud ADC (`GOOGLE_APPLICATION_CREDENTIALS`) dla Vertex mode

Brak zależności od `gemini` CLI — to kluczowe dla niezawodności.

---

## README structure (qmediat + marketing)

**Tagline:** *"Give Claude Code persistent memory of your codebase, backed by Gemini's 2M-token context."*

Sekcje:
1. **Badges** — npm, downloads, MIT, CI, TypeScript strict, Smithery
2. **30-second pitch + GIF** — "Before: 45s per question. After: 2s." (animated terminal demo)
3. **Why this server?** (tabela porównawcza vs jamubc/gemini-mcp-tool + vs raw SDK)
4. **Quick Start** (4 linijki: `npm install`, set API key, paste config, restart Claude Code)
5. **Claude Code setup** — copy-paste (najważniejszy CTA)
6. **Claude Desktop / Cursor setup**
7. **How it works** — 1-paragraf + diagram + link do `docs/how-caching-works.md`
8. **Tools** — 4 toole z real-world example per każdy
9. **Configuration** — env vars tabela
10. **Cost model** — "cached tokens are 4x cheaper; our usage dashboard shows savings" (link do `docs/cost-model.md`)
11. **Migration from `gemini-mcp-tool`** — osobna dedykowana sekcja
12. **Architecture** — jeden akapit + link
13. **Security** — SSRF, API key rotation, no telemetry, manifest stored locally
14. **Contributing**
15. **License** — MIT, Quantum Media Technologies sp. z o.o.

---

## Implementation phases (2 tygodnie ship)

### Phase 0 — Bootstrap (0.5 dnia)
1. `mkdir <project-dir>/gemini-code-context-mcp/`, skopiuj PLAN.md.
2. `gh repo create qmediat/gemini-code-context-mcp --public --license mit`.
3. Setup: package.json (scope `@qmediat.io`), tsconfig strict, biome, vitest, struktura src.
4. CI skeleton.
5. **STOP — review ze mną.**

### Phase 1 — Foundation (1 dzień)
1. `config.ts` — env vars, auth profile detection.
2. `gemini/client.ts` — `@google/genai` factory.
3. `utils/logger.ts` + `utils/progress.ts`.
4. Smoke test: jedna kreacja `GoogleGenAI` client + call `generateContent`.
5. **STOP — review.**

### Phase 2 — Workspace indexing (1.5 dnia)
1. `indexer/workspace-scanner.ts` — glob + gitignore + domyślne exclude.
2. `indexer/hasher.ts` — sha256 content hashing + in-memory cache.
3. `manifest/db.ts` + schema — better-sqlite3 + migracje.
4. Unit tests dla scanner + hasher + DB.
5. **STOP — review.**

### Phase 3 — Cache manager (2 dni) ← NAJWAŻNIEJSZE
1. `cache/files-uploader.ts` — upload przez Files API (z deduplikacją per hash).
2. `cache/cache-manager.ts` — build cache, refresh TTL, invalidate on hash change.
3. `cache/ttl-watcher.ts` — background refresh (tylko dla aktywnych workspace).
4. `gemini/models.ts` — model aliases ("latest-pro" → "gemini-3-pro-preview").
5. Integration test z prawdziwym API (skipped w CI, run locally).
6. **STOP — review.**

### Phase 4 — Tools + MCP server (2 dni)
1. `tools/ask.tool.ts` — request flow z §"Request flow" powyżej.
2. `tools/code.tool.ts` — coding delegation:
   - System prompt z code-optimized instructions
   - `thinkingConfig: { thinkingBudget: N }` parametryzowane
   - Opcjonalnie `tools: [{ codeExecution: {} }]` per `codeExecution` param
   - Structured output parser (code blocks + OLD/NEW extraction)
3. `tools/status.tool.ts`, `tools/reindex.tool.ts`, `tools/clear.tool.ts`.
4. `server.ts` — request handlers + progress notifications + cancellation.
5. `index.ts` — stdio bootstrap + graceful shutdown.
6. E2E przez `@modelcontextprotocol/inspector` — test `code` tool na realnym zadaniu ("refaktoryzuj funkcję X w repo Y").
7. **STOP — review.**

### Phase 5 — Cost telemetry + polish (1 dzień)
1. `utils/cost-estimator.ts` — per-model pricing lookup (updates via env var).
2. `usage_metrics` tabela + kwerendy w `status` tool.
3. Error handling polish (quota exceeded → fallback model; API key missing → clear instruction).
4. Telemetry **opt-in only** via env var (anonymous usage ping).
5. **STOP — review.**

### Phase 6 — Docs + marketing materials (1.5 dnia)
1. README wszystkie sekcje.
2. `docs/how-caching-works.md` — flagowy piece of content (diagramy, before/after).
3. `docs/migration-from-jamubc.md` — snippet "1 line in ~/.claude.json".
4. Demo GIF (terminal → dev.to-ready).
5. Blog draft na qmediat.io: "Why we built gemini-code-context-mcp after consulting 3 LLMs".
6. `Dockerfile`.
7. **STOP — review.**

### Phase 7 — Release + launch (1 dzień)
1. `changesets init`, v1.0.0.
2. `npm publish --access public`.
3. GitHub release + CHANGELOG.
4. `ghcr.io/qmediat/gemini-code-context-mcp` image push.
5. **Launch day** (patrz sekcja Marketing).

**Budżet:** ~10 dni roboczych solo (~2 tyg kalendarzowe z reviewami). Można przyspieszyć agentami do ~7 dni.

---

## Marketing & launch (Grok-informed)

### Pre-launch
1. **Flagowy content:** blog `"Why Claude Code's Gemini integration is leaving $X on the table (and how to fix it)"` — deep technical z before/after benchmarks.
2. **GIF demo:** 15-sekundowy terminal clip "pierwsza kwerenda na 2M codebase vs druga kwerenda (cached)".
3. **Migration guide** pod linkiem w README.

### Launch (T+0)
**Priority 1 (Grok ranking):**
1. **Reddit** r/ClaudeAI, r/LocalLLaMA, r/mcp — posty *technical/benchmark* (nie self-promo).
2. **Dev.to** + medium cross-post — deep technical article, 4k+ words z benchmarkami.

**Priority 2:**
3. **Targeted DMs** do ~10 aktywnych MCP buildersów na X (Anthropic folks, Google Gemini DevRel, jamubc sam if reachable).
4. **awesome-mcp-servers PR.**

**Priority 3 (nice-to-have, low expected install lift):**
5. **Smithery publish** — nadal tak, bo bezpłatne i dyskoverable (nawet jeśli Grok to odrzucił — to jest de-facto registry).
6. **mcpservers.org listing.**

**Pomijamy:**
- ❌ Product Hunt (Grok: "pure theater dla infra tools").
- ❌ Paid ads (too niche, bad ROI).

### Long-term moat
- Aktywny maintenance (response time < 48h na issue w pierwszych 30 dniach).
- Monthly changelog post z benchmarkami.
- Feature poll (community-driven v1.1 priorities).
- Hit mailing list dla qmediat OSS projects (build audience).

---

## Ryzyka & mitigations

| Ryzyko | Mitigation |
|---|---|
| Google dodaje natywny MCP-server mode do gemini CLI → nasz produkt zbędny | v1.1 added abstract backend interface; można zamienić SDK → Google MCP bez zmiany naszego UX. Plus: nasza value = Context Cache layer, a nie wrapping — pozostaje wartość nawet jeśli Google zmieni backend. |
| Files API deprecation / breaking changes | Abstract via `gemini/client.ts` adapter. Vendor-pin SDK do minor version. Integration tests wykryją przy CI. |
| User nie chce zarządzać API key (CLI ma user login flow) | Setup command `npx @qmediat.io/gemini-code-context-mcp init` z interactive profile selection (API key | ADC | Vertex). |
| 1h default Cache TTL → nieoczekiwane koszty refresh | Background `ttl-watcher` refresh TYLKO dla "hot" workspace (ostatnie użycie <10min); cold workspace pozwalamy wygasnąć; `status` pokazuje TTL. |
| SQLite concurrency issues | better-sqlite3 WAL mode + synchronous=NORMAL. MCP server single-instance per Claude Code session, więc concurrency niska. |
| Marketing floppe — nikt nie zauważy launchu | Fallback: zgłosić w issues jamubca #49, #64 jako merytoryczny odpowiednik (bez spamu). Absorbowanie orphan users. |
| Przejście od jamubca = migracja nietrywialna (różne nazwy toolów) | `docs/migration-from-jamubc.md` + optional `legacy-compat` shim w v1.1 (tools ask-gemini→ask alias). |

---

## Critical files (reference)

**Research source (jamubc, MIT license, inspection only):**
- `<ref-checkout>/gemini-mcp-tool/dist/` (from upstream jamubc `gemini-cli`) — reference dla keepalive pattern, progress notification cycling, MCP schema patterns

**Google docs cited (all verified URLs):**
- Context caching guide: https://ai.google.dev/gemini-api/docs/caching/
- Caching API: https://ai.google.dev/api/caching
- Files API (48h note): https://ai.google.dev/gemini-api/docs/files
- `@google/genai` caches class: https://googleapis.github.io/js-genai/release_docs/classes/caches.Caches.html
- Gemini CLI auth: https://google-gemini.github.io/gemini-cli/docs/get-started/authentication.html

---

## Verification

**Phase 3 (cache manager):**
```bash
cd <repo-root>
GEMINI_API_KEY=$GEMINI_API_KEY npm test -- test/integration/real-gemini.smoke.test.ts
```
Oczekiwane: upload 5 testowych plików, build cache, follow-up query hits cache, `status` pokazuje `cache_hits > 0`.

**Phase 4 (e2e):**
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
- `tools/list` → 5 tooli (ask, code, status, reindex, clear)
- `ask {"prompt": "summarize this repo"}` pierwszy call = slow (upload + cache build)
- drugi identyczny call = szybki (cache hit)
- `code {"task": "add input validation to the login function", "thinkingBudget": 16384}` → zwraca `edits` array z OLD/NEW; Claude Code aplikuje przez Edit tool
- `code {"task": "write a function to compute Fibonacci", "codeExecution": true}` → Gemini generuje kod, wykonuje Python w sandbox, zwraca executed_code + execution_output
- `status` pokazuje cached_tokens, available_models, thinking_tokens_used
- `clear` + ponowny `ask` = pierwszy slow

**Phase 7 (release smoke):**
```bash
rm -rf /tmp/smoke && mkdir /tmp/smoke && cd /tmp/smoke
npm install @qmediat.io/gemini-code-context-mcp
GEMINI_API_KEY=sk-... node node_modules/@qmediat.io/gemini-code-context-mcp/dist/index.js
# (powinien startować stdio server)
```

**Benchmark dla marketing GIF:**
```bash
# workspace: real repo ~500k tokens
time <call ask "explain module X">         # first: ~30-45s
time <call ask "explain module Y">         # cached: ~2-3s
```

---

## Auth & Credentials Security (Rev 3)

**Problem:** Klucz API w envvar w `~/.claude.json` ma 4 realne ryzyka: plaintext w dotfiles repo (jedno nieuważne git commit = wyciek), widoczność w `/proc/<pid>/environ`, brak revocation, brak cost cap.

**Multi-tier architektura:**

| Tier | Mechanizm | Kiedy | Trust |
|---|---|---|---|
| **1 (recommended)** | Google ADC via `gcloud auth application-default login` | User ma GCP setup | Najwyższy — Google-managed, auto-rotation, revocable |
| **2 (domyślne)** | Credentials file `~/.config/qmediat/credentials` (chmod 0600) via `init` command | Wszyscy inni | Wysoki — local, permissions-enforced, poza Claude Code config |
| **3 (dev fallback)** | `GEMINI_API_KEY` env var z warning przy starcie | Quick test / CI | Niski — warning nagłówek przy starcie |

**`init` subcommand flow:**
```bash
npx @qmediat.io/gemini-code-context-mcp init
```
- Interactive prompts (inquirer z password mask)
- Wybór auth method (ADC / API key / Vertex)
- API key: ukryty input → zapis do `~/.config/qmediat/credentials` z `chmod 0600`
- Auto-detekcja git repo → ostrzeżenie jeśli credentials path pod workingdirem
- `~/.claude.json` dostaje **tylko profile reference** (`GEMINI_CREDENTIALS_PROFILE: "default"`), nigdy samego klucza
- Budżet: `GEMINI_DAILY_BUDGET_USD` też pytany i zapisywany do profilu

**Dodatkowe zabezpieczenia (baseline v1.0):**
- **Key fingerprint logging** — nigdy pełny klucz; tylko `AIza...xyz9`
- **Cost cap hard stop** — dzienny limit, po przekroczeniu server odmawia calli do następnego UTC midnight
- **Secret scanning** — GitHub push protection włączone na repo
- **Security.md** — threat model + incident response
- **No telemetry** — nic nie leci do nas, wszystko local
- **npm provenance** — publish via GitHub Actions z provenance flag (npm trust badge)

**Folder dodany do architektury:**
```
src/auth/
├── profile-loader.ts      # env → file → ADC (priority chain)
├── credentials-store.ts   # R/W ~/.config/qmediat/credentials (0600)
├── init-command.ts        # interactive setup (inquirer)
└── fingerprint.ts         # safe partial-key preview
```

**Dropped z planu:** `Dockerfile` + `ghcr.io` — zbędne dla stdio MCP. `npx @qmediat.io/gemini-code-context-mcp` jest prostszą i bezpieczniejszą ścieżką dystrybucji.

---

## Decyzje domknięte (po rundzie pytań + 3 follow-up)

- **Nazwa:** `@qmediat.io/gemini-code-context-mcp` (user accepted kebab-case variant proponowany przeze mnie zamiast compound `codecontext`).
- **Scope v1.0:** 5 core tooli (`ask`, **`code`**, `status`, `reindex`, `clear`). Wycięte z v1.0: legacy `changeMode`, `brainstorm`, `fetch-chunk` — zastąpione przez lepszą architekturę (native Gemini thinking/code execution w `code` tool).
- **2M context:** zachowany — SDK używa identycznego backendu, Context Cache wręcz zaprojektowany pod 2M scenariusze. Kluczowy dla `/coderev` use case.
- **Wybór modelu:** dynamic via `models.list()` przy starcie; aliasy `latest-pro`/`latest-flash`; per-call override. Zero hardcoded modeli.
- **Gemini coding mode:** wspierany natywnie — thinking budget (16k+ tokens default dla `code` tool), opt-in codeExecution tool, coding-optimized system prompt. Zastępuje legacy `changeMode` lepszą architekturą.
- **Legacy-compat:** w v1.1 opcjonalny moduł z `brainstorm`/`fetch-chunk` za env var flag. Tylko jeśli jamubc-orphan users zgłoszą popyt w issues.
