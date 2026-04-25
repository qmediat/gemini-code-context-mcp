/**
 * Backward-compat verification: v1.5.2 manifest.db opened by v1.7.0 ManifestDb
 * must read existing rows correctly + accept new writes + populate D#7 fields.
 *
 * D#7 added NO new columns — it queries existing `duration_ms = 0` differently.
 * SCHEMA_VERSION stayed at '1'. This test pins the no-migration-needed claim.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManifestDb } from '../../src/manifest/db.js';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mig-safety-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('v1.5.2 → v1.7.0 manifest.db forward-compatibility', () => {
  it('opens a v1.5.2-shape DB and reads existing rows correctly', () => {
    const dbPath = join(tmp, 'v152-shape.db');

    // Manually create the DB with the v1.5.2 schema (byte-identical to v1.7.0
    // — verifies the no-migration-needed claim isn't accidentally broken).
    const raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.exec(`
      CREATE TABLE workspaces (
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
      CREATE TABLE files (
        workspace_root       TEXT NOT NULL,
        relpath              TEXT NOT NULL,
        content_hash         TEXT NOT NULL,
        file_id              TEXT,
        uploaded_at          INTEGER,
        expires_at           INTEGER,
        PRIMARY KEY (workspace_root, relpath),
        FOREIGN KEY (workspace_root) REFERENCES workspaces(workspace_root) ON DELETE CASCADE
      );
      CREATE INDEX idx_files_hash ON files(content_hash);
      CREATE TABLE usage_metrics (
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
      CREATE INDEX idx_usage_occurred_at ON usage_metrics(occurred_at);
      CREATE INDEX idx_usage_workspace ON usage_metrics(workspace_root);
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('version', '1');
    `);

    // Seed with realistic v1.5.2-era data.
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('/legacy/wks', 'h-old', 'gemini-2.5-pro', '', 'cachedContents/legacy', now + 3_600_000, '[]', now - 60_000, now - 1_000);
    raw
      .prepare(
        `INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('/legacy/wks', 'src/old.ts', 'h1', 'files/legacy-1', now - 60_000, now + 47 * 3600 * 1000);
    // Settled call (duration_ms > 0) + an in-flight reservation (duration_ms = 0)
    raw
      .prepare(
        `INSERT INTO usage_metrics(workspace_root, tool_name, model, cached_tokens, uncached_tokens, cost_usd_micro, duration_ms, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('/legacy/wks', 'ask', 'gemini-2.5-pro', 1000, 500, 800_000, 1500, now - 30_000); // settled $0.80
    raw
      .prepare(
        `INSERT INTO usage_metrics(workspace_root, tool_name, model, cached_tokens, uncached_tokens, cost_usd_micro, duration_ms, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('/legacy/wks', 'ask', 'gemini-2.5-pro', 0, 0, 2_500_000, 0, now - 5_000); // in-flight $2.50
    raw.close();

    // Now open with v1.7.0 ManifestDb.
    const db = new ManifestDb(dbPath);

    // 1. Reads work — workspace + files round-trip.
    const ws = db.getWorkspace('/legacy/wks');
    expect(ws).toBeTruthy();
    expect(ws?.cacheId).toBe('cachedContents/legacy');
    expect(ws?.model).toBe('gemini-2.5-pro');
    expect(db.getFiles('/legacy/wks')).toHaveLength(1);

    // 2. v1.7.0 D#7 query correctly classifies the seeded rows.
    const stats = db.workspaceStats('/legacy/wks');
    expect(stats.callCount).toBe(2);
    expect(stats.totalCostMicros).toBe(800_000 + 2_500_000);
    expect(stats.inFlightReservedMicros).toBe(2_500_000); // The duration_ms=0 row.
    // todaysCostMicros should match (both rows occurred today).
    expect(db.todaysInFlightReservedMicros(now)).toBe(2_500_000);

    // 3. Writes work — new reservation + finalize using v1.7.0 ManifestDb.
    const newRes = db.reserveBudget({
      workspaceRoot: '/legacy/wks',
      toolName: 'ask',
      model: 'gemini-pro-latest',
      estimatedCostMicros: 100_000,
      dailyBudgetMicros: 100_000_000,
      nowMs: now,
    });
    if (!('id' in newRes)) throw new Error('reserve unexpectedly rejected');
    db.finalizeBudgetReservation(newRes.id, {
      cachedTokens: 500,
      uncachedTokens: 100,
      costUsdMicro: 80_000,
      durationMs: 1200,
    });

    // 4. Updated stats reflect the new finalized row.
    const after = db.workspaceStats('/legacy/wks');
    expect(after.callCount).toBe(3);
    expect(after.totalCostMicros).toBe(800_000 + 2_500_000 + 80_000);
    expect(after.inFlightReservedMicros).toBe(2_500_000); // Still just the legacy stuck row.

    // 5. v1.5.2-era stuck reservation (the duration_ms=0 row) is still
    //    discoverable. Operators can clean it up via cancelBudgetReservation
    //    if they detect a dead reservation from a crashed process.
    const stuckId = (raw as unknown as { exec: (sql: string) => unknown }) === undefined
      ? null
      : null; // (raw is closed; we look up by query)
    const reopened = new Database(dbPath, { readonly: true });
    const stuck = reopened
      .prepare(`SELECT id FROM usage_metrics WHERE duration_ms = 0 AND cost_usd_micro = 2500000`)
      .get() as { id: number } | undefined;
    reopened.close();
    expect(stuck?.id).toBeGreaterThan(0);

    db.close();
  });

  it('schema_meta version stays at "1" (no migration triggered)', () => {
    const dbPath = join(tmp, 'version-check.db');
    const db = new ManifestDb(dbPath);
    db.close();

    const reopened = new Database(dbPath, { readonly: true });
    const row = reopened.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as
      | { value: string }
      | undefined;
    reopened.close();
    expect(row?.value).toBe('1');
  });

  it('verifies sqlite3 schema columns are byte-identical between v1.5.2 expectation and v1.7.0 actual', () => {
    const dbPath = join(tmp, 'shape-check.db');
    const db = new ManifestDb(dbPath);
    db.close();

    const reopened = new Database(dbPath, { readonly: true });
    const colsFor = (table: string): Array<{ name: string; type: string; notnull: number }> =>
      reopened.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;

    // workspaces — same shape as v1.5.2 (and earlier)
    const wsCols = colsFor('workspaces').map((c) => `${c.name}:${c.type}`).join(',');
    expect(wsCols).toBe(
      'workspace_root:TEXT,files_hash:TEXT,model:TEXT,system_prompt_hash:TEXT,cache_id:TEXT,cache_expires_at:INTEGER,file_ids:TEXT,created_at:INTEGER,updated_at:INTEGER',
    );

    // usage_metrics — D#7's new field is NOT a column; it's derived from duration_ms.
    const umCols = colsFor('usage_metrics').map((c) => c.name).join(',');
    expect(umCols).toBe(
      'id,workspace_root,tool_name,model,cached_tokens,uncached_tokens,cost_usd_micro,duration_ms,occurred_at',
    );
    reopened.close();
  });
});
