/**
 * The caching mode a call actually runs with — the one decision `ask` and `code`
 * share before `prepareContext`.
 */

import type { ResolvedModel } from '../types.js';
import { logger } from '../utils/logger.js';
import type { ProgressEmitter } from '../utils/progress.js';

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
