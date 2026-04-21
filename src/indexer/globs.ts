/**
 * Default include/exclude patterns for workspace indexing.
 *
 * Philosophy: favour a small, predictable default surface over full glob semantics.
 * Users can extend via `includeGlobs` / `excludeGlobs` on tool calls; those accept
 * both extension patterns (`.go`, `*.kt`) and directory names (`vendor`, `target`).
 */

/** File extensions included by default — source code + prose + infra. */
export const DEFAULT_INCLUDE_EXTENSIONS: readonly string[] = [
  // JS / TS
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svelte',
  '.vue',
  '.astro',
  // Backend
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.cs',
  '.fs',
  '.swift',
  '.m',
  '.mm',
  '.cpp',
  '.cc',
  '.cxx',
  '.c',
  '.h',
  '.hpp',
  '.ex',
  '.exs',
  '.erl',
  '.clj',
  '.php',
  '.lua',
  '.dart',
  '.hs',
  '.zig',
  '.nim',
  '.sol',
  // Data / config
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env.example',
  '.xml',
  // Shell / infra
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  'Dockerfile',
  'Makefile',
  '.mk',
  '.tf',
  '.hcl',
  // Docs / prose
  '.md',
  '.mdx',
  '.rst',
  '.adoc',
  '.txt',
  // SQL
  '.sql',
  '.prisma',
  '.graphql',
  '.gql',
];

/**
 * Path fragments excluded regardless of depth.
 *
 * Matched by `isPathExcluded` (below) against the workspace-relative POSIX path
 * in three modes: exact equality, `${dir}/` prefix, and `/${dir}/` substring.
 * Entries are therefore typically directory *basenames* (`node_modules`,
 * `.ssh`), but multi-segment fragments like `.config/gcloud` also match
 * correctly — the matcher sees the full relative path, not just `dirent.name`.
 *
 * Two classes of entries:
 *   - **Build / cache artefacts** — indexing them wastes tokens on derived output
 *     (no value to Gemini).
 *   - **Secret-bearing directories** (`.ssh`, `.aws`, `.gnupg`, `.kube`, …) — if a
 *     user or prompt-injected agent points `workspace` at `$HOME`, we refuse to
 *     even walk these even if `workspace-validation.ts` is bypassed. Defense in
 *     depth against credential exfiltration through the Files API upload path.
 *
 * Entries here are ALWAYS excluded: `isFileIncluded` checks `isPathExcluded`
 * first, and `defaultMatchConfig` only ever APPENDS extra excludes supplied by
 * the caller. Tool-level `includeGlobs` cannot re-include a directory that is
 * in this list — if a repo has a legitimately-named dir that collides with
 * one of these, the fix is to rename the dir or fork the list, not to try to
 * punch through via `includeGlobs`.
 */
export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  // Dependencies / build output
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'vendor',
  'Pods',
  'DerivedData',
  '.gradle',
  '.idea',
  '.vscode',
  'bin',
  'obj',
  '.DS_Store',
  '.terraform',
  // VCS internals
  '.git',
  '.hg',
  '.svn',
  '.jj',
  // Secret-bearing directories — never index, never upload.
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.kube',
  '.docker',
  '.1password',
  '.pki',
  '.gcloud',
  '.azure',
  '.config/gcloud',
  '.config/azure',
  'Keychains', // macOS: `Library/Keychains`
  // Home-level user directories — defense in depth. If a caller somehow
  // ends up scanning `$HOME` despite `validateWorkspacePath`'s home-reject
  // (e.g. a symlinked sibling that points back at home, or a future MCP
  // host pattern we haven't seen), these are the top offenders: privacy-
  // hostile, massive, and guaranteed not to be part of any legitimate
  // codebase. Refusing them blunts the blast radius even in the edge cases
  // where the root guard doesn't fire.
  '.Trash', // macOS: Finder trash — large, privacy-sensitive
  'Trash', // Linux variants: `~/.local/share/Trash/files`
  'Library', // macOS: app support / caches / prefs — huge, not a codebase
  'Downloads',
  'Desktop',
  'Documents',
  'Movies', // macOS
  'Music', // macOS / Linux
  'Pictures',
  'Videos',
  'Public', // macOS
];

/** Files excluded by full relpath suffix (supports either `node_modules` prefix or literal suffix). */
export const DEFAULT_EXCLUDE_FILE_NAMES: readonly string[] = [
  // Lockfiles / build metadata
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  '.DS_Store',
  'Thumbs.db',
  // Belt-and-suspenders literal match for TS incremental build cache —
  // the extension-based `DEFAULT_EXCLUDE_EXTENSIONS` entry catches this
  // too, but an explicit literal makes the intent obvious in error logs
  // when users wonder why their `tsconfig.tsbuildinfo` isn't indexed.
  'tsconfig.tsbuildinfo',
  // Secret-bearing files (belt + suspenders on top of directory excludes).
  '.netrc',
  '.pypirc',
  '.npmrc',
  '.pgpass',
  '.git-credentials',
  'credentials', // AWS, qmediat, gcloud all use this filename in config dirs
];

/**
 * Extensions whose files are ALWAYS excluded from indexing, regardless of
 * caller `includeGlobs`. Checked via `filename.endsWith(ext)` in
 * `isFileIncluded`, AFTER `excludeFileNames` and BEFORE `includeExtensions`.
 *
 * Kept intentionally small — each entry is a hard no-analyse call. Add only
 * when the cost of indexing the file (token waste + misleading Gemini
 * responses) clearly outweighs any imaginable user need.
 *
 *   - `.tsbuildinfo` — TypeScript incremental build cache; generated,
 *     enormous (6-figure tokens on mid-size projects), zero analytical
 *     value. Empirically observed at 158k tokens on a single file in the
 *     RowrMail workspace that triggered the v1.4.2 fix.
 *
 * Explicitly NOT here:
 *   - `.map` / `.min.js` / `.min.css` — in some diagnostic / legacy-bundle
 *     workflows the minified file is the ONLY available source. A global
 *     default exclude would silently erase them from Gemini's view. If
 *     you want them skipped, pass `excludeGlobs: ['*.map', '*.min.js']`.
 *   - Framework migration snapshots (Drizzle `meta/*.json`, Prisma) —
 *     each framework uses a different path shape, and some projects
 *     check migrations into source control for review. Users can opt in
 *     via `excludeGlobs: ['src/lib/db/migrations/meta']` (now that Fix A
 *     makes path-prefix patterns work as users expect).
 */
export const DEFAULT_EXCLUDE_EXTENSIONS: readonly string[] = ['.tsbuildinfo'];

export interface MatchConfig {
  includeExtensions: readonly string[];
  excludeDirs: readonly string[];
  /**
   * File extension patterns to exclude, matched via `filename.endsWith(ext)`.
   * Always stored with a leading dot (e.g. `.tsbuildinfo`). Populated from
   * `DEFAULT_EXCLUDE_EXTENSIONS` plus any caller `excludeGlobs` pattern
   * recognised as an extension by `normalizeExcludeGlob` (i.e. starts with
   * `*.` or a leading dot).
   */
  excludeExtensions: readonly string[];
  excludeFileNames: readonly string[];
}

/**
 * Normalise an `includeGlobs` entry. Accepts three shapes per the tool schema:
 *   - `.ext`    → literal extension suffix (matched via `endsWith`)
 *   - `*.ext`   → glob form; we strip the `*` and treat as extension
 *   - `Name`    → literal filename (matched via strict equality)
 *
 * Heuristic for the filename branch: no `*`, no `.`, no path separators →
 * treat as a filename (e.g. `Dockerfile`, `Makefile`). Otherwise extension.
 */
function normalizeIncludeGlob(pattern: string): string {
  if (pattern.startsWith('.')) return pattern;
  if (pattern.startsWith('*.')) return `.${pattern.slice(2)}`;
  if (
    !pattern.includes('*') &&
    !pattern.includes('.') &&
    !pattern.includes('/') &&
    !pattern.includes('\\')
  ) {
    // Looks like a filename — pass through literally.
    return pattern;
  }
  return `.${pattern}`;
}

/**
 * Classification for a caller-supplied `excludeGlobs` pattern. Mirror of the
 * existing `normalizeIncludeGlob` heuristic so `excludeGlobs` and
 * `includeGlobs` share one semantic model — a consistency gap prior to v1.4.2
 * caused user patterns like `*.tsbuildinfo` to be silently treated as
 * directory names, matching nothing. Empirically observed on RowrMail
 * workspace (1.7M tokens) where 40 aggressive excludes reduced file count
 * by just one — see `docs/FOLLOW-UP-PRS.md` for the trace evidence.
 *
 * Supported shapes:
 *   - `*.tsbuildinfo`, `.map`         → extension (normalized to `.ext`)
 *   - `pr27-diff.txt`, `foo.bar.baz`  → literal filename (no separators, has dot)
 *   - `node_modules`, `src/vendor`    → directory name / path prefix
 *
 * Pre-normalisation (codex PR #20 review): POSIX separator, strip leading
 * `./`, strip trailing `/`, trim whitespace. Without this, the bucketing
 * heuristic misses common user inputs like `./dist/`, `src\\vendor`.
 *
 * Intentional non-goals: no full minimatch (no `**`, mid-string `*`, `?`,
 * character classes). Keeping the surface predictable and symmetric with
 * `normalizeIncludeGlob`. Users needing glob power can split patterns
 * manually (directory + extension as two entries).
 */
type ExcludeBucket =
  | { kind: 'extension'; value: string }
  | { kind: 'filename'; value: string }
  | { kind: 'dir'; value: string };

export function normalizeExcludeGlob(pattern: string): ExcludeBucket | null {
  // Normalise separators + strip filler so downstream heuristic sees a
  // canonical form. Order matters:
  //   1. Windows `\` → POSIX `/`
  //   2. Strip leading `./` (users copy from shell prompts often have this)
  //   3. Strip trailing `/` (a dir written as `dist/` means the dir `dist`)
  //   4. Trim whitespace
  const cleaned = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
  if (cleaned.length === 0) return null;

  // Extension bucket: `*.ext` or bare `.ext` (no slash — `src/.env` is a
  // path, not an extension).
  if (cleaned.startsWith('*.')) {
    return { kind: 'extension', value: `.${cleaned.slice(2)}` };
  }
  if (cleaned.startsWith('.') && !cleaned.includes('/')) {
    return { kind: 'extension', value: cleaned };
  }

  // Filename bucket: no separators, no wildcards, has a dot (so callers
  // writing `Dockerfile` or `Makefile` fall through to dir — preserves
  // prior behaviour where bare names matched `DEFAULT_EXCLUDE_DIRS`
  // basename-style entries).
  if (!cleaned.includes('/') && !cleaned.includes('*') && cleaned.includes('.')) {
    return { kind: 'filename', value: cleaned };
  }

  // Everything else → directory (bare dir name, or path-with-slash).
  return { kind: 'dir', value: cleaned };
}

export function defaultMatchConfig(
  extra: { includeGlobs?: readonly string[]; excludeGlobs?: readonly string[] } = {},
): MatchConfig {
  const extraExtsInclude: string[] = [];
  const extraExtsExclude: string[] = [];
  const extraFileNames: string[] = [];
  const extraDirs: string[] = [];

  for (const pattern of extra.includeGlobs ?? []) {
    extraExtsInclude.push(normalizeIncludeGlob(pattern));
  }
  // Route each excludeGlob to its semantic bucket (dir / filename / ext).
  // Pre-v1.4.2: every pattern was force-pushed to excludeDirs, silently
  // ignoring any that weren't literal dir basenames.
  for (const pattern of extra.excludeGlobs ?? []) {
    const bucket = normalizeExcludeGlob(pattern);
    if (!bucket) continue;
    if (bucket.kind === 'extension') extraExtsExclude.push(bucket.value);
    else if (bucket.kind === 'filename') extraFileNames.push(bucket.value);
    else extraDirs.push(bucket.value);
  }

  return {
    includeExtensions: [...DEFAULT_INCLUDE_EXTENSIONS, ...extraExtsInclude],
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS, ...extraDirs],
    excludeExtensions: [...DEFAULT_EXCLUDE_EXTENSIONS, ...extraExtsExclude],
    excludeFileNames: [...DEFAULT_EXCLUDE_FILE_NAMES, ...extraFileNames],
  };
}

export function isPathExcluded(relpath: string, config: MatchConfig): boolean {
  for (const dir of config.excludeDirs) {
    if (relpath === dir) return true;
    if (relpath.startsWith(`${dir}/`)) return true;
    if (relpath.includes(`/${dir}/`)) return true;
  }
  return false;
}

export function isFileIncluded(relpath: string, config: MatchConfig): boolean {
  if (isPathExcluded(relpath, config)) return false;

  const filename = relpath.includes('/') ? relpath.slice(relpath.lastIndexOf('/') + 1) : relpath;
  for (const excluded of config.excludeFileNames) {
    if (filename === excluded) return false;
  }
  // Extension-based excludes run AFTER filename excludes (which are more
  // specific) and BEFORE the include check. This ordering matters: an
  // extension exclude must be able to veto a file that would otherwise
  // match `includeExtensions` (e.g. `.tsbuildinfo` would be admitted by
  // a caller who passed `includeGlobs: ['*.tsbuildinfo']` — the exclude
  // still wins, matching the invariant already documented on
  // `DEFAULT_EXCLUDE_DIRS`).
  for (const ext of config.excludeExtensions) {
    if (filename.endsWith(ext)) return false;
  }

  for (const ext of config.includeExtensions) {
    if (ext.startsWith('.')) {
      if (filename.endsWith(ext)) return true;
    } else if (filename === ext) {
      return true;
    }
  }
  return false;
}
