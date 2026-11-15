# Migration from `gemini-mcp-tool` (jamubc)

If you've been using [jamubc/gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool), here's how to switch.

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

The two servers side by side, with the date the comparison was checked: [why.md](why.md).

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
2. **One scan, many questions.** The workspace is scanned once and reused; implicit caching is the default, an explicit Context Cache is one parameter away (`cachingMode: "explicit"`).
3. **Cheaper on repeats in explicit mode.** Cached input is billed at Google's cached-input price (the estimator assumes 25 % of the input rate when a model lists none); the implicit default has no guaranteed discount.
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

Your API key's tier doesn't reach any Gemini model. Check [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Paid tier gets the 1M-token context + access to `-pro` and `-pro-thinking` models.

### "Daily budget cap reached"

You (or someone with your key) have spent the configured `GEMINI_DAILY_BUDGET_USD` today. It resets at UTC midnight. Raise the cap or wait.

### First query is slow, even on repeat

Check `status`. In the default implicit mode there is no `cache_id` — every question carries the workspace and only Gemini's automatic cache can shorten it. For a persistent cache call `ask({ cachingMode: "explicit" })`; if `cache_id` stays `null` there, the model may not support caching — try `ask({ model: "latest-pro" })`.

### I want jamubc tools back

File an issue at [qmediat/gemini-code-context-mcp/issues](https://github.com/qmediat/gemini-code-context-mcp/issues) naming which one and why. We ship legacy-compat behind a flag if enough users want it.
