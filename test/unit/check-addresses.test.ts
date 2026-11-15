import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-addresses.mjs');
// Assembled at run time so that this file holds no foreign address for the repository's own check to find.
const FOREIGN = 'someone' + '@elsewhere.test';

interface CheckRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCheck(args: string[]): CheckRun {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() };
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('scripts/check-addresses.mjs', () => {
  let dir: string;

  /** Writes the files into the throwaway directory and, unless `tracked` is false, tracks them in a git repository. */
  function writeFiles(files: Record<string, string>, tracked = true): void {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    if (!tracked) return;
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-addresses-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on an address in another domain, naming its path and line', () => {
    writeFiles({ 'NOTES.md': `# notes\n\nwrite to ${FOREIGN} today\n` });
    const run = runCheck([dir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`NOTES.md:3: ${FOREIGN}\n`);
  });

  it('passes qmediat.io and the allowed addresses', () => {
    const text = [
      'dev@qmediat.io',
      'Security@QMediat.io',
      '12345+someone@users.noreply.github.com',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'jane@example.com, joe@example.org, ann@example.net',
    ].join('\n');
    writeFiles({ 'AUTHORS.md': text });
    const run = runCheck([dir]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('does not take an npm scope, a version pin or a git remote for an address', () => {
    const text =
      'npx @qmediat.io/gemini-code-context-mcp@1.2.3 "@modelcontextprotocol/sdk@1.29.x" zod@3.x git@github.com:qmediat/x.git';
    writeFiles({ 'README.md': text });
    expect(runCheck([dir]).status).toBe(0);
  });

  it('does not read a binary file or package-lock.json', () => {
    writeFiles({ 'logo.bin': `\0${FOREIGN}`, 'package-lock.json': `{ "author": "${FOREIGN}" }` });
    const run = runCheck([dir]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('exits 2 with one line when git cannot list the files', () => {
    writeFiles({ 'NOTES.md': FOREIGN }, false);
    const run = runCheck([dir]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^check-addresses: git cannot list the files of .*\n$/);
  });

  it("holds for the repository's own tracked files", () => {
    const run = runCheck([]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
