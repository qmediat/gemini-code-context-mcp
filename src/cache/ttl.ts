/**
 * The TTL a Gemini Context Cache lives for — the one value every TTL sent to Google and every expiry counted from a
 * TTL read: the create request and its stored expiry, the TTL watcher's `caches.update` and the expiry it stores when
 * the answer carries none. The operator's `cacheTtlSeconds` stays as written; only what reaches a cache is shaped here.
 */

/** Whole seconds, at least 60: the floor `docs/configuration.md` states for a cache TTL. */
export function effectiveTtlSeconds(requested: number): number {
  return Math.max(60, Math.floor(requested));
}
