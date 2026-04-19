import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('rejects a non-existent path', () => {
    expect(() => validateWorkspacePath(join(root, 'does-not-exist'))).toThrow(
      WorkspaceValidationError,
    );
  });

  it('rejects a path that is a file, not a directory', () => {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'hello');
    expect(() => validateWorkspacePath(file)).toThrow(WorkspaceValidationError);
  });

  it('rejects a directory outside cwd with no workspace marker', () => {
    // `root` is a fresh tmpdir — definitely not under our cwd and has no marker.
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

  it('bypasses the check when GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE=true', () => {
    process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE = 'true';
    expect(() => validateWorkspacePath(root)).not.toThrow();
  });

  it('does not bypass the check for a non-"true" value', () => {
    process.env.GEMINI_CODE_CONTEXT_ALLOW_NONWORKSPACE = '1';
    expect(() => validateWorkspacePath(root)).toThrow(WorkspaceValidationError);
  });

  it('accepts process.cwd() itself without a marker', () => {
    // We run the test from the repo root which happens to have markers, but
    // cwd is always trusted even without one.
    expect(() => validateWorkspacePath(process.cwd())).not.toThrow();
  });

  it('accepts a descendant of cwd without a marker', () => {
    // The test runner's cwd is the repo; the repo's `test/` dir has no markers
    // of its own but should still be trusted as a descendant.
    const testDir = join(process.cwd(), 'test');
    expect(() => validateWorkspacePath(testDir)).not.toThrow();
  });

  it('rejects the parent of cwd unless it happens to have a marker', () => {
    // Parent of our repo — may or may not have `.git` depending on the user's
    // machine. We simply assert the check runs without throwing unexpectedly.
    const parent = dirname(process.cwd());
    // Either it passes (parent has a marker) or throws a validation error —
    // no other exception type allowed.
    try {
      validateWorkspacePath(parent);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceValidationError);
    }
  });
});
