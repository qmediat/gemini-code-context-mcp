/**
 * XDG-compliant paths for qmediat config and state.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Config directory — `~/.config/qmediat/` (or `$XDG_CONFIG_HOME/qmediat/`). */
export function qmediatConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? join(xdg, 'qmediat') : join(homedir(), '.config', 'qmediat');
}

/** State directory for manifest DB — `~/.qmediat/gemini-code-context-mcp/`. */
export function qmediatStateDir(): string {
  return join(homedir(), '.qmediat', 'gemini-code-context-mcp');
}

/** Path to credentials file for a given profile. */
export function credentialsPath(): string {
  return join(qmediatConfigDir(), 'credentials');
}

/** Path to manifest SQLite DB. */
export function manifestDbPath(): string {
  return join(qmediatStateDir(), 'manifest.db');
}
