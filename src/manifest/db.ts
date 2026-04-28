/**
 * better-sqlite3 wrapper for the manifest DB.
 *
 * Opens at `~/.qmediat/gemini-code-context-mcp/manifest.db` in WAL mode.
 * Single-file schema; future migrations bump `schema_version` in schema_meta.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type { FileRow, UsageMetricRow, WorkspaceRow } from '../types.js';
import { logger } from '../utils/logger.js';
import { manifestDbPath, qmediatStateDir } from '../utils/paths.js';

const SCHEMA_VERSION = '1';

/** Inlined schema — kept in sync with `schema.sql` (the .sql file is the human-readable source of truth). */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_root       TEXT PRIMARY KEY,
  files_hash           TEXT NOT NULL,
  model                TEXT NOT NULL,
  system_prompt_hash   TEXT NOT NULL DEFAULT '',
  cache_id             TEXT,
  cache_expires_at     INTEGER,
  file_ids             TEXT NOT NULL DEFAULT '[]',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  workspace_root       TEXT NOT NULL,
  relpath              TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  file_id              TEXT,
  uploaded_at          INTEGER,
  expires_at           INTEGER,
  -- v1.13.0+: scan-memo columns. Allow re-using a stored content_hash when
  -- the file's mtime + size haven't changed since the last scan, skipping
  -- the read+SHA256 cost for ~95% of files on a typical warm code-review.
  -- Nullable for rows written before v1.13.0; the scanner forces a fresh
  -- hash whenever either column is null.
  mtime_ms             INTEGER,
  size                 INTEGER,
  PRIMARY KEY (workspace_root, relpath),
  FOREIGN KEY (workspace_root) REFERENCES workspaces(workspace_root) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

CREATE TABLE IF NOT EXISTS usage_metrics (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_root       TEXT NOT NULL,
  tool_name            TEXT NOT NULL,
  model                TEXT,
  cached_tokens        INTEGER,
  uncached_tokens      INTEGER,
  cost_usd_micro       INTEGER,
  duration_ms          INTEGER NOT NULL,
  occurred_at          INTEGER NOT NULL,
  -- v1.13.0+: caching-mode telemetry. caching_mode records whether this
  -- call used "explicit" (caches.create) or "implicit" (Gemini's automatic
  -- cache for 2.5+/3 Pro). cached_content_token_count mirrors
  -- usage_metadata.cachedContentTokenCount from the Gemini response and
  -- is used by the status tool to compute cache-hit rate. Nullable for
  -- rows written before v1.13.0 (treated as "explicit" for aggregations).
  caching_mode               TEXT,
  cached_content_token_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_usage_occurred_at ON usage_metrics(occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_workspace ON usage_metrics(workspace_root);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function rowToWorkspace(row: Record<string, unknown>): WorkspaceRow {
  const fileIdsRaw = typeof row.file_ids === 'string' ? row.file_ids : '[]';
  let fileIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(fileIdsRaw);
    if (Array.isArray(parsed)) fileIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch (err) {
    // Corruption is silent to the runtime (file_ids is currently write-only
    // and slated for removal in T16), but surface it in logs so users
    // debugging manifest issues get a signal instead of an empty array.
    logger.warn(
      `manifest: failed to parse workspaces.file_ids for ${String(row.workspace_root)}: ${String(err)}; defaulting to []`,
    );
    fileIds = [];
  }
  return {
    workspaceRoot: String(row.workspace_root),
    filesHash: String(row.files_hash),
    model: String(row.model),
    systemPromptHash: String(row.system_prompt_hash ?? ''),
    cacheId: (row.cache_id as string | null) ?? null,
    cacheExpiresAt: (row.cache_expires_at as number | null) ?? null,
    fileIds,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToFile(row: Record<string, unknown>): FileRow {
  return {
    workspaceRoot: String(row.workspace_root),
    relpath: String(row.relpath),
    contentHash: String(row.content_hash),
    fileId: (row.file_id as string | null) ?? null,
    uploadedAt: (row.uploaded_at as number | null) ?? null,
    expiresAt: (row.expires_at as number | null) ?? null,
    mtimeMs: (row.mtime_ms as number | null) ?? null,
    size: (row.size as number | null) ?? null,
  };
}

/**
 * v1.13.0+ additive column migrations. Each invocation runs `ALTER TABLE …
 * ADD COLUMN` for one new column and swallows the "duplicate column name"
 * error so the call is idempotent — re-running the binary on an already-
 * migrated DB is a no-op. Every other SQLite error rethrows so genuine
 * schema corruption surfaces.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, hence the catch dance.
 */
function addColumnIfMissing(db: DatabaseType, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate column name')) return;
    throw err;
  }
}

export class ManifestDb {
  private readonly db: DatabaseType;

  constructor(pathOverride?: string) {
    const dbPath = pathOverride ?? manifestDbPath();
    const stateDir = pathOverride ? dirname(pathOverride) : qmediatStateDir();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(SCHEMA_SQL);

    // v1.13.0 additive migrations. `CREATE TABLE IF NOT EXISTS` above defines
    // the post-1.13 schema for fresh DBs; for DBs already created by v1.12.x
    // these `ADD COLUMN` calls bring the existing tables up to spec. Both
    // calls are no-ops on a fresh DB (the columns already exist) thanks to
    // `addColumnIfMissing`'s duplicate-column swallow.
    addColumnIfMissing(this.db, 'files', 'mtime_ms', 'INTEGER');
    addColumnIfMissing(this.db, 'files', 'size', 'INTEGER');
    addColumnIfMissing(this.db, 'usage_metrics', 'caching_mode', 'TEXT');
    addColumnIfMissing(this.db, 'usage_metrics', 'cached_content_token_count', 'INTEGER');

    const meta = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version');
    if (!meta) {
      this.db
        .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?)')
        .run('version', SCHEMA_VERSION);
    }
  }

  close(): void {
    this.db.close();
  }

  getWorkspace(workspaceRoot: string): WorkspaceRow | null {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE workspace_root = ?')
      .get(workspaceRoot) as Record<string, unknown> | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  upsertWorkspace(ws: WorkspaceRow): void {
    this.db
      .prepare(
        `INSERT INTO workspaces(
           workspace_root, files_hash, model, system_prompt_hash,
           cache_id, cache_expires_at, file_ids, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_root) DO UPDATE SET
           files_hash = excluded.files_hash,
           model = excluded.model,
           system_prompt_hash = excluded.system_prompt_hash,
           cache_id = excluded.cache_id,
           cache_expires_at = excluded.cache_expires_at,
           file_ids = excluded.file_ids,
           updated_at = excluded.updated_at`,
      )
      .run(
        ws.workspaceRoot,
        ws.filesHash,
        ws.model,
        ws.systemPromptHash,
        ws.cacheId,
        ws.cacheExpiresAt,
        JSON.stringify(ws.fileIds),
        ws.createdAt,
        ws.updatedAt,
      );
  }

  deleteWorkspace(workspaceRoot: string): void {
    // `files.workspace_root` → `workspaces(workspace_root) ON DELETE CASCADE`
    // plus `PRAGMA foreign_keys = ON` in the constructor — the child rows
    // drop automatically. No explicit `DELETE FROM files` needed.
    this.db.prepare('DELETE FROM workspaces WHERE workspace_root = ?').run(workspaceRoot);
  }

  getFiles(workspaceRoot: string): FileRow[] {
    const rows = this.db
      .prepare('SELECT * FROM files WHERE workspace_root = ? ORDER BY relpath')
      .all(workspaceRoot) as Record<string, unknown>[];
    return rows.map(rowToFile);
  }

  /**
   * v1.13.0+ memo-seeder. Used by `prepareContext`'s inline / implicit /
   * small-workspace branches — those paths skip the uploader entirely (which
   * is the only writer of `upsertFile`), so without this the scan memo would
   * silently degrade to cold every call (every file re-hashes — defeating
   * the v1.13.0 perf headline).
   *
   * Conditional preservation of `file_id` / `uploaded_at` / `expires_at`
   * (round-3 fix for the v1.13.0 silent-corruption HIGH found by Gemini /
   * GPT / Copilot in the round-2 review):
   *
   *   - **content_hash UNCHANGED** → preserve the upload metadata. A prior
   *     explicit-cache run uploaded these bytes to Files API; a switch back
   *     to `cachingMode: 'explicit'` should hit dedup and skip re-upload.
   *   - **content_hash CHANGED** → null out `file_id` / `uploaded_at` /
   *     `expires_at`. The previous fileId points to an upload of OLD bytes
   *     on Google's servers; preserving it would let `findFileRowByHash`
   *     return that stale fileId for the NEW content — silently feeding
   *     OLD bytes into Gemini under the file's NEW relpath.
   *
   * The pre-fix version preserved unconditionally, locking in a stale-fileId
   * row whenever an edit landed between an explicit run and an implicit run.
   * Two corruption scenarios were reachable:
   *   (A) same-relpath self-corruption: file edited mid-session, subsequent
   *       explicit run reuses the stale fileId for the changed file.
   *   (B) cross-file leak: a different file with the same NEW content_hash
   *       hits the dedup query and gets routed through the stale fileId.
   *
   * The CASE-based clear closes both. Confirmed by /6step round-3 analysis:
   * `findFileRowByHash` returns rows where `content_hash = ?` and `file_id IS
   * NOT NULL` — the conditional null-out ensures any stale fileId is gone
   * BEFORE the dedup query could return it.
   */
  refreshFileFingerprints(
    rows: ReadonlyArray<{
      workspaceRoot: string;
      relpath: string;
      contentHash: string;
      mtimeMs: number;
      size: number;
    }>,
  ): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO files(
         workspace_root, relpath, content_hash, file_id, uploaded_at, expires_at,
         mtime_ms, size
       ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(workspace_root, relpath) DO UPDATE SET
         file_id     = CASE WHEN files.content_hash <> excluded.content_hash THEN NULL ELSE files.file_id     END,
         uploaded_at = CASE WHEN files.content_hash <> excluded.content_hash THEN NULL ELSE files.uploaded_at END,
         expires_at  = CASE WHEN files.content_hash <> excluded.content_hash THEN NULL ELSE files.expires_at  END,
         content_hash = excluded.content_hash,
         mtime_ms     = excluded.mtime_ms,
         size         = excluded.size`,
    );
    const tx = this.db.transaction((batch: ReadonlyArray<(typeof rows)[number]>): void => {
      for (const r of batch) {
        stmt.run(r.workspaceRoot, r.relpath, r.contentHash, r.mtimeMs, r.size);
      }
    });
    tx(rows);
  }

  upsertFile(file: FileRow): void {
    this.db
      .prepare(
        `INSERT INTO files(
           workspace_root, relpath, content_hash, file_id, uploaded_at, expires_at,
           mtime_ms, size
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_root, relpath) DO UPDATE SET
           content_hash = excluded.content_hash,
           file_id = excluded.file_id,
           uploaded_at = excluded.uploaded_at,
           expires_at = excluded.expires_at,
           mtime_ms = excluded.mtime_ms,
           size = excluded.size`,
      )
      .run(
        file.workspaceRoot,
        file.relpath,
        file.contentHash,
        file.fileId,
        file.uploadedAt,
        file.expiresAt,
        file.mtimeMs ?? null,
        file.size ?? null,
      );
  }

  deleteFile(workspaceRoot: string, relpath: string): void {
    this.db
      .prepare('DELETE FROM files WHERE workspace_root = ? AND relpath = ?')
      .run(workspaceRoot, relpath);
  }

  /** Find a file ID for a content hash already uploaded (dedupe helper). */
  findFileIdByHash(workspaceRoot: string, contentHash: string, nowMs: number): string | null {
    const row = this.findFileRowByHash(workspaceRoot, contentHash, nowMs);
    return row?.fileId ?? null;
  }

  /**
   * Find the full row (including original uploadedAt/expiresAt) for a content hash.
   * Used by the uploader reuse path to preserve Google's original upload clock
   * — Google's 48 h auto-delete timer starts at the ORIGINAL upload, not at reuse.
   */
  findFileRowByHash(workspaceRoot: string, contentHash: string, nowMs: number): FileRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM files
         WHERE workspace_root = ? AND content_hash = ? AND file_id IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(workspaceRoot, contentHash, nowMs) as Record<string, unknown> | undefined;
    return row ? rowToFile(row) : null;
  }

  insertUsageMetric(metric: UsageMetricRow): void {
    this.db
      .prepare(
        `INSERT INTO usage_metrics(
           workspace_root, tool_name, model, cached_tokens, uncached_tokens,
           cost_usd_micro, duration_ms, occurred_at,
           caching_mode, cached_content_token_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metric.workspaceRoot,
        metric.toolName,
        metric.model,
        metric.cachedTokens,
        metric.uncachedTokens,
        metric.costUsdMicro,
        metric.durationMs,
        metric.occurredAt,
        metric.cachingMode ?? null,
        metric.cachedContentTokenCount ?? null,
      );
  }

  /**
   * Atomically check the daily budget and — if there's headroom — reserve
   * an estimate against it, so concurrent tool calls can't all pass the
   * pre-check and then collectively overshoot the cap.
   *
   * Implemented as a `BEGIN IMMEDIATE`-backed SQLite transaction:
   *
   *   1. SUM existing `cost_usd_micro` since UTC midnight (includes
   *      previously-reserved but not yet finalized rows, so concurrent
   *      reservations see each other).
   *   2. If `spent + estimate > cap`, rollback and return `rejected`.
   *   3. Otherwise INSERT a row with the estimate. The caller receives its
   *      primary-key `id` and is expected to later `finalizeBudgetReservation`
   *      (on successful call) or `cancelBudgetReservation` (on failure).
   *
   * `dailyBudgetMicros` of `Number.POSITIVE_INFINITY` disables the check and
   * should not be passed here — the caller should branch on `Number.isFinite`
   * and skip the reservation entirely (plain `insertUsageMetric` after the
   * call is enough when there's no cap).
   */
  reserveBudget(args: {
    workspaceRoot: string;
    toolName: string;
    model: string;
    estimatedCostMicros: number;
    dailyBudgetMicros: number;
    nowMs: number;
  }):
    | { id: number }
    | { rejected: true; spentMicros: number; capMicros: number; estimateMicros: number } {
    const startOfUtcDay = new Date(args.nowMs);
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const startMs = startOfUtcDay.getTime();

    const run = this.db.transaction(
      ():
        | { id: number }
        | { rejected: true; spentMicros: number; capMicros: number; estimateMicros: number } => {
        const row = this.db
          .prepare(
            'SELECT COALESCE(SUM(cost_usd_micro), 0) AS total FROM usage_metrics WHERE occurred_at >= ?',
          )
          .get(startMs) as { total: number };
        const spent = row.total ?? 0;
        if (spent + args.estimatedCostMicros > args.dailyBudgetMicros) {
          return {
            rejected: true,
            spentMicros: spent,
            capMicros: args.dailyBudgetMicros,
            estimateMicros: args.estimatedCostMicros,
          };
        }
        const result = this.db
          .prepare(
            `INSERT INTO usage_metrics(
               workspace_root, tool_name, model, cached_tokens, uncached_tokens,
               cost_usd_micro, duration_ms, occurred_at
             ) VALUES (?, ?, ?, 0, 0, ?, 0, ?)`,
          )
          .run(args.workspaceRoot, args.toolName, args.model, args.estimatedCostMicros, args.nowMs);
        return { id: Number(result.lastInsertRowid) };
      },
    );

    // `immediate` mode acquires a reserved lock at BEGIN so a second process
    // reaching `BEGIN IMMEDIATE` is serialised. Prevents two concurrent
    // MCP instances both passing the SUM check on the same headroom.
    return run.immediate();
  }

  /**
   * Replace the placeholder values on a reservation row with the measured
   * cost and token counts after a tool call completes successfully.
   */
  finalizeBudgetReservation(
    reservationId: number,
    data: {
      cachedTokens: number;
      uncachedTokens: number;
      costUsdMicro: number;
      durationMs: number;
      /**
       * v1.13.0+: caching mode used for the call. `'inline'` is the
       * forced-inline outcome (e.g. `code({ codeExecution: true })`), added in
       * the v1.13.0 round-2 review fix (FN2) so telemetry distinguishes
       * "user asked for explicit and got it" from "user asked for explicit but
       * the runtime forced inline".
       */
      cachingMode?: 'explicit' | 'implicit' | 'inline' | null;
      /** v1.13.0+: `usage_metadata.cachedContentTokenCount` from the Gemini response. */
      cachedContentTokenCount?: number | null;
    },
  ): void {
    // D#7 (v1.7.0) belt-and-suspenders: D#7's settled-vs-in-flight split
    // uses `WHERE duration_ms = 0` as the in-flight sentinel. A real
    // network round-trip cannot complete in 0 ms (verified empirically
    // and reasoned about — `Date.now()` resolution is 1 ms and the
    // smallest realistic Gemini call takes 10+ ms wall-clock), but if a
    // future code path ever managed to call `finalize` with `durationMs = 0`
    // (clock skew, NTP backwards jump, instrumented mock test), that row
    // would stay misclassified as in-flight forever. Floor to 1 ms to make
    // the sentinel deterministic regardless of upstream weirdness.
    const safeDurationMs = Math.max(1, data.durationMs);
    this.db
      .prepare(
        `UPDATE usage_metrics
         SET cached_tokens = ?, uncached_tokens = ?, cost_usd_micro = ?, duration_ms = ?,
             caching_mode = ?, cached_content_token_count = ?
         WHERE id = ?`,
      )
      .run(
        data.cachedTokens,
        data.uncachedTokens,
        data.costUsdMicro,
        safeDurationMs,
        data.cachingMode ?? null,
        data.cachedContentTokenCount ?? null,
        reservationId,
      );
  }

  /**
   * Drop a reservation row when the tool call failed before producing any
   * billable output. Idempotent — calling with an unknown id is a no-op.
   */
  cancelBudgetReservation(reservationId: number): void {
    this.db.prepare('DELETE FROM usage_metrics WHERE id = ?').run(reservationId);
  }

  /** Sum costs spent today (UTC) in USD micros. Includes both settled
   * (`duration_ms > 0`) and in-flight reserved (`duration_ms = 0`) rows —
   * conservative for the purpose of budget-cap enforcement, where the
   * reservation MUST count against headroom until the call finalises. */
  todaysCostMicros(nowMs: number): number {
    const startOfUtcDay = new Date(nowMs);
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(cost_usd_micro), 0) AS total FROM usage_metrics WHERE occurred_at >= ?',
      )
      .get(startOfUtcDay.getTime()) as { total: number };
    return row.total ?? 0;
  }

  /**
   * Sum of TODAY's in-flight reservations (rows where `duration_ms = 0` —
   * reserved but not yet finalised). Subset of `todaysCostMicros`. Used by
   * `status` (D#7, v1.7.0) to show users the breakdown of "this is what
   * has actually settled" vs "this is provisional and may shrink when the
   * call completes". The reservation IS counted against the daily cap (so
   * cap enforcement stays safe), but surfacing the split lets users
   * understand why `status` looks higher than expected during a long
   * in-flight call (especially under streaming, where calls can be in
   * flight for 60-180s on HIGH thinking levels).
   */
  todaysInFlightReservedMicros(nowMs: number): number {
    const startOfUtcDay = new Date(nowMs);
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(cost_usd_micro), 0) AS total FROM usage_metrics WHERE occurred_at >= ? AND duration_ms = 0',
      )
      .get(startOfUtcDay.getTime()) as { total: number };
    return row.total ?? 0;
  }

  /** Aggregate stats for a workspace — powers the `status` tool. */
  workspaceStats(workspaceRoot: string): {
    callCount: number;
    totalCachedTokens: number;
    totalUncachedTokens: number;
    totalCostMicros: number;
    /**
     * Subset of `totalCostMicros` representing in-flight reservations
     * (D#7, v1.7.0). Settled cost = `totalCostMicros - inFlightReservedMicros`.
     * Reservation rows are written with `duration_ms = 0` and updated to
     * the real duration when the call finalises; this slice surfaces the
     * provisional portion so users running `status` mid-call understand
     * why the cost looks higher than the calls that have actually completed.
     */
    inFlightReservedMicros: number;
    last24hCostMicros: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS call_count,
           COALESCE(SUM(cached_tokens), 0) AS total_cached,
           COALESCE(SUM(uncached_tokens), 0) AS total_uncached,
           COALESCE(SUM(cost_usd_micro), 0) AS total_cost,
           COALESCE(SUM(CASE WHEN duration_ms = 0 THEN cost_usd_micro ELSE 0 END), 0) AS in_flight
         FROM usage_metrics WHERE workspace_root = ?`,
      )
      .get(workspaceRoot) as {
      call_count: number;
      total_cached: number;
      total_uncached: number;
      total_cost: number;
      in_flight: number;
    };

    const last24h = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd_micro), 0) AS total FROM usage_metrics
         WHERE workspace_root = ? AND occurred_at >= ?`,
      )
      .get(workspaceRoot, Date.now() - 24 * 3600 * 1000) as { total: number };

    return {
      callCount: row.call_count,
      totalCachedTokens: row.total_cached,
      totalUncachedTokens: row.total_uncached,
      totalCostMicros: row.total_cost,
      inFlightReservedMicros: row.in_flight,
      last24hCostMicros: last24h.total,
    };
  }

  /**
   * v1.13.0+: caching telemetry aggregation for the `status` tool.
   *
   * Surfaces caching mode adoption, implicit-cache hit rate (when applicable),
   * and explicit-cache rebuild count over the last 24 h. Hit rate is computed
   * as `sum(cached_content_token_count) / (sum(cached_content_token_count) +
   * sum(uncached_tokens))` across implicit-mode calls — the ratio of input
   * tokens that Gemini's automatic implicit cache served vs the ones we paid
   * full input rate for. Settled rows only (`duration_ms > 0`) so in-flight
   * reservations don't skew the hit rate downward.
   *
   * `mode` is the dominant caching mode in the window:
   *   - `'explicit'` if all metric rows used explicit (or no caching mode set)
   *   - `'implicit'` if all metric rows used implicit
   *   - `'inline'`   if all metric rows used the forced-inline path (e.g.
   *                  `code({ codeExecution: true })` — the user requested
   *                  explicit but the runtime forbade `cachedContent` + tools
   *                  simultaneously). Distinguished from `'explicit'` so the
   *                  v1.14.0 default-flip telemetry isn't biased toward
   *                  "explicit adoption" by codeExecution traffic.
   *   - `'mixed'`    if 2+ of the above modes appear (operator changed
   *                  defaults mid-day, codeExecution + non-codeExecution
   *                  traffic, etc.)
   *   - `null`       if no calls in the window
   *
   * Rows older than v1.13.0 lack `caching_mode` (NULL) and are treated as
   * `'explicit'` for the dominant-mode tally.
   *
   * Upgrade-day note (v1.12.x → v1.13.0): if pre-upgrade calls landed inside
   * the 24h window AND post-upgrade traffic is exclusively forced-inline
   * (e.g. `code({ codeExecution: true })`), `mode` returns `'mixed'` because
   * the legacy NULL rows COALESCE into the explicit tally. This self-corrects
   * once the legacy rows fall out of the 24h window. Operators surprised by
   * `'mixed'` post-upgrade should look at `inlineCallCount` and
   * `explicitRebuildCount` to confirm the actual post-upgrade traffic shape.
   */
  cacheStatsLast24h(nowMs: number): {
    mode: 'explicit' | 'implicit' | 'inline' | 'mixed' | null;
    callCount: number;
    implicitCallsTotal: number;
    implicitCallsWithHit: number;
    implicitCachedTokens: number;
    implicitUncachedTokens: number;
    implicitHitRate: number;
    explicitRebuildCount: number;
    /** v1.13.0 round-2 (FN2 fix): forced-inline call count. Useful for
     *  understanding why explicit-rebuild count differs from explicit-call
     *  count (codeExecution calls request explicit, get inline, never trigger
     *  caches.create). */
    inlineCallCount: number;
  } {
    const since = nowMs - 24 * 3600 * 1000;
    // Restricted to `ask` + `code` rows: those are the calls that flow through
    // `prepareContext` and have a meaningful caching mode. `ask_agentic` (NULL
    // caching_mode by design — no workspace cache) and `cache.create` (infra
    // rebuild marker — counted separately below) are excluded so they don't
    // skew the dominant-mode tally toward 'explicit'.
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS call_count,
           COALESCE(SUM(CASE WHEN COALESCE(caching_mode, 'explicit') = 'explicit' THEN 1 ELSE 0 END), 0) AS explicit_count,
           COALESCE(SUM(CASE WHEN caching_mode = 'implicit' THEN 1 ELSE 0 END), 0) AS implicit_count,
           COALESCE(SUM(CASE WHEN caching_mode = 'inline' THEN 1 ELSE 0 END), 0) AS inline_count,
           COALESCE(SUM(CASE WHEN caching_mode = 'implicit' AND COALESCE(cached_content_token_count, 0) > 0 THEN 1 ELSE 0 END), 0) AS implicit_hit_count,
           COALESCE(SUM(CASE WHEN caching_mode = 'implicit' THEN cached_content_token_count ELSE 0 END), 0) AS implicit_cached_tokens,
           COALESCE(SUM(CASE WHEN caching_mode = 'implicit' THEN uncached_tokens ELSE 0 END), 0) AS implicit_uncached_tokens
         FROM usage_metrics
         WHERE occurred_at >= ? AND duration_ms > 0
           AND tool_name IN ('ask', 'code')`,
      )
      .get(since) as {
      call_count: number;
      explicit_count: number;
      implicit_count: number;
      inline_count: number;
      implicit_hit_count: number;
      implicit_cached_tokens: number;
      implicit_uncached_tokens: number;
    };

    // `tool_name = 'cache.create'` rows are emitted by cache-manager when a
    // fresh `caches.create` call lands on the explicit path. Counting them
    // gives the operator a direct rebuild tally — the v1.13.0 motivation for
    // pivoting toward implicit caching is to drive this number toward zero.
    const rebuilds = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM usage_metrics
         WHERE occurred_at >= ? AND duration_ms > 0 AND tool_name = 'cache.create'`,
      )
      .get(since) as { n: number };

    // Dominant mode: 'mixed' if 2+ of the three actual modes appear; else the
    // one mode that did. v1.13.0 round-2 (FN2 fix) widened this to include
    // 'inline' alongside 'explicit' / 'implicit'.
    const explicitN = row.explicit_count;
    const implicitN = row.implicit_count;
    const inlineN = row.inline_count;
    const presentModes = [explicitN > 0, implicitN > 0, inlineN > 0].filter(Boolean).length;
    let mode: 'explicit' | 'implicit' | 'inline' | 'mixed' | null;
    if (row.call_count === 0) mode = null;
    else if (presentModes >= 2) mode = 'mixed';
    else if (implicitN > 0) mode = 'implicit';
    else if (inlineN > 0) mode = 'inline';
    else mode = 'explicit';

    const denom = row.implicit_cached_tokens + row.implicit_uncached_tokens;
    const implicitHitRate = denom > 0 ? row.implicit_cached_tokens / denom : 0;

    return {
      mode,
      callCount: row.call_count,
      implicitCallsTotal: row.implicit_count,
      implicitCallsWithHit: row.implicit_hit_count,
      implicitCachedTokens: row.implicit_cached_tokens,
      implicitUncachedTokens: row.implicit_uncached_tokens,
      implicitHitRate,
      explicitRebuildCount: rebuilds.n,
      inlineCallCount: row.inline_count,
    };
  }
}
