# @syncro-now-ai/sass-plugin

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

## Overview

This plugin allows you to run [Sass](https://sass-lang.com/) on scss/sass files. This enables you to modularize your CSS and also adds some useful features that CSS doesn't normally support such as variables.

## Installation

```bash
npm i -D @syncro-now-ai/sass-plugin
```

## Options

No options required.

## Example Usage

This example takes `.scss` files and compiles them with the Sass compiler.

```javascript
//sync.config.js
module.exports={
  rules:{
    match:/\.scss$/,
    plugins:[
      {
        name:"@syncro-now-ai/sass-plugin",
        //No options necessary
        options:{}
      }
    ]
  }
};
```
