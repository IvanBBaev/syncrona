# @syncro-now-ai/prettier-plugin

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

## Overview

This plugin allows you to run [Prettier](https://prettier.io/) on all supported file types. Supports `.prettierrc` files.

## Installation

```bash
npm i -D @syncro-now-ai/prettier-plugin
```

## Options

This plugin takes the exact same options as [.prettierrc](https://prettier.io/docs/en/options.html).

### Order of Configurations

1. Check for `.prettierrc` file and load those options
2. Load from `sync.config.js` options and override any overlapping values.

## Example Usage

This example takes `.js` files and prettifies them.

```javascript
//sync.config.js
module.exports={
  rules:{
    match:/\.js$/,
    plugins:[
      name:"@syncro-now-ai/prettier-plugin",
      //Prettier options
      options:{
        //sets tabs to be 2 spaces
        tabWidth:2,
        //append semicolons to ends of lines
        semi:true
      }
    ]
  }
};
```

You could also create a `.prettierrc` file with those same options in your project and it would respect those values.
