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

/**
 * What a timeout message says of the aborted request's cost, the same in the three tools: the abort stops the client
 * only; the server books a request aborted after its stream opened at 0, and whether Google bills it is not measured.
 */
export const ABORTED_REQUEST_NOTE =
  'Note: the abort stops the client only. A request aborted after its stream opened is booked 0 here; whether Google bills it is not measured (docs/cost-model.md).';

const ABSOLUTE_MAX_MS = 1_800_000; // 30 min — conservative ceiling for total
const ABSOLUTE_MIN_MS = 1_000; // 1 s — anything shorter is a unit-conversion bug
/** 10 min — a stall watchdog longer than this is just a slow total cap; the longest `stallMs` a schema accepts. */
export const STALL_ABSOLUTE_MAX_MS = 600_000;

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
  /**
   * Stop the stall timer until the next `recordChunk()`. Called when one request of a long decode has streamed to its
   * end: the gap before the next request's first chunk (its opening, its prefill) is exempt like the first
   * request's, and the first chunk re-arms the watchdog. No-op when the stall watchdog is disabled.
   */
  pauseStall(): void;
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

/** `requested` clamped into `[ABSOLUTE_MIN_MS, maxMs]`, or `null` when it is not a positive finite number. */
function clampedMs(requested: number, maxMs: number): number | null {
  if (!Number.isFinite(requested) || requested <= 0) return null;
  return Math.max(ABSOLUTE_MIN_MS, Math.min(maxMs, Math.floor(requested)));
}

/**
 * The total wall-clock cap a controller built from `totalMs` / `totalEnvVar` keeps,
 * in ms, or `null` when it keeps none — the bound a budget reservation covers
 * before the controller exists.
 */
export function resolveTotalTimeoutMs(
  totalMs: number | undefined,
  totalEnvVar: string,
): number | null {
  return clampedMs(totalMs !== undefined ? totalMs : readEnvMs(totalEnvVar), ABSOLUTE_MAX_MS);
}

/** The stall watchdog a controller built from `stallMs` / `stallEnvVar` keeps, in ms, or `null` when it keeps none. */
export function resolveStallTimeoutMs(
  stallMs: number | undefined,
  stallEnvVar: string,
): number | null {
  return clampedMs(stallMs !== undefined ? stallMs : readEnvMs(stallEnvVar), STALL_ABSOLUTE_MAX_MS);
}

/**
 * The abort reason of a fired limit: a `TimeoutError` whose message names the kind ("total wall-clock" / "stall — no
 * chunk received") and whose `timeoutKind` property carries it, so `getTimeoutKind` never depends on the copy.
 * `extra` adds properties a caller reads besides the kind.
 */
export function timeoutReason(
  limitMs: number,
  kind: TimeoutKind,
  extra: Readonly<Record<string, unknown>> = {},
): DOMException {
  const suffix = kind === 'stall' ? '(stall — no chunk received)' : '(total wall-clock)';
  const reason = new DOMException(`Timed out after ${limitMs} ms ${suffix}`, 'TimeoutError');
  Object.assign(reason, { timeoutKind: kind, ...extra });
  return reason;
}

/** A timer that does not hold the event loop open. */
export function unrefTimer(ms: number, fire: () => void): NodeJS.Timeout {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return timer;
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
 */
export function createTimeoutController(opts: CreateTimeoutControllerOpts): TimeoutController {
  const totalMs = resolveTotalTimeoutMs(opts.totalMs, opts.totalEnvVar);
  const stallMs = resolveStallTimeoutMs(opts.stallMs, opts.stallEnvVar);
  if (totalMs === null && stallMs === null) return disabledController();
  return composedController(totalMs, stallMs);
}

/**
 * The controller of at least one limit. The total timer arms at creation. The stall timer arms at the FIRST
 * `recordChunk()`, not at creation: the pre-stream phase (workspace scan, countTokens preflight, Files API upload, the
 * TLS handshake of `generateContentStream`) is local I/O and SDK setup, not a Gemini-side stall — `timeoutMs` bounds
 * it. After the first chunk the timer resets on every chunk (text or thought); a gap longer than `stallMs` aborts with
 * kind `stall`. A stream that opens but never yields a chunk is bounded by `timeoutMs` only. Whichever timer fires
 * clears the other.
 */
function composedController(totalMs: number | null, stallMs: number | null): TimeoutController {
  const controller = new AbortController();
  let totalTimer: NodeJS.Timeout | null = null;
  let stallTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  const clearTimers = (): void => {
    if (totalTimer !== null) clearTimeout(totalTimer);
    if (stallTimer !== null) clearTimeout(stallTimer);
    totalTimer = null;
    stallTimer = null;
  };
  const fire = (limitMs: number, kind: TimeoutKind) => () => {
    controller.abort(timeoutReason(limitMs, kind));
    clearTimers();
  };
  if (totalMs !== null) totalTimer = unrefTimer(totalMs, fire(totalMs, 'total'));
  return {
    signal: controller.signal,
    timeoutMs: totalMs,
    stallMs,
    dispose: () => {
      disposed = true;
      clearTimers();
    },
    recordChunk: () => {
      // never re-armed after dispose() or after a limit fired
      if (stallMs === null || disposed || controller.signal.aborted) return;
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = unrefTimer(stallMs, fire(stallMs, 'stall'));
    },
    pauseStall: () => {
      if (stallTimer === null) return;
      clearTimeout(stallTimer);
      stallTimer = null;
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
    pauseStall: () => {
      /* nothing to pause */
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

/** A timed-out `ask` / `code` call as its result reports it. */
export interface TimedOutCall {
  /** The limit that fired: `stall`, or `total` for every other timeout. */
  readonly kind: TimeoutKind;
  /** That limit in ms, `null` when it was not configured. */
  readonly limitMs: number | null;
  /** The error message: what fired, the knob that raises it, and what the abort means for the cost. */
  readonly message: string;
}

/** What a timeout of an `ask` / `code` call reports: the limit that fired and the message naming its knob. */
export function timedOutCall(
  tool: 'ask' | 'code',
  err: unknown,
  controller: TimeoutController,
): TimedOutCall {
  const env = `GEMINI_CODE_CONTEXT_${tool.toUpperCase()}`;
  if (getTimeoutKind(err) === 'stall') {
    return {
      kind: 'stall',
      limitMs: controller.stallMs,
      message: `${tool} timed out — no chunk received for ${controller.stallMs ?? '?'}ms (stall watchdog). Increase \`stallMs\` per call or set \`${env}_STALL_MS\` higher; default disabled. Stall watchdog is heartbeat-aware — it does NOT fire while the model is streaming chunks. A fired stall is usually a dead socket or a server-side hang. ${ABORTED_REQUEST_NOTE}`,
    };
  }
  return {
    kind: 'total',
    limitMs: controller.timeoutMs,
    message: `${tool} timed out after ${controller.timeoutMs ?? '?'}ms (total wall-clock). Increase \`timeoutMs\` per call or set \`${env}_TIMEOUT_MS\` higher; default disabled. Consider \`stallMs\` instead — a heartbeat-aware watchdog that does NOT fire while the model is actively thinking. ${ABORTED_REQUEST_NOTE}`,
  };
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
