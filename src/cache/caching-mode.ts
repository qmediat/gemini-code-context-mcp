/**
 * The caching mode a call actually runs with — the one decision `ask` and `code`
 * share before `prepareContext`.
 */

import type { ResolvedModel } from '../types.js';
import { logger } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';

/** What `'explicit'` turns into when it cannot be honoured — appended to `ask` / `code`'s `cachingMode` description. */
export const CACHING_MODE_FALLBACK_DESCRIPTION =
  " A model without `createCachedContent` (`gemini-4-argon`) runs `'explicit'` as `'implicit'`, and a failed `caches.create` sends the files without a cache; either way the response says what ran in `cachingMode` and why in `cachingModeNote`.";

/** The caching mode a call runs with, and why it differs from the one requested. */
export interface CachingModeChoice {
  readonly mode: 'explicit' | 'implicit';
  /** Set when the requested mode could not be honoured; said to the caller and the log. */
  readonly note: string | null;
}

/**
 * The caching mode a call actually runs with. A model that does not accept
 * `caches.create` (no `createCachedContent` in its actions — `gemini-4-argon`)
 * runs an `explicit` request as `implicit`: the files go inline and Gemini's
 * implicit cache applies, with no upload and no create attempt that can only fail.
 */
export function cachingModeFor(
  requested: 'explicit' | 'implicit',
  model: ResolvedModel,
  emitter: ProgressEmitter,
): CachingModeChoice {
  if (requested !== 'explicit' || model.supportsCaching) return { mode: requested, note: null };
  const note = `cachingMode 'explicit' is not available for ${model.resolved} (no createCachedContent) — running implicit: files inline, Gemini's implicit cache applies.`;
  emitter.emit(note);
  logger.warn(note);
  return { mode: 'implicit', note };
}

/** The caching mode a call ran with, as telemetry and the response record it. */
export type RanCachingMode = 'explicit' | 'implicit' | 'inline';

/** What ran, and why it differs from what was asked when it does. */
export interface RanCaching {
  readonly mode: RanCachingMode;
  readonly note: string | null;
}

const CREATE_FAILED_NOTE =
  "cachingMode 'explicit': the Context Cache could not be created (caches.create failed) — the files went without a cache; Gemini's implicit cache applies.";

/**
 * The caching mode a prepared context actually ran with: a cache id means the
 * Context Cache served the call (`explicit`); inline-only means the files went
 * inline by choice (`implicit`) or by force (`inline`: no caching allowed, a
 * workspace under the cache floor); neither means `caches.create` failed and the
 * files went without a cache, which Gemini's implicit cache serves (`implicit`).
 */
export function cachingRan(
  prep: { readonly cacheId: string | null; readonly inlineOnly: boolean },
  choice: CachingModeChoice,
): RanCaching {
  if (prep.cacheId !== null) return { mode: 'explicit', note: choice.note };
  if (prep.inlineOnly) {
    return { mode: choice.mode === 'implicit' ? 'implicit' : 'inline', note: choice.note };
  }
  return { mode: 'implicit', note: CREATE_FAILED_NOTE };
}
