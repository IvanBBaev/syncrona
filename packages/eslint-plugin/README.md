# @syncro-now-ai/eslint-plugin

## Overview

This plugin allows you to run the [ESLint](https://eslint.org/) checker on files.

## Installation

```bash
npm i -D @syncro-now-ai/eslint-plugin
```

### Order of Configurations

1. Load from `sync.config.js` options.
2. Check for `.eslintrc` file or generate one.

## Example Usage

This example takes `.ts` files and runs eslint on them. The output with errors and warnings
is printed on the console. If there are any errors the code is not pushed.

```javascript
//sync.config.js
module.exports={
  rules:{
    match:/\.ts$/,
    plugins:[
      name:"@syncro-now-ai/eslint-plugin",
    ]
  }
}; 
```
