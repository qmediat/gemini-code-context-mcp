import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../../src/indexer/workspace-validation.js';

describe('validateWorkspacePath', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gcctx-val-'));
    // biome-ignore lint/performance/noDelete: setting to `undefined` stringifies to "undefined" in env; delete is the correct unset.
    delete process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: setting to `undefined` stringifies to "undefined" in env; delete is the correct unset.
    delete process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE;
  });

  it('rejects a relative path', () => {
    expect(() => validateWorkspacePath('./some-relative-dir')).toThrow(WorkspaceValidationError);
  });

  it('rejects a non-existent path with "does not exist"', () => {
    expect(() => validateWorkspacePath(join(root, 'does-not-exist'))).toThrow(/does not exist/);
  });

  it('rejects a path that is a file, not a directory', () => {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'hello');
    expect(() => validateWorkspacePath(file)).toThrow(/not a directory/);
  });

  it('rejects a directory outside cwd with no workspace marker', () => {
    expect(() => validateWorkspacePath(root)).toThrow(/no recognised workspace marker/);
  });

  it('accepts a directory outside cwd that contains a .git dir', () => {
    mkdirSync(join(root, '.git'));
    expect(() => validateWorkspacePath(root)).not.toThrow();
  });

  it('accepts a directory outside cwd that contains a package.json', () => {
    writeFileSync(join(root, 'package.json'), '{}');
    expect(() => validateWorkspacePath(root)).not.toThrow();
  });

  it('accepts a directory outside cwd that contains a Cargo.toml', () => {
    writeFileSync(join(root, 'Cargo.toml'), '[package]');
    expect(() => validateWorkspacePath(root)).not.toThrow();
  });

  it('does NOT accept `.projectile` (weak editor-only marker, dropped per Copilot review C4)', () => {
    writeFileSync(join(root, '.projectile'), '');
    expect(() => validateWorkspacePath(root)).toThrow(WorkspaceValidationError);
  });

  it('bypasses the check when GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE=true', () => {
    process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE = 'true';
    expect(() => validateWorkspacePath(root)).not.toThrow();
  });

  it('does not bypass the check for a non-"true" value', () => {
    process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE = '1';
    expect(() => validateWorkspacePath(root)).toThrow(WorkspaceValidationError);
  });

  // ---------------------------------------------------------------------------
  // Symlink hardening (SR1) — validation runs against the canonical (realpath)
  // form, so a symlink under cwd cannot be used to bypass the cwd-ancestry
  // test by pointing at e.g. `$HOME` or `/etc`.
  // ---------------------------------------------------------------------------
  describe('canonical-path resolution', () => {
    let cwdSandbox: string;
    let originalCwd: string;

    beforeAll(() => {
      // Run cwd-sensitive tests inside a controlled sandbox so the assertions
      // don't depend on where Vitest happened to be launched from
      // (Copilot review C5 — repo-root cwd assumption was brittle).
      cwdSandbox = mkdtempSync(join(tmpdir(), 'gcctx-cwd-'));
      originalCwd = process.cwd();
      process.chdir(cwdSandbox);
    });

    afterAll(() => {
      process.chdir(originalCwd);
    });

    it('accepts the sandbox cwd itself even without a marker', () => {
      expect(() => validateWorkspacePath(cwdSandbox)).not.toThrow();
    });

    it('accepts a real subdir of the sandbox cwd', () => {
      const sub = join(cwdSandbox, 'sub');
      mkdirSync(sub);
      expect(() => validateWorkspacePath(sub)).not.toThrow();
    });

    it('rejects a symlink under cwd that resolves OUTSIDE cwd to a non-workspace dir', () => {
      // `external` is in tmpdir, not under our sandbox cwd, no marker.
      const external = mkdtempSync(join(tmpdir(), 'gcctx-ext-'));
      const link = join(cwdSandbox, 'sneaky-link');
      symlinkSync(external, link);
      // Without realpath, the cwd check would pass (link is under cwd) and
      // the scanner would walk `external`. With realpath, validation rejects.
      expect(() => validateWorkspacePath(link)).toThrow(/no recognised workspace marker/);
    });

    it('accepts a symlink under cwd that resolves OUTSIDE cwd but to a real workspace', () => {
      // `external` has a `.git` marker — should pass even though the path
      // we're validating is the symlink under cwd.
      const external = mkdtempSync(join(tmpdir(), 'gcctx-ext-marker-'));
      mkdirSync(join(external, '.git'));
      const link = join(cwdSandbox, 'real-repo-link');
      symlinkSync(external, link);
      expect(() => validateWorkspacePath(link)).not.toThrow();
    });

    it('accepts a symlink to a sibling subdir of cwd', () => {
      const sibling = join(cwdSandbox, 'sibling');
      mkdirSync(sibling);
      const link = join(cwdSandbox, 'sibling-link');
      symlinkSync(sibling, link);
      expect(() => validateWorkspacePath(link)).not.toThrow();
    });
  });

  describe("refuses the user's home directory as a workspace", () => {
    // The canonical MCP launch pattern (this repo's own README recommends
    // it, and `~/.claude.json` installs use it) sets cwd=$HOME to sidestep
    // an npx-in-same-repo conflict. A tool call that omits `workspace`
    // then defaults to `process.cwd() === $HOME` and would pass the
    // cwd-ancestry check, letting the scanner walk Desktop / Documents /
    // Downloads / .Trash / everything. The home-reject guard prevents
    // this regardless of cwd.

    const originalHome = process.env.HOME;

    afterAll(() => {
      if (originalHome === undefined) {
        // biome-ignore lint/performance/noDelete: setting to `undefined` stringifies in env; delete is the correct unset.
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    });

    it('rejects when workspace resolves to os.homedir()', () => {
      // `os.homedir()` reads HOME at call time on POSIX — point it at a real
      // tmpdir path so `realpathSync` resolves without touching the
      // developer's actual home directory.
      const fakeHome = mkdtempSync(join(tmpdir(), 'gcctx-fake-home-'));
      process.env.HOME = fakeHome;

      expect(() => validateWorkspacePath(fakeHome)).toThrow(WorkspaceValidationError);
      expect(() => validateWorkspacePath(fakeHome)).toThrow(/home directory/i);
      expect(() => validateWorkspacePath(fakeHome)).toThrow(/Pass 'workspace' explicitly/);
    });

    it('rejects even when $HOME is itself a workspace-marker root', () => {
      // Defense in depth: if the user (or their dotfile repo) keeps a
      // `.git` inside $HOME, the marker check would otherwise green-light
      // scanning the whole home directory. The home-reject guard fires
      // BEFORE the marker check to block this.
      const fakeHome = mkdtempSync(join(tmpdir(), 'gcctx-fake-home-marker-'));
      mkdirSync(join(fakeHome, '.git'));
      process.env.HOME = fakeHome;

      expect(() => validateWorkspacePath(fakeHome)).toThrow(/home directory/i);
    });

    it('accepts a subdirectory of home (real project roots still work)', () => {
      // The guard MUST NOT overreach — users legitimately keep code at
      // `$HOME/code/my-project`, `$HOME/src/foo`, etc. Only $HOME itself
      // is refused.
      const fakeHome = mkdtempSync(join(tmpdir(), 'gcctx-home-sub-'));
      const project = join(fakeHome, 'code', 'my-project');
      mkdirSync(project, { recursive: true });
      mkdirSync(join(project, '.git'));
      process.env.HOME = fakeHome;

      expect(() => validateWorkspacePath(project)).not.toThrow();
    });

    it('rejects via realpath even when the input path is a symlink to home', () => {
      // Symlink bypass attempt: point a path-that-looks-innocent at $HOME.
      // Without canonicalisation, the literal string comparison would miss;
      // with `realpathSync`, the guard catches it.
      const fakeHome = mkdtempSync(join(tmpdir(), 'gcctx-home-symlink-'));
      process.env.HOME = fakeHome;

      const sneaky = mkdtempSync(join(tmpdir(), 'gcctx-sneaky-'));
      const homeLink = join(sneaky, 'looks-like-a-repo');
      symlinkSync(fakeHome, homeLink);

      expect(() => validateWorkspacePath(homeLink)).toThrow(/home directory/i);
    });
  });
});
