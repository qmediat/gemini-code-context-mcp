/**
 * Interactive `init` subcommand — guides the user through secure credential setup.
 *
 * Writes `~/.config/qmediat/credentials` with chmod 0600. Offers to print an MCP
 * host config snippet to paste into `~/.claude.json` (etc.) that references the
 * profile by name rather than embedding the key.
 */

import { execFileSync } from 'node:child_process';
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
      // Detach process-level handlers so repeated askHidden calls don't
      // accumulate listeners (Node warns at >10). `process.off` is a no-op
      // if the handler isn't registered, so calling unconditionally is safe.
      try {
        process.off('SIGINT', cleanup);
        process.off('exit', cleanup);
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
        // Strip ANSI escape sequences — they'd otherwise silently corrupt the key.
        // Handle the four main ESC forms that terminals emit during password entry:
        //   CSI:  ESC [ <params> <final-letter>       (arrow keys, Home/End)
        //   SS3:  ESC O <letter>                      (F1-F4 on xterm/tmux)
        //   OSC:  ESC ] <params> <BEL or ESC \>       (title sets, clipboard pastes)
        //   DCS:  ESC P <params> <ESC \>              (device control, rare)
        // Anything else starting with ESC is consumed as a 2-byte sequence (ESC + next).
        if (ch === '\u001b') {
          i += 1;
          const next = s[i];
          if (next === '[') {
            // CSI: skip params then the final letter.
            i += 1;
            while (i < s.length && !/[A-Za-z~]/.test(s[i] ?? '')) i += 1;
            i += 1;
          } else if (next === 'O') {
            // SS3: ESC O <letter> — consume the letter.
            i += 1; // skip 'O'
            if (i < s.length) i += 1; // skip final letter
          } else if (next === ']' || next === 'P') {
            // OSC / DCS: terminated by BEL (\x07) or ST (ESC \).
            i += 1; // skip ']' or 'P'
            while (i < s.length) {
              const c = s[i];
              if (c === '\u0007') {
                i += 1;
                break;
              }
              if (c === '\u001b' && s[i + 1] === '\\') {
                i += 2;
                break;
              }
              i += 1;
            }
          } else {
            // Unknown ESC-prefixed sequence: consume ESC + next byte.
            if (i < s.length) i += 1;
          }
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

function claudeCodeConfigPath(): string {
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
    // `execFileSync` (no shell) → no `2>/dev/null` quirks on Windows cmd.exe.
    // stderr suppressed via `stdio: ['ignore', 'pipe', 'ignore']`.
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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

    const claudeConfig = claudeCodeConfigPath();
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
