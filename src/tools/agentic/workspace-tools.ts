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

import type { Dirent } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type MatchConfig,
  defaultMatchConfig,
  isFileIncluded,
  isPathExcluded,
  matchesAnyIncludeExtension,
} from '../../indexer/globs.js';
import { SandboxError, resolveInsideWorkspace } from './sandbox.js';

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
  if (isPathExcluded(relpath, config)) return true;
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

/**
 * List immediate children of `relPath` (non-recursive). Default-excluded
 * dirs and denylisted filenames are silently omitted; the model sees only
 * paths it is allowed to ask for via `read_file` / `grep`.
 */
export async function listDirectoryExecutor(
  workspaceRoot: string,
  relPath: string,
  matchConfig?: MatchConfig,
): Promise<ListDirectoryResult> {
  const target = await resolveInsideWorkspace(workspaceRoot, relPath);
  const config = resolveMatchConfig(matchConfig);

  // Top-level gate (v1.9.0 Phase 1.1, /6step Finding #1): the requested
  // directory itself must be checked against user `excludeGlobs`. Without
  // this, `list_directory("internal-secrets")` (where `internal-secrets`
  // is in user excludes but NOT in `DEFAULT_EXCLUDE_DIRS`) succeeds and
  // returns a filtered child list — the model can probe path existence
  // by comparing success vs `NOT_FOUND` from `resolveInsideWorkspace`.
  // The sandbox layer (`resolveInsideWorkspace`) checks default-excluded
  // dirs only; user-supplied excludes were unenforced at this level.
  // Generic message — no path interpolation — to avoid the same
  // existence-leak via error string (see Finding #2 for the file-level
  // analogue).
  if (target.relpath && isPathExcluded(target.relpath, config)) {
    throw new SandboxError('EXCLUDED_DIR', 'directory is excluded by configured policy', relPath);
  }

  let rawEntries: Dirent<string>[];
  try {
    rawEntries = await readdir(target.absolutePath, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    // Distinguish "path exists but is a file" from "path missing" — same
    // taxonomy grep's `pathPrefix` already uses. Blanket NOT_FOUND here
    // misled the model into retrying a non-existent alias when the real
    // fix was calling `read_file`. PR #24 round-4 review (Copilot P1).
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

  const entries: DirEntry[] = [];
  let totalEntries = 0;
  for (const entry of rawEntries) {
    const isFile = entry.isFile();
    const isDir = entry.isDirectory();
    if (!isFile && !isDir) continue; // skip symlinks / sockets / fifos / etc.

    // Build the would-be relpath for this child so dir-prefix excludes
    // (user-supplied `excludeGlobs`, e.g. `src/vendor/`) match against the
    // full nested path, not just the basename.
    const childRel = target.relpath ? `${target.relpath}/${entry.name}` : entry.name;

    // Skip excluded directories (user never gets to recurse into them).
    // Defaults (`node_modules`, `.git`, …) are merged into `config.excludeDirs`
    // by `defaultMatchConfig`; user `excludeGlobs` (dir-shaped) add to it.
    if (isDir && isPathExcluded(childRel, config)) continue;
    // Skip files the user's excludes filter out — exclude-side ONLY.
    // Deliberately NOT requiring include-extension match: `list_directory`
    // is a navigation aid, not a content-access gate, so a `LICENSE` /
    // image / binary should still appear in the listing even though
    // `read_file` would later reject it. The privacy-relevant cases are
    // the exclude-side ones.
    if (isFile && isFileExcludedByConfig(childRel, entry.name, config)) continue;

    totalEntries += 1;
    if (entries.length >= MAX_LIST_ENTRIES) continue; // count but don't push

    const child: DirEntry = {
      relpath: childRel,
      type: isDir ? 'dir' : 'file',
    };
    if (isFile) {
      try {
        const s = await stat(join(target.absolutePath, entry.name));
        child.size = s.size;
      } catch {
        /* stat failure — omit size, still include entry */
      }
    }
    entries.push(child);
  }

  return {
    path: target.relpath || '.',
    entries,
    truncated: totalEntries > entries.length,
    totalEntries,
  };
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
 * Recursive glob search inside the workspace. Respects default excludes +
 * extension gating (same rules as the eager scanner, so the model never
 * sees paths it couldn't `read_file` on anyway — avoids a foot-gun where
 * the model tries to open a secret it saw in a `find_files` response).
 */
export async function findFilesExecutor(
  workspaceRoot: string,
  pattern: string,
  matchConfig?: MatchConfig,
): Promise<FindFilesResult> {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new SandboxError('INVALID_INPUT', 'pattern is empty', pattern);
  }
  const regex = globToRegExp(pattern.trim());
  const config = resolveMatchConfig(matchConfig);

  const matches: string[] = [];
  let totalMatches = 0;
  // Track real (symlink-resolved) paths we've walked so a directory loop
  // (e.g. `dir/self -> dir`) does not cause infinite recursion.
  const seenReal = new Set<string>();
  let depthExceeded = false;

  async function walk(currentAbs: string, currentRel: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) {
      depthExceeded = true;
      return;
    }
    // Guard against symlink loops via realpath memoisation.
    try {
      const real = await realpath(currentAbs);
      if (seenReal.has(real)) return;
      seenReal.add(real);
    } catch {
      // Unreadable parent — nothing to walk into.
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = await readdir(currentAbs, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Honour user `excludeGlobs` dir entries in addition to defaults
        // — `isPathExcluded` checks the full nested path, so multi-segment
        // globs like `src/vendor` work even when we hit them mid-walk.
        if (isPathExcluded(childRel, config)) continue;
        await walk(join(currentAbs, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      // Unified filter: covers default filename / extension excludes,
      // user `excludeGlobs` filename / extension entries, AND requires
      // an include-extension match (default + user). Same predicate the
      // eager scanner uses — no agentic / eager divergence.
      if (!isFileIncluded(childRel, config)) continue;

      if (!regex.test(childRel)) continue;
      totalMatches += 1;
      if (matches.length < MAX_FIND_MATCHES) matches.push(childRel);
    }
  }

  await walk(workspaceRoot, '', 0);

  return {
    pattern,
    matches,
    truncated: totalMatches > matches.length || depthExceeded,
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

/**
 * Read a file with bounded bytes + lines. Every response includes enough
 * metadata (`totalLines`, `totalBytes`, `truncated`, `truncationReason`) for
 * the model to request the next slice intelligently.
 *
 * Slicing semantics:
 *   - `startLine` / `endLine` are 1-indexed inclusive ranges when given.
 *   - Omit both → return the first `DEFAULT_READ_LINE_LIMIT` lines, up to
 *     `MAX_READ_BYTES`, whichever hits first.
 */
export async function readFileExecutor(
  workspaceRoot: string,
  relPath: string,
  startLine?: number,
  endLine?: number,
  matchConfig?: MatchConfig,
): Promise<ReadFileResult> {
  const target = await resolveInsideWorkspace(workspaceRoot, relPath);
  const config = resolveMatchConfig(matchConfig);

  // Unified gate (v1.9.0+). `isFileIncluded` enforces:
  //   - path not under any excluded dir (default + user `excludeGlobs`)
  //   - basename not on filename denylist (default + user)
  //   - extension not on exclude-ext list (default + user)
  //   - extension IS on include-ext list (default + user `includeGlobs`)
  //
  // Phase 3 (`ask` → `ask_agentic` fallback) depends on this: a user who
  // passed `excludeGlobs: ['*.env*']` to `ask` must see the same files
  // refused by `ask_agentic.read_file` — otherwise silently dropping their
  // filter on fallback would be a privacy regression. The `EXCLUDED_FILE`
  // taxonomy code is new in v1.9.0; the `NON_SOURCE_FILE` code stays for
  // the more specific "extension not allowed at all" sub-case so callers
  // can still distinguish "explicitly excluded by your config" from
  // "default-rejected source-set membership".
  if (!isFileIncluded(target.relpath, config)) {
    // Discriminate the two failure modes via the shared helper (v1.9.0
    // Phase 1.1, /6step Finding #3): if NO include-extension matches, the
    // file is structurally non-source — keep the path in the message
    // because the model needs to know which file it asked for is
    // "wrong-tool" territory (binary, image, etc.) and the path is purely
    // utility, not privacy-bearing. If an include-extension DOES match,
    // the file is excluded by some other rule (filename / extension
    // exclude / dir-prefix exclude) — emit a generic message with NO path
    // (Finding #2) so the error string can't be used as an existence
    // oracle for paths the user explicitly excluded. The third
    // `SandboxError` argument (`relPath`) is preserved either way for
    // internal logging via `requestedPath`.
    if (!matchesAnyIncludeExtension(target.relpath, config)) {
      throw new SandboxError(
        'NON_SOURCE_FILE',
        `file extension not in allowed source set: ${target.relpath}`,
        relPath,
      );
    }
    throw new SandboxError('EXCLUDED_FILE', 'file is excluded by configured policy', relPath);
  }

  // Stat first so we never allocate a >200MB Buffer for a minified bundle.
  // Files larger than 5× MAX_READ_BYTES (1MB) get rejected with a
  // metadata-only response so the model can skip them instead of DOSing
  // the process. Reported in PR #24 review by GPT.
  let totalBytes: number;
  try {
    totalBytes = (await stat(target.absolutePath)).size;
  } catch (err) {
    throw new SandboxError('NOT_FOUND', `stat failed: ${String(err)}`, relPath);
  }
  const HARD_FILE_SIZE_LIMIT = 5 * MAX_READ_BYTES; // 1MB
  if (totalBytes > HARD_FILE_SIZE_LIMIT) {
    // NOTE: the startLine/endLine slicing logic further below is gated on
    // a successful `readFile` of the full content. For files over this
    // hard cap we can't safely load the buffer at all (OOM risk), so we
    // DON'T offer slicing as a workaround here — the message explicitly
    // steers the model toward `grep` (which has its own streaming path)
    // or skipping the file. Honest message vs. pre-round-3 wording that
    // suggested slicing but never delivered. Reported in PR #24 round-3
    // review by GPT.
    return {
      relpath: target.relpath,
      content: `[file too large to inline: ${totalBytes} bytes > ${HARD_FILE_SIZE_LIMIT} byte cap. Use \`grep\` with a narrow pattern, or skip this file. Slicing via startLine/endLine is not supported at this size.]`,
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: true,
      truncationReason: 'max_bytes',
      totalBytes,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(target.absolutePath);
  } catch (err) {
    throw new SandboxError('NOT_FOUND', `read failed: ${String(err)}`, relPath);
  }

  const fullText = buffer.toString('utf8');
  const allLines = fullText.split('\n');
  const totalLines = allLines.length;

  // Clamp slice bounds defensively. Accept only finite positive ints.
  const sliceStart =
    typeof startLine === 'number' && Number.isFinite(startLine) && startLine >= 1
      ? Math.floor(startLine)
      : 1;
  const rawEnd =
    typeof endLine === 'number' && Number.isFinite(endLine) && endLine >= sliceStart
      ? Math.floor(endLine)
      : sliceStart + DEFAULT_READ_LINE_LIMIT - 1;
  const sliceEnd = Math.min(totalLines, rawEnd);

  const slice = allLines.slice(sliceStart - 1, sliceEnd);
  let content = slice.join('\n');

  let truncated = sliceEnd < totalLines;
  let truncationReason: ReadFileResult['truncationReason'] | undefined = truncated
    ? 'max_lines'
    : undefined;

  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    // Byte-cap kicks in — trim the tail. Slice bytes, not characters, to
    // match the limit exactly; then re-decode with `TextDecoder` using
    // `ignoreBOM` + `fatal: false` so a mid-rune cut produces a single
    // replacement character instead of a malformed string. Back off to
    // the last newline to avoid emitting a partial line — that naturally
    // chops any trailing replacement char as well. Reported in PR #24
    // review by Gemini and Grok.
    const cappedBuf = Buffer.from(content, 'utf8').subarray(0, MAX_READ_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
    const cappedText = decoder.decode(cappedBuf);
    const lastNewline = cappedText.lastIndexOf('\n');
    // Two truncation paths:
    //   - If there's a newline in the capped region, drop everything after
    //     the last newline — that naturally trims any mid-rune replacement
    //     character that landed on the tail.
    //   - If there's NO newline (realistic for single-line minified
    //     content at 200 KB), the fallback used to keep the raw decoded
    //     text including a trailing U+FFFD. Strip trailing replacements
    //     explicitly. Reported in PR #24 round-3 review by Gemini +
    //     self-review.
    content =
      lastNewline > 0 ? cappedText.slice(0, lastNewline) : cappedText.replace(/\uFFFD+$/, '');
    truncated = true;
    truncationReason = 'max_bytes';
  }

  return {
    relpath: target.relpath,
    content,
    startLine: sliceStart,
    endLine: sliceStart + content.split('\n').length - 1,
    totalLines,
    truncated,
    ...(truncationReason ? { truncationReason } : {}),
    totalBytes,
  };
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

/**
 * Recursive regex search. Supports a basic anchored `pathPrefix` so the
 * model can scope to a subtree. Pattern is compiled as JS RegExp — the
 * model can use standard metacharacters.
 *
 * Hard caps:
 *   - `MAX_GREP_MATCHES` matches returned
 *   - each match line truncated to 500 chars (guard against minified
 *     lines flooding the payload)
 */
export async function grepExecutor(
  workspaceRoot: string,
  pattern: string,
  pathPrefix?: string,
  matchConfig?: MatchConfig,
): Promise<GrepResult> {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new SandboxError('INVALID_INPUT', 'grep pattern is empty', pattern);
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    throw new SandboxError('INVALID_INPUT', `invalid regex: ${String(err)}`, pattern);
  }
  const config = resolveMatchConfig(matchConfig);

  const matches: GrepMatch[] = [];
  let totalMatches = 0;
  let respBytes = 0;

  // Determine starting directory. When `pathPrefix` is given, validate it
  // sits inside the workspace (reuse same sandbox logic as read_file), AND
  // ensure it's a directory — grep'ing a single file via `pathPrefix`
  // would silently return zero matches (readdir throws ENOTDIR, caught by
  // the walk) which misleads the model. Reported in PR #24 review by Gemini.
  let startAbs = workspaceRoot;
  let startRel = '';
  if (typeof pathPrefix === 'string' && pathPrefix.trim().length > 0) {
    const resolved = await resolveInsideWorkspace(workspaceRoot, pathPrefix);
    // Top-level gate (v1.9.0 Phase 1.1, /6step Finding #1 ext): same threat
    // as `listDirectoryExecutor` — the requested pathPrefix must be checked
    // against user `excludeGlobs` BEFORE walking it. Without this,
    // `grep("regex", "internal-secrets")` (where the dir is in user
    // excludes but NOT in DEFAULT_EXCLUDE_DIRS) succeeds-with-zero-results
    // when the dir exists vs throws NOT_FOUND when it doesn't — same
    // existence-probe oracle. Generic message, no path leak.
    if (resolved.relpath && isPathExcluded(resolved.relpath, config)) {
      throw new SandboxError(
        'EXCLUDED_DIR',
        'pathPrefix is excluded by configured policy',
        pathPrefix,
      );
    }
    try {
      const s = await stat(resolved.absolutePath);
      if (!s.isDirectory()) {
        throw new SandboxError(
          'NOT_A_DIRECTORY',
          `pathPrefix must be a directory, got a file: ${resolved.relpath}. To search a single file, use read_file instead.`,
          pathPrefix,
        );
      }
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      throw new SandboxError(
        'NOT_FOUND',
        `pathPrefix cannot be stat'd: ${String(err)}`,
        pathPrefix,
      );
    }
    startAbs = resolved.absolutePath;
    startRel = resolved.relpath;
  }

  const seenReal = new Set<string>();
  let depthExceeded = false;

  async function walk(currentAbs: string, currentRel: string, depth: number): Promise<void> {
    if (respBytes >= MAX_RESPONSE_BYTES) return;
    if (depth > MAX_WALK_DEPTH) {
      depthExceeded = true;
      return;
    }
    try {
      const real = await realpath(currentAbs);
      if (seenReal.has(real)) return;
      seenReal.add(real);
    } catch {
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = await readdir(currentAbs, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (respBytes >= MAX_RESPONSE_BYTES) return;
      const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Honour user `excludeGlobs` dir entries in addition to defaults
        // (mirror of `findFilesExecutor`). Critical for grep specifically:
        // dropping the user's filter here means the regex would scan files
        // they explicitly excluded — and grep returns matched LINES, so
        // a regex like `password|secret|api_key` could leak content from
        // an excluded `internal-config/` dir straight into the model.
        if (isPathExcluded(childRel, config)) continue;
        await walk(join(currentAbs, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      // Unified filter — same predicate as `findFilesExecutor` and the
      // eager scanner. Honours default + user excludes; requires include
      // extension. v1.9.0 closes the agentic / eager divergence.
      if (!isFileIncluded(childRel, config)) continue;

      // Read full file (bounded by MAX_READ_BYTES via soft stat check).
      const absFile = join(currentAbs, entry.name);
      let fileSize = 0;
      try {
        fileSize = (await stat(absFile)).size;
      } catch {
        continue;
      }
      if (fileSize > 5 * MAX_READ_BYTES) continue; // skip large files in grep

      let text: string;
      try {
        text = await readFile(absFile, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (!regex.test(line)) continue;
        totalMatches += 1;
        if (matches.length >= MAX_GREP_MATCHES) continue;
        // Cap line length in the payload to 500 chars — minified files
        // can have multi-megabyte single lines.
        const trimmed = line.length > 500 ? `${line.slice(0, 500)}…` : line;
        const match: GrepMatch = { relpath: childRel, line: i + 1, text: trimmed };
        matches.push(match);
        // Use UTF-8 byte length (not .length which is UTF-16 code units)
        // so the 500k cap holds on CJK / emoji-heavy matches. `+32` is
        // the envelope overhead (JSON keys, quotes, line-number int).
        respBytes +=
          Buffer.byteLength(match.text, 'utf8') + Buffer.byteLength(match.relpath, 'utf8') + 32;
      }
    }
  }

  await walk(startAbs, startRel, 0);

  return {
    pattern,
    pathPrefix: pathPrefix ?? null,
    matches,
    truncated: totalMatches > matches.length || respBytes >= MAX_RESPONSE_BYTES || depthExceeded,
    totalMatches,
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
