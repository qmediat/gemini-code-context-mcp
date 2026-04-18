/**
 * Interactive `init` subcommand — guides the user through secure credential setup.
 *
 * Writes `~/.config/qmediat/credentials` with chmod 0600. Offers to print an MCP
 * host config snippet to paste into `~/.claude.json` (etc.) that references the
 * profile by name rather than embedding the key.
 */

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { credentialsPath, qmediatConfigDir } from '../utils/paths.js';
import { sanitizeProfileName, saveProfile } from './credentials-store.js';
import { fingerprint } from './fingerprint.js';

type AuthMethod = 'api-key' | 'vertex';

async function askHidden(prompt: string): Promise<string> {
  // Refuse to read secrets when stdin is not a TTY. Piped input (`echo $KEY | init`)
  // leaves the key in shell history, pipe buffers, and screen-recorded CI logs.
  // Non-interactive environments should use GEMINI_API_KEY env var or Vertex ADC.
  if (!input.isTTY) {
    throw new Error(
      [
        'Cannot read a secret without a TTY (stdin is piped or redirected).',
        'To avoid leaking your key via shell history / CI logs, pick one of:',
        '  1. Run `init` in an interactive terminal.',
        '  2. Skip `init` and set GEMINI_API_KEY as an env var in your MCP host config (Tier 3, logs a warning).',
        '  3. Use Vertex: `gcloud auth application-default login` + GEMINI_USE_VERTEX=true + GOOGLE_CLOUD_PROJECT.',
      ].join('\n'),
    );
  }

  // Interactive TTY path: echo '*' for each char so users can verify length without leaking content.
  output.write(`${prompt} `);
  return await new Promise<string>((resolve, reject) => {
    let buf = '';
    // Ensure the terminal is ALWAYS restored, even on exit / uncaught errors.
    // Without this, Ctrl+C leaves the shell in raw mode — no echo, no line editing —
    // until the user blindly types `reset`.
    const cleanup = (): void => {
      try {
        input.off('data', listener);
        input.setRawMode?.(false);
        input.pause();
      } catch {
        /* best-effort */
      }
    };
    const listener = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === undefined) {
          i += 1;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          output.write('\n');
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C — restore terminal before exiting, otherwise the shell is left unusable.
          output.write('\n');
          cleanup();
          // Use reject so the caller's try/finally (runInit → rl.close) still fires.
          reject(new Error('Interrupted by user (Ctrl+C)'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            output.write('\b \b');
          }
          i += 1;
          continue;
        }
        // Strip ANSI escape sequences (arrow keys, Home/End, etc.) — they'd otherwise
        // silently corrupt the key. Arrow keys emit ESC[<letter>; we skip the whole
        // sequence up to the final letter.
        if (ch === '\u001b') {
          i += 1;
          // Skip optional '['
          if (s[i] === '[') i += 1;
          // Skip parameters until a final byte (a letter).
          while (i < s.length && !/[A-Za-z~]/.test(s[i] ?? '')) i += 1;
          // Skip the final letter.
          i += 1;
          continue;
        }
        // Reject other control chars (0x00-0x1F except handled above, and 0x7F).
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          i += 1;
          continue;
        }
        buf += ch;
        output.write('*');
        i += 1;
      }
    };
    process.once('SIGINT', cleanup);
    process.once('exit', cleanup);
    input.setRawMode?.(true);
    input.resume();
    input.on('data', listener);
  });
}

function claudeCodeConfigDir(): string {
  return join(process.env.HOME ?? '', '.claude.json');
}

/**
 * Detect whether the credentials directory sits inside a git-tracked tree.
 *
 * On a fresh install the credentials dir doesn't exist yet; running `git` there
 * fails with ENOENT and previously returned `false` — missing the warning for
 * users whose home / dotfiles repo tracks `~/.config/`. We walk up the path
 * hierarchy until we hit an existing ancestor and run the check from there.
 */
function detectGitUnderConfigDir(): boolean {
  let cwd = qmediatConfigDir();
  while (!existsSync(cwd)) {
    const parent = dirname(cwd);
    if (parent === cwd) return false;
    cwd = parent;
  }
  try {
    const output = execSync('git rev-parse --show-toplevel 2>/dev/null', {
      cwd,
      encoding: 'utf8',
    });
    const top = output.trim();
    return top.length > 0 && existsSync(top);
  } catch {
    return false;
  }
}

export async function runInit(): Promise<void> {
  const rl = createInterface({ input, output });
  const log = (line: string): void => {
    output.write(`${line}\n`);
  };

  try {
    log('');
    log('qmediat — gemini-code-context-mcp secure setup');
    log('==============================================');
    log('');
    log('This will store credentials in ~/.config/qmediat/credentials (chmod 0600).');
    log('Your MCP host config (~/.claude.json etc.) will only reference the profile name,');
    log('never the raw key.');
    log('');

    if (detectGitUnderConfigDir()) {
      log('Warning: ~/.config/qmediat appears to be inside a git repository.');
      log('   Make sure `qmediat/credentials` is .gitignored before continuing.');
      log('');
    }

    const methodInput = (
      await rl.question(
        'Auth method? [1] API key (Gemini Developer API), [2] Vertex AI (enterprise GCP)  [1]: ',
      )
    ).trim();
    const method: AuthMethod = methodInput === '2' ? 'vertex' : 'api-key';
    // Note: raw ADC without Vertex is not a supported path — @google/genai expects
    // either an API key or a Vertex configuration. Users who want ADC should pick
    // option 2 and let the SDK pick up GOOGLE_APPLICATION_CREDENTIALS automatically.

    const profileInput = (await rl.question('Profile name [default]: ')).trim();
    // Validate now so we fail fast with a clear message instead of at write time.
    let profileName: string;
    try {
      profileName = sanitizeProfileName(profileInput.length > 0 ? profileInput : 'default');
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      return;
    }

    const data: Parameters<typeof saveProfile>[1] = {};

    if (method === 'api-key') {
      const key = (await askHidden('Paste your Gemini API key (hidden):')).trim();
      if (key.length < 20) {
        log('Key looks too short — aborting.');
        return;
      }
      data.geminiApiKey = key;
    } else if (method === 'vertex') {
      const project = (await rl.question('GCP project ID: ')).trim();
      if (project.length === 0) {
        log('Project is required for Vertex. Aborting.');
        return;
      }
      const location = (await rl.question('Location [us-central1]: ')).trim() || 'us-central1';
      data.vertexProject = project;
      data.vertexLocation = location;
    }

    const modelInput = (await rl.question('Default model [latest-pro]: ')).trim();
    if (modelInput.length > 0) data.defaultModel = modelInput;

    const budgetInput = (await rl.question('Daily budget cap in USD (blank = no cap) []: ')).trim();
    if (budgetInput.length > 0) {
      const n = Number.parseFloat(budgetInput);
      if (Number.isFinite(n) && n > 0) data.dailyBudgetUsd = n;
    }

    saveProfile(profileName, data);

    log('');
    log(`Saved profile '${profileName}' to ${credentialsPath()} (chmod 0600).`);
    if (data.geminiApiKey) {
      log(`   Key fingerprint: ${fingerprint(data.geminiApiKey)}`);
    }
    log('');
    log('Add this to your MCP host config (no API key leaves this machine):');
    log('');
    log('  {');
    log('    "mcpServers": {');
    log('      "gemini-code-context": {');
    log('        "command": "npx",');
    log('        "args": ["-y", "@qmediat.io/gemini-code-context-mcp"],');
    log(
      `        "env": { "GEMINI_CREDENTIALS_PROFILE": "${profileName}"${method === 'vertex' ? ', "GEMINI_USE_VERTEX": "true"' : ''} }`,
    );
    log('      }');
    log('    }');
    log('  }');
    log('');

    const claudeConfig = claudeCodeConfigDir();
    if (existsSync(claudeConfig)) {
      const stats = statSync(claudeConfig);
      log(`Detected Claude Code config at ${claudeConfig} (${stats.size} bytes).`);
      log('Edit it by hand — we intentionally do not auto-modify it to avoid clobbering state.');
    }

    log('');
    log('Never commit the credentials file to git.');
  } finally {
    rl.close();
  }
}
