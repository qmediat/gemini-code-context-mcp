import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_EXTENSIONS,
  DEFAULT_EXCLUDE_FILE_NAMES,
  DEFAULT_INCLUDE_EXTENSIONS,
  defaultMatchConfig,
  isFileIncluded,
  isPathExcluded,
  normalizeExcludeGlob,
} from '../../src/indexer/globs.js';

describe('normalizeExcludeGlob', () => {
  it('routes `*.ext` to extension bucket', () => {
    expect(normalizeExcludeGlob('*.tsbuildinfo')).toEqual({
      kind: 'extension',
      value: '.tsbuildinfo',
    });
  });

  it('routes bare `.name` (no slash) to filename bucket (PR #24 round-3)', () => {
    // Round-3 fix: bare dotfile literals like `.env`, `.map`, `.tsbuildinfo`
    // now route to filename bucket for exact-match semantics. Users who
    // genuinely want extension semantics must write `*.ext`. This avoids
    // over-matching: pre-fix `.env` excluded `staging.env` via endsWith().
    expect(normalizeExcludeGlob('.map')).toEqual({ kind: 'filename', value: '.map' });
    expect(normalizeExcludeGlob('.env')).toEqual({ kind: 'filename', value: '.env' });
    expect(normalizeExcludeGlob('.tsbuildinfo')).toEqual({
      kind: 'filename',
      value: '.tsbuildinfo',
    });
  });

  it('routes literal filename (no slash, has dot) to filename bucket', () => {
    expect(normalizeExcludeGlob('pr27-diff.txt')).toEqual({
      kind: 'filename',
      value: 'pr27-diff.txt',
    });
    expect(normalizeExcludeGlob('foo.bar.baz')).toEqual({
      kind: 'filename',
      value: 'foo.bar.baz',
    });
  });

  it('routes bare name (no separator, no dot) to dir bucket', () => {
    expect(normalizeExcludeGlob('node_modules')).toEqual({ kind: 'dir', value: 'node_modules' });
    expect(normalizeExcludeGlob('Dockerfile')).toEqual({ kind: 'dir', value: 'Dockerfile' });
  });

  it('routes path-with-slash to dir bucket', () => {
    expect(normalizeExcludeGlob('src/vendor')).toEqual({ kind: 'dir', value: 'src/vendor' });
    expect(normalizeExcludeGlob('src/lib/db/migrations/meta')).toEqual({
      kind: 'dir',
      value: 'src/lib/db/migrations/meta',
    });
  });

  it('normalises Windows backslashes to POSIX', () => {
    expect(normalizeExcludeGlob('src\\vendor')).toEqual({ kind: 'dir', value: 'src/vendor' });
  });

  it('strips leading `./`', () => {
    expect(normalizeExcludeGlob('./dist')).toEqual({ kind: 'dir', value: 'dist' });
    expect(normalizeExcludeGlob('./src/vendor')).toEqual({ kind: 'dir', value: 'src/vendor' });
  });

  it('strips trailing slashes', () => {
    expect(normalizeExcludeGlob('dist/')).toEqual({ kind: 'dir', value: 'dist' });
    expect(normalizeExcludeGlob('src/vendor//')).toEqual({ kind: 'dir', value: 'src/vendor' });
  });

  it('handles combined normalisation', () => {
    expect(normalizeExcludeGlob('./src\\vendor/')).toEqual({ kind: 'dir', value: 'src/vendor' });
  });

  it('returns null on empty / whitespace-only input', () => {
    expect(normalizeExcludeGlob('')).toBeNull();
    expect(normalizeExcludeGlob('   ')).toBeNull();
    expect(normalizeExcludeGlob('./')).toBeNull();
  });

  // --- PR #24 review regressions (F#8) ---

  it('F#8: trailing-slash dot-dirs route to `dir` bucket (not extension)', () => {
    // Pre-fix: `.vercel/` → strip `/` → starts with `.` → extension bucket.
    // User intent "exclude the directory" was silently ignored.
    expect(normalizeExcludeGlob('.vercel/')).toEqual({ kind: 'dir', value: '.vercel' });
    expect(normalizeExcludeGlob('.next/')).toEqual({ kind: 'dir', value: '.next' });
    expect(normalizeExcludeGlob('.turbo/')).toEqual({ kind: 'dir', value: '.turbo' });
    expect(normalizeExcludeGlob('.serverless/')).toEqual({ kind: 'dir', value: '.serverless' });
  });

  it('F#8: trailing-slash non-dot dirs route to `dir` bucket too', () => {
    expect(normalizeExcludeGlob('dist/')).toEqual({ kind: 'dir', value: 'dist' });
    expect(normalizeExcludeGlob('build/')).toEqual({ kind: 'dir', value: 'build' });
    expect(normalizeExcludeGlob('vendor\\')).toEqual({ kind: 'dir', value: 'vendor' });
  });

  it('F#8 + round-3: bare dot-names map to FILENAME bucket (exact-match)', () => {
    // Post-round-3: bare dotfile literals like `.map` / `.tsbuildinfo` map
    // to filename for exact-match semantics. Pre-v1.5.0-round-3 they mapped
    // to extension (endsWith) and over-matched (`.env` would exclude
    // `staging.env`). Users who want extension semantics write `*.ext`.
    expect(normalizeExcludeGlob('.map')).toEqual({ kind: 'filename', value: '.map' });
    expect(normalizeExcludeGlob('.tsbuildinfo')).toEqual({
      kind: 'filename',
      value: '.tsbuildinfo',
    });
  });
});

describe('defaultMatchConfig', () => {
  it('ships `.tsbuildinfo` as a default excluded extension', () => {
    const config = defaultMatchConfig();
    expect(config.excludeExtensions).toContain('.tsbuildinfo');
    expect(DEFAULT_EXCLUDE_EXTENSIONS).toContain('.tsbuildinfo');
  });

  it('routes user excludeGlobs into the correct buckets', () => {
    const config = defaultMatchConfig({
      excludeGlobs: [
        '*.tsbuildinfo', // extension
        'pr27-diff.txt', // filename
        'src/vendor', // dir with slash
        'node_modules', // dir bare
        './dist/', // dir after normalisation
      ],
    });
    // Extension bucket keeps default + new user one.
    expect(config.excludeExtensions).toEqual(expect.arrayContaining(['.tsbuildinfo']));
    expect(config.excludeFileNames).toEqual(expect.arrayContaining(['pr27-diff.txt']));
    expect(config.excludeDirs).toEqual(
      expect.arrayContaining(['src/vendor', 'node_modules', 'dist']),
    );
  });

  it('preserves pre-v1.5.0 backward compat for bare dir names', () => {
    const config = defaultMatchConfig({ excludeGlobs: ['node_modules'] });
    // Pre-fix behaviour: push to excludeDirs. Verified by the absence
    // of a new filename/extension classification for a plain dir name.
    expect(config.excludeDirs).toContain('node_modules');
    expect(config.excludeFileNames).not.toContain('node_modules');
    expect(config.excludeExtensions).not.toContain('node_modules');
  });

  it('drops empty / whitespace-only excludeGlobs entries', () => {
    const before = defaultMatchConfig();
    const after = defaultMatchConfig({ excludeGlobs: ['', '   ', './'] });
    expect(after.excludeDirs).toEqual(before.excludeDirs);
    expect(after.excludeFileNames).toEqual(before.excludeFileNames);
    expect(after.excludeExtensions).toEqual(before.excludeExtensions);
  });
});

describe('isFileIncluded with excludeExtensions', () => {
  const config = defaultMatchConfig();

  it('rejects default-excluded extensions even with matching include', () => {
    expect(isFileIncluded('tsconfig.tsbuildinfo', config)).toBe(false);
    expect(isFileIncluded('foo/bar.tsbuildinfo', config)).toBe(false);
  });

  it('still admits the matching positive-include extensions', () => {
    expect(isFileIncluded('src/index.ts', config)).toBe(true);
    expect(isFileIncluded('README.md', config)).toBe(true);
  });

  it('honours a user-supplied extension exclude', () => {
    const userConfig = defaultMatchConfig({ excludeGlobs: ['*.json'] });
    expect(isFileIncluded('package.json', userConfig)).toBe(false);
    expect(isFileIncluded('src/config/app.json', userConfig)).toBe(false);
    expect(isFileIncluded('src/index.ts', userConfig)).toBe(true);
  });

  it('honours a user-supplied filename exclude', () => {
    const userConfig = defaultMatchConfig({ excludeGlobs: ['pr27-diff.txt'] });
    expect(isFileIncluded('pr27-diff.txt', userConfig)).toBe(false);
    expect(isFileIncluded('docs/pr27-diff.txt', userConfig)).toBe(false); // basename match
    expect(isFileIncluded('pr28-diff.txt', userConfig)).toBe(true);
  });

  it('honours a user-supplied path-prefix exclude', () => {
    const userConfig = defaultMatchConfig({
      excludeGlobs: ['src/lib/db/migrations/meta'],
    });
    expect(isPathExcluded('src/lib/db/migrations/meta/0001_snapshot.json', userConfig)).toBe(true);
    expect(isPathExcluded('src/lib/db/schema.ts', userConfig)).toBe(false);
  });
});

describe('defaults sanity', () => {
  it('include extensions remain populated', () => {
    expect(DEFAULT_INCLUDE_EXTENSIONS.length).toBeGreaterThan(30);
  });
  it('exclude dirs remain populated', () => {
    expect(DEFAULT_EXCLUDE_DIRS).toContain('node_modules');
    expect(DEFAULT_EXCLUDE_DIRS).toContain('.git');
  });
  it('exclude filenames include tsconfig.tsbuildinfo literal match', () => {
    expect(DEFAULT_EXCLUDE_FILE_NAMES).toContain('tsconfig.tsbuildinfo');
  });
});
