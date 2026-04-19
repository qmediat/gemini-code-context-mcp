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
});
