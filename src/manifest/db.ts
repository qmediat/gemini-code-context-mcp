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
  occurred_at          INTEGER NOT NULL
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
  } catch {
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
  };
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

  upsertFile(file: FileRow): void {
    this.db
      .prepare(
        `INSERT INTO files(
           workspace_root, relpath, content_hash, file_id, uploaded_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_root, relpath) DO UPDATE SET
           content_hash = excluded.content_hash,
           file_id = excluded.file_id,
           uploaded_at = excluded.uploaded_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        file.workspaceRoot,
        file.relpath,
        file.contentHash,
        file.fileId,
        file.uploadedAt,
        file.expiresAt,
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
           cost_usd_micro, duration_ms, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  /** Sum costs spent today (UTC) in USD micros. */
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

  /** Aggregate stats for a workspace — powers the `status` tool. */
  workspaceStats(workspaceRoot: string): {
    callCount: number;
    totalCachedTokens: number;
    totalUncachedTokens: number;
    totalCostMicros: number;
    last24hCostMicros: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS call_count,
           COALESCE(SUM(cached_tokens), 0) AS total_cached,
           COALESCE(SUM(uncached_tokens), 0) AS total_uncached,
           COALESCE(SUM(cost_usd_micro), 0) AS total_cost
         FROM usage_metrics WHERE workspace_root = ?`,
      )
      .get(workspaceRoot) as {
      call_count: number;
      total_cached: number;
      total_uncached: number;
      total_cost: number;
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
      last24hCostMicros: last24h.total,
    };
  }
}
