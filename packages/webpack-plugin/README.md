# @syncrona/webpack-plugin

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

## Overview

This plugin allows you to run [Webpack](https://webpack.js.org/) on your desired files. This allows you to build frontend bundles in a more modern way or even potentially bundle server side javascript files.

## Installation

```bash
npm i -D @syncrona/webpack-plugin
```

## Options

| Key               | Type                                                | Default  | Description                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configGenerator` | `(context:Sync.FileContext)=>webpack.Configuration` | `()=>{}` | Function that can generate a webpack configuration object. A [Sync.FileContext](../types/index.d.ts) is passed in so that you can substitute options using the context |
| `webpackConfig`   | `webpack.Configuration`                             | `{}`     | Same as [webpack.config.js](https://webpack.js.org/configuration/) object                                                                                                                                                 |

### Order of Configurations

1. Load from closest `webpack.config.js`.
2. Load from `webpackConfig` in `sync.config.js` and override any overlapping values.
3. Run `configGenerator()` from `configGenerator` option in `sync.config.js` and override any overlapping values.

## Example Usage

This example takes `.wp.js` files and bundles them with webpack by generating the options with a function

```javascript
//sync.config.js
module.exports={
  rules:{
    match:/\.wp\.js$/,
    plugins:[
      name:"@syncrona/webpack-plugin",
      options:{
        configGenerator:(context)=>{
          mode:"production",
          //set name of record as the library name
          library:context.name
        }
      }
    ]
  }
};
```


