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

/** Directory names excluded regardless of depth. */
export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
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
];

/** Files excluded by full relpath suffix (supports either `node_modules` prefix or literal suffix). */
export const DEFAULT_EXCLUDE_FILE_NAMES: readonly string[] = [
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
];

export interface MatchConfig {
  includeExtensions: readonly string[];
  excludeDirs: readonly string[];
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

export function defaultMatchConfig(
  extra: { includeGlobs?: readonly string[]; excludeGlobs?: readonly string[] } = {},
): MatchConfig {
  const extraExts: string[] = [];
  const extraDirs: string[] = [];

  for (const pattern of extra.includeGlobs ?? []) {
    extraExts.push(normalizeIncludeGlob(pattern));
  }
  for (const pattern of extra.excludeGlobs ?? []) {
    extraDirs.push(pattern);
  }

  return {
    includeExtensions: [...DEFAULT_INCLUDE_EXTENSIONS, ...extraExts],
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS, ...extraDirs],
    excludeFileNames: DEFAULT_EXCLUDE_FILE_NAMES,
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

  for (const ext of config.includeExtensions) {
    if (ext.startsWith('.')) {
      if (filename.endsWith(ext)) return true;
    } else if (filename === ext) {
      return true;
    }
  }
  return false;
}
