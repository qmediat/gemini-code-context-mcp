/**
 * Resolution-order coverage for `resolveAuth()`.
 *
 * Tier 1 (Vertex env) > Tier 2 (credentials file) > Tier 3 (env var) > error.
 * Each tier is independently verified, plus the warn-on-env-key edge case.
 *
 * Uses `vi.stubEnv` / `vi.unstubAllEnvs` per the project convention established
 * by `preflight-guard.test.ts` (v1.5.0 PR #24) — Vitest snapshots/restores the
 * full env on its own, so individual restore-bookkeeping is not needed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveProfile } from '../../src/auth/credentials-store.js';
import { resolveAuth } from '../../src/auth/profile-loader.js';
import { logger } from '../../src/utils/logger.js';

describe('profile-loader.resolveAuth', () => {
  let tmpConfig: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpConfig = mkdtempSync(join(tmpdir(), 'gcctx-resolve-'));
    // Sandbox the credentials file under a temp dir.
    vi.stubEnv('XDG_CONFIG_HOME', tmpConfig);
    // Clear any inherited auth env so each test starts hermetic.
    // `vi.stubEnv(_, undefined)` removes the var without leaking real values.
    vi.stubEnv('GEMINI_USE_VERTEX', undefined);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
    vi.stubEnv('GEMINI_CREDENTIALS_PROFILE', undefined);
    vi.stubEnv('GEMINI_API_KEY', undefined);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
    rmSync(tmpConfig, { recursive: true, force: true });
  });

  describe('Tier 1 — Vertex env', () => {
    it('returns vertex profile when GEMINI_USE_VERTEX=true and GOOGLE_CLOUD_PROJECT set', () => {
      vi.stubEnv('GEMINI_USE_VERTEX', 'true');
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'my-gcp-project');
      const auth = resolveAuth();
      expect(auth.profile).toEqual({
        kind: 'vertex',
        project: 'my-gcp-project',
        location: 'us-central1',
      });
      expect(auth.source).toBe('vertex-env');
      expect(auth.keyFingerprint).toBe('vertex:adc');
    });

    it('honours GOOGLE_CLOUD_LOCATION override', () => {
      vi.stubEnv('GEMINI_USE_VERTEX', 'true');
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'p');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west1');
      const auth = resolveAuth();
      expect(auth.profile).toEqual({
        kind: 'vertex',
        project: 'p',
        location: 'europe-west1',
      });
    });

    it('skips Vertex when GOOGLE_CLOUD_PROJECT missing and falls through (warns)', () => {
      vi.stubEnv('GEMINI_USE_VERTEX', 'true');
      vi.stubEnv('GEMINI_API_KEY', 'AIzaFromEnvWhenVertexIncomplete');
      const auth = resolveAuth();
      expect(auth.source).toBe('env-var');
      expect(warnSpy).toHaveBeenCalled();
      const messages = warnSpy.mock.calls.map((c) => c[0] as string);
      expect(messages.some((m) => m.includes('GOOGLE_CLOUD_PROJECT'))).toBe(true);
    });

    it('does not activate Vertex when GEMINI_USE_VERTEX is unset/false', () => {
      vi.stubEnv('GEMINI_USE_VERTEX', 'false');
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'still-set');
      vi.stubEnv('GEMINI_API_KEY', 'AIzaFallback');
      const auth = resolveAuth();
      expect(auth.profile).toEqual({ kind: 'api-key', apiKey: 'AIzaFallback' });
    });
  });

  describe('Tier 2 — credentials file', () => {
    it('reads default profile when GEMINI_CREDENTIALS_PROFILE unset', () => {
      saveProfile('default', {
        geminiApiKey: 'AIzaFromDefaultProfile',
        defaultModel: 'latest-pro-thinking',
        dailyBudgetUsd: 7.5,
      });
      const auth = resolveAuth();
      expect(auth.profile).toEqual({ kind: 'api-key', apiKey: 'AIzaFromDefaultProfile' });
      expect(auth.source).toBe('credentials-file');
      expect(auth.defaultModel).toBe('latest-pro-thinking');
      expect(auth.dailyBudgetUsd).toBe(7.5);
      expect(auth.keyFingerprint).not.toBe('vertex:adc');
      expect(auth.keyFingerprint.length).toBeGreaterThan(0);
    });

    it('reads named profile when GEMINI_CREDENTIALS_PROFILE set', () => {
      saveProfile('work', { geminiApiKey: 'AIzaWorkKey' });
      vi.stubEnv('GEMINI_CREDENTIALS_PROFILE', 'work');
      const auth = resolveAuth();
      expect(auth.profile).toEqual({ kind: 'api-key', apiKey: 'AIzaWorkKey' });
      expect(auth.source).toBe('credentials-file');
    });

    it('returns vertex from profile file (vertexProject set)', () => {
      saveProfile('vertex-prof', {
        vertexProject: 'gcp-from-file',
        vertexLocation: 'asia-northeast1',
      });
      vi.stubEnv('GEMINI_CREDENTIALS_PROFILE', 'vertex-prof');
      const auth = resolveAuth();
      expect(auth.profile).toEqual({
        kind: 'vertex',
        project: 'gcp-from-file',
        location: 'asia-northeast1',
      });
      expect(auth.source).toBe('credentials-file');
    });

    it('falls through when named profile missing geminiApiKey AND vertexProject', () => {
      saveProfile('empty', { dailyBudgetUsd: 10 });
      vi.stubEnv('GEMINI_CREDENTIALS_PROFILE', 'empty');
      vi.stubEnv('GEMINI_API_KEY', 'AIzaEnvFallback');
      const auth = resolveAuth();
      expect(auth.source).toBe('env-var');
      expect(auth.profile).toEqual({ kind: 'api-key', apiKey: 'AIzaEnvFallback' });
    });

    it('credentials file Tier 2 wins over env var Tier 3', () => {
      saveProfile('default', { geminiApiKey: 'AIzaProfileWins' });
      vi.stubEnv('GEMINI_API_KEY', 'AIzaEnvLoses');
      const auth = resolveAuth();
      expect(auth.profile).toEqual({ kind: 'api-key', apiKey: 'AIzaProfileWins' });
      expect(auth.source).toBe('credentials-file');
    });
  });

  describe('Tier 3 — env var', () => {
    it('returns env-var profile and warns', () => {
      vi.stubEnv('GEMINI_API_KEY', 'AIzaEnvOnly');
      const auth = resolveAuth();
      expect(auth.source).toBe('env-var');
      expect(auth.profile).toEqual({ kind: 'api-key', apiKey: 'AIzaEnvOnly' });
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('GEMINI_API_KEY');
      expect(msg).toContain('init');
    });

    it('treats empty GEMINI_API_KEY as missing', () => {
      vi.stubEnv('GEMINI_API_KEY', '');
      expect(() => resolveAuth()).toThrow(/No Gemini credentials/);
    });
  });

  describe('All-missing error', () => {
    it('throws actionable error listing all three options', () => {
      expect(() => resolveAuth()).toThrow(/No Gemini credentials/);
      try {
        resolveAuth();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toContain('init');
        expect(msg).toContain('GEMINI_USE_VERTEX');
        expect(msg).toContain('GEMINI_API_KEY');
        expect(msg).toContain('https://github.com/qmediat/gemini-code-context-mcp');
      }
    });
  });
});
