import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestDb } from '../../src/manifest/db.js';

describe('ManifestDb', () => {
  let db: ManifestDb;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gcctx-db-'));
    db = new ManifestDb(join(tmp, 'manifest.db'));
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a workspace row', () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot: '/tmp/wks',
      filesHash: 'deadbeef',
      model: 'gemini-3-pro-preview',
      systemPromptHash: 'abc123',
      cacheId: 'cachedContents/xyz',
      cacheExpiresAt: now + 3600 * 1000,
      fileIds: ['files/1', 'files/2'],
      createdAt: now,
      updatedAt: now,
    });
    const loaded = db.getWorkspace('/tmp/wks');
    expect(loaded).toMatchObject({
      workspaceRoot: '/tmp/wks',
      filesHash: 'deadbeef',
      model: 'gemini-3-pro-preview',
      cacheId: 'cachedContents/xyz',
      fileIds: ['files/1', 'files/2'],
    });
  });

  it('deduplicates file IDs by content hash', () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot: '/tmp/wks',
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    db.upsertFile({
      workspaceRoot: '/tmp/wks',
      relpath: 'src/a.ts',
      contentHash: 'hashA',
      fileId: 'files/aaa',
      uploadedAt: now,
      expiresAt: now + 3600 * 1000,
    });
    expect(db.findFileIdByHash('/tmp/wks', 'hashA', now)).toBe('files/aaa');
    expect(db.findFileIdByHash('/tmp/wks', 'missing', now)).toBeNull();
  });

  it('ignores file IDs that have expired', () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot: '/tmp/wks',
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    db.upsertFile({
      workspaceRoot: '/tmp/wks',
      relpath: 'src/a.ts',
      contentHash: 'hashA',
      fileId: 'files/aaa',
      uploadedAt: now - 10_000,
      expiresAt: now - 1,
    });
    expect(db.findFileIdByHash('/tmp/wks', 'hashA', now)).toBeNull();
  });

  it('aggregates usage metrics', () => {
    const now = Date.now();
    db.insertUsageMetric({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      cachedTokens: 100,
      uncachedTokens: 50,
      costUsdMicro: 1500,
      durationMs: 1234,
      occurredAt: now,
    });
    db.insertUsageMetric({
      workspaceRoot: '/tmp/wks',
      toolName: 'code',
      model: 'gemini-3-pro-preview',
      cachedTokens: 200,
      uncachedTokens: 80,
      costUsdMicro: 2000,
      durationMs: 2000,
      occurredAt: now,
    });
    const stats = db.workspaceStats('/tmp/wks');
    expect(stats.callCount).toBe(2);
    expect(stats.totalCachedTokens).toBe(300);
    expect(stats.totalUncachedTokens).toBe(130);
    expect(stats.totalCostMicros).toBe(3500);
  });

  it('reserves budget atomically and rejects when cap would be exceeded', () => {
    const now = Date.now();
    // Cap: $0.01 = 10_000 micros.
    const cap = 10_000;

    // First reservation — fits.
    const r1 = db.reserveBudget({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      estimatedCostMicros: 6_000,
      dailyBudgetMicros: cap,
      nowMs: now,
    });
    expect('id' in r1).toBe(true);

    // Second reservation — would push over cap (6_000 + 5_000 > 10_000).
    const r2 = db.reserveBudget({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      estimatedCostMicros: 5_000,
      dailyBudgetMicros: cap,
      nowMs: now,
    });
    expect('rejected' in r2).toBe(true);
    if ('rejected' in r2) {
      expect(r2.spentMicros).toBe(6_000);
      expect(r2.capMicros).toBe(cap);
    }
  });

  it('finalizes a reservation with the measured cost', () => {
    const now = Date.now();
    const r = db.reserveBudget({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      estimatedCostMicros: 8_000,
      dailyBudgetMicros: 100_000,
      nowMs: now,
    });
    expect('id' in r).toBe(true);
    if (!('id' in r)) throw new Error('reservation rejected');

    db.finalizeBudgetReservation(r.id, {
      cachedTokens: 500,
      uncachedTokens: 200,
      costUsdMicro: 3_500,
      durationMs: 1234,
    });

    const stats = db.workspaceStats('/tmp/wks');
    expect(stats.callCount).toBe(1);
    expect(stats.totalCachedTokens).toBe(500);
    expect(stats.totalUncachedTokens).toBe(200);
    // Actual cost (3_500) overwrites the estimate (8_000).
    expect(stats.totalCostMicros).toBe(3_500);
  });

  it('cancels a reservation so its estimate does not burn budget', () => {
    const now = Date.now();
    const cap = 20_000;

    const r = db.reserveBudget({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      estimatedCostMicros: 15_000,
      dailyBudgetMicros: cap,
      nowMs: now,
    });
    expect('id' in r).toBe(true);
    if (!('id' in r)) throw new Error('reservation rejected');

    db.cancelBudgetReservation(r.id);

    // After cancellation, a fresh reservation with the same estimate fits again.
    const r2 = db.reserveBudget({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      estimatedCostMicros: 15_000,
      dailyBudgetMicros: cap,
      nowMs: now,
    });
    expect('id' in r2).toBe(true);
  });

  it("counts only today's reservations against the cap (UTC midnight boundary)", () => {
    const now = Date.now();
    // Insert an "yesterday" high-cost row directly so we can verify the
    // daily SUM excludes it.
    const yesterday = now - 25 * 3600 * 1000;
    db.insertUsageMetric({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      cachedTokens: 0,
      uncachedTokens: 0,
      costUsdMicro: 999_999_999,
      durationMs: 0,
      occurredAt: yesterday,
    });

    const r = db.reserveBudget({
      workspaceRoot: '/tmp/wks',
      toolName: 'ask',
      model: 'gemini-3-pro-preview',
      estimatedCostMicros: 5_000,
      dailyBudgetMicros: 10_000,
      nowMs: now,
    });
    // Yesterday's massive row must NOT count — reservation fits under today's cap.
    expect('id' in r).toBe(true);
  });

  it('cascades file deletes when a workspace is deleted', () => {
    const now = Date.now();
    db.upsertWorkspace({
      workspaceRoot: '/tmp/wks',
      filesHash: 'h',
      model: 'm',
      systemPromptHash: '',
      cacheId: null,
      cacheExpiresAt: null,
      fileIds: [],
      createdAt: now,
      updatedAt: now,
    });
    db.upsertFile({
      workspaceRoot: '/tmp/wks',
      relpath: 'a.ts',
      contentHash: 'h',
      fileId: 'files/a',
      uploadedAt: now,
      expiresAt: now + 3600 * 1000,
    });
    expect(db.getFiles('/tmp/wks').length).toBe(1);
    db.deleteWorkspace('/tmp/wks');
    expect(db.getWorkspace('/tmp/wks')).toBeNull();
    expect(db.getFiles('/tmp/wks').length).toBe(0);
  });

  describe('D#7 (v1.7.0) — in-flight reservation visibility', () => {
    it('todaysInFlightReservedMicros returns sum of unfinalised rows only', () => {
      const now = Date.now();
      // Settled call (duration_ms > 0).
      const settled = db.reserveBudget({
        workspaceRoot: '/x',
        toolName: 'ask',
        model: 'gemini-x',
        estimatedCostMicros: 1_000_000, // $1.00
        dailyBudgetMicros: 100_000_000,
        nowMs: now,
      });
      if (!('id' in settled)) throw new Error('reserve rejected unexpectedly');
      db.finalizeBudgetReservation(settled.id, {
        cachedTokens: 0,
        uncachedTokens: 100,
        costUsdMicro: 800_000, // $0.80 actual
        durationMs: 1_500,
      });

      // In-flight (not finalised — still duration_ms = 0).
      const inFlight = db.reserveBudget({
        workspaceRoot: '/x',
        toolName: 'ask',
        model: 'gemini-x',
        estimatedCostMicros: 2_000_000, // $2.00 estimate
        dailyBudgetMicros: 100_000_000,
        nowMs: now,
      });
      expect('id' in inFlight).toBe(true);

      const todayTotal = db.todaysCostMicros(now);
      const todayInFlight = db.todaysInFlightReservedMicros(now);
      // Total includes both settled actual + in-flight estimate.
      expect(todayTotal).toBe(800_000 + 2_000_000);
      // In-flight is only the unfinalised slice.
      expect(todayInFlight).toBe(2_000_000);
    });

    it('workspaceStats.inFlightReservedMicros isolates the unfinalised slice', () => {
      const now = Date.now();
      const r1 = db.reserveBudget({
        workspaceRoot: '/wks',
        toolName: 'code',
        model: 'm',
        estimatedCostMicros: 500_000,
        dailyBudgetMicros: 100_000_000,
        nowMs: now,
      });
      if (!('id' in r1)) throw new Error('reserve rejected');
      db.finalizeBudgetReservation(r1.id, {
        cachedTokens: 0,
        uncachedTokens: 50,
        costUsdMicro: 400_000,
        durationMs: 800,
      });
      db.reserveBudget({
        workspaceRoot: '/wks',
        toolName: 'code',
        model: 'm',
        estimatedCostMicros: 1_500_000,
        dailyBudgetMicros: 100_000_000,
        nowMs: now,
      });

      const stats = db.workspaceStats('/wks');
      expect(stats.totalCostMicros).toBe(400_000 + 1_500_000);
      expect(stats.inFlightReservedMicros).toBe(1_500_000);
      // callCount counts BOTH rows (in-flight is a real row, just not finalised).
      expect(stats.callCount).toBe(2);
    });

    it('all-settled workspace reports inFlightReservedMicros = 0', () => {
      const now = Date.now();
      const r = db.reserveBudget({
        workspaceRoot: '/clean',
        toolName: 'ask',
        model: 'm',
        estimatedCostMicros: 100_000,
        dailyBudgetMicros: 10_000_000,
        nowMs: now,
      });
      if (!('id' in r)) throw new Error('reserve rejected');
      db.finalizeBudgetReservation(r.id, {
        cachedTokens: 0,
        uncachedTokens: 10,
        costUsdMicro: 80_000,
        durationMs: 500,
      });
      const stats = db.workspaceStats('/clean');
      expect(stats.inFlightReservedMicros).toBe(0);
      expect(stats.totalCostMicros).toBe(80_000);
    });
  });
});
