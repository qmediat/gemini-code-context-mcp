// @ts-check
// Structure lint: the shared preset (lint/structure.mjs) beside Biome, which keeps the style and its own rules.
// TypeScript 7 has no JavaScript API for typescript-eslint to parse with, so Babel's TypeScript plugin parses it.
import babelParser from "@babel/eslint-parser";
import vitest from "@vitest/eslint-plugin";
import { structure } from "./lint/structure.mjs";

export default [
  { ignores: ["dist/**", "coverage/**", ".jscpd-report/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ["typescript"] } },
      },
    },
  },
  ...structure({ vitest }),
];
