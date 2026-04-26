/**
 * Hard end-to-end test of v1.7.0 streaming + D#7 against the real Gemini API.
 *
 * Triggered by user request "przetestuj to samodzielnie, do $10". Each test
 * reports its cost and the suite aborts if cumulative cost exceeds the cap.
 *
 * Skips if no creds. Run with:
 *   GEMINI_CREDENTIALS_PROFILE=default npx vitest run test/integration/v1.7.0-streaming-srogi.test.ts --reporter=verbose
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAuth } from '../../src/auth/profile-loader.js';
import { TtlWatcher } from '../../src/cache/ttl-watcher.js';
import { createGeminiClient } from '../../src/gemini/client.js';
import { ManifestDb } from '../../src/manifest/db.js';
import { askTool } from '../../src/tools/ask.tool.js';
import { codeTool } from '../../src/tools/code.tool.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { createTpmThrottle } from '../../src/tools/shared/throttle.js';
import { statusTool } from '../../src/tools/status.tool.js';

// --- Cost cap enforcement -----------------------------------------------------

const HARD_BUDGET_USD = 10.0;
let cumulativeCost = 0;

function recordCost(label: string, cost: number): void {
  cumulativeCost += cost;
  // eslint-disable-next-line no-console
  console.log(
    `[cost] ${label}: $${cost.toFixed(4)} | cumulative: $${cumulativeCost.toFixed(4)} / $${HARD_BUDGET_USD.toFixed(2)}`,
  );
  if (cumulativeCost > HARD_BUDGET_USD) {
    throw new Error(
      `Hard budget cap $${HARD_BUDGET_USD} exceeded after ${label} ($${cumulativeCost.toFixed(4)}). Aborting suite.`,
    );
  }
}

// --- Decide whether to run (creds + opt-in env) -------------------------------

let auth: ReturnType<typeof resolveAuth> | null = null;
try {
  auth = resolveAuth();
} catch {
  // No creds → skip the suite. tryResolveAuth doesn't return null on missing,
  // it throws an actionable message — caught here so the test can skip cleanly.
  auth = null;
}
const explicitlyEnabled = process.env.RUN_SROGI_TEST === 'true';
const suite = auth && explicitlyEnabled ? describe : describe.skip;

// --- ToolContext factory ------------------------------------------------------

let tmpStateDir: string;
let workspaceRoot: string;
let manifest: ManifestDb;
let ttlWatcher: TtlWatcher;

function buildCtx(): ToolContext {
  if (!auth) throw new Error('auth missing');
  const client = createGeminiClient(auth.profile);
  ttlWatcher = new TtlWatcher(client, manifest);
  return {
    server: {
      // The MCP SDK Server exposes `.notification()` (not sendNotification);
      // see src/utils/progress.ts:42. Stub returns a resolved promise.
      notification: async () => undefined,
    } as unknown as ToolContext['server'],
    config: {
      auth,
      defaultModel: 'latest-pro-thinking',
      // Generous cap; the script enforces its own $10 cumulative cap above.
      dailyBudgetUsd: 50,
      maxFilesPerWorkspace: 200,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3600,
      // Match prod default. Fixture size is calibrated to clear Gemini's
      // server-side 1024-token hard floor for cache builds.
      cacheMinTokens: 1024,
      tpmThrottleLimit: 80_000,
      forceMaxOutputTokens: false,
      workspaceGuardRatio: 0.9,
    } as ToolContext['config'],
    client,
    manifest,
    ttlWatcher,
    progressToken: 'srogi-test-token',
    throttle: createTpmThrottle(80_000),
  };
}

// --- Fixture workspace --------------------------------------------------------

beforeAll(() => {
  tmpStateDir = mkdtempSync(join(tmpdir(), 'srogi-state-'));
  manifest = new ManifestDb(join(tmpStateDir, 'manifest.db'));

  // Build a small but real workspace — 5 TS files with realistic content.
  // package.json is the workspace marker for the validateWorkspacePath guard.
  workspaceRoot = mkdtempSync(join(tmpdir(), 'srogi-wks-'));
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: 'srogi-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'auth.ts'),
    `export interface AuthProfile { kind: 'api-key' | 'vertex'; apiKey?: string; project?: string; }
export function resolveAuth(): AuthProfile {
  if (process.env.GEMINI_USE_VERTEX === 'true') {
    return { kind: 'vertex', project: process.env.GOOGLE_CLOUD_PROJECT! };
  }
  return { kind: 'api-key', apiKey: process.env.GEMINI_API_KEY! };
}`,
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'cache.ts'),
    `import type { AuthProfile } from './auth.js';
export class CacheManager {
  constructor(private auth: AuthProfile) {}
  async build(workspaceRoot: string): Promise<{ cacheId: string; ttlSec: number }> {
    return { cacheId: \`cache-\${Date.now()}\`, ttlSec: 3600 };
  }
  async invalidate(cacheId: string): Promise<void> { /* no-op */ }
}`,
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'retry.ts'),
    `export interface RetryOptions { attempts?: number; baseMs?: number; signal?: AbortSignal; }
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.min(10, opts.attempts ?? 3);
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i === attempts) throw e; }
  }
  throw last;
}`,
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'streaming.ts'),
    `export async function* yieldChunks<T>(items: T[], delayMs: number): AsyncGenerator<T> {
  for (const item of items) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}`,
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'index.ts'),
    `export { resolveAuth } from './auth.js';
export { CacheManager } from './cache.js';
export { withRetry } from './retry.js';
export { yieldChunks } from './streaming.js';`,
  );
  // Calibrated bulk content to push the workspace over Gemini's 1024-token
  // server-side cache floor. ~5 KB of realistic code-shaped text → ~1300+
  // tokens. Without this the cache build would 400 with "Cached content is
  // too small" and we'd fall through to inline — defeating the cache-hit
  // test below.
  writeFileSync(
    join(workspaceRoot, 'src', 'types.ts'),
    `// Domain types for the srogi-test fixture. Mirrors a realistic backend.
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme: 'light' | 'dark' | 'auto';
  language: string;
  timezone: string;
  notifications: NotificationPreferences;
}

export interface NotificationPreferences {
  email: boolean;
  push: boolean;
  sms: boolean;
  digest: 'instant' | 'daily' | 'weekly' | 'never';
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  ipAddress: string;
  userAgent: string;
  revoked: boolean;
}

export interface AuditLog {
  id: string;
  userId: string;
  action: AuditAction;
  resource: string;
  metadata: Record<string, unknown>;
  occurredAt: number;
}

export type AuditAction =
  | 'login'
  | 'logout'
  | 'password_change'
  | 'email_change'
  | 'profile_update'
  | 'session_revoke'
  | 'export_data'
  | 'delete_account';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  cause?: Error;
}

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'RESOURCE_EXHAUSTED'
  | 'FAILED_PRECONDITION'
  | 'INTERNAL'
  | 'UNAVAILABLE';

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  totalCount?: number;
}
`,
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'errors.ts'),
    `import type { ApiErrorCode } from './types.js';

/**
 * Domain-specific error class hierarchy. Each subclass carries an
 * \`ApiErrorCode\` discriminator that gateway layers translate into
 * HTTP status codes.
 */
export class DomainError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (details) this.details = details;
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message);
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(action: string, resource: string) {
    super('PERMISSION_DENIED', \`Forbidden: \${action} on \${resource}\`, { action, resource });
  }
}

export class InvalidArgumentError extends DomainError {
  constructor(field: string, reason: string) {
    super('INVALID_ARGUMENT', \`Invalid \${field}: \${reason}\`, { field, reason });
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', \`\${resource} not found: \${id}\`, { resource, id });
  }
}

export class AlreadyExistsError extends DomainError {
  constructor(resource: string, identifier: string) {
    super('ALREADY_EXISTS', \`\${resource} already exists: \${identifier}\`, { resource, identifier });
  }
}

export class RateLimitError extends DomainError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('RESOURCE_EXHAUSTED', \`Rate limit exceeded; retry after \${retryAfterMs}ms\`, {
      retryAfterMs,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export class FailedPreconditionError extends DomainError {
  constructor(condition: string, current: string) {
    super('FAILED_PRECONDITION', \`Precondition failed: \${condition}; current state \${current}\`, {
      condition,
      currentState: current,
    });
  }
}

export class InternalError extends DomainError {
  constructor(message: string, cause?: Error) {
    super('INTERNAL', message);
    if (cause) this.cause = cause;
  }
}

export class UnavailableError extends DomainError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super('UNAVAILABLE', message);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof UnavailableError) return true;
  return false;
}

export function toApiError(err: unknown): { code: ApiErrorCode; message: string } {
  if (err instanceof DomainError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
}
`,
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'storage.ts'),
    `import type { User, Session, AuditLog, PaginatedResult } from './types.js';

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  list(opts: { cursor?: string; limit?: number }): Promise<PaginatedResult<User>>;
  create(input: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User>;
  update(id: string, patch: Partial<User>): Promise<User>;
  delete(id: string): Promise<void>;
}

export interface SessionRepository {
  findByToken(token: string): Promise<Session | null>;
  listForUser(userId: string): Promise<Session[]>;
  create(session: Omit<Session, 'createdAt'>): Promise<Session>;
  revoke(token: string): Promise<void>;
  pruneExpired(now: number): Promise<number>;
}

export interface AuditLogRepository {
  append(entry: Omit<AuditLog, 'id'>): Promise<AuditLog>;
  listForUser(userId: string, opts: { limit?: number }): Promise<AuditLog[]>;
}
`,
  );
});

afterAll(() => {
  ttlWatcher?.stop();
  manifest?.close();
  rmSync(tmpStateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

// --- Tests --------------------------------------------------------------------

suite('v1.7.0 — srogi end-to-end test against real Gemini', () => {
  it('T20 cold streaming with HIGH thinking — verifies chunk accumulation + thought summary', async () => {
    const ctx = buildCtx();
    const result = await askTool.execute(
      {
        workspace: workspaceRoot,
        prompt:
          'List every exported symbol in this codebase with its module path. Then explain in 2 sentences how `withRetry` and `yieldChunks` could be combined to build a streaming network call with retries on transient errors.',
        thinkingLevel: 'HIGH',
      },
      ctx,
    );
    if (result.isError) {
      // eslint-disable-next-line no-console
      console.error('[T20 cold] FAILED. content:', JSON.stringify(result.content, null, 2));
      // eslint-disable-next-line no-console
      console.error(
        '[T20 cold] structuredContent:',
        JSON.stringify(result.structuredContent, null, 2),
      );
    }
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    // Sanity: the model must mention at least one of the symbols we exported.
    expect(text).toMatch(/withRetry|resolveAuth|yieldChunks|CacheManager/i);
    // T20 invariant: usage metadata must be populated (proves stream-collector
    // captured the FINAL chunk's usageMetadata, not lost during chunk pumping).
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    expect(sc).toBeTruthy();
    expect(typeof sc?.cachedTokens).toBe('number');
    expect(typeof sc?.uncachedTokens).toBe('number');
    expect(typeof sc?.outputTokens).toBe('number');
    // First call → no cache hit.
    expect(sc?.cacheHit).toBe(false);
    // HIGH thinking → thinking tokens > 0.
    expect(sc?.thinkingTokens).toBeGreaterThan(0);
    recordCost(
      `T20 cold + HIGH thinking [model=${sc?.resolvedModel}]`,
      sc?.costEstimateUsd as number,
    );
  }, 300_000);

  it('T20 warm streaming — same workspace, second call hits cache', async () => {
    const ctx = buildCtx();
    const result = await askTool.execute(
      {
        workspace: workspaceRoot,
        prompt: 'In one sentence, what does `CacheManager.build` return?',
        thinkingLevel: 'LOW',
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    // Diagnostic: dump cache-related fields so we can see WHY cacheHit is false.
    // eslint-disable-next-line no-console
    console.log(
      `[T20 warm diag] cacheHit=${sc?.cacheHit}, cacheRebuilt=${sc?.cacheRebuilt}, inlineOnly=${sc?.inlineOnly}, cached=${sc?.cachedTokens}, uncached=${sc?.uncachedTokens}, durationMs=${sc?.durationMs}`,
    );
    // Second call on identical workspace → cache should be hit.
    expect(sc?.cacheHit).toBe(true);
    // Cached tokens should dominate.
    const cached = sc?.cachedTokens as number;
    const uncached = sc?.uncachedTokens as number;
    expect(cached).toBeGreaterThan(uncached);
    recordCost(
      `T20 warm cache hit [cached=${cached} uncached=${uncached}]`,
      sc?.costEstimateUsd as number,
    );
  }, 120_000);

  it('T19 timeout interrupts a streaming call mid-flight (returns TIMEOUT errorCode)', async () => {
    const ctx = buildCtx();
    // Force a long-running call: HIGH thinking + a question that requires
    // serious reasoning. Then cap at 3 seconds — should NOT be enough.
    const result = await askTool.execute(
      {
        workspace: workspaceRoot,
        prompt:
          'Perform a deep analysis: enumerate every potential edge case in `withRetry` (consider AbortSignal, timer leaks, exponential backoff math, error type discrimination). For each edge case, propose a unit test. Be exhaustive.',
        thinkingLevel: 'HIGH',
        timeoutMs: 3000,
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    expect(sc?.errorCode).toBe('TIMEOUT');
    expect(sc?.timeoutMs).toBe(3000);
    expect(sc?.retryable).toBe(true);
    // No real cost recorded by us — but Gemini may still bill server-side
    // for completed work (per the AbortSignal client-only caveat). Record
    // estimated worst-case so the budget cap honours it.
    recordCost('T19 timeout abort (Gemini may still bill — recorded as $0.10 estimate)', 0.1);
  }, 30_000);

  it('D#7 status separates settled from in-flight reserved cost', async () => {
    const ctx = buildCtx();

    // 1. Capture baseline BEFORE the long call. settled_before is what the
    //    suite has already spent up to this point.
    const statusBefore = await statusTool.execute({ workspace: workspaceRoot }, ctx);
    const scBefore = statusBefore.structuredContent as Record<string, unknown> | undefined;
    const settledBefore = scBefore?.spentTodaySettledUsd as number;
    const inFlightBefore = scBefore?.inFlightReservedTodayUsd as number;
    expect(inFlightBefore).toBe(0); // No call running yet.

    // 2. Kick off a long ask in the background.
    const longRunning = askTool.execute(
      {
        workspace: workspaceRoot,
        prompt:
          'Generate a comprehensive 5-paragraph architecture document for this codebase, covering each module in detail.',
        thinkingLevel: 'MEDIUM',
      },
      ctx,
    );
    // Give it a moment to insert the reservation row + start streaming.
    await new Promise((r) => setTimeout(r, 1_500));

    // 3. Query status while in flight.
    const statusDuring = await statusTool.execute({ workspace: workspaceRoot }, ctx);
    const scDuring = statusDuring.structuredContent as Record<string, unknown> | undefined;
    const inFlightDuring = scDuring?.inFlightReservedTodayUsd as number;
    const settledDuring = scDuring?.spentTodaySettledUsd as number;
    const upperBoundDuring = scDuring?.spentTodayUsd as number;

    // D#7 invariants mid-call:
    // (a) inFlight > 0 — the ask's reservation is open
    // (b) settled_during ≈ settled_before — no new finalized rows since baseline
    // (c) upperBound = settled + inFlight (math holds)
    expect(inFlightDuring).toBeGreaterThan(0);
    expect(settledDuring).toBeCloseTo(settledBefore, 4);
    expect(Math.abs(upperBoundDuring - (settledDuring + inFlightDuring))).toBeLessThan(0.0001);

    // Human-readable output renders the breakdown when in-flight is non-zero.
    const humanDuring =
      statusDuring.content?.[0]?.type === 'text' ? statusDuring.content[0].text : '';
    expect(humanDuring).toMatch(/in-flight reserved/);

    // 4. Wait for the long call to finish.
    const result = await longRunning;
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    const actualCost = sc?.costEstimateUsd as number;
    recordCost(`D#7 long ask [duration=${sc?.durationMs}ms]`, actualCost);

    // 5. Query status AFTER. Verify the post-finalize invariants:
    //    (a) inFlight back to 0
    //    (b) settled went up by exactly the call's actual cost (not the
    //        reservation estimate, which was MUCH higher worst-case)
    const statusAfter = await statusTool.execute({ workspace: workspaceRoot }, ctx);
    const scAfter = statusAfter.structuredContent as Record<string, unknown> | undefined;
    expect(scAfter?.inFlightReservedTodayUsd).toBe(0);
    expect(scAfter?.spentTodaySettledUsd).toBeCloseTo(settledBefore + actualCost, 3);

    // Human output should NOT include in-flight section once cleared.
    const humanAfter = statusAfter.content?.[0]?.type === 'text' ? statusAfter.content[0].text : '';
    expect(humanAfter).not.toMatch(/in-flight reserved/);
  }, 240_000);

  it('code tool — streaming refactor preserves OLD/NEW edit parsing', async () => {
    const ctx = buildCtx();
    const result = await codeTool.execute(
      {
        workspace: workspaceRoot,
        task: 'Refactor `withRetry` in src/retry.ts to add a `onAttemptFailure?: (attempt: number, err: unknown) => void` callback that is invoked before each backoff sleep. Provide an OLD/NEW diff edit.',
        thinkingLevel: 'MEDIUM',
        expectEdits: true,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    // Parser must surface at least one edit despite the streaming refactor.
    const edits = sc?.edits as Array<unknown> | undefined;
    expect(edits).toBeDefined();
    expect((edits ?? []).length).toBeGreaterThan(0);
    recordCost(
      `code tool with OLD/NEW edits [edits=${edits?.length ?? 0}]`,
      sc?.costEstimateUsd as number,
    );
  }, 240_000);

  it('FINAL: cost summary', () => {
    // eslint-disable-next-line no-console
    console.log('\n=== SROGI TEST SUITE COST SUMMARY ===');
    // eslint-disable-next-line no-console
    console.log(
      `Total cumulative cost: $${cumulativeCost.toFixed(4)} / $${HARD_BUDGET_USD.toFixed(2)} cap`,
    );
  });
});
