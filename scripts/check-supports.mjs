#!/usr/bin/env node
// @ts-check
// The README heading `## Supports · version X.Y.Z` names the version its Supports list describes. It must equal the
// package's version, so a version bump without a README update fails before anything is published.
//
//   node scripts/check-supports.mjs [<README.md> [<package.json>]]   (defaults: the repository's own files)
//
// Exit: 0 when the two versions are equal; 1 when they differ, the heading is missing or a file cannot be read —
// one line on stderr names what was found.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADING = /^## Supports · version (\S+)[ \t]*$/m;

/**
 * @typedef {{ ok: boolean, message: string }} Verdict
 */

/**
 * @param {string} readmeText
 * @returns {string | null} the version the heading names, or null when the README has no such heading
 */
function readmeVersion(readmeText) {
  const match = HEADING.exec(readmeText);
  return match?.[1] ?? null;
}

/**
 * @param {string} packageText
 * @returns {string | null} package.json's `version`, or null when it has none
 */
function packageVersion(packageText) {
  const parsed = JSON.parse(packageText);
  return typeof parsed?.version === 'string' ? parsed.version : null;
}

/**
 * @param {string} readmeText
 * @param {string} packageText
 * @returns {Verdict}
 */
function verdict(readmeText, packageText) {
  const pkg = packageVersion(packageText);
  if (pkg === null) return { ok: false, message: 'package.json has no version' };
  const readme = readmeVersion(readmeText);
  if (readme === null) {
    return { ok: false, message: `README has no "## Supports · version …" heading; package.json is ${pkg}` };
  }
  if (readme !== pkg) {
    return { ok: false, message: `README "Supports" names version ${readme}; package.json is ${pkg}` };
  }
  return { ok: true, message: `README "Supports" names version ${pkg}, as package.json does` };
}

/**
 * @param {string[]} args
 * @returns {Verdict}
 */
function run(args) {
  const readmePath = args[0] ?? join(ROOT, 'README.md');
  const packagePath = args[1] ?? join(ROOT, 'package.json');
  try {
    return verdict(readFileSync(readmePath, 'utf8'), readFileSync(packagePath, 'utf8'));
  } catch (error) {
    return { ok: false, message: `cannot read the versions: ${error instanceof Error ? error.message : error}` };
  }
}

const result = run(process.argv.slice(2));
if (result.ok) {
  console.log(`check-supports: ${result.message}`);
} else {
  console.error(`check-supports: ${result.message}`);
  process.exitCode = 1;
}
