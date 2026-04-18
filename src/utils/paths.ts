/**
 * XDG-compliant paths for qmediat config and state.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Config directory — `~/.config/qmediat/` (or `$XDG_CONFIG_HOME/qmediat/`). */
export function qmediatConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  // In test mode, require an explicit sandbox via XDG_CONFIG_HOME to prevent
  // accidental reads/writes against the developer's real credentials file.
  if (process.env.NODE_ENV === 'test' && (!xdg || xdg.length === 0)) {
    throw new Error(
      'qmediatConfigDir() refuses to resolve in NODE_ENV=test without XDG_CONFIG_HOME set — ' +
        'set it to a temp directory to avoid polluting real ~/.config/qmediat credentials.',
    );
  }
  return xdg && xdg.length > 0 ? join(xdg, 'qmediat') : join(homedir(), '.config', 'qmediat');
}

/**
 * State directory for manifest DB.
 *
 * Follows XDG base-dir when `XDG_STATE_HOME` is set (per spec:
 * https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html).
 * Otherwise defaults to `~/.qmediat/gemini-code-context-mcp/` — pre-XDG for
 * backwards compatibility with existing installs. Users on strict-XDG systems
 * (NixOS, some BSDs) can set `XDG_STATE_HOME=~/.local/state` to route here.
 */
export function qmediatStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, 'qmediat', 'gemini-code-context-mcp');
  }
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
