/**
 * Unit tests for the four `ask_agentic` workspace tool executors.
 *
 * Covers:
 *   - Happy path per tool
 *   - Sandbox enforcement (path traversal, symlink escape, secret denylist,
 *     excluded dir)
 *   - Hard byte / line / match limits
 *   - Extension gating
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SandboxError,
  resolveInsideWorkspace,
  resolveWorkspaceRoot,
} from '../../src/tools/agentic/sandbox.js';
import {
  AGENTIC_LIMITS,
  findFilesExecutor,
  grepExecutor,
  listDirectoryExecutor,
  readFileExecutor,
} from '../../src/tools/agentic/workspace-tools.js';

describe('sandbox: resolveInsideWorkspace', () => {
  let root: string;

  beforeEach(async () => {
    // Use `realpath` for the root — test fixtures must match what the
    // sandbox resolves at runtime. On macOS `/tmp` is a symlink to `/private/tmp`,
    // so without this the jail-check would (correctly) reject everything.
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-agentic-')));
    writeFileSync(join(root, 'keep.ts'), 'export const a = 1;');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'nested.ts'), 'export const b = 2;');
  });

  it('resolves a simple relative path inside the workspace', async () => {
    const res = await resolveInsideWorkspace(root, 'keep.ts');
    expect(res.relpath).toBe('keep.ts');
    expect(res.absolutePath).toBe(join(root, 'keep.ts'));
  });

  it('resolves a nested path', async () => {
    const res = await resolveInsideWorkspace(root, 'sub/nested.ts');
    expect(res.relpath).toBe('sub/nested.ts');
  });

  it('rejects `..` traversal even when the target does not exist', async () => {
    await expect(resolveInsideWorkspace(root, '../outside.ts')).rejects.toThrow(SandboxError);
  });

  it('rejects an absolute path pointing outside the workspace', async () => {
    await expect(resolveInsideWorkspace(root, '/etc/passwd')).rejects.toThrow(SandboxError);
  });

  it('rejects a symlink that points outside the workspace (realpath jail)', async () => {
    // Create symlink /workspace/escape → /etc (outside)
    try {
      symlinkSync('/etc', join(root, 'escape'));
    } catch {
      // Skip on platforms without symlink support (not expected on macOS/Linux).
      return;
    }
    await expect(resolveInsideWorkspace(root, 'escape/passwd')).rejects.toThrow(SandboxError);
  });

  it('rejects a secret-basename file even inside the workspace', async () => {
    writeFileSync(join(root, '.env'), 'SECRET=hunter2');
    await expect(resolveInsideWorkspace(root, '.env')).rejects.toThrow(/secret-basename denylist/);
  });

  it('rejects a secret-extension file (case-insensitive)', async () => {
    writeFileSync(join(root, 'deploy.PEM'), 'key material');
    await expect(resolveInsideWorkspace(root, 'deploy.PEM')).rejects.toThrow(
      /secret-extension denylist/,
    );
  });

  it('rejects paths inside default-excluded dirs', async () => {
    mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'foo', 'index.js'), 'x');
    await expect(resolveInsideWorkspace(root, 'node_modules/foo/index.js')).rejects.toThrow(
      /excluded directory/,
    );
  });

  it('rejects lockfile names on the default filename deny list', async () => {
    writeFileSync(join(root, 'package-lock.json'), '{}');
    await expect(resolveInsideWorkspace(root, 'package-lock.json')).rejects.toThrow(
      /default exclude list/,
    );
  });

  it('surfaces NOT_FOUND for a missing file that is structurally inside the root', async () => {
    await expect(resolveInsideWorkspace(root, 'does-not-exist.ts')).rejects.toThrow(
      /does not exist/,
    );
  });

  // --- PR #24 review regressions ---

  it('F#7: rejects a basename on the secret denylist case-insensitively (`.ENV`)', async () => {
    writeFileSync(join(root, '.ENV'), 'API_KEY=secret');
    await expect(resolveInsideWorkspace(root, '.ENV')).rejects.toThrow(/secret-basename denylist/);
  });

  it('F#7/F#12: rejects new secret extensions (`.jks`, `.gpg`, `.ppk`)', async () => {
    writeFileSync(join(root, 'keystore.jks'), 'bin');
    writeFileSync(join(root, 'secrets.gpg'), 'bin');
    writeFileSync(join(root, 'id_rsa.ppk'), 'bin');
    await expect(resolveInsideWorkspace(root, 'keystore.jks')).rejects.toThrow(
      /secret-extension denylist/,
    );
    await expect(resolveInsideWorkspace(root, 'secrets.gpg')).rejects.toThrow(
      /secret-extension denylist/,
    );
    await expect(resolveInsideWorkspace(root, 'id_rsa.ppk')).rejects.toThrow(
      /secret-extension denylist/,
    );
  });

  it('F#18: filename-on-default-exclude throws `EXCLUDED_FILENAME` (not reused `EXCLUDED_DIR`)', async () => {
    writeFileSync(join(root, 'package-lock.json'), '{}');
    try {
      await resolveInsideWorkspace(root, 'package-lock.json');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('EXCLUDED_FILENAME');
    }
  });
});

describe('listDirectoryExecutor', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-agentic-')));
    writeFileSync(join(root, 'a.ts'), 'a');
    writeFileSync(join(root, 'b.md'), 'b');
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, 'node_modules'));
  });

  it('lists immediate children, skipping node_modules', async () => {
    const res = await listDirectoryExecutor(root, '.');
    const names = res.entries.map((e) => e.relpath).sort();
    expect(names).toEqual(['a.ts', 'b.md', 'sub']);
  });

  it('reports entry types correctly', async () => {
    const res = await listDirectoryExecutor(root, '.');
    const byName = Object.fromEntries(res.entries.map((e) => [e.relpath, e.type]));
    expect(byName['a.ts']).toBe('file');
    expect(byName.sub).toBe('dir');
  });

  it('truncates + reports totalEntries when exceeding MAX_LIST_ENTRIES', async () => {
    const big = mkdtempSync(join(tmpdir(), 'gcctx-agentic-big-'));
    const bigReal = await resolveWorkspaceRoot(big);
    for (let i = 0; i < AGENTIC_LIMITS.MAX_LIST_ENTRIES + 5; i++) {
      writeFileSync(join(bigReal, `file-${i}.ts`), `// ${i}`);
    }
    const res = await listDirectoryExecutor(bigReal, '.');
    expect(res.entries.length).toBe(AGENTIC_LIMITS.MAX_LIST_ENTRIES);
    expect(res.truncated).toBe(true);
    expect(res.totalEntries).toBeGreaterThan(AGENTIC_LIMITS.MAX_LIST_ENTRIES);
  });
});

describe('findFilesExecutor', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-agentic-')));
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'a');
    writeFileSync(join(root, 'src', 'utils', 'helpers.ts'), 'b');
    writeFileSync(join(root, 'src', 'utils', 'README.md'), 'c');
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep', 'index.ts'), 'ignored');
  });

  it('supports `**/*.ts` glob and excludes node_modules', async () => {
    const res = await findFilesExecutor(root, '**/*.ts');
    expect(res.matches.sort()).toEqual(['src/app.ts', 'src/utils/helpers.ts']);
  });

  it('matches literal paths without wildcards', async () => {
    const res = await findFilesExecutor(root, 'src/app.ts');
    expect(res.matches).toEqual(['src/app.ts']);
  });

  it('respects default-exclude extensions', async () => {
    writeFileSync(join(root, 'tsconfig.tsbuildinfo'), 'x');
    const res = await findFilesExecutor(root, '**/*.tsbuildinfo');
    // `.tsbuildinfo` is not in DEFAULT_INCLUDE_EXTENSIONS so it should
    // never surface through find_files (already filtered at the executor).
    expect(res.matches).toEqual([]);
  });

  it('rejects empty pattern', async () => {
    await expect(findFilesExecutor(root, '')).rejects.toThrow(SandboxError);
  });
});

describe('readFileExecutor', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-agentic-')));
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(root, 'small.ts'), lines.join('\n'));
  });

  it('reads full small file when under limits', async () => {
    const res = await readFileExecutor(root, 'small.ts');
    expect(res.totalLines).toBe(10);
    expect(res.truncated).toBe(false);
    expect(res.content.split('\n')).toHaveLength(10);
  });

  it('honours startLine / endLine slice', async () => {
    const res = await readFileExecutor(root, 'small.ts', 3, 5);
    expect(res.startLine).toBe(3);
    expect(res.endLine).toBe(5);
    expect(res.content).toBe('line 3\nline 4\nline 5');
  });

  it('truncates at DEFAULT_READ_LINE_LIMIT when slice not specified', async () => {
    const lots = Array.from(
      { length: AGENTIC_LIMITS.DEFAULT_READ_LINE_LIMIT + 50 },
      (_, i) => `line ${i + 1}`,
    );
    writeFileSync(join(root, 'big.ts'), lots.join('\n'));
    const res = await readFileExecutor(root, 'big.ts');
    expect(res.truncated).toBe(true);
    expect(res.truncationReason).toBe('max_lines');
    expect(res.endLine).toBe(AGENTIC_LIMITS.DEFAULT_READ_LINE_LIMIT);
  });

  it('truncates at MAX_READ_BYTES when a single slice exceeds byte budget', async () => {
    // 5000 lines × 50 bytes each = 250k bytes > 200k cap.
    const long = Array.from({ length: 5000 }, () => 'x'.repeat(50)).join('\n');
    writeFileSync(join(root, 'long.ts'), long);
    const res = await readFileExecutor(root, 'long.ts', 1, 5000);
    expect(res.truncated).toBe(true);
    expect(res.truncationReason).toBe('max_bytes');
    expect(Buffer.byteLength(res.content, 'utf8')).toBeLessThanOrEqual(
      AGENTIC_LIMITS.MAX_READ_BYTES,
    );
  });

  it('rejects extensions outside the allowed source set', async () => {
    writeFileSync(join(root, 'image.png'), 'binary');
    await expect(readFileExecutor(root, 'image.png')).rejects.toThrow(/not in allowed source set/);
  });

  it('rejects `.env` via secret denylist (layered defence)', async () => {
    writeFileSync(join(root, '.env'), 'SECRET=x');
    await expect(readFileExecutor(root, '.env')).rejects.toThrow(SandboxError);
  });

  // --- PR #24 review regressions ---

  it('F#5: returns a metadata stub for files > 1MB instead of allocating full buffer', async () => {
    const big = 'x'.repeat(1_200_000); // 1.2 MB — above HARD_FILE_SIZE_LIMIT (1MB = 5×200k)
    writeFileSync(join(root, 'huge.ts'), big);
    const res = await readFileExecutor(root, 'huge.ts');
    expect(res.truncated).toBe(true);
    expect(res.truncationReason).toBe('max_bytes');
    expect(res.totalBytes).toBeGreaterThan(1_000_000);
    expect(res.content).toContain('file too large to inline');
  });

  it('F#13: UTF-8 truncation does not leave a lone replacement character', async () => {
    // Build a file whose byte-trimmed last line would split a 4-byte
    // emoji mid-rune. After the last-newline backtrack there should be
    // no U+FFFD in the returned content.
    const emoji = '😀'; // 4 bytes in UTF-8
    const line = `const x = '${emoji.repeat(50)}'; // line\n`;
    const big = line.repeat(3000); // ~600k bytes — forces byte-cap path
    writeFileSync(join(root, 'unicode.ts'), big);
    const res = await readFileExecutor(root, 'unicode.ts', 1, 10_000);
    expect(res.truncated).toBe(true);
    expect(res.content.includes('\uFFFD')).toBe(false);
  });
});

describe('grepExecutor', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-agentic-')));
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'a.ts'),
      ['export function foo() {}', 'const bar = 1;', 'export const FOO_BAR = 1;'].join('\n'),
    );
    writeFileSync(join(root, 'src', 'b.ts'), ['import { foo } from "./a";', 'foo();'].join('\n'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.ts'), 'FOO_BAR_NM');
  });

  it('finds matches across multiple files and skips node_modules', async () => {
    const res = await grepExecutor(root, 'FOO_BAR');
    expect(res.matches.map((m) => m.relpath).sort()).toEqual(['src/a.ts']);
    expect(res.matches[0].line).toBe(3);
  });

  it('supports regex metacharacters', async () => {
    const res = await grepExecutor(root, '^export');
    const files = [...new Set(res.matches.map((m) => m.relpath))].sort();
    expect(files).toEqual(['src/a.ts']);
    expect(res.matches.length).toBeGreaterThanOrEqual(2);
  });

  it('scopes search via pathPrefix', async () => {
    const res = await grepExecutor(root, 'foo', 'src');
    expect(res.matches.every((m) => m.relpath.startsWith('src/'))).toBe(true);
  });

  it('rejects invalid regex', async () => {
    await expect(grepExecutor(root, '[unclosed')).rejects.toThrow(/invalid regex/);
  });

  it('caps match count and signals truncation', async () => {
    const many = Array.from({ length: AGENTIC_LIMITS.MAX_GREP_MATCHES + 20 }, () => 'needle').join(
      '\n',
    );
    writeFileSync(join(root, 'src', 'huge.ts'), many);
    const res = await grepExecutor(root, 'needle');
    expect(res.matches.length).toBeLessThanOrEqual(AGENTIC_LIMITS.MAX_GREP_MATCHES);
    expect(res.truncated).toBe(true);
    expect(res.totalMatches).toBeGreaterThan(AGENTIC_LIMITS.MAX_GREP_MATCHES);
  });

  // --- PR #24 review regressions ---

  it('F#10: rejects `pathPrefix` that points at a file (not dir) with NOT_A_DIRECTORY', async () => {
    try {
      await grepExecutor(root, 'foo', 'src/a.ts');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NOT_A_DIRECTORY');
    }
  });

  it('F#11: aborts walk past MAX_WALK_DEPTH and flags truncated', async () => {
    // Build a 25-level deep nested chain (MAX_WALK_DEPTH=20). Walk must
    // stop before exhausting the stack and set `truncated: true`.
    let cur = root;
    for (let i = 0; i < 25; i++) {
      cur = join(cur, `d${i}`);
      mkdirSync(cur);
    }
    writeFileSync(join(cur, 'deep.ts'), 'const deepNeedle = 1;');
    const res = await grepExecutor(root, 'deepNeedle');
    // Match not found (walk aborted before reaching it); truncated=true.
    expect(res.truncated).toBe(true);
  });

  // --- PR #24 round-3 review regressions ---

  it('R3#8: empty pattern throws INVALID_INPUT (not PATH_TRAVERSAL)', async () => {
    try {
      await grepExecutor(root, '');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('R3#8: invalid regex throws INVALID_INPUT (not PATH_TRAVERSAL)', async () => {
    try {
      await grepExecutor(root, '[unclosed');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INVALID_INPUT');
    }
  });
});

// ---------------------------------------------------------------------------
// PR #24 round-3 globToRegExp + case-insensitive regressions
// ---------------------------------------------------------------------------
describe('round-3: globToRegExp via findFilesExecutor', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-r3-')));
    writeFileSync(join(root, 'README.md'), 'root readme');
    writeFileSync(join(root, 'index.ts'), 'root index');
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'src index');
    writeFileSync(join(root, 'src', 'components', 'index.ts'), 'nested index');
    writeFileSync(join(root, 'src', 'README.md'), 'src readme');
  });

  it('R3#1: `README.*` matches README.md (was silently empty in pre-fix)', async () => {
    const res = await findFilesExecutor(root, 'README.*');
    expect(res.matches.sort()).toEqual(['README.md']);
  });

  it('R3#1: `**/index.*` matches root AND nested index files', async () => {
    const res = await findFilesExecutor(root, '**/index.*');
    expect(res.matches.sort()).toEqual(['index.ts', 'src/components/index.ts', 'src/index.ts']);
  });

  it('R3#1: `**/*.ts` matches a root-level .ts (dir-boundary expansion)', async () => {
    const res = await findFilesExecutor(root, '**/*.ts');
    expect(res.matches).toContain('index.ts');
    expect(res.matches).toContain('src/index.ts');
    expect(res.matches).toContain('src/components/index.ts');
  });

  it('R3#1: `src/**/index.*` anchors to src/ prefix and matches nested', async () => {
    const res = await findFilesExecutor(root, 'src/**/index.*');
    expect(res.matches.sort()).toEqual(['src/components/index.ts', 'src/index.ts']);
  });
});

describe('round-3: case-insensitive default excludes', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-r3-ci-')));
  });

  it('R3#2: rejects uppercase `PACKAGE-LOCK.JSON` via default-exclude filename', async () => {
    writeFileSync(join(root, 'PACKAGE-LOCK.JSON'), '{}');
    try {
      await resolveInsideWorkspace(root, 'PACKAGE-LOCK.JSON');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('EXCLUDED_FILENAME');
    }
  });

  it('R3#2: rejects mixed-case `Node_Modules/foo.js` via default-exclude dir', async () => {
    mkdirSync(join(root, 'Node_Modules'), { recursive: true });
    writeFileSync(join(root, 'Node_Modules', 'foo.js'), 'x');
    try {
      await resolveInsideWorkspace(root, 'Node_Modules/foo.js');
      throw new Error('should have thrown');
    } catch (err) {
      // Not a secret dir — plain chaff, routed to EXCLUDED_DIR.
      expect((err as { code?: string }).code).toBe('EXCLUDED_DIR');
    }
  });

  it('R3#7: `.SSH/` is SECRET_DENYLIST, not EXCLUDED_DIR', async () => {
    mkdirSync(join(root, '.SSH'), { recursive: true });
    writeFileSync(join(root, '.SSH', 'id_rsa'), 'private');
    try {
      await resolveInsideWorkspace(root, '.SSH/id_rsa');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SECRET_DENYLIST');
    }
  });

  it('R3#7: plain chaff dir `.git/` maps to EXCLUDED_DIR (not SECRET_DENYLIST)', async () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
    try {
      await resolveInsideWorkspace(root, '.git/HEAD');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('EXCLUDED_DIR');
    }
  });
});

describe('round-3: readFileExecutor UTF-8 trailing strip for no-newline files', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-r3-utf-')));
  });

  it('R3#6: no-newline file truncated mid-multibyte rune strips trailing FFFD', async () => {
    // Build a single long line (no `\n`) over the byte-cap that splits
    // a 4-byte emoji at the tail after byte truncation.
    const emoji = '😀';
    const line = `const x = '${emoji.repeat(60_000)}';`;
    writeFileSync(join(root, 'single-line.ts'), line);
    const res = await readFileExecutor(root, 'single-line.ts');
    expect(res.truncated).toBe(true);
    expect(res.content.endsWith('\uFFFD')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PR #24 round-4 regressions
// ---------------------------------------------------------------------------
describe('round-4: find_files + grep case-insensitive include-ext gate', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-r4-ext-')));
    writeFileSync(join(root, 'App.TS'), 'export const a = 1;');
    writeFileSync(join(root, 'helper.ts'), 'export const b = 1;');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'Page.JSX'), "import 'x'; export default null;");
  });

  it('R4#2: find_files surfaces `App.TS` (uppercase ext) — parity with readFileExecutor', async () => {
    const res = await findFilesExecutor(root, '**/*.ts');
    expect(res.matches.sort()).toEqual(['App.TS', 'helper.ts']);
  });

  it('R4#2: grep scans uppercase `App.TS` — parity with read/find', async () => {
    const res = await grepExecutor(root, 'const a');
    const files = res.matches.map((m) => m.relpath).sort();
    expect(files).toContain('App.TS');
  });
});

describe('round-4: listDirectoryExecutor ENOTDIR classification', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-r4-enotdir-')));
    writeFileSync(join(root, 'app.ts'), 'export const a = 1;');
  });

  it('R4#5: list_directory on a file throws NOT_A_DIRECTORY (not NOT_FOUND)', async () => {
    try {
      await listDirectoryExecutor(root, 'app.ts');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NOT_A_DIRECTORY');
    }
  });

  it('R4#5: list_directory on a missing path still throws NOT_FOUND (via resolveInsideWorkspace)', async () => {
    try {
      await listDirectoryExecutor(root, 'does-not-exist');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NOT_FOUND');
    }
  });
});

// =============================================================================
// v1.9.0 Phase 1 — user `includeGlobs` / `excludeGlobs` plumbed through every
// agentic executor. PRIVACY contract: when `ask` falls back to `ask_agentic`
// on `WORKSPACE_TOO_LARGE` (Phase 3), user-supplied filter globs MUST be
// honoured by all four executors — otherwise a user who excluded `*.env*`
// or `internal-secrets/` gets those paths walked anyway, leaking content
// straight into the model. These tests pin the contract.
// =============================================================================

describe('agentic executors honour user excludeGlobs / includeGlobs (v1.9.0)', () => {
  let root: string;

  beforeEach(async () => {
    root = await resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), 'gcctx-globs-')));
    writeFileSync(join(root, 'app.ts'), 'export const app = 1;');
    writeFileSync(join(root, 'app.test.ts'), 'import { app } from "./app";');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib.ts'), 'export const lib = 2;');
    mkdirSync(join(root, 'internal-secrets'), { recursive: true });
    writeFileSync(join(root, 'internal-secrets', 'token.ts'), 'export const TOKEN = "abc";');
    writeFileSync(join(root, 'custom.private.ts'), 'export const PRIVATE = 1;');
  });

  it('listDirectory: skips a directory matching user excludeGlobs', async () => {
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['internal-secrets'] });

    const result = await listDirectoryExecutor(root, '.', config);
    const dirs = result.entries.filter((e) => e.type === 'dir').map((e) => e.relpath);
    expect(dirs).toContain('src');
    expect(dirs).not.toContain('internal-secrets');
  });

  it('listDirectory: skips files matching user excludeGlobs extension pattern', async () => {
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['*.test.ts'] });

    const result = await listDirectoryExecutor(root, '.', config);
    const files = result.entries.filter((e) => e.type === 'file').map((e) => e.relpath);
    expect(files).toContain('app.ts');
    expect(files).not.toContain('app.test.ts');
  });

  it('findFiles: skips dirs matching user excludeGlobs (no recursion into them)', async () => {
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['internal-secrets'] });

    const result = await findFilesExecutor(root, '**/*.ts', config);
    expect(result.matches).toContain('app.ts');
    expect(result.matches).toContain('src/lib.ts');
    // The token.ts file inside the excluded dir must not surface — the
    // walk skipped the dir entirely.
    expect(result.matches).not.toContain('internal-secrets/token.ts');
  });

  it('findFiles: skips files matching user excludeGlobs filename literal', async () => {
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['custom.private.ts'] });

    const result = await findFilesExecutor(root, '**/*.ts', config);
    expect(result.matches).toContain('app.ts');
    expect(result.matches).not.toContain('custom.private.ts');
  });

  it('readFile: rejects a file matching user excludeGlobs with EXCLUDED_FILE', async () => {
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['custom.private.ts'] });

    try {
      await readFileExecutor(root, 'custom.private.ts', undefined, undefined, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as { code?: string }).code).toBe('EXCLUDED_FILE');
    }
  });

  it('readFile: rejects a file inside a user-excluded directory', async () => {
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['internal-secrets'] });

    try {
      await readFileExecutor(root, 'internal-secrets/token.ts', undefined, undefined, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      // dir-prefix excludes surface as EXCLUDED_FILE here (the file is
      // structurally a source extension; it's the parent path that's
      // excluded). The PRE-v1.9.0 sandbox layer's EXCLUDED_DIR is for
      // default-excluded dirs (node_modules, .git, …); user-supplied
      // dir excludes go through the same isFileIncluded path as filename
      // excludes, hence EXCLUDED_FILE. Good enough for the model — the
      // message body cites the path explicitly.
      expect((err as { code?: string }).code).toBe('EXCLUDED_FILE');
    }
  });

  it('grep: skips dirs matching user excludeGlobs (no content scanning, no leak)', async () => {
    // Without v1.9.0 plumbing this would scan `internal-secrets/token.ts`
    // and return the line containing "TOKEN" — direct content leak from
    // an excluded dir. With the plumbing, the walk skips the dir before
    // reading any file content.
    writeFileSync(
      join(root, 'internal-secrets', 'token.ts'),
      'export const SECRET_TOKEN_VALUE = "abc";',
    );
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['internal-secrets'] });

    const result = await grepExecutor(root, 'SECRET_TOKEN_VALUE', undefined, config);
    expect(result.matches).toEqual([]);
  });

  it('omitting matchConfig preserves pre-v1.9.0 behaviour (defaults only)', async () => {
    // Backwards-compat: existing tests + production callers that don't
    // pass matchConfig must see identical behaviour to before. Verify by
    // running one executor without a config and asserting the same
    // observable outcome as a config built with no extra globs.
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const a = await findFilesExecutor(root, '**/*.ts');
    const b = await findFilesExecutor(root, '**/*.ts', defaultMatchConfig({}));
    expect(a.matches.sort()).toEqual(b.matches.sort());
  });

  // -----------------------------------------------------------------------
  // /6step Phase 1.1 hardening — top-level dir gate (Finding #1) +
  // no-path-leak in error message (Finding #2). Both close path-existence
  // probe oracles that survived the initial Phase 1 plumbing.
  // -----------------------------------------------------------------------

  it('Finding #1: listDirectory rejects the requested directory itself when in user excludeGlobs', async () => {
    // Pre-fix: list_directory('internal-secrets', config) succeeded and
    // returned a (filtered) child list — model could probe path existence.
    // Post-fix: the requested dir is checked against `isPathExcluded`
    // before readdir even fires, throwing SandboxError(EXCLUDED_DIR).
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['internal-secrets'] });

    try {
      await listDirectoryExecutor(root, 'internal-secrets', config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as { code?: string }).code).toBe('EXCLUDED_DIR');
      // Generic message — must NOT leak the excluded path so the error
      // string itself can't be used as an existence oracle.
      expect((err as Error).message).not.toContain('internal-secrets');
    }
  });

  it('Finding #1: grep rejects pathPrefix matching user excludeGlobs', async () => {
    // Same threat as the listDirectory oracle: grep("regex",
    // "internal-secrets") would walk the dir's children (filtered) when
    // the dir exists vs throw NOT_FOUND when it doesn't — existence probe.
    // Post-fix: pathPrefix is gated against user excludes BEFORE the walk.
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['internal-secrets'] });

    try {
      await grepExecutor(root, 'TOKEN', 'internal-secrets', config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as { code?: string }).code).toBe('EXCLUDED_DIR');
      expect((err as Error).message).not.toContain('internal-secrets');
    }
  });

  it('Finding #2: readFile EXCLUDED_FILE error message does not leak the excluded path', async () => {
    // Pre-fix: error message was `file matches an exclude pattern …:
    // ${target.relpath}` — model could read the path back from the error
    // string and confirm existence/structure of paths the user excluded.
    // Post-fix: generic message, third constructor arg (`requestedPath`)
    // preserved for ops logging but no longer in `.message`.
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    const config = defaultMatchConfig({ excludeGlobs: ['custom.private.ts'] });

    try {
      await readFileExecutor(root, 'custom.private.ts', undefined, undefined, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as { code?: string }).code).toBe('EXCLUDED_FILE');
      // Existence-probe defense: error.message must NOT contain any path
      // component that could differentiate "exists+excluded" from
      // "doesn't exist" (NOT_FOUND).
      expect((err as Error).message).not.toContain('custom.private.ts');
      expect((err as Error).message).not.toContain('private');
      // Internal logging field preserved — the third constructor arg
      // (relPath) is still recorded as `requestedPath`, just not surfaced
      // through `.message` to the model.
      expect((err as { requestedPath?: string }).requestedPath).toBe('custom.private.ts');
    }
  });

  it('Finding #2: NON_SOURCE_FILE keeps the path in its message (different threat model)', async () => {
    // NON_SOURCE_FILE is a "wrong tool" signal (binary / image / unknown
    // extension), NOT a privacy-probe vector — the path string is utility
    // information for the model, telling it which file in its own request
    // is structurally non-readable. Verifies the discriminator from
    // Finding #3's helper extraction works correctly.
    const { defaultMatchConfig } = await import('../../src/indexer/globs.js');
    writeFileSync(join(root, 'binary.bin'), 'binary');
    const config = defaultMatchConfig({});

    try {
      await readFileExecutor(root, 'binary.bin', undefined, undefined, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as { code?: string }).code).toBe('NON_SOURCE_FILE');
      expect((err as Error).message).toContain('binary.bin');
    }
  });
});
