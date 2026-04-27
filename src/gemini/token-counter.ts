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
 *     `SHA256(filesHash + promptHash + model + globsHash)`. `filesHash` is
 *     already computed by the workspace scanner and auto-invalidates on
 *     file change. TTL = process lifetime; no manifest persistence.
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

/** Token reserve subtracted from the comparison threshold to account for
 * `systemInstruction` + tool declarations that countTokens doesn't count
 * on the Gemini Developer API path. See Q3 in
 * `.claude/local-PLAN-v1.10.0.md`. The 1 000-token reserve is generous —
 * empirical agentic systemInstruction is ~600 tokens; tool declarations
 * for the four `ask_agentic` functions are ~200-400 tokens. `ask` and
 * `code` typically pass no system instruction so the reserve is pure
 * safety margin there. */
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

export type TokenCountMethod = 'heuristic' | 'exact' | 'fallback';

export interface PreflightTokenResult {
  /** The count we'll compare against `inputTokenLimit × workspaceGuardRatio`. */
  effectiveTokens: number;
  /** Which path produced the count. Surfaces in tool metadata. */
  method: TokenCountMethod;
  /** Raw count from the source — for diagnostics. Same as `effectiveTokens`
   * minus `SYSTEM_INSTRUCTION_RESERVE` for `'exact'` / `'fallback'` paths;
   * equal to `effectiveTokens` for `'heuristic'` (the heuristic already
   * has slop). */
  rawTokens: number;
}

/** Inputs to the preflight count. Mirror what `ask` / `code` already
 * compute internally. */
export interface PreflightInput {
  files: ScannedFile[];
  prompt: string;
  model: string;
  /** Stable hash of the workspace's file content + extension membership.
   * Already computed by `scanWorkspace` for cache-key purposes. */
  filesHash: string;
  /** User-supplied globs, hashed for cache-key isolation. Pass `''` if
   * no globs. */
  globsHash?: string;
  /** Optional override of the heuristic-vs-exact cutoff. */
  preflightMode?: 'heuristic' | 'exact' | 'auto';
  /** The model's advertised input token limit. The cutoff fraction is
   * applied to this. */
  inputTokenLimit: number;
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
  const globsHash = input.globsHash ?? '';
  return createHash('sha256')
    .update(`${input.filesHash}|${promptHash}|${input.model}|${globsHash}`)
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

  // Pure-heuristic mode bypasses the API entirely. No reserve subtracted —
  // the heuristic is already a coarse estimate; users opting into this
  // mode prioritize predictability over accuracy.
  if (mode === 'heuristic') {
    return { effectiveTokens: heuristicCount, method: 'heuristic', rawTokens: heuristicCount };
  }

  // Auto-tier decision: if the heuristic count is well under the cliff,
  // skip the API call. The cutoff fraction (0.5) ensures we never trust
  // the heuristic near the threshold.
  if (mode === 'auto' && heuristicCount < input.inputTokenLimit * HEURISTIC_CUTOFF_FRACTION) {
    return { effectiveTokens: heuristicCount, method: 'heuristic', rawTokens: heuristicCount };
  }

  // Exact mode (or auto + near-cliff). Try the cache first.
  const cacheKey = buildCacheKey(input);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return {
      effectiveTokens: cached + SYSTEM_INSTRUCTION_RESERVE,
      method: 'exact',
      rawTokens: cached,
    };
  }

  // Build the actual payload we'll send to generateContent — full file
  // contents, not just filename annotations. Tier-2 accuracy requires
  // sending the same bytes the model will see. For files we can't read
  // (test mocks with fake `absolutePath`, deleted between scan and
  // preflight, permission errors, etc.), we substitute a placeholder
  // string of length `file.size` filled with `'a'` — Gemini's tokenizer
  // hits ~7-8 bytes/token on `'a'`-repetition (per v1.9.0 probe Q2:
  // 100 KB → 12 801 tokens), which UNDERCOUNTS real source by ~50%.
  // Combined with the `bytes/3` final fallback if the whole API call
  // fails, the total estimate is still bounded above the heuristic
  // for safety.
  type CountTokensContent = { role: 'user'; parts: Array<{ text: string }> };
  const fileParts: Array<{ text: string }> = [];
  for (const file of input.files) {
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
    fileParts.push({ text: `// ${file.relpath}\n${text}` });
  }
  const contents: CountTokensContent[] = [
    { role: 'user', parts: [...fileParts, { text: input.prompt }] },
  ];

  // NOTE: we deliberately don't pass `config.systemInstruction` even when
  // it's available. The Gemini Developer API rejects it on countTokens
  // (probe Q3); the Vertex API accepts it. Rather than branching on auth
  // tier, we accept the undercount and add `SYSTEM_INSTRUCTION_RESERVE`
  // to the threshold subtractor — uniform behaviour across both tiers.
  try {
    const response = await client.models.countTokens({ model: input.model, contents });
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
      return { effectiveTokens: fallback, method: 'fallback', rawTokens: fallback };
    }
    cache.set(cacheKey, totalTokens);
    return {
      effectiveTokens: totalTokens + SYSTEM_INSTRUCTION_RESERVE,
      method: 'exact',
      rawTokens: totalTokens,
    };
  } catch (err) {
    logger.warn(
      `countTokens preflight failed for model=${safeForLog(input.model)}: ${safeForLog(err)} — falling back to heuristic × 1.33 (safety multiplier for the empirical 30-50% CJK undercount)`,
    );
    const fallback = computeFallback(input.files, input.prompt);
    return { effectiveTokens: fallback, method: 'fallback', rawTokens: fallback };
  }
}
