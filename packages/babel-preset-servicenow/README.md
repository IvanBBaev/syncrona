# @syncrona/babel-preset-servicenow

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

## Overview

This [Babel](https://babeljs.io) preset is meant to run **absolutely last** of all plugins and presets. Its purpose is to remove or refactor any code that might break ServiceNow's serverside Rhino engine.
Right now it is fairly simple, but it might be enhanced in the future if more issues are discovered.

## Installation

```bash
npm i -D @syncrona/babel-preset-servicenow
```

After the installation is completed, add it to the `presets` section of your Babel configuration.

## Sanitizer

The sanitizer performs various operations on code to make it safe for ServiceNow

### `__proto__` references

ServiceNow blocks references to `__proto__` on the serverside. This is sidestepped by changing all references to `__proto__` to `__proto-sn__`. So far all functionality has been preserved in transpiled output.

```javascript
test.__proto__ = {};
```

**becomes...**

```javascript
test.__proto-sn__ = {};
```

### Keyword Identifiers

ServiceNow does not allow properties of objects that have the same name as keywords to be accessed directly. This is sidestepped by using the index syntax instead.

```javascript
test.default;
```

**becomes...**

```javascript
test["default"]
```