/**
 * Interactive `init` subcommand — guides the user through secure credential setup.
 *
 * Writes `~/.config/qmediat/credentials` with chmod 0600. Offers to print an MCP
 * host config snippet to paste into `~/.claude.json` (etc.) that references the
 * profile by name rather than embedding the key.
 */

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { credentialsPath, qmediatConfigDir } from '../utils/paths.js';
import { saveProfile } from './credentials-store.js';
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
  return await new Promise<string>((resolve) => {
    let buf = '';
    const listener = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          output.write('\n');
          input.off('data', listener);
          input.setRawMode?.(false);
          input.pause();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          output.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        buf += ch;
        output.write('*');
      }
    };
    input.setRawMode?.(true);
    input.resume();
    input.on('data', listener);
  });
}

function claudeCodeConfigDir(): string {
  return join(process.env.HOME ?? '', '.claude.json');
}

function detectGitUnderConfigDir(): boolean {
  try {
    const output = execSync('git rev-parse --show-toplevel 2>/dev/null', {
      cwd: qmediatConfigDir(),
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
    const profileName = profileInput.length > 0 ? profileInput : 'default';

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
