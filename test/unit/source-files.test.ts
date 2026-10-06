/**
 * Which files count as source — for the eager scan and for every `ask_agentic` tool alike:
 *   - a `bin/` directory is source (CLIs, scripts), not build output;
 *   - an extensionless file that starts with `#!` is a script and counts as source;
 *   - an excluded directory nested anywhere (`pkg/node_modules`) is neither listed nor readable;
 *   - a FILE named like an excluded directory (`script/build`, `bin/release`) is a file, not that directory;
 *   - .NET build output under `bin/` stays out at any platform depth;
 *   - the scan reports what it left out.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDE_DIRS,
  defaultMatchConfig,
  isPathExcluded,
} from '../../src/indexer/globs.js';
import { clearHashCache } from '../../src/indexer/hasher.js';
import {
  isExtensionless,
  isSourceFile,
  startsWithShebang,
} from '../../src/indexer/source-files.js';
import { scanWorkspace } from '../../src/indexer/workspace-scanner.js';
import {
  SandboxError,
  resolveInsideWorkspace,
  resolveWorkspaceRoot,
} from '../../src/tools/agentic/sandbox.js';
import {
  findFilesExecutor,
  grepExecutor,
  listDirectoryExecutor,
  readFileExecutor,
} from '../../src/tools/agentic/workspace-tools.js';

function put(root: string, rel: string, text: string, executable = false): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
  if (executable) chmodSync(abs, 0o755);
}

/** A repo laid out like a shell-tool monorepo: scripts in `tool/bin/`, a nested vendored `node_modules`. */
function toolRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gcctx-src-'));
  put(root, 'tool/SKILL.md', '# tool\n');
  put(root, 'tool/bin/review', '#!/usr/bin/env bash\nreview_main() { echo run; }\n', true);
  put(root, 'tool/bin/helper.sh', 'helper() { :; }\n', true);
  put(root, 'tool/bin/data', 'not a script\n');
  put(root, 'tool/lib/ledger.sh', 'ledger() { :; }\n');
  put(root, 'pkg/index.js', 'module.exports = 1;\n');
  put(root, 'pkg/node_modules/dep/index.js', 'vendored\n');
  put(root, 'pkg/node_modules/dep/cli', '#!/usr/bin/env node\nvendored\n');
  return root;
}

describe('the rule for a source file', () => {
  it('leaves bin out of the always-excluded directories', () => {
    expect(DEFAULT_EXCLUDE_DIRS).not.toContain('bin');
    expect(isPathExcluded('tool/bin/review', defaultMatchConfig({}), 'file')).toBe(false);
  });

  it('treats an excluded directory nested anywhere as excluded, the directory itself included', () => {
    const config = defaultMatchConfig({});
    expect(isPathExcluded('pkg/node_modules', config, 'dir')).toBe(true);
    expect(isPathExcluded('pkg/node_modules/dep/index.js', config, 'file')).toBe(true);
    expect(isPathExcluded('pkg/node_modules_docs', config, 'dir')).toBe(false);
  });

  it('takes a file named like a default build directory for a file; a secret, dot or caller-excluded name still matches it', () => {
    const config = defaultMatchConfig({});
    expect(isPathExcluded('script/build', config, 'file')).toBe(false);
    expect(isPathExcluded('script/build', config, 'dir')).toBe(true);
    expect(isPathExcluded('build', config, 'file')).toBe(false);
    expect(isPathExcluded('bin/release', config, 'file')).toBe(false);
    expect(isPathExcluded('.ssh', config, 'file')).toBe(true);
    expect(isPathExcluded('home/.aws', config, 'file')).toBe(true);
    expect(isPathExcluded('wt/.git', config, 'file')).toBe(true);
    const own = defaultMatchConfig({ excludeGlobs: ['deploy'] });
    expect(isPathExcluded('bin/deploy', own, 'file')).toBe(true);
    expect(isPathExcluded('notes/Documents', config, 'file')).toBe(true);
  });

  it('lets a caller exclude hide a file named like a default build directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-own-'));
    put(root, 'script/build', '#!/bin/sh\nprivate\n', true);
    const own = defaultMatchConfig({ excludeGlobs: ['build'] });
    expect(isPathExcluded('script/build', own, 'file')).toBe(true);
    expect(await isSourceFile(join(root, 'script/build'), 'script/build', own)).toBe(false);
    clearHashCache();
    const result = await scanWorkspace(root, {
      maxFiles: 1000,
      maxFileSizeBytes: 100_000,
      excludeGlobs: ['build'],
    });
    expect(result.files.map((f) => f.relpath)).toEqual([]);
  });

  it('excludes .NET build output under bin/ at the configuration or the platform level', () => {
    const config = defaultMatchConfig({});
    expect(isPathExcluded('App/bin/Debug', config, 'dir')).toBe(true);
    expect(isPathExcluded('App/bin/x64/Release', config, 'dir')).toBe(true);
    expect(isPathExcluded('App/bin/x64/Release/net8.0/App.xml', config, 'file')).toBe(true);
    expect(isPathExcluded('App/bin/x64', config, 'dir')).toBe(false);
    expect(isPathExcluded('App/bin/tool.json', config, 'file')).toBe(false);
  });

  it('calls a name without a dot extensionless, a dotfile never', () => {
    expect(isExtensionless('tool/bin/review')).toBe(true);
    expect(isExtensionless('Makefile')).toBe(true);
    expect(isExtensionless('tool/bin/helper.sh')).toBe(false);
    expect(isExtensionless('.env')).toBe(false);
    expect(isExtensionless('.npmrc')).toBe(false);
  });

  it('reads the #! of a script and nothing of a file without one', async () => {
    const root = toolRepo();
    expect(await startsWithShebang(join(root, 'tool/bin/review'))).toBe(true);
    expect(await startsWithShebang(join(root, 'tool/bin/data'))).toBe(false);
    expect(await startsWithShebang(join(root, 'tool/missing'))).toBe(false);
  });

  it('admits a #! script, never one under an excluded directory, one a caller excluded or one named like a secret file', async () => {
    const root = toolRepo();
    const config = defaultMatchConfig({});
    expect(await isSourceFile(join(root, 'tool/bin/review'), 'tool/bin/review', config)).toBe(true);
    expect(await isSourceFile(join(root, 'tool/bin/data'), 'tool/bin/data', config)).toBe(false);
    expect(
      await isSourceFile(
        join(root, 'pkg/node_modules/dep/cli'),
        'pkg/node_modules/dep/cli',
        config,
      ),
    ).toBe(false);
    put(root, 'tool/bin/review-excluded', '#!/bin/sh\n');
    const named = defaultMatchConfig({ excludeGlobs: ['review-excluded'] });
    expect(
      await isSourceFile(join(root, 'tool/bin/review-excluded'), 'tool/bin/review-excluded', named),
    ).toBe(false);
    put(root, 'tool/bin/credentials', '#!/bin/sh\necho token\n');
    expect(
      await isSourceFile(join(root, 'tool/bin/credentials'), 'tool/bin/credentials', config),
    ).toBe(false);
  });
});

describe('the eager scan', () => {
  beforeEach(() => clearHashCache());

  it('indexes bin/ and #! scripts, and reports the excluded directories and the non-source files', async () => {
    const root = toolRepo();
    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    expect(result.files.map((f) => f.relpath).sort()).toEqual([
      'pkg/index.js',
      'tool/SKILL.md',
      'tool/bin/helper.sh',
      'tool/bin/review',
      'tool/lib/ledger.sh',
    ]);
    expect(result.excludedDirs).toEqual(['pkg/node_modules']);
    expect(result.excludedDirsTotal).toBe(1);
    expect(result.skippedNonSource).toBe(1); // tool/bin/data
  });

  it('indexes #! scripts named like excluded directories (script/build, bin/release)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-named-'));
    put(root, 'script/build', '#!/bin/sh\nmake\n', true);
    put(root, 'bin/build', '#!/bin/sh\ndetect\n', true);
    put(root, 'bin/release', '#!/bin/sh\nrelease\n', true);
    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    expect(result.files.map((f) => f.relpath).sort()).toEqual([
      'bin/build',
      'bin/release',
      'script/build',
    ]);
    expect(result.skippedNonSource).toBe(0);
  });

  it('names the first 50 excluded directories and counts them all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-many-'));
    for (let i = 0; i < 51; i += 1) put(root, `packages/p${i}/node_modules/dep/index.js`, 'x\n');
    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    expect(result.excludedDirs).toHaveLength(50);
    expect(result.excludedDirsTotal).toBe(51);
  });

  it('keeps the .NET build output under bin/ out, json and xml copies included, at any platform depth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-dotnet-'));
    put(root, 'App/Program.cs', 'class P {}\n');
    put(root, 'App/bin/Debug/net8.0/App.deps.json', '{}\n');
    put(root, 'App/bin/Release/net8.0/App.xml', '<doc/>\n');
    put(root, 'App/bin/x64/Debug/net8.0/App.runtimeconfig.json', '{}\n');
    put(root, 'App/bin/tool.json', '{}\n');
    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    expect(result.files.map((f) => f.relpath).sort()).toEqual([
      'App/Program.cs',
      'App/bin/tool.json',
    ]);
    expect(result.excludedDirs).toEqual(['App/bin/Debug', 'App/bin/Release', 'App/bin/x64/Debug']);
  });
});

/** The tools work on the workspace's real path (the sandbox compares real paths; a temp dir may be a symlink). */
async function agenticRepo(): Promise<string> {
  return resolveWorkspaceRoot(toolRepo());
}

describe('the ask_agentic tools', () => {
  it('list a directory without its nested excluded directory', async () => {
    const root = await agenticRepo();
    const listed = await listDirectoryExecutor(root, 'pkg');
    expect(listed.entries.map((e) => e.relpath).sort()).toEqual(['pkg/index.js']);
  });

  it('refuse a nested excluded directory itself as excluded', async () => {
    const root = await agenticRepo();
    await expect(resolveInsideWorkspace(root, 'pkg/node_modules')).rejects.toBeInstanceOf(
      SandboxError,
    );
    await expect(listDirectoryExecutor(root, 'pkg/node_modules')).rejects.toMatchObject({
      code: 'EXCLUDED_DIR',
    });
  });

  it('read, find and grep a #! script under bin/', async () => {
    const root = await agenticRepo();
    const read = await readFileExecutor(root, 'tool/bin/review');
    expect(read.content).toContain('review_main');
    const found = await findFilesExecutor(root, '**/review');
    expect(found.matches).toEqual(['tool/bin/review']);
    const grep = await grepExecutor(root, 'review_main');
    expect(grep.matches.map((m) => m.relpath)).toEqual(['tool/bin/review']);
  });

  it('refuse an extensionless file without #! as not source, naming why', async () => {
    const root = await agenticRepo();
    await expect(readFileExecutor(root, 'tool/bin/data')).rejects.toMatchObject({
      code: 'NON_SOURCE_FILE',
      message: expect.stringContaining('not a readable #! script'),
    });
  });

  it('read and list a #! script named like an excluded directory', async () => {
    const root = await agenticRepo();
    put(root, 'script/build', '#!/bin/sh\nbuild_main\n', true);
    put(root, 'tool/bin/release', '#!/bin/sh\nrelease_main\n', true);
    expect((await readFileExecutor(root, 'script/build')).content).toContain('build_main');
    expect((await readFileExecutor(root, 'tool/bin/release')).content).toContain('release_main');
    const listed = await listDirectoryExecutor(root, 'tool/bin');
    expect(listed.entries.map((e) => e.relpath)).toContain('tool/bin/release');
    expect((await resolveInsideWorkspace(root, 'script/build')).kind).toBe('file');
  });

  it('refuse a file named like a secret-bearing directory, and .NET output at the platform level', async () => {
    const root = await agenticRepo();
    put(root, '.aws', '[default]\n');
    await expect(resolveInsideWorkspace(root, '.aws')).rejects.toMatchObject({
      code: 'SECRET_DENYLIST',
    });
    put(root, 'App/bin/x64/Release/App.xml', '<doc/>\n');
    await expect(listDirectoryExecutor(root, 'App/bin/x64/Release')).rejects.toMatchObject({
      code: 'EXCLUDED_DIR',
    });
    await expect(readFileExecutor(root, 'App/bin/x64/Release/App.xml')).rejects.toMatchObject({
      code: 'EXCLUDED_DIR',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'refuse a named pipe, extensionless or with a source extension, without a read that would never end',
    async () => {
      const root = await agenticRepo();
      execFileSync('mkfifo', [join(root, 'tool/bin/pipe')]);
      expect(await startsWithShebang(join(root, 'tool/bin/pipe'))).toBe(false);
      await expect(readFileExecutor(root, 'tool/bin/pipe')).rejects.toMatchObject({
        code: 'NON_SOURCE_FILE',
      });
      execFileSync('mkfifo', [join(root, 'tool/lib/pipe.ts')]);
      await expect(readFileExecutor(root, 'tool/lib/pipe.ts')).rejects.toMatchObject({
        code: 'NON_SOURCE_FILE',
        message: expect.stringContaining('not a regular file'),
      });
    },
    2000,
  );
});
