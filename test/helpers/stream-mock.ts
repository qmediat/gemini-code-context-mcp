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
 * Wrap a thrown error as a stream that rejects when opened (i.e. the
 * Promise<AsyncGenerator> rejects, NOT the generator itself). Use this to
 * simulate pre-response failures (DNS blip, 429, stale-cache 404).
 */
export function rejectingStream(
  err: unknown,
): () => Promise<AsyncGenerator<GenerateContentResponse>> {
  return async () => {
    throw err;
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
