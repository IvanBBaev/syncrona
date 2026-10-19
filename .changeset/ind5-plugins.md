---
"@syncrona/babel-plugin": patch
"@syncrona/babel-plugin-remove-modules": patch
"@syncrona/babel-preset-servicenow": patch
"@syncrona/eslint-plugin": patch
"@syncrona/prettier-plugin": patch
"@syncrona/sass-plugin": patch
"@syncrona/typescript-plugin": patch
"@syncrona/webpack-plugin": patch
---

- The build plugin packages (babel, babel-plugin-remove-modules, babel-preset-servicenow, eslint, prettier, sass, typescript, webpack) are re-implemented from their documented behaviour; options, exports and output are unchanged.
- `babel-plugin-remove-modules` rejects `@expandModule` on an import with a string name (`import { "a-b" as x }`) instead of leaving that name unbound; without `@expandModule` such an import is still removed.
