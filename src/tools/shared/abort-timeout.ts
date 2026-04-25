/**
 * Per-call wall-clock timeout for tool dispatch (T19, v1.6.0).
 *
 * Why this exists:
 *
 * `withNetworkRetry` (`src/gemini/retry.ts`) only catches PRE-response transient
 * failures (TCP reset, DNS blip, TLS handshake timeout). Once the SDK has
 * accepted a response stream, a server that takes 10 minutes to think — or
 * one that hangs on cached-content recall — is observable to the caller as a
 * silent stall. The MCP host's own progress notifications keep the connection
 * alive, but there is no upper bound on total wall-clock time.
 *
 * `createTimeoutController` returns an `AbortController` whose signal fires
 * after `timeoutMs`. Wired into the SDK via `config.abortSignal` (verified
 * empirically against `node_modules/@google/genai/dist/genai.d.ts:1841`),
 * the abort fires at the client side — the request is dropped from the
 * subscription side. Per Google's SDK comment: *"AbortSignal is a client-only
 * operation. Using it to cancel an operation will not cancel the request in
 * the service. You will still be charged usage for any applicable operations."*
 *
 * Resolution order for `timeoutMs`:
 *   1. Per-call schema parameter (e.g. `ask({ timeoutMs: 60000 })`) — wins.
 *   2. Tool-specific env var (e.g. `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`).
 *   3. Default disabled (`0` / `undefined` / negative).
 *
 * When disabled, `createTimeoutController` returns a controller whose signal
 * never fires. Call sites pass the signal unconditionally — uniform plumbing,
 * no per-call branching on "is timeout enabled".
 */

const ABSOLUTE_MAX_MS = 1_800_000; // 30 min — conservative ceiling
const ABSOLUTE_MIN_MS = 1_000; // 1 s — anything shorter is almost certainly a unit-conversion bug

export interface TimeoutController {
  /** Pass into SDK config or `withNetworkRetry({signal})`. */
  readonly signal: AbortSignal;
  /**
   * Cancel the pending timer. Call in a `finally` block to prevent the timer
   * from holding the event loop open if the call resolves before the deadline.
   * Idempotent — safe to call multiple times or on a never-firing controller.
   */
  dispose(): void;
  /**
   * Effective timeout in ms used by this controller. `null` when timeout was
   * disabled (no env, no per-call, or 0). Useful for emitting accurate
   * progress messages ("ask: aborted after 60001ms — limit was 60000ms").
   */
  readonly timeoutMs: number | null;
}

/**
 * Build a controller for a tool dispatch.
 *
 * @param perCallMs — value from schema (`input.timeoutMs`). Wins when set.
 * @param envVarName — name of the tool-specific env var to consult as fallback.
 *   E.g. `'GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS'`. Empty/missing/non-numeric → ignored.
 *
 * Returns a controller. When effective timeout is `0` / negative / `undefined`,
 * the signal NEVER fires — call sites can wire it in unconditionally.
 *
 * Bounds: `[1_000, 1_800_000]` ms (1 s to 30 min). Out-of-range positive
 * values are clamped (silently) and the effective value is reported via
 * `controller.timeoutMs`. The 30-min ceiling matches the longest realistic
 * workflow we've observed (a `code` task with HIGH thinking on a 1M-token
 * cached workspace has finished within 4 min in measured benchmarks).
 */
export function createTimeoutController(
  perCallMs: number | undefined,
  envVarName: string,
): TimeoutController {
  const envRaw = process.env[envVarName];
  const envParsed = envRaw !== undefined && envRaw.length > 0 ? Number(envRaw) : Number.NaN;
  const envValid = Number.isFinite(envParsed) ? envParsed : 0;

  const requested = perCallMs !== undefined ? perCallMs : envValid;
  if (!Number.isFinite(requested) || requested <= 0) {
    return disabledController();
  }
  const effective = Math.max(ABSOLUTE_MIN_MS, Math.min(ABSOLUTE_MAX_MS, Math.floor(requested)));

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Timed out after ${effective} ms`, 'TimeoutError'));
  }, effective);
  // Don't pin the event loop just for this timer — if the process is otherwise
  // idle (no other work, no other handles), the timer can be GC'd. Real
  // dispatches will keep the loop alive on their own via the in-flight fetch.
  timer.unref?.();

  return {
    signal: controller.signal,
    timeoutMs: effective,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * A "no-op" controller — its signal never fires.
 *
 * Returned when timeout is disabled. Lets call sites pass the signal into the
 * SDK and `withNetworkRetry` unconditionally without a per-call `if (signal)`
 * branch. The SDK accepts a never-firing signal cleanly (no perf cost).
 */
function disabledController(): TimeoutController {
  return {
    signal: new AbortController().signal, // never fires
    timeoutMs: null,
    dispose: () => {
      /* nothing to dispose */
    },
  };
}

/**
 * Identify a timeout-driven abort vs a user-driven abort.
 *
 * `createTimeoutController` aborts with a `DOMException` whose `name` is
 * `'TimeoutError'`. Callers can use this to map the error to a user-facing
 * `errorCode: 'TIMEOUT'` rather than the generic `'ABORTED'`.
 */
export function isTimeoutAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError') return true;
  // Some SDK paths re-throw with `cause` set to the abort reason.
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.name === 'TimeoutError') return true;
  return false;
}
