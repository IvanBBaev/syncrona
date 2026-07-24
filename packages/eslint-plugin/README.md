# @syncrona/eslint-plugin

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

## Overview

This plugin allows you to run the [ESLint](https://eslint.org/) checker on files.

## Installation

```bash
npm i -D @syncrona/eslint-plugin
```

### Order of Configurations

1. Load from `sync.config.js` options.
2. Fall back to the project's flat ESLint config (`eslint.config.js` / `eslint.config.mjs`), which ESLint resolves from the linted file's directory upward.

## Example Usage

This example takes `.ts` files and runs eslint on them. If there are any errors the code
is not pushed and the lint report is included in the build error; nothing is printed to
stdout, which keeps MCP stdio transports clean.

```javascript
//sync.config.js
module.exports={
  rules:{
    match:/\.ts$/,
    plugins:[
      name:"@syncrona/eslint-plugin",
    ]
  }
}; 
```
