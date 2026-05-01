/**
 * Iterate Gemini's `generateContentStream` AsyncGenerator and accumulate it
 * into a single `CollectedResponse` shaped like the synchronous
 * `generateContent` return — so the call sites in `ask.tool.ts` and
 * `code.tool.ts` keep their downstream parsing unchanged (T20, v1.7.0).
 *
 * Behaviour notes:
 *
 *   - **Text concat**: each chunk's `.text` is treated as a delta and joined
 *     verbatim. Gemini's text accessor returns the chunk-local string, not a
 *     running total — verified empirically via `genai.d.ts` getter.
 *
 *   - **`usageMetadata` is final-chunk-only**: Gemini sends `usageMetadata`
 *     only on the LAST chunk of a stream (per Google docs and observed
 *     telemetry). We always overwrite — last-write-wins is correct semantics
 *     even on the off-chance an early chunk includes a partial. If no chunk
 *     ever provided usageMetadata, the return is `undefined` and downstream
 *     cost accounting falls back to a 0-token estimate. (Callers may choose
 *     to log this as a warning — neither this collector nor `ask`/`code`
 *     currently does, since it would only fire if Google changed the stream
 *     protocol.)
 *
 *   - **`candidates.content.parts` ACCUMULATES across chunks** (T35,
 *     v1.16.3): `parts` from every chunk are appended to a running array
 *     rather than overwritten. Required for multi-chunk function calling —
 *     Gemini emits parallel `functionCall` Parts across separate chunks,
 *     and the `thoughtSignature` mandated on the FIRST `functionCall` Part
 *     (Gemini 3 contract — see ai.google.dev/gemini-api/docs/thought-signatures)
 *     would be silently dropped by any last-write-wins gate. Empty-text
 *     terminator Parts are also preserved because Google's docs note that
 *     during streaming, a model response may carry a `thoughtSignature`
 *     in a part with an empty text string. Filtering them would discard
 *     load-bearing signature material.
 *
 *   - **Candidate METADATA (`finishReason`, safetyRatings, groundingMetadata,
 *     citationMetadata) last-write-wins**: only become authoritative on
 *     the final chunk — earlier chunks may report
 *     "STOP_REASON_UNSPECIFIED" mid-stream. We retain the LAST chunk's
 *     candidate scaffold and synthesise the final `candidates` array on
 *     exit by overlaying the accumulated `parts` onto it.
 *
 *   - **Thought chunks (`part.thought === true`)** are forwarded to
 *     `onThoughtChunk` immediately as they arrive, but the callback fires
 *     at most every `thoughtEmitThrottleMs` ms (default 1500) so the MCP
 *     host's UI doesn't get flooded by short bursts. The full thought text
 *     is also retained in `thoughtsSummary` (capped at 1200 chars to match
 *     the existing `ask` / `code` post-call extraction behaviour) for the
 *     final response metadata.
 *
 *   - **Abort propagation**: if the supplied `signal` fires mid-stream, we
 *     close the generator (`.return?.()`) and re-throw the signal's reason
 *     — the SDK's own abortSignal plumbing should also tear down the
 *     underlying request, but we re-check defensively in case a chunk is
 *     mid-flight when abort fires.
 *
 *   - **`withNetworkRetry` wraps the OPENING of the stream** (in the call
 *     site, not here). A pre-response failure (DNS blip etc.) → retry opens
 *     a fresh stream. A mid-stream failure CANNOT be retried (Gemini's
 *     `generateContentStream` doesn't support resume). We propagate
 *     mid-stream failures verbatim — caller maps them to UNKNOWN errorCode.
 *
 *   - **Stale-cache mid-stream**: if a chunk read throws an error matching
 *     `isStaleCacheError`, we still propagate — caller's stale-cache catch
 *     branch invalidates and opens a NEW full stream. Discards partial.
 */

import type { Candidate, GenerateContentResponse, Part } from '@google/genai';

const DEFAULT_THOUGHT_EMIT_THROTTLE_MS = 1500;
const THOUGHTS_SUMMARY_MAX_CHARS = 1200;

export interface StreamCollectorOptions {
  /** Per-call abort (T19). Threading through here means we drop chunks the
   * moment timeout fires, not after the next one comes through. */
  readonly signal?: AbortSignal;
  /** Called with thought-part text as it arrives, throttled. The text passed
   * is the SAME chunk's thought (not accumulated) — easier for emitters that
   * just want to surface "what is the model thinking RIGHT NOW". */
  readonly onThoughtChunk?: (text: string) => void;
  /** Minimum gap between `onThoughtChunk` emits. Default 1500ms — short
   * enough to feel live, long enough to avoid flooding MCP host throttles. */
  readonly thoughtEmitThrottleMs?: number;
  /**
   * Called on EVERY chunk arrival (Phase 4, v1.12.0). Used to reset the
   * heartbeat-aware stall watchdog. Both text-bearing and thought-only
   * chunks reset the timer — both prove the stream is alive. No-op when
   * caller didn't supply one.
   *
   * Wire this from `createTimeoutController(...).recordChunk`. The
   * controller's `recordChunk` is also a safe no-op when stall is
   * disabled, so callers can pass the controller's `recordChunk`
   * unconditionally.
   */
  readonly onChunkReceived?: () => void;
}

export interface CollectedResponse {
  /** Concatenated text from all chunks. */
  readonly text: string;
  /** Last non-empty candidates array seen — finish reasons live here. */
  readonly candidates: GenerateContentResponse['candidates'];
  /** Final-chunk usage; undefined if no chunk reported one. */
  readonly usageMetadata: GenerateContentResponse['usageMetadata'];
  /** Concatenated thought text, capped at 1200 chars. Null when none seen. */
  readonly thoughtsSummary: string | null;
  /** Number of chunks consumed. Useful for diagnostics + logging. */
  readonly chunkCount: number;
  /** Wall-clock timestamps for first/last chunk arrival (Date.now() values). */
  readonly firstChunkAt: number | null;
  readonly lastChunkAt: number | null;
}

/**
 * Drive an `AsyncGenerator<GenerateContentResponse>` to completion and
 * collect the deltas into a single response shape.
 *
 * Throws (re-throws really) on:
 *   - Abort signal fired before or during iteration → signal.reason
 *   - Generator yielding an error → propagated verbatim
 */
export async function collectStream(
  stream: AsyncGenerator<GenerateContentResponse>,
  opts: StreamCollectorOptions = {},
): Promise<CollectedResponse> {
  const signal = opts.signal;
  const onThoughtChunk = opts.onThoughtChunk;
  const onChunkReceived = opts.onChunkReceived;
  const throttleMs = opts.thoughtEmitThrottleMs ?? DEFAULT_THOUGHT_EMIT_THROTTLE_MS;

  // Pre-flight: never start consuming if abort already fired. Saves the cost
  // of touching the generator at all.
  if (signal?.aborted) {
    void stream.return?.(undefined);
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Operation aborted', 'AbortError');
  }

  const textChunks: string[] = [];
  const thoughtChunks: string[] = [];
  // T35 (v1.16.3): accumulate parts from every chunk rather than picking the
  // "best" chunk's parts. Multi-chunk function calls and standalone signature
  // terminator Parts both depend on this — see file-level docstring.
  //
  // R1 fold (PR #59 — GPT F1 / Gemini F1 / Grok F2): per-candidate-index maps
  // preserve the pre-T35 multi-candidate contract. Pre-T35 the synth was
  // `lastCandidates = chunk.candidates` (full N-element array preserved).
  // The initial T35 implementation collapsed to single-element synth which
  // narrowed the type for any future caller that sets `candidateCount > 1`.
  // Today no caller does, but `code.tool.ts:727` iterates ALL candidates
  // (`for (const cand of candidates)`) so a future caller would silently
  // lose candidates 1..N's parts/safety/grounding. Per-index maps keep the
  // accumulation invariant for every emitted candidate.
  const accumulatedPartsByIndex = new Map<number, Part[]>();
  // Last seen candidate-scaffold per index — finishReason, safetyRatings,
  // groundingMetadata, citationMetadata. We DON'T accumulate these (each is
  // a standalone field where the latest authoritative value wins). On exit
  // we overlay each index's accumulated parts onto its last scaffold to
  // synthesise the returned `lastCandidates`.
  const scaffoldsByIndex = new Map<number, Candidate>();
  let lastUsageMetadata: GenerateContentResponse['usageMetadata'];
  let chunkCount = 0;
  let firstChunkAt: number | null = null;
  let lastChunkAt: number | null = null;
  let lastThoughtEmitAt = 0;
  // Outer try/finally guarantees the underlying generator gets a `.return()`
  // call on EVERY exit path — happy completion, mid-stream throw, abort
  // propagation. Without this, the previous `void stream.return?.()` calls
  // were "best effort" and could be skipped on uncommon error paths,
  // leaking the underlying SSE connection until GC kicked in.
  let needsCleanup = true;

  try {
    for await (const chunk of stream) {
      // Mid-stream abort check — if signal fired while we were waiting on
      // the next chunk, close the generator and propagate the reason. The
      // SDK's own abortSignal (wired via config.abortSignal) should tear
      // the underlying fetch down, but the for-await loop hands us one
      // more chunk before the abort propagates from the SDK. Without the
      // explicit check, we'd accumulate that extra chunk.
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Operation aborted', 'AbortError');
      }

      chunkCount += 1;
      const now = Date.now();
      if (firstChunkAt === null) firstChunkAt = now;
      lastChunkAt = now;

      // Reset the heartbeat-aware stall watchdog (Phase 4, v1.12.0).
      // Both text-bearing and thought-only chunks reset — both prove the
      // stream is alive. Called BEFORE the abort check below would
      // re-fire to cover the (rare) race where stall fires AFTER the
      // SDK yielded this chunk but BEFORE we processed it.
      onChunkReceived?.();

      // Text concat. `chunk.text` is a getter on GenerateContentResponse
      // that joins parts.text from the first candidate; safe to read even
      // when the chunk only carries thoughts (returns empty string then).
      const chunkText = chunk.text ?? '';
      if (chunkText.length > 0) textChunks.push(chunkText);

      // Accumulate parts across chunks (T35, v1.16.3).
      //
      // History — four iterations:
      //
      // **v1.7.0 → v1.16.1**: gate was `chunk.candidates.length > 0` (outer
      // array length only) under last-write-wins semantics. Correct for the
      // ask/code text-extraction path (which reads accumulated
      // `response.text`, not `candidates[0].content.parts`). But v1.16.2's
      // ask_agentic streaming migration was the first consumer that reads
      // `candidates[0].content.parts` directly to extract `functionCall`
      // Parts — last-write-wins is fragile here.
      //
      // **v1.16.2** (PR #58 Round-1 fold of gemini Finding #1): gate
      // tightened to also require `parts.length > 0`. Closed the case
      // `{ candidates: [{ content: { parts: [], finishReason: 'STOP' }}] }`
      // — non-empty outer, empty inner.
      //
      // **v1.16.3 hotfix-A** (interim): gate strengthened further to require
      // AT LEAST ONE content-bearing part. Closed the empirical Gemini
      // empty-text-terminator pattern (`parts: [{ text: '' }]` after the
      // functionCall chunk). But still last-write-wins — under multi-chunk
      // function calling (parallel `functionCall` Parts across separate
      // chunks, or `thoughtSignature` carried on a standalone empty-text
      // terminator), earlier chunks were silently dropped, including the
      // Gemini-3-mandated signature on the FIRST functionCall part.
      // Empirically reproduced by Test 5 — multi-file ask_agentic prompt
      // returned 400 "missing thought_signature, position 2" against live
      // Gemini Pro on 2026-05-01.
      //
      // **v1.16.3 (T35, this fix)**: ACCUMULATE parts across every chunk.
      // Filtering is wrong by construction — Google's docs explicitly state
      // (https://ai.google.dev/gemini-api/docs/thought-signatures):
      //   "During a model response not containing a FC with a streaming
      //    request, the model may return the thought signature in a part
      //    with an empty text content part. It is advisable to parse the
      //    entire request until the `finish_reason` is returned"
      // and (function-calling docs):
      //   "Don't merge a Part containing a signature with one that does not.
      //    This breaks the positional context of the thought."
      // Accumulating preserves every Part exactly as Gemini emitted it —
      // signature attachments, parallel functionCall Parts, executableCode
      // chunks followed by codeExecutionResult chunks, and so on.
      //
      // Side-effect on ask/code: `response.candidates[0].content.parts`
      // now contains every emitted Part (including thought parts and any
      // empty-text terminator parts). Neither tool reads parts directly
      // for text extraction — both go through accumulated `response.text`
      // — so behaviour is observably equivalent. ask_agentic's parts-iter
      // (filter for `functionCall`, count thought parts) sees richer
      // input but each filter handles the extra Part variants without
      // change.
      // Per-candidate-index accumulation. Today Gemini's streaming protocol
      // emits candidateCount=1 by default (no caller in this codebase sets
      // candidateCount>1 — verified by repo-wide grep). Per-index maps cost
      // ~10 lines and preserve the pre-T35 contract for any future caller
      // that does set candidateCount>1, matching `code.tool.ts:727`'s
      // existing `for (const cand of candidates)` consumption pattern.
      //
      // R2 fold (PR #59 — GPT R2 F1 / Gemini R2 F1, 2-way HIGH): key Maps by
      // `cand.index ?? i` instead of array position alone. Per @google/genai
      // SDK Candidate.index doc: "The 0-based index of this candidate in
      // the list of generated responses. This is useful for distinguishing
      // between multiple candidates when candidate_count > 1." Sparse stream
      // emission like `candidates: [{ index: 1, content: ... }]` (only
      // index 1, not 0) would otherwise cross-wire that part into bucket 0.
      const candidates = chunk.candidates ?? [];
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        if (!cand) continue;
        const cIdx = cand.index ?? i;
        const incomingParts = cand.content?.parts;
        if (Array.isArray(incomingParts) && incomingParts.length > 0) {
          let bucket = accumulatedPartsByIndex.get(cIdx);
          if (!bucket) {
            bucket = [];
            accumulatedPartsByIndex.set(cIdx, bucket);
          }
          bucket.push(...incomingParts);
        }
        // Track the latest candidate scaffold for this index. finishReason,
        // safety ratings, grounding, citation metadata — each chunk yields
        // a fresh scaffold per index; finalisation overlays per-index
        // accumulated parts onto each index's last seen scaffold.
        scaffoldsByIndex.set(cIdx, cand);
      }

      // Thought-part extraction. `parts[i].thought === true` flags an
      // internal-reasoning chunk. Push to summary, throttle emit.
      // (Reuses `candidates` from the per-index accumulation block above.)
      for (const cand of candidates) {
        const parts = cand.content?.parts ?? [];
        for (const part of parts) {
          if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
            thoughtChunks.push(part.text);
            if (onThoughtChunk && now - lastThoughtEmitAt >= throttleMs) {
              // Re-check abort RIGHT BEFORE invoking the callback. If the
              // signal flipped between the loop-top check and here (e.g.
              // a long-running thought-extraction loop on a chunk with many
              // parts), we don't want to surface a stale "thinking: …"
              // notification AFTER the user has already seen the timeout
              // error — that's confusing UX.
              if (signal?.aborted) {
                throw signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException('Operation aborted', 'AbortError');
              }
              lastThoughtEmitAt = now;
              try {
                onThoughtChunk(part.text);
              } catch (cbErr) {
                // Emitter exceptions must not abort the stream — log and
                // keep collecting. The caller's response shape is more
                // important than progress notification fidelity.
                // eslint-disable-next-line no-console -- shared module, no logger dep
                console.warn(
                  `stream-collector: onThoughtChunk threw, suppressed: ${
                    cbErr instanceof Error ? cbErr.message : String(cbErr)
                  }`,
                );
              }
            }
          }
        }
      }

      // usageMetadata appears on the final chunk; keep last-write-wins.
      if (chunk.usageMetadata) {
        lastUsageMetadata = chunk.usageMetadata;
      }
    }
    // for-await exited cleanly — generator is exhausted, no cleanup needed.
    needsCleanup = false;
  } catch (err) {
    // If abort is the cause of the throw, prefer the signal's reason. SDK
    // sometimes throws a generic "fetch failed" because abort tore down
    // the socket — we want the timeout-driven error to surface.
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Operation aborted', 'AbortError');
    }
    throw err;
  } finally {
    // Best-effort cleanup of the underlying generator + transport. Awaited
    // detachment is fire-and-forget here — we're already on the way out
    // of the function and any async cleanup error would mask the original
    // throw (or just delay successful completion). The async generator's
    // own try/finally inside the SDK is the actual guarantee; this is
    // belt-and-suspenders.
    if (needsCleanup) {
      void stream.return?.(undefined);
    }
  }

  const text = textChunks.join('');
  const thoughtsSummary =
    thoughtChunks.length > 0 ? thoughtChunks.join('\n').slice(0, THOUGHTS_SUMMARY_MAX_CHARS) : null;

  // Synthesize final candidates by overlaying each index's accumulated parts
  // onto that index's last seen scaffold. When NO chunk yielded a candidate
  // at all (e.g. text-only stream with naked `{ text: 'x' }` chunks),
  // `lastCandidates` stays undefined — preserves the prior contract for the
  // no-candidates path. When chunks emitted candidateCount>1, every emitted
  // index gets a synthesised entry, sorted by ordinal index — matches
  // pre-T35 `lastCandidates = chunk.candidates` semantics.
  //
  // The .sort() is load-bearing under R2 fold's `cand.index ?? i` keying:
  // sparse emission (chunk 1 emits index 1 first, chunk 2 emits index 0)
  // would yield Map insertion order [1, 0] without the sort, mis-ordering
  // the final candidates array. Map preserves insertion order, so sort is
  // the only guarantee of ordinal output ordering.
  const lastCandidates: GenerateContentResponse['candidates'] =
    scaffoldsByIndex.size > 0
      ? Array.from(scaffoldsByIndex.entries())
          .sort(([a], [b]) => a - b)
          .map(([i, scaffold]) => ({
            ...scaffold,
            content: {
              ...(scaffold.content ?? {}),
              role: scaffold.content?.role ?? 'model',
              parts: accumulatedPartsByIndex.get(i) ?? [],
            },
          }))
      : undefined;

  return {
    text,
    candidates: lastCandidates,
    usageMetadata: lastUsageMetadata,
    thoughtsSummary,
    chunkCount,
    firstChunkAt,
    lastChunkAt,
  };
}
