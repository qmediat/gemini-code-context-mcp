/**
 * Application-level retry for transient network failures around Gemini API calls.
 *
 * Why this exists:
 *
 * The SDK ships an optional retry wrapper that triggers ONLY when the client
 * is constructed with `httpOptions.retryOptions`. `createGeminiClient`
 * INTENTIONALLY omits that option — see `src/gemini/client.ts` for the
 * rationale (SDK retry replaces Gemini's informative `ApiError` body with
 * `"Non-retryable exception Bad Request sending request"`, which strips the
 * structured `INVALID_ARGUMENT` details callers and the integration smoke
 * test depend on). In the current configuration HTTP status errors therefore
 * surface verbatim from the SDK; 429 rate-limits are handled at the tool
 * layer via `isGemini429` + `parseRetryDelayMs` (`src/tools/shared/throttle.ts`);
 * other status codes propagate to the caller as-is.
 *
 * Even IF the SDK's retry path were enabled, it could not cover Node 18+
 * undici's `TypeError: fetch failed`. The SDK delegates to `p-retry` 4.6.2,
 * whose `isNetworkError` whitelist only matches browser-era strings
 * (`"Failed to fetch"`, `"NetworkError when attempting to fetch resource."`,
 * `"The Internet connection appears to be offline."`, `"Network request failed"`).
 * Any `TypeError` outside that whitelist — including undici's
 * `"fetch failed"` emitted for every pre-response failure (TCP reset, DNS
 * blip, TLS handshake timeout, connection abort) — is routed to
 * `operation.stop()` → reject with zero retries.
 *
 * `withNetworkRetry` catches `TypeError: fetch failed` (and common errno
 * codes surfaced via `err.cause.code`) at the application layer and retries
 * with exponential backoff. Non-transient errors (auth failures, schema
 * rejections, HTTP status errors — those carry a numeric `.status` that this
 * module deliberately treats as permanent so no retry budget is wasted and
 * no double-retry stacks with any future SDK-side retry we might opt into)
 * propagate immediately.
 */

export interface NetworkRetryOptions {
  /** Total attempts including the initial try. Default 3. Clamped to [1, 10]. */
  readonly attempts?: number;
  /** Base delay in ms before the first retry. Growth factor is 3×. Default 1000. */
  readonly baseMs?: number;
  /** Called before each retry with the 1-indexed attempt number that just failed. */
  readonly onRetry?: (attempt: number, err: unknown) => void;
  /**
   * Optional abort signal (T19, v1.6.0). When the signal fires:
   *   1. The currently-pending `fn()` is left to throw `AbortError` on its own
   *      (the SDK propagates `signal.aborted` through `config.abortSignal`).
   *   2. The retry loop short-circuits — no further attempts, no backoff sleep.
   *   3. The signal's reason (or a synthesised AbortError) is thrown.
   *
   * Pre-attempt check: if `signal.aborted` is set BEFORE the first try, we
   * throw immediately rather than dispatching a doomed call. Saves the cost
   * of the first abortive request.
   */
  readonly signal?: AbortSignal;
}

/**
 * Errno / message fragments surfaced by Node undici when the HTTP request fails
 * before a response is received. Matched case-insensitively against the error
 * message, its `cause.message`, and `cause.code`.
 */
const TRANSIENT_PATTERNS =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|socket hang up|network socket disconnected/i;

/**
 * Decide whether an error is worth retrying at the application layer.
 *
 * Returns `true` only for network-shaped failures that happened BEFORE a
 * response was received. Everything else — HTTP status errors (which carry a
 * numeric `.status`), AbortError, validation errors, assertion failures — is
 * treated as permanent so the caller fails fast.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // User-initiated abort — never retry.
  if (err.name === 'AbortError') return false;

  // HTTP status errors come from the SDK with a numeric `status`. They have
  // their own retry path inside the SDK (via `httpOptions.retryOptions`);
  // retrying them here would double-retry.
  if (typeof (err as { status?: unknown }).status === 'number') return false;

  const message = String(err.message ?? '');

  const cause: unknown = (err as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : '';
  const causeCode =
    cause !== null &&
    typeof cause === 'object' &&
    typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : '';

  return TRANSIENT_PATTERNS.test(`${message} ${causeMessage} ${causeCode}`);
}

/**
 * Run `fn`, retrying on transient network errors with exponential backoff.
 *
 * Delays follow `baseMs * 3^(attempt - 1)`: defaults to 1s, 3s, 9s. Non-
 * transient errors (per `isTransientNetworkError`) propagate on the first
 * failure — no backoff is spent on permanent failures.
 *
 * The final attempt's error is re-thrown as-is so callers observe the same
 * error shape they would have seen without retry wrapping.
 */
export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  options: NetworkRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(10, options.attempts ?? 3));
  const baseMs = Math.max(0, options.baseMs ?? 1000);
  const signal = options.signal;

  // Pre-flight abort check — never dispatch when the caller has already
  // signalled they don't want the work done.
  throwIfAborted(signal);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Abort short-circuits everything — the signal's reason wins over any
      // SDK error that happened to surface concurrently. (E.g. SDK throws
      // generic "fetch failed" because abort tore down the socket; we want
      // the timeout-driven AbortError, not the generic transient error.)
      // Checked TWICE: once before classifying the error (catches the common
      // case), once on the final-attempt throw (closes the narrow window
      // where abort flips between the first check and the terminal throw).
      if (signal?.aborted) {
        throwAbortReason(signal);
      }
      if (!isTransientNetworkError(err) || attempt === attempts) {
        if (signal?.aborted) throwAbortReason(signal);
        throw err;
      }
      options.onRetry?.(attempt, err);
      const delayMs = baseMs * 3 ** (attempt - 1);
      if (delayMs > 0) {
        await abortableSleep(delayMs, signal);
      }
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastErr;
}

/** Throws the signal's reason (or synthesised AbortError) if aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throwAbortReason(signal);
}

function throwAbortReason(signal: AbortSignal): never {
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('Operation aborted', 'AbortError');
}

/**
 * `setTimeout(resolve, ms)` that also rejects with the abort reason when
 * `signal` fires. Without abort awareness, a 9s backoff sleep — or worse, a
 * 60s TPM-throttle wait — would block T19's wall-clock cap. Exported so tool
 * call sites can reuse it for the throttle/reservation sleep without
 * duplicating the listener+timer dance.
 *
 * Race-safety:
 *   - Pre-flight check throws synchronously when signal is already aborted.
 *   - Listener uses `{ once: true }` → auto-removes on fire (no leak).
 *   - Timer-first path explicitly removes the listener before `resolve()` so
 *     a same-tick abort that would re-fire is impossible.
 *   - Abort-first path clears the timer before `reject()`.
 *   - Single-threaded JS means no read-resolve-then-write-reject window.
 */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      try {
        throwAbortReason(signal);
      } catch (err) {
        reject(err);
      }
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      try {
        if (signal) throwAbortReason(signal);
      } catch (err) {
        reject(err);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
