import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { logger, safeForLog } from '../utils/logger.js';
import { type MatchConfig, isFileIncluded, isPathExcluded } from './globs.js';

/**
 * A file with no extension whose first two bytes are `#!` is a script — `bin/review`, `scripts/deploy` — and counts
 * as source although no include extension names it. A dotfile (`.env`, `.npmrc`) is never one: its name is all
 * "extension" and the secret and config rules decide it.
 */
export function isExtensionless(relpath: string): boolean {
  const base = baseName(relpath);
  return base.length > 0 && !base.startsWith('.') && !base.includes('.');
}

function baseName(relpath: string): string {
  return relpath.slice(relpath.lastIndexOf('/') + 1);
}

/** Errors that mean "not a script" (gone, a directory, a pipe or socket with no writer) — every other one is logged. */
const NOT_A_SCRIPT_ERRORS: ReadonlySet<string> = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EAGAIN',
  'ENXIO',
]);

/**
 * Whether the file starts with `#!`. False for a file that is not a readable `#!` script — no `#!`, unreadable,
 * a directory, a named pipe — and the caller then treats it as not source. `O_NONBLOCK` keeps a named pipe from
 * blocking the open and the read (a no-op for a regular file; absent on Windows, which has no pipes in the tree).
 */
export async function startsWithShebang(absolutePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && !NOT_A_SCRIPT_ERRORS.has(code)) {
      logger.warn(
        `not indexed, cannot read the first bytes (${code}): ${safeForLog(absolutePath)}`,
      );
    }
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * The include rule every path that indexes or reads files uses: `isFileIncluded` (excluded directories, file names
 * and extensions; an include extension or filename), or an extensionless script under no excluded directory.
 */
export async function isSourceFile(
  absolutePath: string,
  relpath: string,
  config: MatchConfig,
): Promise<boolean> {
  if (isFileIncluded(relpath, config)) return true;
  if (!isExtensionless(relpath) || isPathExcluded(relpath, config, 'file')) return false;
  const base = baseName(relpath);
  if (config.excludeFileNames.some((n) => n.toLowerCase() === base.toLowerCase())) return false;
  return startsWithShebang(absolutePath);
}
