/**
 * Unit coverage for `collectStream` (T20, v1.7.0).
 *
 * Verifies (without hitting the network) the stream-accumulation contract that
 * `ask` and `code` rely on: text concat, last-write-wins for usageMetadata
 * and candidates, throttled thought emit, abort propagation, and the
 * mid-stream-error path.
 */

import type { GenerateContentResponse } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { collectStream } from '../../src/tools/shared/stream-collector.js';

async function* gen(
  chunks: Array<Partial<GenerateContentResponse>>,
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) yield chunk as GenerateContentResponse;
}

async function* genThatThrows(
  chunks: Array<Partial<GenerateContentResponse>>,
  err: unknown,
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) yield chunk as GenerateContentResponse;
  throw err;
}

describe('collectStream — text concat', () => {
  it('concatenates text from each chunk in order', async () => {
    const result = await collectStream(
      gen([{ text: 'Hello, ' }, { text: 'world' }, { text: '!' }]),
    );
    expect(result.text).toBe('Hello, world!');
    expect(result.chunkCount).toBe(3);
  });

  it('skips empty/missing text chunks', async () => {
    const result = await collectStream(gen([{ text: 'a' }, {}, { text: 'b' }]));
    expect(result.text).toBe('ab');
    expect(result.chunkCount).toBe(3);
  });

  it('returns empty string when no chunks yielded', async () => {
    const result = await collectStream(gen([]));
    expect(result.text).toBe('');
    expect(result.chunkCount).toBe(0);
  });
});

describe('collectStream — usageMetadata last-write-wins', () => {
  it('captures usageMetadata only from the final chunk', async () => {
    const result = await collectStream(
      gen([
        { text: 'first' },
        { text: 'second' },
        { text: 'last', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } },
      ]),
    );
    expect(result.usageMetadata).toEqual({ promptTokenCount: 100, candidatesTokenCount: 50 });
  });

  it('returns undefined usageMetadata when no chunk provides one', async () => {
    const result = await collectStream(gen([{ text: 'a' }, { text: 'b' }]));
    expect(result.usageMetadata).toBeUndefined();
  });

  it('overwrites earlier usageMetadata with later (defensive against partials)', async () => {
    const result = await collectStream(
      gen([
        { text: 'a', usageMetadata: { promptTokenCount: 50 } },
        { text: 'b', usageMetadata: { promptTokenCount: 100 } },
      ]),
    );
    expect(result.usageMetadata?.promptTokenCount).toBe(100);
  });
});

describe('collectStream — candidate scaffold metadata last-write-wins', () => {
  it('captures finishReason from the latest candidate-bearing chunk', async () => {
    const result = await collectStream(
      gen([
        { candidates: [{ content: { parts: [{ text: 'first' }] }, finishReason: undefined }] },
        { candidates: [{ content: { parts: [{ text: 'last' }] }, finishReason: 'STOP' }] },
      ]),
    );
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
  });

  it('preserves earlier scaffold when a later chunk has no candidates', async () => {
    const result = await collectStream(
      gen([
        { candidates: [{ content: { parts: [{ text: 'kept' }] }, finishReason: 'STOP' }] },
        { candidates: [] },
      ]),
    );
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
  });
});

describe('collectStream — parts ACCUMULATE across chunks (T35, v1.16.3)', () => {
  it('preserves functionCall from chunk 1 when chunk 2 carries an empty-text terminator (v1.16.3 hotfix-A regression pin)', async () => {
    // Empirical raw-stream capture against live Gemini Pro on 2026-05-01
    // showed the canonical Gemini stream protocol pattern for tool-using
    // turns: the functionCall arrives in chunk 1 and a TERMINATOR shaped
    // `{ candidates: [{ content: { parts: [{ text: '' }] },
    // finishReason: 'STOP' }] }` in chunk 2.
    //
    // Pre-T35 (v1.16.3 hotfix-A) used a content-bearing-parts gate +
    // last-write-wins, which kept the functionCall. T35 (true parts
    // accumulation) goes further: ALL parts from every chunk are
    // appended verbatim. This means the empty-text Part from the
    // terminator is also preserved — Google's docs explicitly state
    // (ai.google.dev/gemini-api/docs/thought-signatures): "the model
    // may return the thought signature in a part with an empty text
    // content part". Filtering would discard load-bearing signature
    // material.
    //
    // The functionCall preservation invariant — the original v1.16.3
    // ask_agentic-empty-response regression test — stays load-bearing.
    const result = await collectStream(
      gen([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'read_file', args: { path: 'package.json' } } }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1397, candidatesTokenCount: 12 },
        },
      ]),
    );
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    // T35: BOTH parts preserved (functionCall + terminator empty-text). The
    // terminator part is harmless to ask_agentic's functionCall extractor
    // (filters for `p.functionCall`) and to ask/code (which read
    // `response.text` not parts).
    expect(parts.length).toBe(2);
    expect(parts[0]?.functionCall?.name).toBe('read_file');
    expect(parts[1]?.text).toBe('');
    // finishReason still last-write-wins on the candidate scaffold.
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
    expect(result.usageMetadata?.promptTokenCount).toBe(1397);
  });

  it('preserves functionCall from chunk 1 when chunk 2 has empty parts (v1.16.2 fragmentation guard regression pin)', async () => {
    // Original v1.16.2 PR-Round-1 fix (gemini Finding #1 HIGH). Pre-fix, an
    // early chunk carrying a `functionCall` Part could be silently
    // overwritten by a final terminator chunk shaped like
    // `{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }`
    // — non-empty outer array but empty inner parts.
    //
    // T35 accumulation: chunk 2 contributes nothing (empty parts array),
    // so accumulatedParts stays at chunk 1's contribution.
    const result = await collectStream(
      gen([
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }],
              },
            },
          ],
        },
        {
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      ]),
    );
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    expect(parts.length).toBe(1);
    expect(parts[0]?.functionCall?.name).toBe('read_file');
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
    expect(result.usageMetadata?.promptTokenCount).toBe(10);
  });

  it('preserves Gemini-3 thoughtSignature on FIRST functionCall when parallel functionCalls span 3 chunks (T35 primary regression — was Test 5 fail)', async () => {
    // Reproduces the Test 5 failure mode that motivated T35. Empirical
    // chunk capture against live Gemini Pro on a multi-file ask_agentic
    // prompt was prevented by sandbox credential gating, but the failure
    // mode is exactly the documented contract violation: Gemini 3
    // attaches a `thoughtSignature` to the FIRST functionCall part
    // (mandatory per ai.google.dev/gemini-api/docs/thought-signatures).
    //
    // Chunk pattern under fragmentation (one observed possibility):
    //   chunk 1: parts: [{ functionCall: read_file(p1), thoughtSignature: 'X' }]
    //   chunk 2: parts: [{ functionCall: read_file(p2) }]
    //   chunk 3: parts: [{ functionCall: read_file(p3) }]
    //   chunk 4: parts: [{ text: '' }]   (terminator)
    //
    // Pre-T35 last-write-wins kept ONLY chunk 3's parts (single FC, no
    // sig); ask_agentic pushed it as model turn 1; iteration 2's
    // generateContent returned 400 "missing thought_signature" against
    // the model turn at position 2 of the contents array.
    //
    // T35: accumulate every part, signature stays on chunk 1's FC.
    const result = await collectStream(
      gen([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'read_file', args: { path: 'package.json' } },
                    thoughtSignature: 'sig-base64-from-gemini-3',
                  },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'read_file', args: { path: 'server.json' } } }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'read_file', args: { path: 'CHANGELOG.md' } } }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 30 },
        },
      ]),
    );
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    // All 3 functionCalls + the empty-text terminator → 4 parts.
    expect(parts.length).toBe(4);
    expect(parts[0]?.functionCall?.args?.path).toBe('package.json');
    // CRITICAL: signature on FC1 must survive accumulation. This is the
    // load-bearing assertion that closes Test 5 against live Gemini.
    expect(parts[0]?.thoughtSignature).toBe('sig-base64-from-gemini-3');
    expect(parts[1]?.functionCall?.args?.path).toBe('server.json');
    expect(parts[2]?.functionCall?.args?.path).toBe('CHANGELOG.md');
    expect(parts[3]?.text).toBe('');
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
  });

  it('preserves thoughtSignature on a standalone empty-text terminator part (Gemini docs streaming guidance)', async () => {
    // ai.google.dev/gemini-api/docs/thought-signatures, verbatim:
    // "During a model response not containing a FC with a streaming
    //  request, the model may return the thought signature in a part
    //  with an empty text content part."
    //
    // Pre-T35 (hotfix-A) gate REJECTED parts where every entry was either
    // empty text or non-content-bearing — would have dropped a signature
    // on a standalone `{ text: '', thoughtSignature: 'X' }` part.
    // Accumulation keeps it intact for the next-turn replay.
    const result = await collectStream(
      gen([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'The answer is 42.' }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: '', thoughtSignature: 'sig-on-terminator' }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
    );
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    expect(parts.length).toBe(2);
    expect(parts[0]?.text).toBe('The answer is 42.');
    expect(parts[1]?.thoughtSignature).toBe('sig-on-terminator');
  });

  it('preserves executableCode + codeExecutionResult across two chunks (T35 secondary — closes the documented `code` tool fragility)', async () => {
    // T35 docs (PR #59) noted that `code.tool.ts:726-733` iterates
    // `response.candidates[0].content.parts` to extract BOTH
    // `executableCode` and `codeExecutionResult`. Pre-T35 last-write-wins
    // would have dropped chunk 1's `executableCode` if Gemini emitted
    // them in separate chunks — empirically not yet observed but covered
    // by the same accumulation contract.
    const result = await collectStream(
      gen([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ executableCode: { language: 'PYTHON', code: 'print(2+2)' } }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '4\n' } },
                  { text: 'Two plus two is 4.' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
    );
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    expect(parts.length).toBe(3);
    expect(parts[0]?.executableCode?.code).toBe('print(2+2)');
    expect(parts[1]?.codeExecutionResult?.output).toBe('4\n');
    expect(parts[2]?.text).toBe('Two plus two is 4.');
  });

  it('synthesises content.role = "model" when the latest scaffold lacks one', async () => {
    // Defensive: some chunks carry `content` without an explicit `role`.
    // The synthesised result should always carry a `role: 'model'` so
    // downstream consumers (ask-agentic pushing model turn to
    // conversation history) don't see a malformed turn.
    const result = await collectStream(
      gen([
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }],
              },
            },
          ],
        },
      ]),
    );
    expect(result.candidates?.[0]?.content?.role).toBe('model');
  });

  it('returns undefined candidates when no chunk yielded a candidate at all', async () => {
    // Text-only stream where chunks come as naked `{ text: 'x' }` (no
    // candidates wrapper). Preserves the prior contract — `candidates`
    // stays undefined, downstream callers fall back to `text`.
    const result = await collectStream(gen([{ text: 'a' }, { text: 'b' }]));
    expect(result.candidates).toBeUndefined();
    expect(result.text).toBe('ab');
  });
});

describe('collectStream — thought parts', () => {
  it('joins thought-flagged parts into thoughtsSummary', async () => {
    const result = await collectStream(
      gen([
        {
          candidates: [
            {
              content: {
                parts: [{ text: 'reasoning A', thought: true }, { text: 'visible answer' }],
              },
            },
          ],
        },
        {
          candidates: [{ content: { parts: [{ text: 'reasoning B', thought: true }] } }],
        },
      ]),
    );
    expect(result.thoughtsSummary).toBe('reasoning A\nreasoning B');
  });

  it('caps thoughtsSummary at 1200 chars', async () => {
    const long = 'x'.repeat(2000);
    const result = await collectStream(
      gen([
        {
          candidates: [{ content: { parts: [{ text: long, thought: true }] } }],
        },
      ]),
    );
    expect(result.thoughtsSummary?.length).toBe(1200);
  });

  it('returns null thoughtsSummary when no thought parts seen', async () => {
    const result = await collectStream(
      gen([{ candidates: [{ content: { parts: [{ text: 'visible only' }] } }] }]),
    );
    expect(result.thoughtsSummary).toBeNull();
  });

  it('throttles onThoughtChunk emits to ~1500ms by default', async () => {
    const onThoughtChunk = vi.fn();
    // Three thought chunks in rapid succession (synthetic, all in the same
    // microtask). Default throttle 1500ms → only the first should emit.
    await collectStream(
      gen([
        { candidates: [{ content: { parts: [{ text: 't1', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 't2', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 't3', thought: true }] } }] },
      ]),
      { onThoughtChunk },
    );
    // First emit always passes (lastEmitAt = 0 initially); subsequent
    // throttled because Date.now() doesn't advance enough between chunks.
    expect(onThoughtChunk).toHaveBeenCalledTimes(1);
    expect(onThoughtChunk).toHaveBeenCalledWith('t1');
  });

  it('throttle window respected per emit, not absolute (custom 0ms = always)', async () => {
    const onThoughtChunk = vi.fn();
    await collectStream(
      gen([
        { candidates: [{ content: { parts: [{ text: 't1', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 't2', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 't3', thought: true }] } }] },
      ]),
      { onThoughtChunk, thoughtEmitThrottleMs: 0 },
    );
    expect(onThoughtChunk).toHaveBeenCalledTimes(3);
  });

  it('swallows onThoughtChunk callback errors', async () => {
    const onThoughtChunk = vi.fn(() => {
      throw new Error('emitter blew up');
    });
    // Stream should still complete despite the callback throwing.
    const result = await collectStream(
      gen([
        { candidates: [{ content: { parts: [{ text: 'thought', thought: true }] } }] },
        { text: 'final answer' },
      ]),
      { onThoughtChunk, thoughtEmitThrottleMs: 0 },
    );
    expect(result.text).toBe('final answer');
    expect(onThoughtChunk).toHaveBeenCalled();
  });
});

describe('collectStream — abort propagation', () => {
  it('throws immediately when signal is pre-aborted (does not consume stream)', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('pre-aborted', 'TimeoutError'));
    let chunksConsumed = 0;
    async function* trackingGen(): AsyncGenerator<GenerateContentResponse> {
      chunksConsumed += 1;
      yield { text: 'never seen' } as GenerateContentResponse;
    }
    await expect(collectStream(trackingGen(), { signal: controller.signal })).rejects.toThrow(
      /pre-aborted/,
    );
    expect(chunksConsumed).toBe(0);
  });

  it('throws when signal fires mid-stream (closes the generator)', async () => {
    const controller = new AbortController();
    let yielded = 0;
    async function* slowGen(): AsyncGenerator<GenerateContentResponse> {
      for (let i = 0; i < 5; i += 1) {
        yielded += 1;
        if (i === 2) controller.abort(new DOMException('mid-stream', 'TimeoutError'));
        yield { text: `chunk-${i}` } as GenerateContentResponse;
      }
    }
    await expect(collectStream(slowGen(), { signal: controller.signal })).rejects.toThrow(
      /mid-stream/,
    );
    // Iteration stops once abort fires — we should NOT have consumed all 5.
    expect(yielded).toBeLessThan(5);
  });

  it('rewrites a generic error into the abort reason when signal fires concurrently', async () => {
    const controller = new AbortController();
    async function* throwingGen(): AsyncGenerator<GenerateContentResponse> {
      yield { text: 'first' } as GenerateContentResponse;
      // Simulate the SDK throwing a generic "fetch failed" because the
      // socket was torn down by abort. The signal is the truer cause.
      controller.abort(new DOMException('timeout-truth', 'TimeoutError'));
      throw new TypeError('fetch failed');
    }
    await expect(collectStream(throwingGen(), { signal: controller.signal })).rejects.toThrow(
      /timeout-truth/,
    );
  });
});

describe('collectStream — mid-stream errors propagate', () => {
  it('mid-stream error is rethrown verbatim (no signal interference)', async () => {
    await expect(collectStream(genThatThrows([{ text: 'a' }], new Error('bang')))).rejects.toThrow(
      /bang/,
    );
  });

  it('does NOT swallow mid-stream errors as transient (caller chooses retry policy)', async () => {
    // Regression-pin for v1.7.0 review CRITICAL #1: previously
    // collectStream was inside withNetworkRetry which would have retried
    // a `TypeError: fetch failed` mid-stream — duplicating model output
    // and double-billing. collectStream itself MUST propagate verbatim.
    await expect(
      collectStream(genThatThrows([{ text: 'partial' }], new TypeError('fetch failed'))),
    ).rejects.toThrow(/fetch failed/);
  });

  it('mid-stream onThoughtChunk emit is suppressed once signal aborts', async () => {
    // Regression-pin for review MEDIUM #4: an abort that fires DURING the
    // for-await iteration (between chunk receive and the inner thought-emit
    // loop) must short-circuit before the stale `thinking: …` notification
    // reaches the user.
    const onThoughtChunk = vi.fn();
    const controller = new AbortController();
    async function* g(): AsyncGenerator<GenerateContentResponse> {
      // First chunk yields a thought — no abort yet, so it emits.
      yield {
        candidates: [{ content: { parts: [{ text: 'first', thought: true }] } }],
      } as GenerateContentResponse;
      // Now abort — collectStream's loop-top check should fire BEFORE the
      // second chunk's thought is processed.
      controller.abort(new DOMException('mid-flight', 'TimeoutError'));
      yield {
        candidates: [{ content: { parts: [{ text: 'second', thought: true }] } }],
      } as GenerateContentResponse;
    }
    await expect(
      collectStream(g(), { signal: controller.signal, onThoughtChunk, thoughtEmitThrottleMs: 0 }),
    ).rejects.toThrow(/mid-flight/);
    expect(onThoughtChunk).toHaveBeenCalledTimes(1);
    expect(onThoughtChunk).toHaveBeenCalledWith('first');
  });
});

describe('collectStream — timing metadata', () => {
  it('records firstChunkAt and lastChunkAt timestamps', async () => {
    const result = await collectStream(gen([{ text: 'a' }, { text: 'b' }]));
    expect(typeof result.firstChunkAt).toBe('number');
    expect(typeof result.lastChunkAt).toBe('number');
    if (result.firstChunkAt !== null && result.lastChunkAt !== null) {
      expect(result.lastChunkAt).toBeGreaterThanOrEqual(result.firstChunkAt);
    }
  });

  it('returns null timestamps for an empty stream', async () => {
    const result = await collectStream(gen([]));
    expect(result.firstChunkAt).toBeNull();
    expect(result.lastChunkAt).toBeNull();
  });
});
