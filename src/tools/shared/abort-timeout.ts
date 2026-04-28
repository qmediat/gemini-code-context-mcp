/**
 * Per-call wall-clock timeout AND heartbeat-aware stall detector for tool
 * dispatch (T19 v1.6.0 + Phase 4 v1.12.0).
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
 * v1.6.0 introduced the wall-clock cap (`timeoutMs`). v1.12.0 adds a
 * complementary stall watchdog (`stallMs`) that resets on every chunk
 * (text or thought) and only fires when the stream goes silent. The two
 * mechanisms are independent and BOTH supported simultaneously:
 *
 *   - **`timeoutMs`** (wall-clock) — cost ceiling. A stuck Gemini server-side
 *     process still bills the user until it self-terminates; a hard cap
 *     bounds the worst-case spend per call.
 *   - **`stallMs`** (heartbeat-aware) — liveness watchdog. Kills truly dead
 *     sockets ~30× faster than the wall-clock alternative. Does NOT fire while
 *     the model is actively thinking (the streaming heartbeat resets it).
 *
 * Both timers feed into ONE unified `signal` — whichever fires first wins.
 * The composite abort reason carries `name === 'TimeoutError'` AND a `kind`
 * suffix on the message ("total wall-clock" vs "stall — no chunk for Xms")
 * so error reports can attribute the cause precisely.
 *
 * Resolution order (each timer independently):
 *   1. Per-call schema parameter (e.g. `ask({ timeoutMs, stallMs })`) — wins.
 *   2. Tool-specific env var (e.g. `GEMINI_CODE_CONTEXT_ASK_TIMEOUT_MS`,
 *      `GEMINI_CODE_CONTEXT_ASK_STALL_MS`).
 *   3. Default disabled (`0` / `undefined` / negative).
 *
 * When BOTH are disabled, the controller's signal NEVER fires — call sites
 * pass it unconditionally and `recordChunk()` is a no-op.
 */

const ABSOLUTE_MAX_MS = 1_800_000; // 30 min — conservative ceiling for total
const ABSOLUTE_MIN_MS = 1_000; // 1 s — anything shorter is a unit-conversion bug
const STALL_ABSOLUTE_MAX_MS = 600_000; // 10 min — a stall watchdog longer than this is just a slow total cap

export interface TimeoutController {
  /** Pass into SDK config or `withNetworkRetry({signal})`. */
  readonly signal: AbortSignal;
  /**
   * Cancel both pending timers (total + stall). Call in a `finally` block
   * to prevent the timer from holding the event loop open if the call
   * resolves before either deadline. Idempotent — safe to call multiple
   * times or on a never-firing controller.
   */
  dispose(): void;
  /**
   * Effective TOTAL wall-clock timeout in ms used by this controller.
   * `null` when total timeout was disabled. Useful for emitting accurate
   * progress messages ("ask: aborted after 60001ms — limit was 60000ms").
   */
  readonly timeoutMs: number | null;
  /**
   * Effective STALL timeout in ms used by this controller. `null` when
   * stall watchdog was disabled. Surfaced in error metadata so callers
   * can distinguish wall-clock vs stall aborts.
   */
  readonly stallMs: number | null;
  /**
   * Reset the stall timer. Call from the stream-consuming loop on every
   * yielded chunk (text OR thought — both prove the call is alive).
   * No-op when stall watchdog is disabled. Idempotent under high
   * frequency — clearing + re-arming a `setTimeout` is microseconds.
   *
   * Important: do NOT call from outside the stream loop (e.g. in retry
   * scaffolding) — the contract is "a chunk arrived" and conflating
   * that with "we're about to start a new request" would cause stalls
   * to be missed during the gap between request-open and first-chunk.
   */
  recordChunk(): void;
}

export interface CreateTimeoutControllerOpts {
  /** Per-call total wall-clock cap in ms. Wins over `totalEnvVar`. */
  totalMs?: number;
  /** Env var name for total wall-clock fallback. */
  totalEnvVar: string;
  /** Per-call stall watchdog in ms. Wins over `stallEnvVar`. */
  stallMs?: number;
  /** Env var name for stall watchdog fallback. */
  stallEnvVar: string;
}

function readEnvMs(envVarName: string): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw.length === 0) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Build a composite controller for a tool dispatch.
 *
 * The returned `signal` fires on EITHER (a) the wall-clock cap (`timeoutMs`)
 * being exceeded, OR (b) the stall watchdog (`stallMs`) firing because no
 * chunk arrived for that long. Whichever fires first wins; the abort
 * reason's message says which kind ("total wall-clock" / "stall — no chunk
 * for Xms"). Both reasons share `name === 'TimeoutError'` so
 * `isTimeoutAbort` returns true uniformly.
 *
 * Bounds:
 *   - `timeoutMs` (total): `[1_000, 1_800_000]` ms (1 s to 30 min).
 *   - `stallMs`: `[1_000, 600_000]` ms (1 s to 10 min).
 *   Out-of-range positive values are clamped silently.
 *
 * Single API: only the structured-options form is supported. The previous
 * v1.6.0–v1.11.0 2-arg signature was retired in v1.12.0 — all internal
 * callers (`ask`, `code`, `ask_agentic`) now pass options.
 */
export function createTimeoutController(opts: CreateTimeoutControllerOpts): TimeoutController {
  // Resolve total wall-clock cap.
  const totalRequested = opts.totalMs !== undefined ? opts.totalMs : readEnvMs(opts.totalEnvVar);
  const totalEffective =
    Number.isFinite(totalRequested) && totalRequested > 0
      ? Math.max(ABSOLUTE_MIN_MS, Math.min(ABSOLUTE_MAX_MS, Math.floor(totalRequested)))
      : 0;

  // Resolve stall watchdog.
  const stallRequested = opts.stallMs !== undefined ? opts.stallMs : readEnvMs(opts.stallEnvVar);
  const stallEffective =
    Number.isFinite(stallRequested) && stallRequested > 0
      ? Math.max(ABSOLUTE_MIN_MS, Math.min(STALL_ABSOLUTE_MAX_MS, Math.floor(stallRequested)))
      : 0;

  if (totalEffective === 0 && stallEffective === 0) {
    return disabledController();
  }

  const controller = new AbortController();
  let totalTimer: NodeJS.Timeout | null = null;
  let stallTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  if (totalEffective > 0) {
    totalTimer = setTimeout(() => {
      const reason = new DOMException(
        `Timed out after ${totalEffective} ms (total wall-clock)`,
        'TimeoutError',
      );
      // Embed the kind on the reason itself — message-string matching
      // (the v1.12.0-pre approach) is brittle to any future copy changes.
      Object.assign(reason, { timeoutKind: 'total' as const });
      controller.abort(reason);
      // Stall timer is now moot — clear it.
      if (stallTimer !== null) clearTimeout(stallTimer);
    }, totalEffective);
    totalTimer.unref?.();
  }

  // Stall watchdog (Phase 4, v1.12.0).
  //
  // The stall timer arms on the FIRST `recordChunk()` call (typically
  // when `collectStream` begins iterating chunks). It does NOT arm on
  // controller creation — counting the pre-stream phase (workspace scan,
  // countTokens preflight, Files API eager upload, TLS handshake to
  // generateContentStream) as "stall budget" is wrong: that latency is
  // local I/O and SDK setup, not Gemini-side stall. If the user wants
  // to bound that phase, they set `timeoutMs` (the wall-clock cost cap),
  // which DOES include pre-stream time.
  //
  // After the first chunk, the timer resets on every subsequent chunk
  // (text or thought — both prove the stream is alive). Gap > stallMs
  // → abort with kind="stall".
  //
  // Edge case: if the stream opens but never yields any chunk
  // (e.g. SDK fetch hangs after returning the response), `recordChunk`
  // is never called, the stall watchdog never arms, and only `timeoutMs`
  // can rescue. Documented limitation; users wanting that safety net
  // should set both `stallMs` and `timeoutMs`.
  const armStallTimer = (): NodeJS.Timeout => {
    const t = setTimeout(() => {
      const reason = new DOMException(
        `Timed out after ${stallEffective} ms (stall — no chunk received)`,
        'TimeoutError',
      );
      Object.assign(reason, { timeoutKind: 'stall' as const });
      controller.abort(reason);
      if (totalTimer !== null) clearTimeout(totalTimer);
    }, stallEffective);
    t.unref?.();
    return t;
  };

  if (stallEffective > 0) {
    return {
      signal: controller.signal,
      timeoutMs: totalEffective > 0 ? totalEffective : null,
      stallMs: stallEffective,
      dispose: () => {
        disposed = true;
        if (totalTimer !== null) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      },
      recordChunk: () => {
        // Defense-in-depth: refuse to re-arm after dispose() clears
        // timers, and don't re-arm a fired controller.
        if (disposed || controller.signal.aborted) return;
        if (stallTimer !== null) clearTimeout(stallTimer);
        stallTimer = armStallTimer();
      },
    };
  }

  // total-only path (no stall watchdog).
  return {
    signal: controller.signal,
    timeoutMs: totalEffective,
    stallMs: null,
    dispose: () => {
      disposed = true;
      if (totalTimer !== null) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
    },
    recordChunk: () => {
      /* stall disabled — no-op */
    },
  };
}

/**
 * A "no-op" controller — its signal never fires.
 *
 * Returned when both timers are disabled. Lets call sites pass the signal
 * into the SDK and `withNetworkRetry` unconditionally without a per-call
 * `if (signal)` branch. The SDK accepts a never-firing signal cleanly
 * (no perf cost). `recordChunk()` is a no-op.
 */
function disabledController(): TimeoutController {
  return {
    signal: new AbortController().signal, // never fires
    timeoutMs: null,
    stallMs: null,
    dispose: () => {
      /* nothing to dispose */
    },
    recordChunk: () => {
      /* nothing to record */
    },
  };
}

/**
 * Identify a timeout-driven abort vs a user-driven abort.
 *
 * `createTimeoutController` aborts with a `DOMException` whose `name` is
 * `'TimeoutError'` — both for total wall-clock and for stall. Callers use
 * this to map the error to a user-facing `errorCode: 'TIMEOUT'` rather
 * than the generic `'ABORTED'`. The TIMEOUT-vs-stall split is captured in
 * the abort reason's MESSAGE (and exposed via `getTimeoutKind` below) so
 * structured-content metadata can distinguish them.
 *
 * Walks the full `error.cause` chain rather than just one level — the
 * `@google/genai` SDK paths through Node `undici` can wrap errors more than
 * once (e.g. `Error('SDK error') → Error('fetch failed') → DOMException
 * TimeoutError`), and a single-level check would miss those. Cycle-safe via
 * `Set<Error>` tracker (real production traces have produced cyclical
 * `cause` chains via re-thrown wrappers).
 */
const MAX_CAUSE_DEPTH = 8;

export function isTimeoutAbort(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (current.name === 'TimeoutError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Distinguish a wall-clock-cap timeout from a stall-watchdog timeout.
 * Callers surface this in error structuredContent (`timeoutKind`) so
 * orchestrators can apply different policies (e.g. retry on stall but
 * not on total).
 *
 * Returns `'total'` | `'stall'` | `null` (last when the error isn't a
 * timeout, OR is a timeout from a different source).
 */
export type TimeoutKind = 'total' | 'stall';

export function getTimeoutKind(err: unknown): TimeoutKind | null {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return null;
    if (seen.has(current)) return null;
    seen.add(current);
    if (current.name === 'TimeoutError') {
      // Prefer the structured `timeoutKind` property on the abort reason
      // (set by `createTimeoutController` since v1.12.0). Property-based
      // dispatch is robust against future message-copy changes.
      const kind = (current as { timeoutKind?: unknown }).timeoutKind;
      if (kind === 'total' || kind === 'stall') return kind;
      // Fall back to message inspection ONLY for messages produced by
      // older v1.12.0-pre code paths (or third-party TimeoutErrors that
      // happen to use this exact wording). Anchored on the parenthetical
      // suffix `createTimeoutController` writes — narrow enough to avoid
      // collisions with arbitrary error text.
      if (current.message.endsWith('(stall — no chunk received)')) return 'stall';
      if (current.message.endsWith('(total wall-clock)')) return 'total';
      // Backward compat: pre-v1.12.0 messages didn't include the suffix
      // — treat as `'total'` (the only kind that existed then).
      return 'total';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
