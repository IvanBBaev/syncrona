# @syncrona/typescript-plugin

<!-- badges:start -->
| [![npm](https://img.shields.io/npm/v/@syncrona/typescript-plugin?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/@syncrona/typescript-plugin) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

## Overview

This plugin allows you to run the [TypeScript](https://www.typescriptlang.org/) compiler on `.ts` files. Supports `tsconfig.json` files.

## Installation

```bash
npm i -D @syncrona/typescript-plugin
```

## Options

| Key               | Type                         | Default | Description                                                                                                                                                |
| ----------------- | ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transpile`       | `boolean`                    | `true`  | Whether or not the contents of the typescript file should be transpiled. Useful if you want to use Babel to transpile instead but still want type checking |
| `compilerOptions` | `typescript.CompilerOptions` | `null`  | Same as `compilerOptions` in a `tsconfig.json` file                                                                                                        |

### Order of Configurations

Later entries win on every overlapping key:

1. **`tsconfig.json`** — the nearest one found by walking up from the file being
   compiled, with its `extends` chain resolved. This is the base.
2. **`compilerOptions` from `sync.config.js`** — merged on top, so a value set here
   overrides the same key in `tsconfig.json`. Both the string spelling
   (`target: "ES2021"`) and an already-resolved `typescript.ScriptTarget` value are
   accepted; an unparsable value fails the push instead of being ignored.
3. **The plugin's own defaults**, applied only where neither source set the key:
   - `target` → `ES2021`, the ECMAScript level current ServiceNow releases support.
     Pinned deliberately, because TypeScript's own default tracks the newest
     language level and changes between compiler majors.
   - `module` → follows the effective `target` (`ES2015` for an ES2015+ target,
     `CommonJS` below it), which is what TypeScript 5 did before its default moved.
   - `moduleResolution` → `Bundler`, but **only** where TypeScript would otherwise
     default to `Classic`, which cannot see `node_modules` at all. A `tsconfig.json`
     that already implies a node-aware resolution is left alone.
   - `alwaysStrict` → `false` for the emit when neither `strict` nor `alwaysStrict`
     was configured anywhere, so the transpiled output carries no `"use strict"`
     prologue. ServiceNow scripts lean on implicit globals, which strict mode turns
     into runtime errors.

The same effective option set drives the type check and the emit, so a knob that
relaxes checking (`noImplicitAny`, `skipLibCheck`, `strict`) really does unblock a
push.

## Example Usage

This example takes `.ts` files and only type checks them.

```javascript
// sync.config.js
module.exports = {
  rules: [
    {
      match: /\.ts$/,
      plugins: [
        {
          name: "@syncrona/typescript-plugin",
          options: {
            transpile: false,
          },
        },
      ],
    },
  ],
};
```
