import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-supports.mjs');

interface CheckRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCheck(args: string[]): CheckRun {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('scripts/check-supports.mjs', () => {
  let dir: string;
  let readme: string;
  let pkg: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-supports-'));
    readme = join(dir, 'README.md');
    pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'demo', version: '2.4.1' }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when the Supports heading names the package version', () => {
    writeFileSync(readme, '# demo\n\n## Supports · version 2.4.1\n\n| Works in | Claude Code |\n');
    const run = runCheck([readme, pkg]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('2.4.1');
  });

  it('fails and names both versions when they differ', () => {
    writeFileSync(readme, '# demo\n\n## Supports · version 2.4.0\n');
    const run = runCheck([readme, pkg]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('version 2.4.0; package.json is 2.4.1');
  });

  it('fails when the README has no Supports heading', () => {
    writeFileSync(readme, '# demo\n\n## Supports\n\nversion 2.4.1\n');
    const run = runCheck([readme, pkg]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no "## Supports · version …" heading; package.json is 2.4.1');
  });

  it('fails when a file cannot be read', () => {
    const run = runCheck([join(dir, 'missing.md'), pkg]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('cannot read the versions');
  });

  it("holds for the repository's own README and package.json", () => {
    const run = runCheck([]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
