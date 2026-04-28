/**
 * Two-tier token counter for the `ask` / `code` workspace-size preflight
 * (v1.10.0+, T17 closure).
 *
 * The original v1.5.0 preflight used `Math.ceil(bytes/4)` as a heuristic for
 * input-token count. That heuristic undercounts dense Unicode (CJK, emoji,
 * minified JS) by 30-50 % — a workspace estimated as "fits" can in fact
 * exceed `inputTokenLimit`, the request fires, Gemini returns
 * `400 INVALID_ARGUMENT`, and the user has paid for the round-trip plus the
 * eager Files API upload that preceded it. Real money on a guaranteed-to-
 * fail call. Tracked as T17 in `docs/FOLLOW-UP-PRS.md`.
 *
 * This module replaces the heuristic with a two-tier strategy:
 *
 *   Tier 1 — heuristic gate (fast path).
 *     Compute `bytes/4 + prompt/4` as before. If the estimate is well under
 *     the cliff (50 % of the model's input limit), skip the API call and
 *     proceed. Saves a round-trip on small repos that obviously fit.
 *
 *   Tier 2 — exact count.
 *     Otherwise call `client.models.countTokens({ model, contents })` with
 *     the same payload shape we'll send to `generateContent`. Use the
 *     returned `totalTokens` for the threshold check. countTokens is
 *     billed at zero (per Google docs and the v1.9.0 probe — see
 *     `.claude/local-PLAN-v1.10.0.md`) and shares NO RPM quota with
 *     `generateContent` (probe Q1 — 30 calls in 2.9 s, zero 429s).
 *
 *   Cache.
 *     `LRUCache<string, number>` (in-process, simple). Key:
 *     `SHA256(filesHash + promptHash + model)`. `filesHash` is computed
 *     post-glob-filter by `scanWorkspace`, so it already encodes the
 *     filtered file set — including a separate `globsHash` axis would be
 *     redundant (and risk join-collision via different glob arrays
 *     serializing to the same string). TTL = process lifetime; no manifest
 *     persistence.
 *
 *   Graceful degradation.
 *     On `countTokens` failure (HTTP error, network, SDK shape mismatch),
 *     log warn and fall back to `Math.ceil(bytes / 3)` (1.33× safety
 *     multiplier — covers the empirical 30-50 % CJK undercount). Never
 *     hard-fail on count failure; never make the user re-run.
 *
 * **Q3 mitigation (probe finding):** `countTokens` does NOT count
 * `systemInstruction` on the Gemini Developer API path (SDK exposes the
 * field, API rejects it). The exact count returned therefore underestimates
 * the actual `generateContent` input by the size of `systemInstruction` +
 * tool declarations. We add `SYSTEM_INSTRUCTION_RESERVE` (1 000 tokens)
 * to the count before comparing against the threshold — losing 1 000
 * tokens of headroom on a 1 M-token model is < 1 % impact.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GoogleGenAI } from '@google/genai';
import type { ScannedFile } from '../indexer/workspace-scanner.js';
import { logger, safeForLog } from '../utils/logger.js';

/** Token reserve added to the count before the threshold comparison
 * (`effectiveTokens = rawTokens + SYSTEM_INSTRUCTION_RESERVE`). Accounts for
 * `systemInstruction` + tool declarations that `countTokens` doesn't count
 * on the Gemini Developer API path. The 1 000-token reserve is generous —
 * empirical agentic `systemInstruction` is ~600 tokens; tool declarations
 * for the four `ask_agentic` functions are ~200-400 tokens. `ask` and
 * `code` typically pass no system instruction so the reserve is pure
 * safety margin there.
 *
 * Applied UNIFORMLY across all three paths (`'heuristic'`, `'exact'`,
 * `'fallback'`) since v1.12.1 — pre-fix the reserve was only on the
 * `'exact'` path, leaving heuristic and fallback paths slightly under-
 * protected against system-instruction overhead. The 1 000-token cost
 * is < 0.1 % of a 1 M-token cap, well within the heuristic's slop and
 * the fallback's 1.33× over-pad — so adding it everywhere is harmless
 * but uniform-by-construction. */
export const SYSTEM_INSTRUCTION_RESERVE = 1_000;

/** Heuristic-vs-exact tier boundary. Below this fraction of the model's
 * input-token limit, we skip the countTokens API call and accept the
 * heuristic's coarse estimate. The 50 % cutoff ensures we never depend on
 * heuristic accuracy near the cliff (where `bytes/4` undercount could push
 * a "fits" past `inputTokenLimit`). Above 50 %, the marginal cost of one
 * countTokens API call (~hundreds of ms) is worth paying for accuracy. */
const HEURISTIC_CUTOFF_FRACTION = 0.5;

/** LRU cache size. Each entry is `<sha-hex-key, number>` ≈ 80 bytes; 256
 * entries is ~20 KB resident. Plenty for typical workflow patterns
 * (handful of workspaces × handful of distinct prompts). */
const LRU_MAX_ENTRIES = 256;

/** Defensive cap on the assembled tier-2 `contents` payload (file content
 * concatenation). The v1.9.0 probe Q2 confirmed countTokens accepts at
 * least 7 MB; we set the bound conservatively above that with headroom for
 * future SDK / API changes. When the assembled payload would exceed this
 * cap, we skip the API call and fall through to the `bytes/3` fallback —
 * counter intuitively, a heuristic is more reliable than a request that's
 * about to 413. Today's defaults (`maxFilesPerWorkspace: 2_000`,
 * `maxFileSizeBytes: 1_000_000`) cap worst-case workspace at ~2 GB, but
 * the heuristic-tier gate (50 % of `inputTokenLimit`) means tier-2 only
 * sees workspaces approaching `inputTokenLimit × 4` raw bytes (~4 MB on a
 * 1 M-token model). The cap is a future-proof defensive measure, not a
 * limit you're expected to hit. */
const MAX_TIER_2_PAYLOAD_BYTES = 32 * 1024 * 1024; // 32 MB

export type TokenCountMethod = 'heuristic' | 'exact' | 'fallback';

export interface PreflightTokenResult {
  /** The count we'll compare against `inputTokenLimit × workspaceGuardRatio`. */
  effectiveTokens: number;
  /** Which path produced the count. Surfaces in tool metadata. */
  method: TokenCountMethod;
  /** Raw count from the source — for diagnostics. Always differs from
   * `effectiveTokens` by exactly `SYSTEM_INSTRUCTION_RESERVE` since
   * v1.12.1 (uniform reserve across all three paths). Pre-v1.12.1 the
   * reserve was only added on the `'exact'` path. */
  rawTokens: number;
  /** Whether the `'exact'` count came from the in-process LRU cache rather
   * than a fresh `countTokens` API call. `false` on every non-`'exact'`
   * path. Surfaces in tool metadata so operators can distinguish "we paid
   * the API round-trip" from "we hit the LRU." */
  cacheHit: boolean;
}

/** Inputs to the preflight count. Mirror what `ask` / `code` already
 * compute internally. */
export interface PreflightInput {
  files: ScannedFile[];
  prompt: string;
  model: string;
  /** Stable hash of the workspace's filtered file set + content. Already
   * computed by `scanWorkspace` post-glob-filter, so two glob configs
   * resolving to the same files share the same hash — no separate
   * `globsHash` axis needed. */
  filesHash: string;
  /** Optional override of the heuristic-vs-exact cutoff. */
  preflightMode?: 'heuristic' | 'exact' | 'auto';
  /** The model's advertised input token limit. The cutoff fraction is
   * applied to this. */
  inputTokenLimit: number;
  /** Wall-clock abort signal threaded into the SDK's `countTokens`
   * `config.abortSignal`. When the caller's `timeoutMs` budget fires (or
   * any upstream cancellation), the SDK's HTTP request is aborted and the
   * `AbortError` is RE-THROWN to the caller (so the outer tool's catch
   * can map it to `errorCode: 'TIMEOUT'`). Non-abort errors still fall
   * through to the `bytes/3` graceful-degradation path. Optional; omit
   * for callers without timeout semantics. */
  signal?: AbortSignal;
}

/** Simple LRU implemented atop `Map`'s insertion-order semantics. Two
 * primitive ops: `get` (touch on hit), `set` (evict oldest if over cap).
 * Avoids pulling in `lru-cache` for ~30 LOC of need. */
class SimpleLRU<K, V> {
  private readonly capacity: number;
  private readonly map: Map<K, V>;
  constructor(capacity: number) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Touch — move to most-recent end of insertion order.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    // Evict oldest if over capacity.
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  /** Test-only — exposed so unit tests can verify cache hit/miss. */
  size(): number {
    return this.map.size;
  }
  /** Test-only — clear all entries. */
  clear(): void {
    this.map.clear();
  }
}

const cache = new SimpleLRU<string, number>(LRU_MAX_ENTRIES);

/** Public for tests. Reset state between cases. */
export function clearTokenCounterCache(): void {
  cache.clear();
}

function buildCacheKey(input: PreflightInput): string {
  const promptHash = createHash('sha256').update(input.prompt).digest('hex');
  return createHash('sha256')
    .update(`${input.filesHash}|${promptHash}|${input.model}`)
    .digest('hex');
}

function computeHeuristic(files: ScannedFile[], prompt: string): number {
  const workspaceBytes = files.reduce((sum, f) => sum + f.size, 0);
  return Math.ceil(workspaceBytes / 4) + Math.ceil(prompt.length / 4);
}

function computeFallback(files: ScannedFile[], prompt: string): number {
  // 1.33× safety multiplier vs heuristic — covers empirical 30-50 % CJK
  // undercount when the API call fails and we have no exact count.
  const workspaceBytes = files.reduce((sum, f) => sum + f.size, 0);
  return Math.ceil(workspaceBytes / 3) + Math.ceil(prompt.length / 3);
}

/**
 * Two-tier preflight token count for `ask` / `code`.
 *
 * Decision:
 *   - `preflightMode: 'heuristic'` → always use `bytes/4` (fast, coarse)
 *   - `preflightMode: 'exact'`     → always call countTokens, fall back to
 *                                    `bytes/3` on API failure
 *   - `preflightMode: 'auto'`      → heuristic if `<50 %` of limit, else exact
 *   - omitted → same as `'auto'`
 *
 * Returns `{effectiveTokens, method, rawTokens}` — `effectiveTokens` is what
 * the caller compares against `inputTokenLimit × guardRatio`. `method`
 * surfaces in structured-content metadata so the orchestrator and the user
 * can see which path produced the count.
 */
export async function countForPreflight(
  client: GoogleGenAI,
  input: PreflightInput,
): Promise<PreflightTokenResult> {
  const heuristicCount = computeHeuristic(input.files, input.prompt);
  const mode = input.preflightMode ?? 'auto';

  // Pure-heuristic mode bypasses the API entirely. Reserve added uniformly
  // (v1.12.1 fix) — small absolute cost (1 000 tokens) well within the
  // heuristic's coarse-estimate slop, but keeps the threshold-comparison
  // contract uniform across all paths so callers don't have to special-case.
  if (mode === 'heuristic') {
    return {
      effectiveTokens: heuristicCount + SYSTEM_INSTRUCTION_RESERVE,
      method: 'heuristic',
      rawTokens: heuristicCount,
      cacheHit: false,
    };
  }

  // Auto-tier decision: if the heuristic count is well under the cliff,
  // skip the API call. The cutoff fraction (0.5) ensures we never trust
  // the heuristic near the threshold.
  if (mode === 'auto' && heuristicCount < input.inputTokenLimit * HEURISTIC_CUTOFF_FRACTION) {
    return {
      effectiveTokens: heuristicCount + SYSTEM_INSTRUCTION_RESERVE,
      method: 'heuristic',
      rawTokens: heuristicCount,
      cacheHit: false,
    };
  }

  // Exact mode (or auto + near-cliff). Try the cache first.
  const cacheKey = buildCacheKey(input);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return {
      effectiveTokens: cached + SYSTEM_INSTRUCTION_RESERVE,
      method: 'exact',
      rawTokens: cached,
      cacheHit: true,
    };
  }

  // Build the payload we'll send to generateContent — full file contents
  // wrapped in the SAME `\n\n--- FILE: <relpath> ---\n…\n` marker that
  // `cache-manager.ts` (`buildContentFromUploaded` / `buildInlineContentFromDisk`)
  // uses on the real call. Diverging from that marker would systematically
  // undercount tokens (~6-8/file × file count). For files we can't read
  // (test mocks with fake `absolutePath`, deleted between scan and
  // preflight, permission errors, etc.), we substitute a placeholder
  // string of length `file.size` filled with `'a'` — Gemini's tokenizer
  // hits ~7-8 bytes/token on `'a'`-repetition (per v1.9.0 probe Q2:
  // 100 KB → 12 801 tokens), which UNDERCOUNTS real source by ~50%.
  // Combined with the `bytes/3` final fallback if the whole API call
  // fails, the total estimate is still bounded above the heuristic.
  //
  // Cap accounting in UTF-8 bytes — `string.length` is UTF-16 code units
  // and would let CJK / emoji / surrogate-pair content slip past the cap
  // (CJK BMP: 1 unit → 3 UTF-8 bytes; emoji: 2 units → 4 UTF-8 bytes).
  // Also pre-checks the *projected* byte cost BEFORE materializing the
  // unreadable-file placeholder, so a single huge unreadable file (e.g.
  // future config bumps to `maxFileSizeBytes`) can't OOM the process.
  type CountTokensContent = { role: 'user'; parts: Array<{ text: string }> };
  const fileParts: Array<{ text: string }> = [];
  const FILE_MARKER_OVERHEAD = '\n\n--- FILE:  ---\n\n'.length; // 18 bytes (ASCII) — the bytes added by the marker template, excluding `relpath` and `text` themselves.
  let assembledBytes = 0;
  for (const file of input.files) {
    // Pre-check the cap against projected bytes BEFORE doing the I/O or
    // allocating the placeholder. Defends against a single huge file
    // (e.g. operator bumps `maxFileSizeBytes` past 32 MB) — would have
    // allocated a `file.size`-long placeholder string before the
    // post-allocation cap check fired on the next iteration.
    const projectedBytes =
      assembledBytes + file.size + Buffer.byteLength(file.relpath, 'utf8') + FILE_MARKER_OVERHEAD;
    if (projectedBytes > MAX_TIER_2_PAYLOAD_BYTES) {
      logger.warn(
        `countTokens preflight payload would exceed ${MAX_TIER_2_PAYLOAD_BYTES} bytes; falling back to heuristic × 1.33 (projected ${projectedBytes} bytes after ${fileParts.length} of ${input.files.length} files)`,
      );
      const fallback = computeFallback(input.files, input.prompt);
      return {
        effectiveTokens: fallback + SYSTEM_INSTRUCTION_RESERVE,
        method: 'fallback',
        rawTokens: fallback,
        cacheHit: false,
      };
    }

    let text: string;
    try {
      text = await readFile(file.absolutePath, 'utf8');
    } catch {
      // File missing / unreadable / non-utf8 binary: substitute a
      // placeholder of equivalent byte length. Gemini tokenizer
      // undercounts vs real source, but the heuristic-vs-exact tier
      // gate already avoided sending workspaces with much headroom
      // through this path.
      text = 'a'.repeat(file.size);
    }
    fileParts.push({ text: `\n\n--- FILE: ${file.relpath} ---\n${text}\n` });
    assembledBytes +=
      Buffer.byteLength(text, 'utf8') +
      Buffer.byteLength(file.relpath, 'utf8') +
      FILE_MARKER_OVERHEAD;
  }

  // Include the prompt in the cap accounting — a giant prompt could push
  // the assembled payload past the cap even when file content stays under it.
  const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
  if (assembledBytes + promptBytes > MAX_TIER_2_PAYLOAD_BYTES) {
    logger.warn(
      `countTokens preflight payload exceeded ${MAX_TIER_2_PAYLOAD_BYTES} bytes after adding prompt; falling back to heuristic × 1.33 (assembled ${assembledBytes} files + ${promptBytes} prompt = ${assembledBytes + promptBytes} bytes)`,
    );
    const fallback = computeFallback(input.files, input.prompt);
    return {
      effectiveTokens: fallback + SYSTEM_INSTRUCTION_RESERVE,
      method: 'fallback',
      rawTokens: fallback,
      cacheHit: false,
    };
  }

  const contents: CountTokensContent[] = [
    { role: 'user', parts: [...fileParts, { text: input.prompt }] },
  ];

  // NOTE: we deliberately don't pass `config.systemInstruction` even when
  // it's available. The Gemini Developer API rejects it on countTokens
  // (probe Q3); the Vertex API accepts it. Rather than branching on auth
  // tier, we accept the undercount and add `SYSTEM_INSTRUCTION_RESERVE`
  // to the count — uniform behaviour across both tiers.
  //
  // The `signal` (when provided by the caller's `timeoutMs`) flows in via
  // `config.abortSignal` per the SDK's `CountTokensConfig`. Cancellation
  // RE-THROWS the `AbortError` so the caller's outer `try/catch` (which
  // maps it to `errorCode: 'TIMEOUT'`) sees it; non-abort errors (429,
  // network, malformed response) still fall through to the `bytes/3`
  // graceful-degradation path.
  try {
    const response = await client.models.countTokens({
      model: input.model,
      contents,
      ...(input.signal !== undefined ? { config: { abortSignal: input.signal } } : {}),
    });
    const totalTokens = response.totalTokens;
    if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) {
      // Defensive: countTokens response shape is documented but we've
      // observed SDK quirks. If the field is missing or malformed, fall
      // back rather than throwing — the user's `ask` shouldn't fail
      // because of a probe-time API hiccup.
      logger.warn(
        `countTokens returned unexpected totalTokens=${safeForLog(totalTokens)} for model=${safeForLog(input.model)}; falling back to heuristic`,
      );
      const fallback = computeFallback(input.files, input.prompt);
      return {
        effectiveTokens: fallback + SYSTEM_INSTRUCTION_RESERVE,
        method: 'fallback',
        rawTokens: fallback,
        cacheHit: false,
      };
    }
    cache.set(cacheKey, totalTokens);
    return {
      effectiveTokens: totalTokens + SYSTEM_INSTRUCTION_RESERVE,
      method: 'exact',
      rawTokens: totalTokens,
      cacheHit: false,
    };
  } catch (err) {
    // If the user-supplied signal fired, propagate the abort instead of
    // swallowing it as a fallback. Otherwise the caller's `timeoutMs`
    // budget is silently extended — `ask` would proceed to eager Files
    // API upload before the abort eventually lands on `generateContent`,
    // wasting bandwidth/compute the user explicitly asked us to abort.
    //
    // Throw `signal.reason` (the canonical TimeoutError DOMException with
    // `timeoutKind` property) rather than the SDK's wrapped `err` —
    // re-throwing the SDK error depends on the SDK preserving the
    // `cause` chain so `isTimeoutAbort` can find the TimeoutError, which
    // is fragile across SDK versions. We control `signal.reason`; using
    // it directly guarantees the outer `isTimeoutAbort` / `getTimeoutKind`
    // walk finds the right error.
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : err;
    }
    logger.warn(
      `countTokens preflight failed for model=${safeForLog(input.model)}: ${safeForLog(err)} — falling back to heuristic × 1.33 (safety multiplier for the empirical 30-50% CJK undercount)`,
    );
    const fallback = computeFallback(input.files, input.prompt);
    return {
      effectiveTokens: fallback + SYSTEM_INSTRUCTION_RESERVE,
      method: 'fallback',
      rawTokens: fallback,
      cacheHit: false,
    };
  }
}
