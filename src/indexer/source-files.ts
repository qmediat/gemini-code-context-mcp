import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
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

/**
 * Whether a regular file starts with `#!`; false for anything else (a directory, a named pipe, a device) and when the
 * file cannot be read — the caller then treats it as not source. A named pipe is never opened for a blocking read: the
 * type is checked first, and `O_NONBLOCK` covers a path swapped for a pipe between the check and the open.
 */
export async function startsWithShebang(absolutePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!(await stat(absolutePath)).isFile()) return false;
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
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
  if (!isExtensionless(relpath) || isPathExcluded(relpath, config)) return false;
  const base = baseName(relpath);
  if (config.excludeFileNames.some((n) => n.toLowerCase() === base.toLowerCase())) return false;
  return startsWithShebang(absolutePath);
}
