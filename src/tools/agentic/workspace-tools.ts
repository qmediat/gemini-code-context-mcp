/**
 * Executor functions for the four Gemini function-call tools used by
 * `ask_agentic`. Each executor takes a workspace-rooted sandbox (from
 * `./sandbox.ts`) and returns a JSON-serialisable result payload, or
 * throws `SandboxError` on security violations / missing files.
 *
 * Hard size limits applied unconditionally (Codex PR2 review critical):
 *   - `read_file` per-file:     ≤ 200 000 bytes returned (files over that
 *     get head-truncated and the response carries `truncated: true` + size
 *     metadata so the model can reason about the gap).
 *   - `grep` per-call response: ≤ 500 000 bytes of JSON body (matches
 *     truncated to fit, response carries `truncated: true`).
 *   - `list_directory` / `find_files`: capped by entry count (`MAX_LIST_ENTRIES`
 *     / `MAX_FIND_MATCHES`, both small integers) rather than a byte budget —
 *     each entry is a short record so the resulting JSON is bounded well
 *     under any per-call ceiling.
 *
 * Together these protect the per-iteration token budget from a single
 * minified bundle or a massive listing burning output tokens on one call.
 */

import type { Dirent, Stats } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { throwIfAborted } from '../../gemini/retry.js';
import { type MatchConfig, defaultMatchConfig, isPathExcluded } from '../../indexer/globs.js';
import { isSourceFile } from '../../indexer/source-files.js';
import { SandboxError, resolveInsideWorkspace } from './sandbox.js';

type ResolvedPath = Awaited<ReturnType<typeof resolveInsideWorkspace>>;

/**
 * Build a `MatchConfig` honouring the caller's `includeGlobs`/`excludeGlobs`
 * (v1.9.0+). When `matchConfig` is undefined, returns the defaults — the same
 * filter the eager `ask`/`code` scanner uses. The agentic executors below
 * route every dir-recurse and file-include decision through this config so
 * Phase 3's `ask` → `ask_agentic` fallback (v1.9.0) preserves the user's
 * filter semantics — no privacy regression where excluded paths leak into
 * the agentic loop's view.
 *
 * Falls back gracefully: existing test call-sites that don't pass a config
 * see the same behaviour they did pre-v1.9.0.
 */
function resolveMatchConfig(matchConfig: MatchConfig | undefined): MatchConfig {
  return matchConfig ?? defaultMatchConfig({});
}

/**
 * Exclude-side check for `list_directory` (v1.9.0+). Returns `true` when the
 * file should be hidden from a navigation listing — covers default filename
 * denylist (lockfiles, `.env*`, etc.), default extension denylist
 * (`.tsbuildinfo`), user `excludeGlobs` filename / extension entries, AND
 * dir-prefix excludes that match the file's parent path. Deliberately does
 * NOT enforce include-extension membership — `list_directory` is a
 * navigation aid; the read-side gate lives in `readFileExecutor`.
 *
 * Implemented as a separate predicate (not `isFileIncluded` from `globs.ts`)
 * because `isFileIncluded` REQUIRES an include-extension match to return
 * true, which is correct for indexing but wrong for listing.
 */
function isFileExcludedByConfig(relpath: string, basename: string, config: MatchConfig): boolean {
  if (isPathExcluded(relpath, config, 'file')) return true;
  const lowerBase = basename.toLowerCase();
  for (const name of config.excludeFileNames) {
    if (lowerBase === name.toLowerCase()) return true;
  }
  for (const ext of config.excludeExtensions) {
    if (lowerBase.endsWith(ext.toLowerCase())) return true;
  }
  return false;
}

/** Hard upper bound on any single `read_file` response body. Bigger files
 * get head-truncated + flagged — never fully expanded into the iteration.
 *
 * 200k bytes ≈ 50k tokens on source code — roughly 5% of a 1M context
 * window, i.e. small enough that one errant read won't derail a 20-
 * iteration budget, but large enough for practically every real source
 * file (the handful of exceptions are generated bundles we already
 * exclude via extension / default denylist). Adjustable via env if a
 * repo has legitimately massive generated code.
 */
const MAX_READ_BYTES = 200_000;

/** Hard upper bound on any single tool response JSON. Bounds what comes
 * back from `list_directory` / `find_files` / `grep`. 500k bytes is ~125k
 * tokens worst-case — still a lot, but keeps one bad response from
 * blowing the iteration budget. */
const MAX_RESPONSE_BYTES = 500_000;

/** Max lines returned in one `read_file` when no explicit slice — forces
 * the model to paginate very large source files. Used in addition to
 * `MAX_READ_BYTES`: whichever limit hits first wins. */
const DEFAULT_READ_LINE_LIMIT = 500;

/** Cap on per-call `grep` matches. More = ask again with narrower pattern. */
const MAX_GREP_MATCHES = 100;

/** Cap on directory entries returned by `list_directory` per call. */
const MAX_LIST_ENTRIES = 200;

/** Cap on `find_files` matches per call. */
const MAX_FIND_MATCHES = 200;

/**
 * Max recursion depth in `find_files` / `grep` walks. Protects against
 * call-stack overflow on deep directory trees (generated code, malformed
 * symlink loops) and bounds worst-case wall time. 20 levels comfortably
 * covers real source repos (typical max depth 7-10) without false
 * positives. Reported in PR #24 review by Grok.
 */
const MAX_WALK_DEPTH = 20;

// ---------------------------------------------------------------------------
// Small glob → RegExp converter.
// Supports `*` (any-except-slash), `**/` (zero-or-more dirs), and `**` (any
// incl. slash). No `?`, no character classes, no `{a,b}` yet — matches the
// claim in the tool schema description so the model doesn't burn iterations
// on unsupported patterns.
//
// Implementation uses Private-Use-Area sentinel characters (\uE000 / \uE001)
// to separate the `**`/`**\/` replacement from the single-`*` replacement,
// avoiding the lookbehind approach that v1.5.0 initially shipped with. That
// earlier version used `(?<!\.)\*` to "protect" escaped dots, but inadvertently
// blocked the `*` replacement whenever it was preceded by ANY escaped dot
// in the pattern — so `index.*`, `README.*`, `src/**/index.*` silently
// matched nothing. Sentinel-based transform was empirically verified
// against all affected patterns during PR #24 round-2 review (Grok P0,
// GPT P1, Gemini P1, Copilot P1, self-review P0).
//
// PUA codepoints are chosen over ASCII control chars (\u0001/\u0002) so the
// Biome `noControlCharactersInRegex` lint stays happy; they're equivalently
// safe because glob input from the Gemini tool-call arguments is plain text
// and can't contain these codepoints organically.
//
// Also handles `**/` specifically so that `**/*.ts` matches BOTH
// `index.ts` (root) and `src/index.ts` (nested). The earlier version's
// `**` → `.*` transform required at least one separator, silently
// skipping root-level matches.
// ---------------------------------------------------------------------------
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*\//g, '\uE000') // sentinel: `**/` → zero-or-more dirs
    .replace(/\*\*/g, '\uE001') // sentinel: bare `**` → any incl. slash
    .replace(/\*/g, '[^/]*') // single `*` → no-slash segment
    .replace(/\uE000/g, '(?:.*/)?') // dir-boundary expansion
    .replace(/\uE001/g, '.*'); // bare globstar
  // `i` flag: macOS (APFS) and Windows (NTFS) default to case-insensitive
  // filesystems — so `App.TS` and `app.ts` refer to the same inode. The
  // extension-gate lowercasing (above) handles the include-ext check, but
  // the user-supplied pattern still needs case-insensitive matching here,
  // otherwise `**/*.ts` skips `App.TS` even though `read_file` would allow
  // it (PR #24 round-4, Gemini P2 — true parity with readFileExecutor).
  return new RegExp(`^${pattern}$`, 'i');
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

export interface DirEntry {
  relpath: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
  totalEntries: number;
}

/** A listing as it is built: the entries returned (at most `MAX_LIST_ENTRIES`) and every entry counted. */
interface Listing {
  readonly entries: DirEntry[];
  total: number;
}

/**
 * The children of a directory the model asked to list. A path that exists but is a file is `NOT_A_DIRECTORY` (the model
 * then calls `read_file`), anything else `NOT_FOUND`.
 */
async function directoryEntries(
  target: ResolvedPath,
  relPath: string,
  signal: AbortSignal | undefined,
): Promise<Dirent<string>[]> {
  throwIfAborted(signal);
  try {
    return await readdir(target.absolutePath, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : undefined;
    if (code === 'ENOTDIR') {
      throw new SandboxError(
        'NOT_A_DIRECTORY',
        `${target.relpath || '.'} is a file, not a directory — use read_file instead`,
        relPath,
      );
    }
    throw new SandboxError('NOT_FOUND', `cannot list: ${String(err)}`, relPath);
  }
}

/**
 * A child as a listing shows it, or `null` when it is hidden: symlinks, sockets and other non-file, non-directory
 * entries are skipped; an excluded directory (defaults and the caller's `excludeGlobs`, matched on the full nested
 * path) and an excluded file are omitted. A file is NOT required to match an include extension: `list_directory` is a
 * navigation aid, the read-side gate is `read_file`'s.
 */
function visibleChild(
  parentRel: string,
  entry: Dirent<string>,
  config: MatchConfig,
): DirEntry | null {
  const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : null;
  if (type === null) return null;
  const relpath = parentRel ? `${parentRel}/${entry.name}` : entry.name;
  const hidden =
    type === 'dir'
      ? isPathExcluded(relpath, config, 'dir')
      : isFileExcludedByConfig(relpath, entry.name, config);
  return hidden ? null : { relpath, type };
}

/** Add one child to a listing: past `MAX_LIST_ENTRIES` it is counted, not returned; a file's size is omitted when its
 * `stat` fails. */
async function listEntry(
  target: ResolvedPath,
  entry: Dirent<string>,
  config: MatchConfig,
  listing: Listing,
): Promise<void> {
  const child = visibleChild(target.relpath, entry, config);
  if (child === null) return;
  listing.total += 1;
  if (listing.entries.length >= MAX_LIST_ENTRIES) return;
  if (child.type === 'file') {
    try {
      child.size = (await stat(join(target.absolutePath, entry.name))).size;
    } catch {
      /* stat failure — omit size, still include entry */
    }
  }
  listing.entries.push(child);
}

/**
 * List immediate children of `relPath` (non-recursive). Default-excluded dirs and denylisted filenames are omitted; the
 * model sees only paths it is allowed to ask for via `read_file` / `grep`. The requested directory itself is checked
 * against the caller's `excludeGlobs` first — with a message that names no path, so success vs `NOT_FOUND` is no oracle
 * for an excluded directory's existence. `signal` is read before each entry.
 */
export async function listDirectoryExecutor(
  workspaceRoot: string,
  relPath: string,
  matchConfig?: MatchConfig,
  signal?: AbortSignal,
): Promise<ListDirectoryResult> {
  const target = await resolveInsideWorkspace(workspaceRoot, relPath);
  const config = resolveMatchConfig(matchConfig);
  if (target.relpath && isPathExcluded(target.relpath, config, target.kind)) {
    throw new SandboxError('EXCLUDED_DIR', 'directory is excluded by configured policy', relPath);
  }
  const listing: Listing = { entries: [], total: 0 };
  for (const entry of await directoryEntries(target, relPath, signal)) {
    throwIfAborted(signal);
    await listEntry(target, entry, config, listing);
  }
  return {
    path: target.relpath || '.',
    entries: listing.entries,
    truncated: listing.total > listing.entries.length,
    totalEntries: listing.total,
  };
}

// ---------------------------------------------------------------------------
// find_files / grep: one walk
// ---------------------------------------------------------------------------

/** One recursive walk of `find_files` or `grep`: what it filters with, what it visits, when it stops. */
interface TreeWalk {
  readonly config: MatchConfig;
  readonly signal: AbortSignal | undefined;
  /** Real (symlink-resolved) directories already walked: a directory loop (`dir/self -> dir`) is walked once. */
  readonly seenReal: Set<string>;
  /** Called with each file the policy lets the model see: defaults and user excludes, an include extension or `#!`. */
  readonly visitFile: (absFile: string, relFile: string) => Promise<void>;
  /** `true` once the walk has gathered all it may return. */
  readonly full: () => boolean;
  depthExceeded: boolean;
}

function treeWalk(
  config: MatchConfig,
  signal: AbortSignal | undefined,
  visitFile: TreeWalk['visitFile'],
  full: TreeWalk['full'] = () => false,
): TreeWalk {
  return { config, signal, seenReal: new Set<string>(), visitFile, full, depthExceeded: false };
}

/** A directory's entries, or `null` when it was walked already (a symlink loop) or cannot be read. */
async function enterDirectory(
  walk: TreeWalk,
  currentAbs: string,
): Promise<Dirent<string>[] | null> {
  try {
    const real = await realpath(currentAbs);
    if (walk.seenReal.has(real)) return null;
    walk.seenReal.add(real);
  } catch {
    return null;
  }
  try {
    return await readdir(currentAbs, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return null;
  }
}

/** One entry of a walked directory: an included directory is walked, a visible file visited, the rest skipped. */
async function walkEntry(
  walk: TreeWalk,
  entry: Dirent<string>,
  parent: { abs: string; rel: string; depth: number },
): Promise<void> {
  const childRel = parent.rel ? `${parent.rel}/${entry.name}` : entry.name;
  const childAbs = join(parent.abs, entry.name);
  if (entry.isDirectory()) {
    if (isPathExcluded(childRel, walk.config, 'dir')) return;
    await walkTree(walk, childAbs, childRel, parent.depth + 1);
    return;
  }
  if (!entry.isFile()) return;
  if (!(await isSourceFile(childAbs, childRel, walk.config))) return;
  await walk.visitFile(childAbs, childRel);
}

/**
 * Walk a tree depth-first, at most `MAX_WALK_DEPTH` levels below its start (deeper directories set `depthExceeded`).
 * `signal` is read at every directory and before every entry: once it fired the walk rejects with its reason.
 */
async function walkTree(
  walk: TreeWalk,
  currentAbs: string,
  currentRel: string,
  depth: number,
): Promise<void> {
  if (walk.full()) return;
  if (depth > MAX_WALK_DEPTH) {
    walk.depthExceeded = true;
    return;
  }
  throwIfAborted(walk.signal);
  const entries = await enterDirectory(walk, currentAbs);
  for (const entry of entries ?? []) {
    if (walk.full()) return;
    throwIfAborted(walk.signal);
    await walkEntry(walk, entry, { abs: currentAbs, rel: currentRel, depth });
  }
}

// ---------------------------------------------------------------------------
// find_files
// ---------------------------------------------------------------------------

export interface FindFilesResult {
  pattern: string;
  matches: string[];
  truncated: boolean;
  totalMatches: number;
}

/**
 * Recursive glob search inside the workspace. Respects default excludes + extension gating (same rules as the eager
 * scanner, so the model never sees paths it could not `read_file` on anyway).
 */
export async function findFilesExecutor(
  workspaceRoot: string,
  pattern: string,
  matchConfig?: MatchConfig,
  signal?: AbortSignal,
): Promise<FindFilesResult> {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new SandboxError('INVALID_INPUT', 'pattern is empty', pattern);
  }
  const regex = globToRegExp(pattern.trim());
  const matches: string[] = [];
  let totalMatches = 0;
  const walk = treeWalk(resolveMatchConfig(matchConfig), signal, async (_absFile, relFile) => {
    if (!regex.test(relFile)) return;
    totalMatches += 1;
    if (matches.length < MAX_FIND_MATCHES) matches.push(relFile);
  });
  await walkTree(walk, workspaceRoot, '', 0);
  return {
    pattern,
    matches,
    truncated: totalMatches > matches.length || walk.depthExceeded,
    totalMatches,
  };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export interface ReadFileResult {
  relpath: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  truncationReason?: 'max_lines' | 'max_bytes';
  totalBytes: number;
}

/** A file larger than this is never loaded: its response carries metadata only. */
const HARD_FILE_SIZE_LIMIT = 5 * MAX_READ_BYTES; // 1MB

/**
 * Refuse a file the source rule does not admit. A file a rule excludes (a caller's `excludeGlobs`, a default exclude:
 * directory, filename or extension) gets a generic message with NO path, whatever its extension — the error string is
 * no existence oracle for paths the caller excluded. Any other refused file is structurally non-source (binary, image,
 * a file without `#!`): the path stays in the message, the model needs to know which file is "wrong-tool" territory.
 * `relPath` is kept either way for internal logging via `requestedPath`. The same gate holds on `ask`'s fallback, so a
 * filter given to `ask` is honoured by `ask_agentic`.
 */
async function assertReadable(
  target: ResolvedPath,
  relPath: string,
  config: MatchConfig,
): Promise<void> {
  if (await isSourceFile(target.absolutePath, target.relpath, config)) return;
  const fileName = target.relpath.slice(target.relpath.lastIndexOf('/') + 1);
  if (isFileExcludedByConfig(target.relpath, fileName, config)) {
    throw new SandboxError('EXCLUDED_FILE', 'file is excluded by configured policy', relPath);
  }
  throw new SandboxError(
    'NON_SOURCE_FILE',
    `file extension not in allowed source set, and not a readable #! script: ${target.relpath}`,
    relPath,
  );
}

/**
 * The size of a regular file, stated before it is read so a minified bundle is never loaded whole. A named pipe,
 * socket or device with a source extension (`pipe.ts`) passes the source rule, and reading it could block forever:
 * it is refused.
 */
async function regularFileSize(target: ResolvedPath, relPath: string): Promise<number> {
  let st: Stats;
  try {
    st = await stat(target.absolutePath);
  } catch (err) {
    throw new SandboxError('NOT_FOUND', `stat failed: ${String(err)}`, relPath);
  }
  if (!st.isFile()) {
    throw new SandboxError('NON_SOURCE_FILE', `not a regular file: ${target.relpath}`, relPath);
  }
  return st.size;
}

/**
 * The response for a file over `HARD_FILE_SIZE_LIMIT`: its buffer is never allocated, so slicing is not offered — the
 * message steers the model to `grep` or to skipping the file.
 */
function tooLargeToRead(relpath: string, totalBytes: number): ReadFileResult {
  return {
    relpath,
    content: `[file too large to inline: ${totalBytes} bytes > ${HARD_FILE_SIZE_LIMIT} byte cap. Use \`grep\` with a narrow pattern, or skip this file. Slicing via startLine/endLine is not supported at this size.]`,
    startLine: 1,
    endLine: 0,
    totalLines: 0,
    truncated: true,
    truncationReason: 'max_bytes',
    totalBytes,
  };
}

/** The file's bytes. A read the signal aborted rejects with the signal's reason, any other failure is `NOT_FOUND`. */
async function readWhole(
  absolutePath: string,
  relPath: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  try {
    return await readFile(absolutePath, { signal });
  } catch (err) {
    throwIfAborted(signal);
    throw new SandboxError('NOT_FOUND', `read failed: ${String(err)}`, relPath);
  }
}

/** The 1-indexed inclusive line range to return: the given bounds when they are finite and ordered, else the defaults. */
function lineRange(
  startLine: number | undefined,
  endLine: number | undefined,
  totalLines: number,
): { start: number; end: number } {
  const start =
    typeof startLine === 'number' && Number.isFinite(startLine) && startLine >= 1
      ? Math.floor(startLine)
      : 1;
  const rawEnd =
    typeof endLine === 'number' && Number.isFinite(endLine) && endLine >= start
      ? Math.floor(endLine)
      : start + DEFAULT_READ_LINE_LIMIT - 1;
  return { start, end: Math.min(totalLines, rawEnd) };
}

/**
 * `content` cut to `MAX_READ_BYTES`: bytes, not characters, re-decoded with `fatal: false` so a mid-rune cut is one
 * replacement character, then backed off to the last newline (which drops that character too). Content with no
 * newline in the capped region (single-line minified code) has its trailing replacement characters stripped.
 */
function capToReadBytes(content: string): string {
  const cappedBuf = Buffer.from(content, 'utf8').subarray(0, MAX_READ_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  const cappedText = decoder.decode(cappedBuf);
  const lastNewline = cappedText.lastIndexOf('\n');
  return lastNewline > 0 ? cappedText.slice(0, lastNewline) : cappedText.replace(/�+$/, '');
}

/** The slice of a file's text a `read_file` returns, with what the model needs to ask for the next slice. */
function readSlice(
  relpath: string,
  buffer: Buffer,
  range: { startLine: number | undefined; endLine: number | undefined },
  totalBytes: number,
): ReadFileResult {
  const allLines = buffer.toString('utf8').split('\n');
  const totalLines = allLines.length;
  const { start, end } = lineRange(range.startLine, range.endLine, totalLines);
  let content = allLines.slice(start - 1, end).join('\n');
  let truncationReason: ReadFileResult['truncationReason'] | undefined =
    end < totalLines ? 'max_lines' : undefined;
  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    content = capToReadBytes(content);
    truncationReason = 'max_bytes';
  }
  return {
    relpath,
    content,
    startLine: start,
    endLine: start + content.split('\n').length - 1,
    totalLines,
    truncated: truncationReason !== undefined,
    ...(truncationReason ? { truncationReason } : {}),
    totalBytes,
  };
}

/**
 * Read a file with bounded bytes + lines. Every response includes enough metadata (`totalLines`, `totalBytes`,
 * `truncated`, `truncationReason`) for the model to request the next slice intelligently. `startLine` / `endLine` are
 * 1-indexed inclusive; omit both → the first `DEFAULT_READ_LINE_LIMIT` lines, up to `MAX_READ_BYTES`, whichever hits
 * first. `signal` is read before the read and aborts it.
 */
export async function readFileExecutor(
  workspaceRoot: string,
  relPath: string,
  startLine?: number,
  endLine?: number,
  matchConfig?: MatchConfig,
  signal?: AbortSignal,
): Promise<ReadFileResult> {
  const target = await resolveInsideWorkspace(workspaceRoot, relPath);
  await assertReadable(target, relPath, resolveMatchConfig(matchConfig));
  throwIfAborted(signal);
  const totalBytes = await regularFileSize(target, relPath);
  if (totalBytes > HARD_FILE_SIZE_LIMIT) return tooLargeToRead(target.relpath, totalBytes);
  const buffer = await readWhole(target.absolutePath, relPath, signal);
  return readSlice(target.relpath, buffer, { startLine, endLine }, totalBytes);
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export interface GrepMatch {
  relpath: string;
  line: number;
  text: string;
}

export interface GrepResult {
  pattern: string;
  pathPrefix: string | null;
  matches: GrepMatch[];
  truncated: boolean;
  totalMatches: number;
}

/** What a grep has gathered: the matches returned, every match counted, and the response's size so far. */
interface GrepFound {
  readonly matches: GrepMatch[];
  total: number;
  respBytes: number;
}

function grepRegex(pattern: string): RegExp {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new SandboxError('INVALID_INPUT', 'grep pattern is empty', pattern);
  }
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new SandboxError('INVALID_INPUT', `invalid regex: ${String(err)}`, pattern);
  }
}

/**
 * Where a grep starts: the workspace root, or `pathPrefix` resolved inside it. The prefix itself is checked against the
 * caller's `excludeGlobs` before it is walked (a generic message: no existence oracle), and must be a directory —
 * grep'ing a single file would silently return zero matches.
 */
async function grepStart(
  workspaceRoot: string,
  pathPrefix: string | undefined,
  config: MatchConfig,
): Promise<{ abs: string; rel: string }> {
  if (typeof pathPrefix !== 'string' || pathPrefix.trim().length === 0) {
    return { abs: workspaceRoot, rel: '' };
  }
  const resolved = await resolveInsideWorkspace(workspaceRoot, pathPrefix);
  if (resolved.relpath && isPathExcluded(resolved.relpath, config, resolved.kind)) {
    throw new SandboxError(
      'EXCLUDED_DIR',
      'pathPrefix is excluded by configured policy',
      pathPrefix,
    );
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(resolved.absolutePath)).isDirectory();
  } catch (err) {
    throw new SandboxError('NOT_FOUND', `pathPrefix cannot be stat'd: ${String(err)}`, pathPrefix);
  }
  if (!isDirectory) {
    throw new SandboxError(
      'NOT_A_DIRECTORY',
      `pathPrefix must be a directory, got a file: ${resolved.relpath}. To search a single file, use read_file instead.`,
      pathPrefix,
    );
  }
  return { abs: resolved.absolutePath, rel: resolved.relpath };
}

/**
 * Add a file's matching lines. Every match is counted; at most `MAX_GREP_MATCHES` are returned, each line cut to 500
 * characters (minified files have multi-megabyte lines). The response size is counted in UTF-8 bytes (+32 for the
 * envelope: JSON keys, quotes, the line number), so the 500 000-byte cap holds on CJK / emoji-heavy matches.
 */
function grepLines(text: string, relpath: string, regex: RegExp, found: GrepFound): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !regex.test(line)) continue;
    found.total += 1;
    if (found.matches.length >= MAX_GREP_MATCHES) continue;
    const trimmed = line.length > 500 ? `${line.slice(0, 500)}…` : line;
    const match: GrepMatch = { relpath, line: i + 1, text: trimmed };
    found.matches.push(match);
    found.respBytes +=
      Buffer.byteLength(match.text, 'utf8') + Buffer.byteLength(match.relpath, 'utf8') + 32;
  }
}

/** Grep one visible file: a file over the read size limit, or one that cannot be stated or read, is skipped. */
async function grepFile(
  absFile: string,
  relFile: string,
  regex: RegExp,
  found: GrepFound,
  signal: AbortSignal | undefined,
): Promise<void> {
  let text: string;
  try {
    if ((await stat(absFile)).size > HARD_FILE_SIZE_LIMIT) return;
    text = await readFile(absFile, { encoding: 'utf8', signal });
  } catch {
    return;
  }
  grepLines(text, relFile, regex, found);
}

/**
 * Recursive regex search. Supports a basic anchored `pathPrefix` so the model can scope to a subtree. Pattern is
 * compiled as JS RegExp — the model can use standard metacharacters. Hard caps: `MAX_GREP_MATCHES` matches returned,
 * each match line truncated to 500 chars, the walk ends once the response reaches `MAX_RESPONSE_BYTES`. The walk
 * honours the caller's directory excludes, so a regex like `password|secret` reads no file in an excluded directory.
 */
export async function grepExecutor(
  workspaceRoot: string,
  pattern: string,
  pathPrefix?: string,
  matchConfig?: MatchConfig,
  signal?: AbortSignal,
): Promise<GrepResult> {
  const regex = grepRegex(pattern);
  const config = resolveMatchConfig(matchConfig);
  const start = await grepStart(workspaceRoot, pathPrefix, config);
  const found: GrepFound = { matches: [], total: 0, respBytes: 0 };
  const walk = treeWalk(
    config,
    signal,
    (absFile, relFile) => grepFile(absFile, relFile, regex, found, signal),
    () => found.respBytes >= MAX_RESPONSE_BYTES,
  );
  await walkTree(walk, start.abs, start.rel, 0);
  return {
    pattern,
    pathPrefix: pathPrefix ?? null,
    matches: found.matches,
    truncated:
      found.total > found.matches.length ||
      found.respBytes >= MAX_RESPONSE_BYTES ||
      walk.depthExceeded,
    totalMatches: found.total,
  };
}

/** Export knobs for tests to reference without re-declaring numeric values. */
export const AGENTIC_LIMITS = Object.freeze({
  MAX_READ_BYTES,
  MAX_RESPONSE_BYTES,
  DEFAULT_READ_LINE_LIMIT,
  MAX_GREP_MATCHES,
  MAX_LIST_ENTRIES,
  MAX_FIND_MATCHES,
} as const);
