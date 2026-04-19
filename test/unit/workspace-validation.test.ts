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
});
