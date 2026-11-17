/**
 * The four `ask_agentic` executors and the pass's abort signal: once it fired, an executor rejects with its reason —
 * `find_files` and `grep` read it at every directory and before every entry of their walk, `list_directory` before
 * every entry, `read_file` before and during its read — so a tools phase that hit its bound stops its file-system work.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspaceRoot } from '../../src/tools/agentic/sandbox.js';
import {
  findFilesExecutor,
  grepExecutor,
  listDirectoryExecutor,
  readFileExecutor,
} from '../../src/tools/agentic/workspace-tools.js';

let root: string;

beforeEach(async () => {
  root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-agentic-abort-')));
  for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, name), '// needle\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The reason a pass's clock aborts with. */
function boundReason(): DOMException {
  return new DOMException('Timed out after 60 ms (total wall-clock)', 'TimeoutError');
}

function firedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(boundReason());
  return controller.signal;
}

/**
 * A signal that fires at its `firesAtRead`-th read of `aborted`: what a walk sees when the bound fires between two of
 * its checks.
 */
function signalFiringAtRead(firesAtRead: number): { signal: AbortSignal; reason: DOMException } {
  const reason = boundReason();
  let reads = 0;
  const signal = {
    get aborted() {
      reads += 1;
      return reads >= firesAtRead;
    },
    reason,
  } as unknown as AbortSignal;
  return { signal, reason };
}

describe('executors once the signal fired', () => {
  it('find_files stops before the next entry of a directory when the signal fires mid-walk', async () => {
    // read 1: the directory itself; read 2: before its first entry
    const { signal, reason } = signalFiringAtRead(2);

    await expect(findFilesExecutor(root, '*.ts', undefined, signal)).rejects.toBe(reason);
  });

  it('find_files walks the whole tree while the signal has not fired', async () => {
    const { signal } = signalFiringAtRead(Number.POSITIVE_INFINITY);

    const result = await findFilesExecutor(root, '*.ts', undefined, signal);

    expect(result.matches).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('grep stops at a subdirectory when the signal fired', async () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'd.ts'), '// needle\n');
    const signal = firedSignal();

    await expect(grepExecutor(root, 'needle', 'sub', undefined, signal)).rejects.toBe(
      signal.reason,
    );
  });

  it('list_directory rejects with the reason before it reads the directory', async () => {
    const signal = firedSignal();

    await expect(listDirectoryExecutor(root, '.', undefined, signal)).rejects.toBe(signal.reason);
  });

  it("read_file rejects with the signal's reason, never as a missing file", async () => {
    const signal = firedSignal();

    await expect(
      readFileExecutor(root, 'a.ts', undefined, undefined, undefined, signal),
    ).rejects.toBe(signal.reason);
  });
});
