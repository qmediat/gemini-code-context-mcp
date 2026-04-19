# Migration from `gemini-mcp-tool` (jamubc)

If you're reading this, you've probably been using [jamubc/gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool) and noticed it hasn't been updated since 2025-07. That's why we built this server. Here's how to switch.

## TL;DR

**One line in `~/.claude.json`:**

```diff
 "mcpServers": {
-  "gemini-cli": {
-    "command": "node",
-    "args": ["/path/to/gemini-mcp-tool/dist/index.js"]
+  "gemini-code-context": {
+    "command": "npx",
+    "args": ["-y", "@qmediat.io/gemini-code-context-mcp"],
+    "env": { "GEMINI_CREDENTIALS_PROFILE": "default" }
   }
 }
```

Both the `command` changes (`node` → `npx`) and the args shape change. Run `npx @qmediat.io/gemini-code-context-mcp init` first to create the credentials profile.

Then restart Claude Code. That's it.

## What's different

| | jamubc | @qmediat.io |
|---|---|---|
| Under the hood | Shells out to `gemini` CLI | Direct `@google/genai` SDK |
| Tool names | `ask-gemini`, `brainstorm`, `fetch-chunk`, `ping`, `Help`, `timeout-test` | `ask`, `code`, `status`, `reindex`, `clear` |
| Default model | Hardcoded `gemini-2.5-pro` on main, `gemini-3.1-pro-preview` on npm v1.1.4 — frozen, no env var override | Dynamic alias `latest-pro` — resolves against your API key tier at startup |
| Quota fallback | Hardcoded to `gemini-2.5-flash` | Generic `models.list()` → pick best available |
| Repeat queries | No caching — each call re-tokenises referenced files | Persistent Context Cache — typically ~5× faster, ~4× cheaper on repeat queries |
| Coding delegation | Prompt-injected OLD/NEW format (`changeMode`) | Native `thinkingConfig` + optional `codeExecution` |
| Auth | Inherits `gemini` CLI auth (browser OAuth or `GEMINI_API_KEY` env) | 3-tier: Vertex ADC / profile file (chmod 0600) / env var |
| Cost control | — | Daily budget cap in USD |

## Tool name mapping

If you had custom agents or workflows that referenced jamubc tool names, here's the mapping:

| jamubc | qmediat |
|---|---|
| `ask-gemini({ prompt })` | `ask({ prompt })` — same semantics, now cached |
| `ask-gemini({ prompt, changeMode: true })` | `code({ task })` — dedicated coding tool with thinking budget |
| `brainstorm({ prompt, methodology })` | `ask({ prompt: "Brainstorm ideas for X using SCAMPER methodology: ..." })` — or open an issue if you miss the dedicated tool |
| `fetch-chunk({ cacheKey, chunkIndex })` | Not needed — SDK streaming is native; if you hit a size limit, filter with `includeGlobs`/`excludeGlobs` |
| `Help()` | `--help` on the binary, or read the docs |
| `timeout-test` | Not needed — the keepalive logic is built in |
| `ping()` | Not needed for client work — use `status` to check liveness + auth |

## What you'll gain

1. **Maintained.** We respond to issues in under 48 h during the first 30 days post-launch.
2. **Faster by default.** The context cache is on by default. You don't have to think about it.
3. **Cheaper.** Cached input tokens are billed at ~25 % of the uncached rate; most queries after the first hit the cache.
4. **Secure.** No API keys in `~/.claude.json`. Daily budget cap out of the box. Fingerprint-only logs.
5. **Future-proof.** Model names aren't hardcoded. When Gemini 4 ships, `latest-pro` picks it up.

## What you'll lose (v1.0)

- `brainstorm` as a distinct tool. Easy to simulate via `ask` with a structured prompt; open an issue if you want it back as first-class.
- `fetch-chunk` chunked responses. SDK streams natively.
- `changeMode` as a legacy prompt-injection mechanism — replaced by `code` tool with native Gemini features.

If any of those block your workflow, we'll ship them in v1.1 behind `GEMINI_CODE_CONTEXT_LEGACY_COMPAT=true`. File an issue.

## First-time setup after swap

```bash
# Move your key out of ~/.claude.json into a secure profile:
npx @qmediat.io/gemini-code-context-mcp init
```

Then update `~/.claude.json` with the `npx` command from the TL;DR above.

## Troubleshooting

### The server starts but `ask` fails with "No models available"

Your API key's tier doesn't reach any Gemini model. Check [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Paid tier gets 2M context + access to `-pro` and `-pro-thinking` models.

### "Daily budget cap reached"

You (or someone with your key) have spent the configured `GEMINI_DAILY_BUDGET_USD` today. It resets at UTC midnight. Raise the cap or wait.

### First query is slow, even on repeat

Check `status`. If `cache_id` is `null`, caching isn't active — probably because the model doesn't support long context. Try `ask({ model: "latest-pro" })` explicitly.

### I want jamubc tools back

File an issue at [qmediat/gemini-code-context-mcp/issues](https://github.com/qmediat/gemini-code-context-mcp/issues) naming which one and why. We ship legacy-compat behind a flag if enough users want it.
