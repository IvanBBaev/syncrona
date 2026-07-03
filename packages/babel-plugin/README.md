# @syncrona/babel-plugin

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

## Overview

This plugin allows you to run [Babel](https://babeljs.io/) on your javascript and TypeScript files. This enables you to do all kinds of interesting things with your code structure. It also lets you use more modern javascript features in your ServiceNow development.

Whatever Babel plugins and presets you use, you still need to `npm install` them like usual.

## Installation

```bash
npm i -D @syncrona/babel-plugin
```

## Options

This plugin takes the exact same options as [.babelrc](https://babeljs.io/docs/en/configuration#babelrc).

## Limitations

Although normal Babel transpilation enables nearly all modern javascript features in older javascript runtimes, ServiceNow's Rhino engine prevents certain modern features from working after transpilation.

Syntactic sugar such as ES6 classes, destructuring, let/const, template strings, default parameters, and arrow functions are supported. Features added to base classes like `Array` or for-of loops, Map, Set, and Weakmap are not supported because the `prototype` of base classes are locked in the Servicenow javascript engine.

A good rule of thumb is to not use the `useBuiltIns` option of the `babel-preset-env` preset. If your code works, then you are fine. If it throws errors when you run it, you most likely need an unsupported polyfill.

Feel free to riot so we can get more modern javascript features in ServiceNow 😉

## Example Usage

This example takes `.ts` files and transpiles it to valid ServiceNow javascript.

```javascript
//sync.config.js
module.exports={
  rules:{
    match:/\.ts$/,
    plugins:[
      name:"@syncrona/babel-plugin",
      //Babel options. Numbering shows order of execution
      options:{
        presets: [
          //6. Sanitize output code for ServiceNow
          "@syncrona/servicenow",
          //5. Babel env preset, transforms syntactic sugar to valid older javascript
          "@babel/env",
          //4. Typescript preset. Removes type information and makes it valid javascript
          "@babel/typescript"
          ],
        plugins: [
          //1. Remove import/export statements used for type inference
          "@syncrona/remove-modules",
          //2 and 3. Required babel plugins for typescript
          "@babel/proposal-class-properties",
          "@babel/proposal-object-rest-spread"
        ]
      }
    ]
  }
};
```
