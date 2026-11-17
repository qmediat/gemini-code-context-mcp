/**
 * @google/genai client factory — builds a GoogleGenAI instance from the resolved auth profile.
 */

import { GoogleGenAI } from '@google/genai';
import type { AuthProfile } from '../types.js';

// NOTE: we intentionally do NOT pass `httpOptions.retryOptions` here. Enabling
// it makes `@google/genai` wrap the response in `p-retry`, which replaces the
// informative Gemini error body (`ApiError: {"error":{"code":400,...}}`) with
// a generic `"Non-retryable exception Bad Request sending request"` — stripping
// the `INVALID_ARGUMENT` details callers and tests rely on. The SDK's retry
// path also fails to cover Node undici's `TypeError: fetch failed` (p-retry
// 4.6.2's `isNetworkError` whitelist doesn't include that string), so the only
// class of failure it would catch is HTTP 5xx / 408 / 429. 429 is already
// handled at the tool layer by `isGemini429` + `parseRetryDelayMs` (see
// `src/tools/shared/throttle.ts`). Pre-response network failures are handled
// by `withNetworkRetry` in `src/gemini/retry.ts`.

/**
 * The Gemini Developer API version every request of an API-key client goes to. `@google/genai` defaults to the
 * stable `v1`, which has no `cachedContents` resource (an explicit Context Cache answers 404 there); `v1beta`
 * serves every surface this server calls — the Files API, `cachedContents`, `models`, `countTokens`,
 * `generateContent` and its stream. Set in the constructor, it also wins over `GOOGLE_GENAI_API_VERSION`.
 */
export const GEMINI_API_VERSION = 'v1beta';

export function createGeminiClient(profile: AuthProfile): GoogleGenAI {
  switch (profile.kind) {
    case 'api-key':
      return new GoogleGenAI({ apiKey: profile.apiKey, apiVersion: GEMINI_API_VERSION });
    case 'vertex':
      // Vertex path implicitly uses ADC (gcloud application-default credentials).
      // Set GEMINI_USE_VERTEX=true + GOOGLE_CLOUD_PROJECT to route through here.
      return new GoogleGenAI({
        vertexai: true,
        project: profile.project,
        location: profile.location,
      });
  }
}
