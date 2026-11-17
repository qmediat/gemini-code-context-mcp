/**
 * The four `ask_agentic` executors and the pass's watch: once its signal fired, an executor rejects with its reason —
 * `find_files` and `grep` read it at every directory and before every entry of their walk, `grep` around each file's
 * read, `list_directory` before every entry, `read_file` before, during and after its read — so a tools phase that hit
 * its bound stops its file-system work. Each of those checkpoints also reports progress.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkspaceRoot } from '../../src/tools/agentic/sandbox.js';
import {
  findFilesExecutor,
  grepExecutor,
  listDirectoryExecutor,
  readFileExecutor,
} from '../../src/tools/agentic/workspace-tools.js';

/** A read that blocks (a slow disk, a network file system): `readFile` of a file whose name ends with `blockedSuffix`
 * settles only when its signal fires — with no signal it never settles. */
const reads = vi.hoisted(() => ({ blockedSuffix: null as string | null }));

vi.mock('node:fs/promises', async () => {
  type Fs = typeof import('node:fs/promises');
  const actual = await vi.importActual<Fs>('node:fs/promises');
  const readFile = ((path: string, options?: { signal?: AbortSignal }) => {
    const blocked = reads.blockedSuffix !== null && String(path).endsWith(reads.blockedSuffix);
    if (!blocked) return actual.readFile(path, options as Parameters<Fs['readFile']>[1]);
    return new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () =>
        reject(new Error('The operation was aborted')),
      );
    });
  }) as Fs['readFile'];
  return { ...actual, readFile };
});

let root: string;

beforeEach(async () => {
  root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-agentic-abort-')));
  for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, name), '// needle\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  reads.blockedSuffix = null;
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

/** A real signal that fires `afterMs` from now: what an executor sees when the bound fires during its read. */
function signalFiringIn(afterMs: number): { signal: AbortSignal; reason: DOMException } {
  const controller = new AbortController();
  const reason = boundReason();
  setTimeout(() => controller.abort(reason), afterMs);
  return { signal: controller.signal, reason };
}

const READ_TEST_TIMEOUT_MS = 2_000;

describe('executors once the signal fired', () => {
  it('find_files stops before the next entry of a directory when the signal fires mid-walk', async () => {
    // read 1: the directory itself; read 2: before its first entry
    const { signal, reason } = signalFiringAtRead(2);

    await expect(findFilesExecutor(root, '*.ts', undefined, { signal })).rejects.toBe(reason);
  });

  it('find_files walks the whole tree while the signal has not fired', async () => {
    const { signal } = signalFiringAtRead(Number.POSITIVE_INFINITY);

    const result = await findFilesExecutor(root, '*.ts', undefined, { signal });

    expect(result.matches).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('grep stops at a subdirectory when the signal fired', async () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'd.ts'), '// needle\n');
    const signal = firedSignal();

    await expect(grepExecutor(root, 'needle', 'sub', undefined, { signal })).rejects.toBe(
      signal.reason,
    );
  });

  it('list_directory rejects with the reason before it reads the directory', async () => {
    const signal = firedSignal();

    await expect(listDirectoryExecutor(root, '.', undefined, { signal })).rejects.toBe(
      signal.reason,
    );
  });

  it("read_file rejects with the signal's reason, never as a missing file", async () => {
    const signal = firedSignal();

    await expect(
      readFileExecutor(root, 'a.ts', undefined, undefined, undefined, { signal }),
    ).rejects.toBe(signal.reason);
  });
});

describe('executors when the signal fires during their work', () => {
  it('list_directory stops between two entries', async () => {
    // read 1: before the directory is read; read 2: before its first entry
    const { signal, reason } = signalFiringAtRead(2);

    await expect(listDirectoryExecutor(root, '.', undefined, { signal })).rejects.toBe(reason);
  });

  it(
    "read_file's read in flight is aborted: it rejects with the signal's reason, never as a missing file",
    async () => {
      reads.blockedSuffix = 'a.ts';
      const { signal, reason } = signalFiringIn(20);

      await expect(
        readFileExecutor(root, 'a.ts', undefined, undefined, undefined, { signal }),
      ).rejects.toBe(reason);
    },
    READ_TEST_TIMEOUT_MS,
  );

  it(
    "grep's read in flight is aborted: it rejects with the signal's reason, never with a result",
    async () => {
      reads.blockedSuffix = 'c.ts';
      const { signal, reason } = signalFiringIn(20);

      await expect(grepExecutor(root, 'needle', undefined, undefined, { signal })).rejects.toBe(
        reason,
      );
    },
    READ_TEST_TIMEOUT_MS,
  );
});

describe('executors report their progress', () => {
  it('a walk reports progress at every directory and entry, a read around its read', async () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'd.ts'), '// needle\n');
    const ticks = { find: 0, read: 0 };

    await findFilesExecutor(root, '**/*.ts', undefined, { onProgress: () => ticks.find++ });
    await readFileExecutor(root, 'a.ts', undefined, undefined, undefined, {
      onProgress: () => ticks.read++,
    });

    // two directories, five entries (a.ts, b.ts, c.ts, sub, sub/d.ts)
    expect(ticks).toEqual({ find: 7, read: 2 });
  });
});
