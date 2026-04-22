/**
 * Application-level retry for transient network failures around Gemini API calls.
 *
 * Why this exists (two-layer gap in the SDK):
 *
 * 1. `@google/genai` retries HTTP status errors (408/429/500/502/503/504) ONLY
 *    when the client is constructed with `httpOptions.retryOptions`. Without
 *    that option the SDK falls through to a naked `fetch()` with no retry.
 *    `createGeminiClient` enables `retryOptions`, which addresses the status-
 *    code path.
 *
 * 2. That SDK retry path delegates to `p-retry` 4.6.2. Its `isNetworkError`
 *    whitelist only matches browser-era error strings (`"Failed to fetch"`,
 *    `"NetworkError when attempting to fetch resource."`,
 *    `"The Internet connection appears to be offline."`,
 *    `"Network request failed"`). A `TypeError` whose message is outside that
 *    whitelist is routed to `operation.stop()` → reject, zero retries. Node 18+
 *    undici emits `TypeError: fetch failed` for every pre-response failure
 *    (TCP reset, DNS blip, TLS handshake timeout, connection abort); the
 *    string is NOT in the whitelist, so the SDK path cannot retry it even
 *    with `retryOptions` enabled.
 *
 * `withNetworkRetry` covers gap #2 by catching `TypeError: fetch failed` (and
 * common errno codes surfaced via `err.cause.code`) at the application layer
 * and retrying with exponential backoff. Non-transient errors (auth failures,
 * schema rejections, HTTP status errors — those already carry a numeric
 * `.status` handled by the SDK layer) propagate immediately so no retry budget
 * is spent on permanent failures.
 */

export interface NetworkRetryOptions {
  /** Total attempts including the initial try. Default 3. Clamped to [1, 10]. */
  readonly attempts?: number;
  /** Base delay in ms before the first retry. Growth factor is 3×. Default 1000. */
  readonly baseMs?: number;
  /** Called before each retry with the 1-indexed attempt number that just failed. */
  readonly onRetry?: (attempt: number, err: unknown) => void;
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

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === attempts) {
        throw err;
      }
      options.onRetry?.(attempt, err);
      const delayMs = baseMs * 3 ** (attempt - 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastErr;
}
