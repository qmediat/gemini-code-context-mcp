#!/usr/bin/env node
// @ts-check
// Every file that carries the package version names package.json's, so a version bump that leaves one behind fails
// before anything is published: the README heading `## Supports · version X.Y.Z` (the version its Supports list
// describes), server.json's `version` and every `packages[].version`, package-lock.json's `version` and
// `packages[""].version` — the last two read beside package.json, both required (a lockfile without a `packages` map
// carries only its root `version`).
//
//   node scripts/check-supports.mjs                             the repository's own files
//   node scripts/check-supports.mjs <README.md> <package.json>   the two files named
//
// Exit: 0 when every version equals package.json's; 1 when one differs, the heading is missing or a file cannot be
// read — one line on stderr per mismatch, naming the file, the value found and package.json's version, or per version
// file that is missing; 2 when
// exactly one file is named.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProgram } from './is-program.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADING = /^## Supports · version (\S+)[ \t]*$/m;

/**
 * @typedef {{ ok: boolean, message: string }} Verdict
 * @typedef {{ version: string } | { problem: string }} PackageVersion
 * @typedef {{ file: string, field: string, value: unknown }} VersionField
 * @typedef {{ ok: true, fields: VersionField[] } | { ok: false, problem: string }} VersionFields
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
  return readmeVerdict(readmeText, packageVersion(packageText));
}

/**
 * @param {string} readmeText
 * @param {PackageVersion} found package.json's version, parsed once by the caller
 * @returns {Verdict}
 */
function readmeVerdict(readmeText, found) {
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
 * server.json's version fields: `version` and every `packages[].version`. The registry manifest is required here.
 * @param {any} server the parsed server.json, or undefined when the file does not exist
 * @returns {VersionFields}
 */
function serverFields(server) {
  if (server === undefined) return { ok: false, problem: 'server.json is missing' };
  const packages = server.packages ?? [];
  if (!Array.isArray(packages)) return { ok: false, problem: 'server.json packages is not an array' };
  /** @type {VersionField[]} */
  const fields = packages.map((entry, index) => ({
    file: 'server.json',
    field: `packages[${index}].version`,
    value: entry?.version,
  }));
  return { ok: true, fields: [{ file: 'server.json', field: 'version', value: server.version }, ...fields] };
}

/**
 * package-lock.json's version fields: the root `version` and, in a lockfile with a `packages` map (lockfileVersion 2
 * and 3), `packages[""].version`.
 * @param {any} lock the parsed package-lock.json, or undefined when the file does not exist
 * @returns {VersionFields}
 */
function lockFields(lock) {
  if (lock === undefined) return { ok: false, problem: 'package-lock.json is missing' };
  /** @type {VersionField} */
  const root = { file: 'package-lock.json', field: 'version', value: lock.version };
  if (lock.packages === undefined) return { ok: true, fields: [root] };
  return {
    ok: true,
    fields: [root, { file: 'package-lock.json', field: 'packages[""].version', value: lock.packages?.['']?.version }],
  };
}

/**
 * @param {VersionField[]} fields
 * @param {string} packageVersion the version in package.json
 * @returns {string[]} one line per field that names another version
 */
export function versionMismatches(fields, packageVersion) {
  return fields
    .filter((field) => field.value !== packageVersion)
    .map((field) => `${field.file} ${field.field} is ${shown(field.value)}; package.json is ${packageVersion}`);
}

/**
 * @param {unknown} value a version field's value
 * @returns {string} the value as a line shows it
 */
function shown(value) {
  if (value === undefined) return 'missing';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * @param {string} path
 * @returns {any} the parsed JSON file, or undefined when it does not exist
 */
function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {string} dir the directory holding server.json and package-lock.json
 * @param {string} packageVersion the version in package.json
 * @returns {string[]} one line per version field of those files that names another version, or per file that cannot
 *   carry one (missing, or `packages` not an array)
 */
export function versionFileMismatches(dir, packageVersion) {
  const found = [
    serverFields(readJsonIfPresent(join(dir, 'server.json'))),
    lockFields(readJsonIfPresent(join(dir, 'package-lock.json'))),
  ];
  return found.flatMap((files) => (files.ok ? versionMismatches(files.fields, packageVersion) : [files.problem]));
}

/**
 * @param {Verdict} readme the README's verdict
 * @param {string[]} mismatches the version files'
 * @returns {Verdict} the README's verdict when no version file differs; otherwise a failure, one line per mismatch
 */
function withMismatches(readme, mismatches) {
  const lines = readme.ok ? mismatches : [readme.message, ...mismatches];
  return lines.length === 0 ? readme : { ok: false, message: lines.join('\n') };
}

/**
 * @param {string} readmePath
 * @param {string} packagePath server.json and package-lock.json are read beside it
 * @returns {Verdict}
 */
export function verdictForFiles(readmePath, packagePath) {
  try {
    const found = packageVersion(readFileSync(packagePath, 'utf8'));
    const readme = readmeVerdict(readFileSync(readmePath, 'utf8'), found);
    if ('problem' in found) return readme;
    const result = withMismatches(readme, versionFileMismatches(dirname(packagePath), found.version));
    if (!result.ok) return result;
    return {
      ok: true,
      message: `README "Supports" and the version files name version ${found.version}, as package.json does`,
    };
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
  for (const line of result.message.split('\n')) console.error(`check-supports: ${line}`);
  return 1;
}

if (isProgram(import.meta.url)) process.exitCode = main(process.argv.slice(2));
