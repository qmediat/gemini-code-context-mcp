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
});
