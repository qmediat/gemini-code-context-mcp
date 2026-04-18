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

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { logger } from '../utils/logger.js';
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

/**
 * Warn if the credentials file has permissions broader than owner-only on POSIX.
 * Windows NTFS ACLs can't be inspected via `mode`; we log a one-shot note there.
 */
function warnOnLoosePermissions(path: string): void {
  if (process.platform === 'win32') return;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn(
        `Credentials file ${path} has permissions 0${mode.toString(8).padStart(3, '0')} — group/other have access. Run 'chmod 0600 ${path}' to restrict.`,
      );
    }
  } catch {
    /* best-effort */
  }
}

/** Load all profiles from disk. Returns empty map if the file doesn't exist. */
export function loadCredentials(): ProfilesMap {
  const path = credentialsPath();
  if (!existsSync(path)) return new Map();
  warnOnLoosePermissions(path);
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

/**
 * Validate a profile name against injection vectors.
 *
 * INI section headers are `[name]` — if `name` contains `]`, `[`, `\n`, `\r`,
 * or `=`, a malicious name could create phantom sections or confuse the parser.
 * readline strips `\n` from interactive input, but a programmatic caller has no
 * such protection; this whitelist is the authoritative defense.
 */
export function sanitizeProfileName(name: string): string {
  // Block INI-syntax chars (`[`, `]`, `=`, `#`, `;`), whitespace-class chars
  // that readline may pass through (`\n`, `\r`, `\t`), and ASCII control chars
  // (`\x00`-`\x1f`). Unicode letters (accented, CJK, etc.) are allowed because
  // profile names are stored locally and displayed back to their creator — no
  // reason to restrict to ASCII.
  if (name.length === 0 || name.length > 32) {
    throw new Error(`Invalid profile name '${name}': must be 1-32 characters.`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars IS the intent here
  if (/[[\]=#;\n\r\t]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    throw new Error(
      `Invalid profile name '${name}': must not contain INI syntax chars ('[', ']', '=', '#', ';') or whitespace/control chars.`,
    );
  }
  return name;
}

/**
 * Persist a single profile, preserving other profiles.
 *
 * Writes atomically via `tmp + rename` so that a chmod / write failure never
 * leaves the secret on disk with the wrong permissions. On POSIX, tmp is
 * created with `O_EXCL` (`flag:'wx'`) to defeat symlink attacks between the
 * existence check and the write.
 */
export function saveProfile(name: string, data: ProfileData): void {
  const safeName = sanitizeProfileName(name);
  const dir = qmediatConfigDir();

  // Create OR tighten the config directory BEFORE any write. `mkdirSync({mode})`
  // only applies when creating — for an existing dir (possibly created by a
  // previous tool at 0o755), we need an explicit chmod up front so the symlink
  // window is as narrow as possible.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort — dir may be held by another process */
    }
  }

  const path = credentialsPath();
  const profiles = existsSync(path) ? loadCredentials() : new Map<string, ProfileData>();
  profiles.set(safeName, data);

  const content = serializeIni(profiles);
  // Random suffix (64 bits of entropy) defeats any attempt to predict the tmp
  // name and pre-create a symlink at that path. `flag: 'wx'` then additionally
  // fails if the path exists, so combined the attack surface is essentially nil.
  const tmpPath = `${path}.tmp.${randomBytes(8).toString('hex')}`;

  try {
    // `flag: 'wx'` → O_CREAT | O_EXCL — fails if tmpPath exists, preventing
    // symlink-attack overwrite of arbitrary targets.
    writeFileSync(tmpPath, content, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') {
      // Defensive: ensure perms even if umask altered the initial create mode.
      chmodSync(tmpPath, 0o600);
    } else {
      logger.warn(
        `Running on Windows — chmod(0600) has no effect on NTFS. The credentials file inherits ACLs from its parent directory. Verify access via: icacls "${path}"`,
      );
    }
    // Atomic on same filesystem. After this line, the secret is at `path`
    // with 0600 perms; there is no window where it exists with looser perms.
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
