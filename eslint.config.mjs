// SPDX-License-Identifier: GPL-3.0-or-later
// Flat-config translation of the former ./.eslintrc (eslint 10 / typescript-eslint 8).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // eslint 9+ only auto-ignores node_modules by default; dist and coverage
    // must be listed explicitly. Kept conservative: the lint scripts glob
    // packages/*/src only, so nothing beyond build/report output is excluded.
    ignores: ["**/node_modules/", "**/dist/", "**/coverage/"],
  },
  // .eslintrc `extends: ["plugin:@typescript-eslint/recommended"]` — the v8
  // equivalent has the same composition (base + eslint-recommended overrides +
  // recommended rules). It also registers the @typescript-eslint plugin and
  // sets @typescript-eslint/parser, covering the old `plugins` and `parser`
  // entries.
  ...tseslint.configs.recommended,
  {
    // Carried verbatim from .eslintrc `rules`.
    rules: {
      "no-useless-catch": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Carried verbatim from .eslintrc `overrides[0]`: relax no-explicit-any in tests.
    files: ["**/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
