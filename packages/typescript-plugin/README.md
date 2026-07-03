# @syncrona/typescript-plugin

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
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

1. Load from `sync.config.js` options.
2. Check for `tsconfig.json` file and and override any overlapping values.

## Example Usage

This example takes `.ts` files and only type checks them.

```javascript
//sync.config.js
module.exports={
  rules:{
    match:/\.ts$/,
    plugins:[
      name:"@syncrona/typescript-plugin",
      options:{
        transpile:false
      }
    ]
  }
};
```
