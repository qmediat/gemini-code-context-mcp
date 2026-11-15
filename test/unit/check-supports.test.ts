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

const serverOf = (version: string, packages: unknown) => ({
  name: 'io.github.example/demo',
  version,
  packages,
});
const lockOf = (version: string, rootVersion: string) => ({
  name: 'demo',
  version,
  lockfileVersion: 3,
  packages: { '': { name: 'demo', version: rootVersion } },
});

describe('scripts/check-supports.mjs', () => {
  let dir: string;
  let readme: string;
  let pkg: string;

  /** Writes `value` as JSON to `name` in the throwaway directory. */
  const writeJson = (name: string, value: unknown): void => {
    writeFileSync(join(dir, name), JSON.stringify(value));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-supports-'));
    readme = join(dir, 'README.md');
    pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'demo', version: '2.4.1' }));
    writeJson('server.json', serverOf('2.4.1', [{ identifier: 'demo', version: '2.4.1' }]));
    writeJson('package-lock.json', lockOf('2.4.1', '2.4.1'));
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

  it('fails when package.json has no version', () => {
    writeFileSync(readme, '# demo\n\n## Supports · version 2.4.1\n');
    writeFileSync(pkg, JSON.stringify({ name: 'demo' }));
    const run = runCheck([readme, pkg]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('package.json has no version');
  });

  it('fails when the package.json version is not a string', () => {
    writeFileSync(readme, '# demo\n\n## Supports · version 1\n');
    writeFileSync(pkg, JSON.stringify({ name: 'demo', version: 1 }));
    const run = runCheck([readme, pkg]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('package.json version is not a string');
  });

  it('refuses a single file: both are named, or neither', () => {
    writeFileSync(readme, '# demo\n\n## Supports · version 2.4.1\n');
    const run = runCheck([readme]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('name both files');
  });

  describe('the version files beside package.json', () => {
    const writeVersions = (
      server: string,
      serverPackage: string,
      lock: string,
      lockRoot: string,
    ): void => {
      writeFileSync(readme, '# demo\n\n## Supports · version 2.4.1\n');
      writeJson('server.json', serverOf(server, [{ identifier: 'demo', version: serverPackage }]));
      writeJson('package-lock.json', lockOf(lock, lockRoot));
    };

    it('passes when server.json and package-lock.json name the package version, and says so', () => {
      writeVersions('2.4.1', '2.4.1', '2.4.1', '2.4.1');
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('README "Supports" and the version files name version 2.4.1');
    });

    it('fails on a stale top-level server.json version, naming the file, the value and the package version', () => {
      writeVersions('2.4.0', '2.4.1', '2.4.1', '2.4.1');
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe(
        'check-supports: server.json version is 2.4.0; package.json is 2.4.1\n',
      );
    });

    it('fails on a stale server.json packages[0].version', () => {
      writeVersions('2.4.1', '2.4.0', '2.4.1', '2.4.1');
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe(
        'check-supports: server.json packages[0].version is 2.4.0; package.json is 2.4.1\n',
      );
    });

    it('fails on a stale package-lock.json root version', () => {
      writeVersions('2.4.1', '2.4.1', '2.4.1', '2.4.0');
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe(
        'check-supports: package-lock.json packages[""].version is 2.4.0; package.json is 2.4.1\n',
      );
    });

    it('prints one line for each of two stale version fields', () => {
      writeVersions('2.4.0', '2.4.1', '2.4.0', '2.4.1');
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe(
        'check-supports: server.json version is 2.4.0; package.json is 2.4.1\n' +
          'check-supports: package-lock.json version is 2.4.0; package.json is 2.4.1\n',
      );
    });

    it('fails without server.json: the registry manifest is required', () => {
      writeVersions('2.4.1', '2.4.1', '2.4.1', '2.4.1');
      rmSync(join(dir, 'server.json'));
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe('check-supports: server.json is missing\n');
    });

    it('fails on a server.json whose packages is not an array', () => {
      writeVersions('2.4.1', '2.4.1', '2.4.1', '2.4.1');
      writeJson('server.json', serverOf('2.4.1', { identifier: 'demo', version: '2.4.1' }));
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe('check-supports: server.json packages is not an array\n');
    });

    it('fails without package-lock.json: the lockfile is required', () => {
      writeVersions('2.4.1', '2.4.1', '2.4.1', '2.4.1');
      rmSync(join(dir, 'package-lock.json'));
      const run = runCheck([readme, pkg]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe('check-supports: package-lock.json is missing\n');
    });

    it('checks a lockfile without a packages map (lockfileVersion 1) on its root version only', () => {
      writeVersions('2.4.1', '2.4.1', '2.4.1', '2.4.1');
      writeJson('package-lock.json', {
        name: 'demo',
        version: '2.4.1',
        lockfileVersion: 1,
        dependencies: {},
      });
      const run = runCheck([readme, pkg]);
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
    });
  });

  it("holds for the repository's own README and package.json", () => {
    const run = runCheck([]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
