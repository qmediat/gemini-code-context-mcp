/**
 * Client-side TPM (tokens-per-minute) throttle for Gemini API calls.
 *
 * Google enforces a per-minute input-token quota on paid Tier 1 Gemini 3 Pro
 * at 100_000 tokens/minute/model/project (per AI Studio dashboard, subject
 * to change). Without a client-side preflight we discover the limit only
 * when Gemini returns 429 `RESOURCE_EXHAUSTED` — by which point the call
 * is already billed (per `@google/genai@1.50.x` genai.d.ts: "AbortSignal
 * is a client-only operation … you will still be charged").
 *
 * The module keeps an in-memory sliding 60-second window of recent input-
 * token usage per resolved model. The primary API is a three-method
 * reservation lifecycle — `reserve` / `release` / `cancel` — because a
 * read-only "peek" API (the obvious design) has a TOCTOU race: between
 * `peek()` → `await sleep()` → `await generateContent()` → `record()`, a
 * concurrent MCP tool call observes the same pre-peek window and both
 * callers proceed, collectively overshooting the quota.
 *
 * `reserve` solves the race by inserting a provisional `WindowEntry` with
 * the caller's ESTIMATE at the moment the reservation is taken (plus the
 * computed delay) — so subsequent concurrent `reserve` calls see the
 * provisional entry and back off. When the call completes, `release`
 * overwrites the estimate with actual token usage; on failure, `cancel`
 * removes the provisional entry so it doesn't keep blocking future calls.
 *
 * Multi-entry eviction math: when the window is over-limit, we find the
 * smallest index `k` such that evicting `entries[0..k]` drops the remaining
 * sum enough to admit the new estimate. Waiting for JUST the oldest entry
 * to expire (the naïve design this module replaced) under-delays whenever
 * two or more large entries are still inside the window after that oldest
 * one ages out.
 *
 * Sorted-array invariant: `entries[model]` is always kept sorted ascending
 * by `tsMs`. `reserve` uses binary-search insertion (not `push`) because
 * future-dated provisionals (hint-driven or window-eviction-driven delay)
 * can produce tsMs values that are out-of-order relative to a subsequent
 * `delayMs = 0` reservation. Without sorted-insert, `prune`'s head-only
 * fast-path silently skips expired entries buried mid-array, causing
 * over-throttle; and `computeWindowDelay`'s oldest-first eviction picks
 * the wrong `entries[k].tsMs` to wait for. Empirically demonstrated during
 * PR #19 code review (Copilot + Grok + Gemini independently flagged).
 *
 * Retry-hint extend-only: `recordRetryHint` keeps the LONGER of existing
 * and new expiry. Allowing a shorter hint to replace a longer one would
 * let a future reserve compute a smaller `tsMs` than an entry previously
 * appended under the longer hint — same ordering break as above via a
 * different trigger path.
 *
 * Deliberate non-goals (tracked in docs/FOLLOW-UP-PRS.md T22 follow-ups):
 *  - Cross-process coordination. State is per-server-process, not shared
 *    across multiple MCP instances keyed on the same API key.
 *  - Persistence across restarts. The window is rebuilt from zero each
 *    server boot; a rapid restart during heavy usage can briefly exceed
 *    the limit until the window saturates again. Acceptable: startup is
 *    rare and the first 429 would re-teach us via `recordRetryHint`.
 *  - Server-side cancellation of in-flight Gemini calls. The throttle is
 *    preflight-only; it never aborts a `generateContent` in progress.
 */

const WINDOW_MS = 60_000;

/**
 * Randomised jitter padded onto computed wait times so a cluster of
 * concurrent waiters evicting the same entry don't all compute the
 * identical wait and wake at the same millisecond — which would re-create
 * the burst they were trying to avoid. Range picked for a human-noticeable
 * spread (≥1 s) without inflating typical waits excessively (≤3 s).
 *
 * `computeJitterMs` is a function (not a constant) because `Math.random()`
 * MUST be evaluated per-caller — a module-scope `const` would be
 * deterministic, which is exactly the thundering-herd bug Gemini flagged
 * during PR #19 review.
 */
const JITTER_MIN_MS = 1_000;
const JITTER_MAX_MS = 3_000;
function computeJitterMs(): number {
  return JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
}

interface WindowEntry {
  readonly id: number;
  /** Effective timestamp — when the tokens actually hit Gemini's quota counter.
   * For provisional reservations with delayMs > 0 this is `nowMs + delayMs`
   * (the time the caller will wake from sleep and issue the request); for
   * zero-delay reservations this is `nowMs`. The window's 60s eviction
   * horizon is measured against THIS value, not the reservation time. */
  readonly tsMs: number;
  /** Current best estimate of the tokens this reservation will spend. The
   * value mutates: `reserve` seeds it with the caller's estimate, `release`
   * replaces it with `promptTokenCount` from Gemini's response (can be
   * higher or lower than the estimate). */
  tokens: number;
}

interface RetryHint {
  readonly expiresAtMs: number;
  readonly retryDelayMs: number;
}

export interface TpmReservation {
  /** Milliseconds the caller must sleep before issuing the `generateContent`
   * call. `0` means proceed immediately. */
  readonly delayMs: number;
  /** Opaque handle for `release` / `cancel`. Forget it and the provisional
   * entry ages out of the window at `reservedAt + 60s` without updating
   * to actuals — safe (errs on over-throttle) but leaves the estimate in
   * the window longer than needed. */
  readonly releaseId: number;
}

export interface TpmThrottle {
  /**
   * Reserve capacity for a planned `generateContent` call. Always returns
   * a reservation — even when the throttle is disabled or the estimate
   * exceeds the cap (in which case `delayMs === 0` and the provisional
   * entry is still inserted so concurrent callers see our footprint).
   *
   * The reservation is provisional at `reserve` time: its token count is
   * the caller's estimate. Always pair with exactly ONE of:
   *   - `release(id, actual)` on a successful Gemini response, or
   *   - `cancel(id)` on any failure BEFORE the call reached Gemini.
   *
   * Forgetting both is not a correctness bug — the provisional entry ages
   * out naturally — but it leaves the estimate in the window for up to
   * 60 seconds, potentially over-throttling future calls.
   */
  reserve(model: string, estimatedInputTokens: number, nowMs?: number): TpmReservation;

  /**
   * Finalise a reservation with the actual input tokens Gemini reports
   * (pass the full `promptTokenCount`, cached + uncached — both count
   * toward Gemini's per-minute budget, empirically confirmed 2026-04-20).
   * No-op if `releaseId` is unknown (already released, or throttle reset).
   */
  release(releaseId: number, actualInputTokens: number, nowMs?: number): void;

  /**
   * Drop a reservation's provisional entry. Call on any failure that did
   * not reach Gemini's billing path (validation error before dispatch,
   * network error, local exception). No-op if `releaseId` is unknown.
   */
  cancel(releaseId: number): void;

  /**
   * Peek the delay the next call would receive WITHOUT inserting a new
   * `WindowEntry`. Exposed for diagnostics, tests, and progress-message
   * rendering — NOT as the primary throttle API, because it has the
   * TOCTOU race this module was written to eliminate.
   *
   * Not strictly side-effect-free: this call opportunistically `prune`s
   * expired entries and advances the `lastObservedNowMs` floor. Both are
   * normalisation, not state *changes* to the throttle's contract — the
   * window's token accounting is unchanged by any number of peeks.
   */
  shouldDelay(model: string, estimatedInputTokens: number, nowMs?: number): number;

  /**
   * Store a `retryInfo.retryDelay` hint extracted from a Gemini 429
   * response. Google's hint is typically more accurate than our clock
   * (we've seen 2–16s hints where our pure-window calculation returned
   * 40+ seconds), so we use `max(computed, hint)` in `reserve` while
   * the hint is active. Auto-expires at `now + retryDelayMs`.
   */
  recordRetryHint(model: string, retryDelayMs: number, nowMs?: number): void;
}

export function createTpmThrottle(limitTokensPerMinute: number): TpmThrottle {
  if (!Number.isFinite(limitTokensPerMinute) || limitTokensPerMinute < 0) {
    throw new Error(
      `createTpmThrottle: limit must be a non-negative finite number, got ${limitTokensPerMinute}`,
    );
  }

  const disabled = limitTokensPerMinute === 0;

  const windows = new Map<string, WindowEntry[]>();
  const hints = new Map<string, RetryHint>();
  const reservationIndex = new Map<
    number,
    { readonly model: string; readonly entry: WindowEntry }
  >();
  let nextReservationId = 1;
  /**
   * Highest `nowMs` ever observed from a public-method call. Used to clamp
   * backwards-jumping clocks (NTP correction, VM suspend/resume) — when
   * the caller supplies a `nowMs` smaller than what we already know to have
   * happened, we pin to our floor. Tracked separately from `entry.tsMs`
   * because entries can be FUTURE-dated (a provisional reservation with
   * `delayMs > 0` inserts at `now + delayMs`), and using those to clamp
   * would pin "now" past the current real-time into scheduled-call time —
   * which breaks multi-entry eviction math by making all past entries look
   * like they've already aged out.
   */
  let lastObservedNowMs = Number.NEGATIVE_INFINITY;

  function effectiveNow(nowMs: number): number {
    // Guard against non-finite caller input (NaN, ±Infinity). Consistent with
    // `sanitizeTokens`' "coerce rather than crash/deadlock" philosophy:
    // passing `Number.NEGATIVE_INFINITY` would otherwise poison
    // `lastObservedNowMs` and cause every subsequent call to compute
    // delays of +Infinity. Fall back to `Date.now()` — the same value
    // the public-API defaults use when `nowMs` is omitted.
    const candidate = Number.isFinite(nowMs) ? nowMs : Date.now();
    const clamped = candidate > lastObservedNowMs ? candidate : lastObservedNowMs;
    lastObservedNowMs = clamped;
    return clamped;
  }

  function prune(model: string, nowMs: number): WindowEntry[] {
    const existing = windows.get(model);
    if (!existing || existing.length === 0) return [];
    const cutoff = nowMs - WINDOW_MS;
    // Fast path: nothing expired → return the array as-is without allocating.
    // Entries are append-sorted by tsMs (chronological), so the head is oldest.
    const first = existing[0];
    if (first && first.tsMs > cutoff) return existing;

    const kept: WindowEntry[] = [];
    for (const e of existing) {
      if (e.tsMs > cutoff) {
        kept.push(e);
      } else {
        // Drop expired reservations from the ID index too — otherwise a late
        // release/cancel would silently resurrect or mutate a stale entry.
        reservationIndex.delete(e.id);
      }
    }
    if (kept.length === 0) {
      windows.delete(model);
      return [];
    }
    windows.set(model, kept);
    return kept;
  }

  function activeHint(model: string, nowMs: number): RetryHint | null {
    const hint = hints.get(model);
    if (!hint) return null;
    if (hint.expiresAtMs <= nowMs) {
      hints.delete(model);
      return null;
    }
    return hint;
  }

  /**
   * Compute the delay needed before a call estimated at `estimate` tokens
   * can fit under `limitTokensPerMinute`, given the current `entries`.
   *
   * Returns `0` when the call fits immediately. Returns `0` when `estimate`
   * alone exceeds the limit — sleeping forever would deadlock the tool;
   * Gemini will either accept (actual < estimate) or 429, at which point
   * `recordRetryHint` seeds the hint path.
   *
   * Otherwise: find the smallest `k` such that evicting `entries[0..k]`
   * leaves `sum(entries[k+1..]) + estimate <= limit`, and wait just long
   * enough for `entries[k]` to age out of the 60s window.
   */
  function computeWindowDelay(entries: WindowEntry[], estimate: number, nowMs: number): number {
    let sum = 0;
    for (const e of entries) sum += e.tokens;

    if (sum + estimate <= limitTokensPerMinute) return 0;
    if (estimate >= limitTokensPerMinute) return 0;

    // Iterate oldest-first, evict one entry at a time, stop when remaining
    // tail + estimate fits. Since entries are chronological (tsMs ascending),
    // evicting `entries[k]` also evicts everything older (they're already
    // past their 60s age when `entries[k]` is).
    let remaining = sum;
    for (let k = 0; k < entries.length; k++) {
      const e = entries[k];
      if (!e) break; // TS narrowing, unreachable given loop bound
      remaining -= e.tokens;
      if (remaining + estimate <= limitTokensPerMinute) {
        const wait = e.tsMs + WINDOW_MS - nowMs;
        return Math.max(0, wait) + computeJitterMs();
      }
    }
    // Unreachable in practice: `estimate < limit` (checked above) means
    // evicting ALL entries (remaining=0) always fits. Return 0 defensively.
    return 0;
  }

  return {
    reserve(model, estimatedInputTokens, nowMs = Date.now()) {
      if (disabled) {
        // Return a no-op reservation that cancel/release will accept. We
        // don't index it — lookups short-circuit on the disabled path.
        return { delayMs: 0, releaseId: -1 };
      }
      const now = effectiveNow(nowMs);
      const estimate = sanitizeTokens(estimatedInputTokens);

      const entries = prune(model, now);
      let delayMs = computeWindowDelay(entries, estimate, now);
      const hint = activeHint(model, now);
      if (hint) {
        const hintDelayMs = Math.max(0, hint.expiresAtMs - now);
        if (hintDelayMs > delayMs) delayMs = hintDelayMs;
      }

      const id = nextReservationId++;
      const entry: WindowEntry = {
        id,
        tsMs: now + delayMs,
        tokens: estimate,
      };
      // Sorted-insert by tsMs ascending. Append-order is NOT a reliable
      // proxy for chronological tsMs order — a `delayMs = 0` reservation
      // arriving after a future-dated provisional (hint-driven or
      // eviction-driven delay) has a smaller tsMs than the provisional's.
      // Without sorted-insert the head-only fast-path in `prune` silently
      // skips expired entries buried mid-array and `computeWindowDelay`'s
      // oldest-first eviction picks the wrong entry to wait for.
      insertSortedByTsMs(entries, entry);
      windows.set(model, entries);
      reservationIndex.set(id, { model, entry });
      return { delayMs, releaseId: id };
    },

    release(releaseId, actualInputTokens, nowMs = Date.now()) {
      if (disabled || releaseId < 0) return;
      const ref = reservationIndex.get(releaseId);
      if (!ref) return;
      const actual = sanitizeTokens(actualInputTokens);
      // Mutate the entry in place so the window sum reflects reality for
      // future `reserve` callers. Leave tsMs unchanged: the call happened
      // at the reservation's effective time regardless of how long the
      // response took to arrive.
      ref.entry.tokens = actual;
      // Delete from the index AFTER mutating so a duplicate `release` or a
      // late `cancel` on the same id becomes a safe no-op — without this,
      // `cancel(alreadyReleasedId)` would remove the already-accounted
      // entry from the window and under-throttle subsequent callers. The
      // entry itself remains in `windows[model]` to count against the
      // running window until it ages out naturally.
      reservationIndex.delete(releaseId);
      // Opportunistically prune while we have a nowMs — amortises cleanup
      // cost across release calls and avoids relying solely on future
      // `reserve` calls for the same model.
      prune(ref.model, effectiveNow(nowMs));
    },

    cancel(releaseId) {
      if (disabled || releaseId < 0) return;
      const ref = reservationIndex.get(releaseId);
      if (!ref) return;
      reservationIndex.delete(releaseId);
      const existing = windows.get(ref.model);
      if (!existing) return;
      const filtered = existing.filter((e) => e.id !== releaseId);
      if (filtered.length === 0) windows.delete(ref.model);
      else windows.set(ref.model, filtered);
    },

    shouldDelay(model, estimatedInputTokens, nowMs = Date.now()) {
      if (disabled) return 0;
      const now = effectiveNow(nowMs);
      const estimate = sanitizeTokens(estimatedInputTokens);
      const entries = prune(model, now);
      const windowDelay = computeWindowDelay(entries, estimate, now);
      const hint = activeHint(model, now);
      const hintDelay = hint ? Math.max(0, hint.expiresAtMs - now) : 0;
      return Math.max(windowDelay, hintDelay);
    },

    recordRetryHint(model, retryDelayMs, nowMs = Date.now()) {
      if (disabled) return;
      if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) return;
      const now = effectiveNow(nowMs);
      const newExpiresAtMs = now + retryDelayMs;
      // Extend-only: a shorter hint replacing a longer one would produce
      // a `reserve` that computes a smaller `tsMs` than entries already
      // appended under the longer hint, breaking the sorted-array
      // invariant. Keep the longer expiry when both exist — even if the
      // new hint's `retryDelayMs` is smaller numerically, the wall-clock
      // expiry monotonically increases.
      const existing = hints.get(model);
      if (existing && existing.expiresAtMs >= newExpiresAtMs) return;
      hints.set(model, { expiresAtMs: newExpiresAtMs, retryDelayMs });
    },
  };
}

/** Coerce non-finite / negative token values to 0 so callers with bad
 * instrumentation data can't crash the throttle. A 0-token reservation
 * still takes an ID (for lifecycle symmetry) but contributes nothing. */
function sanitizeTokens(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * Insert `entry` into `entries` at the position that keeps the array
 * sorted ascending by `tsMs`. Binary-search for the insertion point;
 * `splice` to insert. O(log n) compares + O(n) shift, same asymptotic
 * cost as `push + sort` but with a smaller constant factor on the
 * append-to-end fast path (the common case when clocks and delays are
 * monotonic).
 */
function insertSortedByTsMs(entries: WindowEntry[], entry: WindowEntry): void {
  // Common case: new entry is latest. Skip the binary search.
  const last = entries[entries.length - 1];
  if (!last || entry.tsMs >= last.tsMs) {
    entries.push(entry);
    return;
  }
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const probe = entries[mid];
    // `probe` is defined because `mid < hi <= entries.length`.
    if (probe && probe.tsMs <= entry.tsMs) lo = mid + 1;
    else hi = mid;
  }
  entries.splice(lo, 0, entry);
}
