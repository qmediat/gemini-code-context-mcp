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

describe('collectStream — candidates last-non-empty-wins', () => {
  it('captures the last non-empty candidates array', async () => {
    const result = await collectStream(
      gen([
        { candidates: [{ content: { parts: [{ text: 'first' }] }, finishReason: undefined }] },
        { candidates: [{ content: { parts: [{ text: 'last' }] }, finishReason: 'STOP' }] },
      ]),
    );
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
  });

  it('does not overwrite with empty candidates', async () => {
    const result = await collectStream(
      gen([
        { candidates: [{ content: { parts: [{ text: 'kept' }] }, finishReason: 'STOP' }] },
        { candidates: [] },
      ]),
    );
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
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
