// @ts-check
// The structure preset shared by our repositories. A project carries this file as `lint/structure.mjs`, byte for
// byte: it is edited where the presets are kept, never in a copy (a copy that differs is reported as drifted).
// It holds structure rules only; a project's parser, style and typed rules stay in its own eslint.config.
import comments from "@eslint-community/eslint-plugin-eslint-comments";

/** @typedef {import("eslint").Linter.Config} Config */
/** @typedef {import("eslint").ESLint.Plugin} Plugin */

const SOURCES = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];
const TESTS = [
  "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "**/{test,tests,__tests__}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
];

// node:test — assert.throws / assert.rejects (also t.assert.…, assert.strict.…, an imported throws) without the expected
// error passes on any exception; a stub's `.throws(err)` is not an assertion and is left alone. Exported so a
// project with its own `no-restricted-syntax` for tests can list these selectors beside its own (a rule's options
// replace, they do not merge).
export const BARE_THROWS = [
  "CallExpression[callee.object.name='assert'][callee.property.name=/^(throws|rejects)$/][arguments.length<2]",
  "CallExpression[callee.object.property.name=/^(assert|strict)$/][callee.property.name=/^(throws|rejects)$/][arguments.length<2]",
  "CallExpression[callee.type='Identifier'][callee.name=/^(throws|rejects)$/][arguments.length<2]",
].map((selector) => ({
  selector,
  message: "Name the expected error (a class, a RegExp or a validation function): a bare throws passes on any exception.",
}));

// Vitest — a toThrow() with no expected error, a test with no assertion, an expect() with no matcher (Vitest's
// expect takes a message as its second argument). A helper that asserts is named `expect*` or `assert*`, so the
// test that calls it counts as asserting.
/** @type {import("eslint").Linter.RulesRecord} */
const VITEST_RULES = {
  "vitest/require-to-throw-message": "error",
  "vitest/expect-expect": ["error", { assertFunctionNames: ["expect*", "assert*", "assert.*"] }],
  "vitest/valid-expect": ["error", { maxArgs: 2 }],
};

/**
 * The structure rules as flat-config objects. Pass `vitest` (the `@vitest/eslint-plugin` default export) when the
 * project's tests run on Vitest; without it the tests get the node:test rule.
 * @param {{ vitest?: Plugin }} [options]
 * @returns {Config[]}
 */
export function structure({ vitest } = {}) {
  /** @type {Config} */
  const tests = vitest
    ? { files: TESTS, plugins: { vitest }, rules: VITEST_RULES }
    : { files: TESTS, rules: { "no-restricted-syntax": ["error", ...BARE_THROWS] } };
  return [
    {
      files: SOURCES,
      plugins: { "@eslint-community/eslint-comments": comments },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      rules: {
        complexity: ["error", 10],
        "max-depth": ["error", 3],
        "@eslint-community/eslint-comments/require-description": ["error", { ignore: ["eslint-enable"] }],
        "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      },
    },
    {
      files: SOURCES,
      ignores: TESTS,
      rules: { "max-lines-per-function": ["error", { max: 40, skipBlankLines: false, skipComments: false }] },
    },
    tests,
  ];
}
