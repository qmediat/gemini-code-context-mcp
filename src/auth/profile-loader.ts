/**
 * Resolve the active auth profile for this process.
 *
 * Resolution order (highest trust first):
 *   1. Vertex env (`GEMINI_USE_VERTEX=true` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`)
 *      → Tier 1 ADC-like (relies on gcloud ADC under the hood)
 *   2. Credentials profile file (`GEMINI_CREDENTIALS_PROFILE` env → profile name)
 *      → Tier 2 (0600 file)
 *   3. API key env var (`GEMINI_API_KEY`)
 *      → Tier 3 (logs a warning at startup)
 *
 * The server also exposes `GOOGLE_APPLICATION_CREDENTIALS` as an alternative ADC
 * path — that's picked up automatically by the SDK, nothing for us to do here.
 */

import type { AuthProfile } from '../types.js';
import { logger } from '../utils/logger.js';
import { type ProfileData, loadProfile } from './credentials-store.js';
import { fingerprint } from './fingerprint.js';

export interface ResolvedAuth {
  profile: AuthProfile;
  source: 'vertex-env' | 'credentials-file' | 'env-var';
  /** Default model override from the profile, if any. */
  defaultModel?: string;
  /** Daily budget cap in USD, if configured. */
  dailyBudgetUsd?: number;
  /** Safe key preview for logging. */
  keyFingerprint: string;
}

function readProfileEnvName(): string {
  const name = process.env.GEMINI_CREDENTIALS_PROFILE;
  return name && name.length > 0 ? name : 'default';
}

function tryVertex(): ResolvedAuth | null {
  if (process.env.GEMINI_USE_VERTEX !== 'true') return null;
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
  if (!project) {
    logger.warn(
      'GEMINI_USE_VERTEX=true but GOOGLE_CLOUD_PROJECT is not set — skipping Vertex profile.',
    );
    return null;
  }
  return {
    profile: { kind: 'vertex', project, location },
    source: 'vertex-env',
    keyFingerprint: 'vertex:adc',
  };
}

function tryCredentialsFile(): ResolvedAuth | null {
  const name = readProfileEnvName();
  let profileData: ProfileData;
  try {
    profileData = loadProfile(name);
  } catch {
    return null;
  }

  if (profileData.vertexProject) {
    return {
      profile: {
        kind: 'vertex',
        project: profileData.vertexProject,
        location: profileData.vertexLocation ?? 'us-central1',
      },
      source: 'credentials-file',
      ...(profileData.defaultModel !== undefined ? { defaultModel: profileData.defaultModel } : {}),
      ...(profileData.dailyBudgetUsd !== undefined
        ? { dailyBudgetUsd: profileData.dailyBudgetUsd }
        : {}),
      keyFingerprint: 'vertex:adc',
    };
  }

  if (!profileData.geminiApiKey) return null;

  return {
    profile: { kind: 'api-key', apiKey: profileData.geminiApiKey },
    source: 'credentials-file',
    ...(profileData.defaultModel !== undefined ? { defaultModel: profileData.defaultModel } : {}),
    ...(profileData.dailyBudgetUsd !== undefined
      ? { dailyBudgetUsd: profileData.dailyBudgetUsd }
      : {}),
    keyFingerprint: fingerprint(profileData.geminiApiKey),
  };
}

function tryEnvKey(): ResolvedAuth | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.length === 0) return null;
  return {
    profile: { kind: 'api-key', apiKey: key },
    source: 'env-var',
    keyFingerprint: fingerprint(key),
  };
}

/** Resolve the best available auth profile, or throw with actionable instructions. */
export function resolveAuth(): ResolvedAuth {
  const vertex = tryVertex();
  if (vertex) return vertex;

  const file = tryCredentialsFile();
  if (file) return file;

  const env = tryEnvKey();
  if (env) {
    logger.warn(
      `API key loaded from GEMINI_API_KEY env var (fingerprint: ${env.keyFingerprint}). This is NOT recommended for production — run \`npx @qmediat.io/gemini-code-context-mcp init\` to move it to a secure credentials file (chmod 0600).`,
    );
    return env;
  }

  throw new Error(
    [
      'No Gemini credentials found.',
      '',
      'Choose one of:',
      '  1. Recommended: `npx @qmediat.io/gemini-code-context-mcp init` (guided setup)',
      '  2. `gcloud auth application-default login` + GEMINI_USE_VERTEX=true',
      '  3. Set GEMINI_API_KEY env var (quick test only)',
      '',
      'See: https://github.com/qmediat/gemini-code-context-mcp#setup',
    ].join('\n'),
  );
}
