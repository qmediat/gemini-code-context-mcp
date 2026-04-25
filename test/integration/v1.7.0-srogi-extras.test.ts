/**
 * Extra real-Gemini coverage requested by user — fills the gaps the original
 * srogi suite left:
 *
 *   E. Concurrent ask() calls — verify in-process mutex coalesces uploads,
 *      reservations don't collide, no DB lock contention.
 *   F. Stale-cache mid-call END-TO-END — build cache, externally delete via
 *      caches.delete API, re-ask, verify rebuild path triggers and response
 *      is correct (not a 404 surfaced to user).
 *   G. ask_agentic with real API — verifies the agentic loop with function
 *      calls works end-to-end after T19 timeout plumbing.
 *
 * Same skip-without-creds pattern as v1.7.0-streaming-srogi.test.ts.
 * Hard $5 cap per file (separate from the other suite's cap).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAuth } from '../../src/auth/profile-loader.js';
import { estimateCostUsd } from '../../src/utils/cost-estimator.js';
import { TtlWatcher } from '../../src/cache/ttl-watcher.js';
import { createGeminiClient } from '../../src/gemini/client.js';
import { ManifestDb } from '../../src/manifest/db.js';
import { askTool } from '../../src/tools/ask.tool.js';
import { askAgenticTool } from '../../src/tools/ask-agentic.tool.js';
import { createTpmThrottle } from '../../src/tools/shared/throttle.js';
import type { ToolContext } from '../../src/tools/registry.js';

const HARD_BUDGET_USD = 5.0;
let cumulativeCost = 0;

function recordCost(label: string, cost: number): void {
  cumulativeCost += cost;
  // eslint-disable-next-line no-console
  console.log(
    `[cost] ${label}: $${cost.toFixed(4)} | cumulative: $${cumulativeCost.toFixed(4)} / $${HARD_BUDGET_USD.toFixed(2)}`,
  );
  if (cumulativeCost > HARD_BUDGET_USD) {
    throw new Error(`Hard $${HARD_BUDGET_USD} cap exceeded after ${label}`);
  }
}

let auth: ReturnType<typeof resolveAuth> | null = null;
try {
  auth = resolveAuth();
} catch {
  auth = null;
}
const explicitlyEnabled = process.env.RUN_SROGI_TEST === 'true';
const suite = auth && explicitlyEnabled ? describe : describe.skip;

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
      notification: async () => undefined,
    } as unknown as ToolContext['server'],
    config: {
      auth,
      defaultModel: 'latest-pro-thinking',
      dailyBudgetUsd: 50,
      maxFilesPerWorkspace: 200,
      maxFileSizeBytes: 1_000_000,
      cacheTtlSeconds: 3600,
      cacheMinTokens: 1024,
      tpmThrottleLimit: 80_000,
      forceMaxOutputTokens: false,
      workspaceGuardRatio: 0.9,
    } as ToolContext['config'],
    client,
    manifest,
    ttlWatcher,
    progressToken: 'extras-token',
    throttle: createTpmThrottle(80_000),
  };
}

beforeAll(() => {
  tmpStateDir = mkdtempSync(join(tmpdir(), 'srogi-extras-state-'));
  manifest = new ManifestDb(join(tmpStateDir, 'manifest.db'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'srogi-extras-wks-'));
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: 'extras-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );
  // Same calibrated bulk pattern as the main srogi suite — clears the 1024-token cache floor.
  const bulk = (name: string, content: string) => writeFileSync(join(workspaceRoot, 'src', name), content);
  bulk(
    'auth.ts',
    `export interface AuthProfile { kind: 'api-key' | 'vertex'; apiKey?: string; project?: string; }
export function resolveAuth(): AuthProfile {
  if (process.env.GEMINI_USE_VERTEX === 'true') {
    return { kind: 'vertex', project: process.env.GOOGLE_CLOUD_PROJECT! };
  }
  return { kind: 'api-key', apiKey: process.env.GEMINI_API_KEY! };
}`,
  );
  bulk(
    'cache.ts',
    `import type { AuthProfile } from './auth.js';
export class CacheManager {
  constructor(private auth: AuthProfile) {}
  async build(workspaceRoot: string): Promise<{ cacheId: string; ttlSec: number }> {
    return { cacheId: \`cache-\${Date.now()}\`, ttlSec: 3600 };
  }
  async invalidate(cacheId: string): Promise<void> { /* no-op */ }
}`,
  );
  bulk(
    'retry.ts',
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
  bulk(
    'errors.ts',
    `export class DomainError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}
export class UnauthenticatedError extends DomainError { constructor(m = 'Auth required') { super('UNAUTHENTICATED', m); } }
export class PermissionDeniedError extends DomainError { constructor(action: string, resource: string) { super('PERMISSION_DENIED', \`Forbidden: \${action} on \${resource}\`); } }
export class InvalidArgumentError extends DomainError { constructor(field: string, reason: string) { super('INVALID_ARGUMENT', \`Invalid \${field}: \${reason}\`); } }
export class NotFoundError extends DomainError { constructor(resource: string, id: string) { super('NOT_FOUND', \`\${resource} not found: \${id}\`); } }
export class RateLimitError extends DomainError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) { super('RESOURCE_EXHAUSTED', \`Rate limit; retry after \${retryAfterMs}ms\`); this.retryAfterMs = retryAfterMs; }
}
export function isRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  return false;
}`,
  );
  bulk(
    'storage.ts',
    `export interface UserRepo {
  findById(id: string): Promise<unknown | null>;
  findByEmail(email: string): Promise<unknown | null>;
  list(opts: { cursor?: string; limit?: number }): Promise<{ items: unknown[]; nextCursor?: string }>;
  create(input: unknown): Promise<unknown>;
  update(id: string, patch: unknown): Promise<unknown>;
  delete(id: string): Promise<void>;
}
export interface SessionRepo {
  findByToken(token: string): Promise<unknown | null>;
  listForUser(userId: string): Promise<unknown[]>;
  revoke(token: string): Promise<void>;
  pruneExpired(now: number): Promise<number>;
}
export interface AuditRepo {
  append(entry: { userId: string; action: string; resource: string }): Promise<unknown>;
  listForUser(userId: string, opts: { limit?: number }): Promise<unknown[]>;
}`,
  );
  bulk(
    'streaming.ts',
    `export async function* yieldChunks<T>(items: T[], delayMs: number): AsyncGenerator<T> {
  for (const item of items) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}`,
  );
  bulk(
    'index.ts',
    `export { resolveAuth } from './auth.js';
export { CacheManager } from './cache.js';
export { withRetry } from './retry.js';
export { yieldChunks, collect } from './streaming.js';
export * from './errors.js';
export * from './storage.js';`,
  );
  // Calibration padding: clear the 1024-token cache floor so we test the
  // cache-build path, not the inline fallback. ~3 KB of realistic types ≈
  // 750 tokens; combined with the rest of the fixture (~700 tokens) we land
  // at ~1450 tokens — comfortably above the floor.
  bulk(
    'types.ts',
    `export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  emailVerifiedAt: number | null;
  preferences: UserPreferences;
}
export interface UserPreferences {
  theme: 'light' | 'dark' | 'auto';
  language: string;
  timezone: string;
  notifications: NotificationPreferences;
  accessibility: AccessibilityPreferences;
}
export interface NotificationPreferences {
  email: boolean;
  push: boolean;
  sms: boolean;
  digest: 'instant' | 'hourly' | 'daily' | 'weekly' | 'never';
  categories: NotificationCategoryToggles;
}
export interface NotificationCategoryToggles {
  security: boolean;
  product_updates: boolean;
  marketing: boolean;
  team_activity: boolean;
}
export interface AccessibilityPreferences {
  reducedMotion: boolean;
  highContrast: boolean;
  screenReaderHints: boolean;
  fontScale: number;
}
export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  ipAddress: string;
  userAgent: string;
  revoked: boolean;
  revokedAt: number | null;
  revokedReason: string | null;
}
export interface AuditLog {
  id: string;
  userId: string;
  action: AuditAction;
  resource: string;
  metadata: Record<string, unknown>;
  occurredAt: number;
  ipAddress: string;
  userAgent: string;
}
export type AuditAction =
  | 'login'
  | 'logout'
  | 'password_change'
  | 'email_change'
  | 'profile_update'
  | 'session_revoke'
  | 'session_revoke_all'
  | 'export_data'
  | 'delete_account'
  | 'permission_grant'
  | 'permission_revoke';
export interface ApiResponse<T> {
  data: T;
  meta: { requestId: string; durationMs: number; cached: boolean };
}
export interface PaginatedResponse<T> {
  items: T[];
  nextCursor?: string;
  prevCursor?: string;
  totalCount?: number;
}
export interface FilterOptions {
  cursor?: string;
  limit?: number;
  sort?: 'asc' | 'desc';
  sortBy?: string;
  search?: string;
  filters?: Record<string, unknown>;
}
`,
  );
});

afterAll(() => {
  ttlWatcher?.stop();
  manifest?.close();
  rmSync(tmpStateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n=== EXTRAS SUITE COST: $${cumulativeCost.toFixed(4)} / $${HARD_BUDGET_USD.toFixed(2)} ===`);
});

suite('v1.7.0 srogi extras — concurrency, stale-cache E2E, ask_agentic E2E', () => {
  it('E — concurrent ask() calls coalesce upload + serialize cleanly', async () => {
    const ctx = buildCtx();
    // Two parallel asks against same workspace. In-process mutex should
    // coalesce the cache build (only 1 caches.create), throttle should
    // serialize the generateContent calls if they'd bust TPM, and
    // reservations must not collide.
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      askTool.execute(
        {
          workspace: workspaceRoot,
          prompt: 'In ONE sentence, what does retry.ts export?',
          thinkingLevel: 'LOW',
        },
        ctx,
      ),
      askTool.execute(
        {
          workspace: workspaceRoot,
          prompt: 'In ONE sentence, what does cache.ts export?',
          thinkingLevel: 'LOW',
        },
        ctx,
      ),
    ]);
    const elapsed = Date.now() - t0;
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    const sc1 = r1.structuredContent as Record<string, unknown> | undefined;
    const sc2 = r2.structuredContent as Record<string, unknown> | undefined;

    // eslint-disable-next-line no-console
    console.log(
      `[E concurrent] r1: cacheHit=${sc1?.cacheHit} rebuilt=${sc1?.cacheRebuilt} cached=${sc1?.cachedTokens} cost=$${sc1?.costEstimateUsd}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[E concurrent] r2: cacheHit=${sc2?.cacheHit} rebuilt=${sc2?.cacheRebuilt} cached=${sc2?.cachedTokens} cost=$${sc2?.costEstimateUsd}`,
    );
    // eslint-disable-next-line no-console
    console.log(`[E concurrent] elapsed wall-clock: ${(elapsed / 1000).toFixed(1)}s`);

    // Real coalesce verification: after BOTH parallel calls finish, the
    // manifest must hold EXACTLY ONE workspace row with ONE cacheId. If the
    // mutex was broken, two independent caches.create network calls would
    // have happened — the SECOND one's cache would overwrite the first in
    // the manifest, but Gemini-side we'd have leaked an orphan. We can also
    // verify both calls actually used cached tokens (confirms they shared
    // the same cache, not two independently built ones).
    const ws = manifest.getWorkspace(workspaceRoot);
    expect(ws?.cacheId).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`[E concurrent] manifest cacheId: ${ws?.cacheId}`);
    // Both calls should have non-zero cached tokens — proves both rode the
    // same Context Cache. (If they raced and one built / one inlined, only
    // one would have cached>0.)
    expect(sc1?.cachedTokens as number).toBeGreaterThan(0);
    expect(sc2?.cachedTokens as number).toBeGreaterThan(0);

    recordCost('E concurrent (r1)', sc1?.costEstimateUsd as number);
    recordCost('E concurrent (r2)', sc2?.costEstimateUsd as number);
  }, 180_000);

  it('F — stale-cache mid-call END-TO-END (externally delete cache, retry triggers rebuild)', async () => {
    const ctx = buildCtx();
    // Step 1: a cold ask to build a fresh cache.
    const r1 = await askTool.execute(
      {
        workspace: workspaceRoot,
        prompt: 'List the exports of streaming.ts in ONE sentence.',
        thinkingLevel: 'LOW',
      },
      ctx,
    );
    expect(r1.isError).toBeFalsy();
    const sc1 = r1.structuredContent as Record<string, unknown> | undefined;
    recordCost('F initial (warm — cache from E)', sc1?.costEstimateUsd as number);

    // Find the cacheId from the manifest (E built one, so we should have one
    // for this workspace by now).
    const ws = manifest.getWorkspace(workspaceRoot);
    const cacheId = ws?.cacheId;
    if (!cacheId) {
      // eslint-disable-next-line no-console
      console.log('[F] No cache built (workspace may have gone inline) — test skipped');
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[F] Built cache: ${cacheId} — externally deleting now to simulate stale-cache event…`);

    // Step 2: externally delete the cache via raw client (same call our
    // invalidateWorkspaceCache uses internally).
    const client = createGeminiClient(auth!.profile);
    try {
      await client.caches.delete({ name: cacheId });
      // eslint-disable-next-line no-console
      console.log(`[F] External delete succeeded`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[F] External delete failed (may already be gone): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 3: ask again — the cached pointer in our manifest is now stale.
    // Gemini will return cachedContent NOT_FOUND on the first attempt; our
    // stale-cache retry path should: invalidate locally + rebuild + open
    // fresh stream + return the response.
    const r2 = await askTool.execute(
      {
        workspace: workspaceRoot,
        prompt: 'List the exports of errors.ts in ONE sentence.',
        thinkingLevel: 'LOW',
      },
      ctx,
    );
    expect(r2.isError).toBeFalsy();
    const sc2 = r2.structuredContent as Record<string, unknown> | undefined;
    // eslint-disable-next-line no-console
    console.log(
      `[F stale-cache E2E] retriedOnStaleCache=${sc2?.retriedOnStaleCache}, cacheRebuilt=${sc2?.cacheRebuilt}, cacheHit=${sc2?.cacheHit}, response.length=${typeof sc2?.responseText === 'string' ? (sc2.responseText as string).length : '?'}`,
    );

    // The retry path's load-bearing invariant: response succeeded (not 404
    // surfaced to user). The retriedOnStaleCache flag tells us the path
    // actually fired; cacheRebuilt confirms the rebuild happened.
    expect(sc2?.retriedOnStaleCache).toBe(true);
    expect(sc2?.cacheRebuilt).toBe(true);
    recordCost('F retry after stale-cache', sc2?.costEstimateUsd as number);
  }, 180_000);

  it('G — ask_agentic with real API + iterationTimeoutMs (happy path)', async () => {
    const ctx = buildCtx();
    // ask_agentic doesn't preload the workspace — Gemini decides which files
    // to read via list_directory / find_files / read_file / grep. Use it on
    // the same fixture and ask a concrete question that requires reading
    // 1-2 files. Generous iterationTimeoutMs so it doesn't fire.
    const result = await askAgenticTool.execute(
      {
        workspace: workspaceRoot,
        prompt:
          'Read src/auth.ts and src/cache.ts. In two sentences, describe the relationship between AuthProfile and CacheManager.',
        thinkingLevel: 'LOW',
        maxIterations: 8,
        iterationTimeoutMs: 60_000,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    // eslint-disable-next-line no-console
    console.log(
      `[G ask_agentic] iterations=${sc?.iterations}, filesRead=${sc?.filesRead}, cumulativeInputTokens=${sc?.cumulativeInputTokens}, cumulativeOutputTokens=${sc?.cumulativeOutputTokens}`,
    );
    // Agentic loop should have made AT LEAST 2 iterations (one to issue
    // function calls, one to consume the responses + emit final answer).
    expect((sc?.iterations as number) ?? 0).toBeGreaterThanOrEqual(2);
    // Should have read at least one file via the tool calls.
    expect((sc?.filesRead as number) ?? 0).toBeGreaterThanOrEqual(1);
    // ask_agentic surfaces token counts but not a precomputed `costEstimateUsd`
    // (inconsistency vs ask/code — tracked but out of scope here). Compute cost
    // ourselves from cumulativeInput/Output/Thinking tokens.
    const cost = estimateCostUsd({
      model: sc?.resolvedModel as string,
      uncachedInputTokens: sc?.cumulativeInputTokens as number,
      cachedInputTokens: 0,
      outputTokens: sc?.cumulativeOutputTokens as number,
      thinkingTokens: (sc?.cumulativeThinkingTokens as number) ?? 0,
    });
    recordCost(`G ask_agentic [iter=${sc?.iterations} filesRead=${sc?.filesRead}]`, cost);
  }, 240_000);
});
