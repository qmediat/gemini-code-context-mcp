/**
 * Test helpers for the v1.7.0 streaming refactor (T20).
 *
 * Production code now calls `client.models.generateContentStream(...)` which
 * returns `Promise<AsyncGenerator<GenerateContentResponse>>`. These helpers
 * wrap a synchronous mock response (or an array of chunks, or a thrown error)
 * into the same shape so tests can keep their assertion structure.
 */

import type { GenerateContentResponse } from '@google/genai';

/**
 * Wrap a single response object as a one-chunk stream — the most common
 * case in unit tests where the test only cares about the final accumulated
 * shape, not chunk-by-chunk delivery.
 */
export function singleChunkStream(
  response: Partial<GenerateContentResponse>,
): () => Promise<AsyncGenerator<GenerateContentResponse>> {
  return async () => {
    async function* gen(): AsyncGenerator<GenerateContentResponse> {
      yield response as GenerateContentResponse;
    }
    return gen();
  };
}

/**
 * Wrap a sequence of chunks as a multi-chunk stream — for tests that need
 * to verify chunk-handling semantics (text concat, last-write-wins on
 * usageMetadata, etc.).
 */
export function chunkedStream(
  chunks: Array<Partial<GenerateContentResponse>>,
): () => Promise<AsyncGenerator<GenerateContentResponse>> {
  return async () => {
    async function* gen(): AsyncGenerator<GenerateContentResponse> {
      for (const chunk of chunks) yield chunk as GenerateContentResponse;
    }
    return gen();
  };
}

/**
 * Wrap an error that fires AFTER the generator starts yielding — for tests
 * that need to simulate a mid-stream failure (network drop after some chunks
 * arrived). Yields `chunksBeforeFailure`, then throws on the next iteration.
 */
export function midStreamFailure(
  chunksBeforeFailure: Array<Partial<GenerateContentResponse>>,
  err: unknown,
): () => Promise<AsyncGenerator<GenerateContentResponse>> {
  return async () => {
    async function* gen(): AsyncGenerator<GenerateContentResponse> {
      for (const chunk of chunksBeforeFailure) yield chunk as GenerateContentResponse;
      throw err;
    }
    return gen();
  };
}

/**
 * The stream twin of a `generateContent` mock: each call forwards its params to the mock and yields what it resolves
 * to as one chunk (or rejects as it rejects), so the mock's call records and its mockResolvedValue /
 * mockRejectedValue chains keep working for code that streams. Give it to `vi.fn(...)` or `.mockImplementation(...)`.
 */
export function forwardingStream(
  generateContent: (params: unknown) => Promise<unknown>,
): (params: unknown) => Promise<AsyncGenerator<GenerateContentResponse>> {
  return async (params) =>
    singleChunkStream((await generateContent(params)) as Partial<GenerateContentResponse>)();
}

/** A one-chunk stream that answers "ok" with a small usage record: the suites that only need a successful call. */
export const okStream = singleChunkStream({
  text: 'ok',
  candidates: [],
  usageMetadata: {
    promptTokenCount: 1_000,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 0,
  },
});
