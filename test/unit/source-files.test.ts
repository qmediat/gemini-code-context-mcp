/**
 * Which files count as source — for the eager scan and for every `ask_agentic` tool alike:
 *   - a `bin/` directory is source (CLIs, scripts), not build output;
 *   - an extensionless file that starts with `#!` is a script and counts as source;
 *   - an excluded directory nested anywhere (`pkg/node_modules`) is neither listed nor readable;
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
    expect(isPathExcluded('tool/bin/review', defaultMatchConfig({}))).toBe(false);
  });

  it('treats an excluded directory nested anywhere as excluded, the directory itself included', () => {
    const config = defaultMatchConfig({});
    expect(isPathExcluded('pkg/node_modules', config)).toBe(true);
    expect(isPathExcluded('pkg/node_modules/dep/index.js', config)).toBe(true);
    expect(isPathExcluded('pkg/node_modules_docs', config)).toBe(false);
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

  it('admits a #! script, never one under an excluded directory or one excluded by name', async () => {
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
    expect(result.skippedNonSource).toBe(1); // tool/bin/data
  });

  it('keeps the .NET build output under bin/Debug and bin/Release out, json and xml copies included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcctx-dotnet-'));
    put(root, 'App/Program.cs', 'class P {}\n');
    put(root, 'App/bin/Debug/net8.0/App.deps.json', '{}\n');
    put(root, 'App/bin/Release/net8.0/App.xml', '<doc/>\n');
    put(root, 'App/bin/tool.json', '{}\n');
    const result = await scanWorkspace(root, { maxFiles: 1000, maxFileSizeBytes: 100_000 });
    expect(result.files.map((f) => f.relpath).sort()).toEqual([
      'App/Program.cs',
      'App/bin/tool.json',
    ]);
    expect(result.excludedDirs).toEqual(['App/bin/Debug', 'App/bin/Release']);
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
      message: expect.stringContaining('no #! line'),
    });
  });

  it.skipIf(process.platform === 'win32')(
    'refuse an extensionless named pipe without opening it for a read that would never end',
    async () => {
      const root = await agenticRepo();
      execFileSync('mkfifo', [join(root, 'tool/bin/pipe')]);
      expect(await startsWithShebang(join(root, 'tool/bin/pipe'))).toBe(false);
      await expect(readFileExecutor(root, 'tool/bin/pipe')).rejects.toMatchObject({
        code: 'NON_SOURCE_FILE',
      });
    },
    2000,
  );
});
