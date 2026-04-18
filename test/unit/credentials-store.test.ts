import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProfile, saveProfile } from '../../src/auth/credentials-store.js';
import { credentialsPath, qmediatConfigDir } from '../../src/utils/paths.js';

describe('credentials store', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'gcctx-creds-'));
  });

  afterEach(() => {
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: intentional cleanup of env var
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it('writes and reads a profile with 0600 permissions', () => {
    saveProfile('default', {
      geminiApiKey: 'AIzaSyTEST123456789abcdef',
      defaultModel: 'latest-pro',
      dailyBudgetUsd: 5.5,
    });
    const profile = loadProfile('default');
    expect(profile.geminiApiKey).toBe('AIzaSyTEST123456789abcdef');
    expect(profile.defaultModel).toBe('latest-pro');
    expect(profile.dailyBudgetUsd).toBe(5.5);

    // Check permissions on POSIX platforms (Windows stat mode is noisy).
    if (process.platform !== 'win32') {
      const mode = statSync(credentialsPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('preserves other profiles when saving a new one', () => {
    saveProfile('default', { geminiApiKey: 'AIzaFirst1234567890abcdef' });
    saveProfile('work', { geminiApiKey: 'AIzaSecond1234567890abcdef' });
    expect(loadProfile('default').geminiApiKey).toBe('AIzaFirst1234567890abcdef');
    expect(loadProfile('work').geminiApiKey).toBe('AIzaSecond1234567890abcdef');
  });

  it('throws an actionable error when the profile is missing', () => {
    expect(() => loadProfile('nonexistent')).toThrow(/not found/);
    expect(() => loadProfile('nonexistent')).toThrow(/init/);
  });

  it('stores vertex configuration', () => {
    saveProfile('prod', {
      vertexProject: 'my-gcp-project',
      vertexLocation: 'europe-west1',
      defaultModel: 'latest-pro',
    });
    const p = loadProfile('prod');
    expect(p.vertexProject).toBe('my-gcp-project');
    expect(p.vertexLocation).toBe('europe-west1');
    expect(p.defaultModel).toBe('latest-pro');
  });

  it('writes the file under the qmediat config directory', () => {
    saveProfile('test', { geminiApiKey: 'AIzaAbCdEfGhIjKlMnOp' });
    expect(credentialsPath()).toContain(qmediatConfigDir());
  });
});
