/**
 * Read/write the local credentials file used by Tier-2 auth.
 *
 * File: `~/.config/qmediat/credentials` (chmod 0600).
 * Format: INI-like profile sections, compatible with AWS/Stripe conventions.
 *
 *   [default]
 *   gemini_api_key = AIza...
 *   daily_budget_usd = 10.00
 *   default_model = latest-pro
 *
 *   [work]
 *   gemini_api_key = AIza...
 *   default_model = latest-flash
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { credentialsPath, qmediatConfigDir } from '../utils/paths.js';

export interface ProfileData {
  geminiApiKey?: string;
  defaultModel?: string;
  dailyBudgetUsd?: number;
  vertexProject?: string;
  vertexLocation?: string;
}

type ProfilesMap = Map<string, ProfileData>;

/** Parse INI-style credentials content. */
function parseIni(raw: string): ProfilesMap {
  const profiles: ProfilesMap = new Map();
  let current: string | null = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch && sectionMatch[1] !== undefined) {
      current = sectionMatch[1].trim();
      if (!profiles.has(current)) profiles.set(current, {});
      continue;
    }

    if (current === null) continue;
    const kvMatch = /^([^=]+)=(.*)$/.exec(line);
    if (!kvMatch || kvMatch[1] === undefined || kvMatch[2] === undefined) continue;

    const key = kvMatch[1].trim();
    const value = kvMatch[2].trim();
    const data = profiles.get(current) as ProfileData;

    switch (key) {
      case 'gemini_api_key':
        data.geminiApiKey = value;
        break;
      case 'default_model':
        data.defaultModel = value;
        break;
      case 'daily_budget_usd': {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n)) data.dailyBudgetUsd = n;
        break;
      }
      case 'vertex_project':
        data.vertexProject = value;
        break;
      case 'vertex_location':
        data.vertexLocation = value;
        break;
      default:
        break;
    }
  }

  return profiles;
}

/** Serialize profiles back to INI format. */
function serializeIni(profiles: ProfilesMap): string {
  const chunks: string[] = [
    '# qmediat credentials — keep this file private (chmod 0600)',
    '# Do NOT commit to version control.',
    '',
  ];

  for (const [name, data] of profiles) {
    chunks.push(`[${name}]`);
    if (data.geminiApiKey !== undefined) chunks.push(`gemini_api_key = ${data.geminiApiKey}`);
    if (data.defaultModel !== undefined) chunks.push(`default_model = ${data.defaultModel}`);
    if (data.dailyBudgetUsd !== undefined) {
      chunks.push(`daily_budget_usd = ${data.dailyBudgetUsd.toFixed(2)}`);
    }
    if (data.vertexProject !== undefined) chunks.push(`vertex_project = ${data.vertexProject}`);
    if (data.vertexLocation !== undefined) chunks.push(`vertex_location = ${data.vertexLocation}`);
    chunks.push('');
  }

  return chunks.join('\n');
}

/** Load all profiles from disk. Returns empty map if the file doesn't exist. */
export function loadCredentials(): ProfilesMap {
  const path = credentialsPath();
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, 'utf8');
    return parseIni(raw);
  } catch {
    return new Map();
  }
}

/** Load a single profile. Throws if missing. */
export function loadProfile(name: string): ProfileData {
  const profiles = loadCredentials();
  const profile = profiles.get(name);
  if (!profile) {
    throw new Error(
      `Credentials profile '${name}' not found in ${credentialsPath()}. Run \`npx @qmediat.io/gemini-code-context-mcp init\` to create it.`,
    );
  }
  return profile;
}

/** Persist a single profile, preserving other profiles. */
export function saveProfile(name: string, data: ProfileData): void {
  const dir = qmediatConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const path = credentialsPath();
  const profiles = existsSync(path) ? loadCredentials() : new Map<string, ProfileData>();
  profiles.set(name, data);

  writeFileSync(path, serializeIni(profiles), { mode: 0o600 });
  // Defensive: force permissions even if umask or existing file allowed more.
  chmodSync(path, 0o600);
  // Defensive: also lock down parent directory.
  chmodSync(dirname(path), 0o700);
}
