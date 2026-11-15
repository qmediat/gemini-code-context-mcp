#!/usr/bin/env node
// @ts-check
// The README heading `## Supports · version X.Y.Z` names the version its Supports list describes. It must equal the
// package's version, so a version bump without a README update fails before anything is published.
//
//   node scripts/check-supports.mjs                             the repository's own files
//   node scripts/check-supports.mjs <README.md> <package.json>   the two files named
//
// Exit: 0 when the two versions are equal; 1 when they differ, the heading is missing or a file cannot be read —
// one line on stderr names what was found; 2 when exactly one file is named.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADING = /^## Supports · version (\S+)[ \t]*$/m;

/**
 * @typedef {{ ok: boolean, message: string }} Verdict
 * @typedef {{ version: string } | { problem: string }} PackageVersion
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
 * @returns {PackageVersion} package.json's `version`, or why it cannot be used
 */
function packageVersion(packageText) {
  const version = JSON.parse(packageText)?.version;
  if (version === undefined) return { problem: 'package.json has no version' };
  if (typeof version !== 'string') return { problem: 'package.json version is not a string' };
  return { version };
}

/**
 * @param {string} readmeText
 * @param {string} packageText
 * @returns {Verdict}
 */
export function verdict(readmeText, packageText) {
  const found = packageVersion(packageText);
  if ('problem' in found) return { ok: false, message: found.problem };
  const pkg = found.version;
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
 * @param {string} readmePath
 * @param {string} packagePath
 * @returns {Verdict}
 */
export function verdictForFiles(readmePath, packagePath) {
  try {
    return verdict(readFileSync(readmePath, 'utf8'), readFileSync(packagePath, 'utf8'));
  } catch (error) {
    return { ok: false, message: `cannot read the versions: ${error instanceof Error ? error.message : error}` };
  }
}

/**
 * @param {string[]} args the arguments after the script's name
 * @returns {number} the exit code
 */
export function main(args) {
  if (args.length === 1) {
    console.error('check-supports: name both files (<README.md> <package.json>) or neither');
    return 2;
  }
  const result = verdictForFiles(args[0] ?? join(ROOT, 'README.md'), args[1] ?? join(ROOT, 'package.json'));
  if (result.ok) {
    console.log(`check-supports: ${result.message}`);
    return 0;
  }
  console.error(`check-supports: ${result.message}`);
  return 1;
}

/** @returns {boolean} whether this file is the program node runs (not a module another file imports) */
function isProgram() {
  const self = fileURLToPath(import.meta.url);
  const started = process.argv[1] ?? '';
  try {
    return Boolean(started) && realpathSync(started) === realpathSync(self);
  } catch {
    return resolve(started) === self; // a path realpath cannot resolve still names this file when node started it
  }
}

if (isProgram()) process.exitCode = main(process.argv.slice(2));
