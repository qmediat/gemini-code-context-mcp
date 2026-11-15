import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-addresses.mjs');
// The shared corpus (test/fixtures/address-corpus.json) holds the pattern's cases; every test address, there and here,
// is written with `(at)` for the at-sign and made an address by `withAtSign` at run time, so that this file holds none
// for the repository's own check to find.

interface Corpus {
  findings: { line: string; address?: string; addresses?: string[] }[];
  clean: string[];
  allowed: string[];
}

// The corpus every implementation of the check shares; `(at)` stands for the at-sign, so the file holds no address.
const CORPUS: Corpus = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'address-corpus.json'), 'utf8'),
);
const withAtSign = (text: string): string => text.replaceAll('(at)', '@');
const FOREIGN = withAtSign('someone(at)elsewhere.test');
const ENV = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() };

interface CheckRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCheck(args: string[], env: NodeJS.ProcessEnv = ENV): CheckRun {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(dir: string, args: string[]): number | null {
  return spawnSync('git', args, { cwd: dir, env: ENV }).status;
}

describe('scripts/check-addresses.mjs', () => {
  const made: string[] = [];

  /** A throwaway directory holding the files; a git repository tracking them unless `tracked` is false. */
  function makeRepo(files: Record<string, string>, tracked = true): string {
    const dir = mkdtempSync(join(tmpdir(), 'check-addresses-'));
    made.push(dir);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    if (!tracked) return dir;
    expect(git(dir, ['init', '-q'])).toBe(0);
    expect(git(dir, ['add', '--', ...Object.keys(files)])).toBe(0);
    return dir;
  }

  /** Tracks a symlink named `link.md` in the repository, pointing at `target`. */
  function trackLink(dir: string, target: string): void {
    symlinkSync(target, join(dir, 'link.md'));
    expect(git(dir, ['add', '--', 'link.md'])).toBe(0);
  }

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('fails on an address in another domain, naming its path and line', () => {
    const run = runCheck([makeRepo({ 'NOTES.md': `# notes\n\nwrite to ${FOREIGN} today\n` })]);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`NOTES.md:3: ${FOREIGN}\n`);
  });

  /** Runs the check on one file of `lines` and expects line N to report `found[N]`, in order, and nothing else. */
  function expectEachFound(lines: string[], found: string[][]): void {
    const run = runCheck([makeRepo({ 'NOTES.md': lines.join('\n') })]);
    expect(run.status).toBe(1);
    const expected = found.flatMap((addresses, index) =>
      addresses.map((address) => `NOTES.md:${index + 1}: ${address}\n`),
    );
    expect(run.stderr).toBe(expected.join(''));
  }

  it('reports every corpus finding as exactly its addresses, with its path and line', () => {
    expectEachFound(
      CORPUS.findings.map(({ line }) => withAtSign(line)),
      CORPUS.findings.map(({ address, addresses }) =>
        (addresses ?? [address ?? '']).map(withAtSign),
      ),
    );
  });

  it('finds no address in a corpus clean line', () => {
    const run = runCheck([makeRepo({ 'NOTES.md': CORPUS.clean.map(withAtSign).join('\n') })]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('allows every corpus allowed line', () => {
    const run = runCheck([makeRepo({ 'AUTHORS.md': CORPUS.allowed.map(withAtSign).join('\n') })]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('does not read a binary file or package-lock.json', () => {
    const run = runCheck([
      makeRepo({ 'logo.bin': `\0${FOREIGN}`, 'package-lock.json': `{ "author": "${FOREIGN}" }` }),
    ]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)(
    'exits 2 with one line when a tracked file cannot be read',
    () => {
      const dir = makeRepo({ 'NOTES.md': FOREIGN });
      chmodSync(join(dir, 'NOTES.md'), 0o000);
      const run = runCheck([dir]);
      chmodSync(join(dir, 'NOTES.md'), 0o644);
      expect(run.status).toBe(2);
      expect(run.stderr).toBe('check-addresses: cannot read NOTES.md: EACCES\n');
    },
  );

  it('exits 2 with one line when a tracked file vanished from the work tree', () => {
    const dir = makeRepo({ 'NOTES.md': 'nothing here\n' });
    rmSync(join(dir, 'NOTES.md'));
    const run = runCheck([dir]);
    expect(run.status).toBe(2);
    expect(run.stderr).toBe('check-addresses: cannot read NOTES.md: ENOENT\n');
  });

  it('reads a tracked symlink to a file inside the repository', () => {
    const dir = makeRepo({ 'kept.md': 'nothing here\n' });
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'target.md'), `write to ${FOREIGN}\n`);
    trackLink(dir, 'notes/target.md');
    const run = runCheck([dir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`link.md:1: ${FOREIGN}\n`);
  });

  it('exits 2 on a tracked symlink that leaves the repository, naming it a symlink', () => {
    const outside = makeRepo({ 'elsewhere.md': FOREIGN }, false);
    const dir = makeRepo({ 'kept.md': 'nothing here\n' });
    trackLink(dir, join(outside, 'elsewhere.md'));
    const run = runCheck([dir]);
    expect(run.status).toBe(2);
    expect(run.stderr).toBe(
      'check-addresses: cannot read link.md: not a file inside the repository (symlink)\n',
    );
  });

  it('exits 2 with one line when git cannot list the files', () => {
    const run = runCheck([makeRepo({ 'NOTES.md': FOREIGN }, false)]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^check-addresses: git cannot list the files of .*: fatal: .*\n$/);
  });

  it('names a git that fails without a word by its exit status', () => {
    const bin = makeRepo({ git: '#!/bin/sh\nexit 3\n' }, false);
    chmodSync(join(bin, 'git'), 0o755);
    const run = runCheck([bin], { ...ENV, PATH: `${bin}:${process.env.PATH}` });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^check-addresses: git cannot list the files of .*: exit 3\n$/);
  });

  it("holds for the repository's own tracked files", () => {
    const run = runCheck([]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
