# @syncrona/babel-plugin-remove-modules

## 1.2.0

### Patch Changes

- - The build plugin packages (babel, babel-plugin-remove-modules, babel-preset-servicenow, eslint, prettier, sass, typescript, webpack) are re-implemented from their documented behaviour; options, exports and output are unchanged.
  - `babel-plugin-remove-modules` rejects `@expandModule` on an import with a string name (`import { "a-b" as x }`) instead of leaving that name unbound; without `@expandModule` such an import is still removed.

## 1.1.0

### Patch Changes

- 5509203: - `export * from "./x"` is removed like an export list; it used to be emitted verbatim, and an `export` statement does not parse on the instance.
  - A default-exported expression with side effects (`export default init();`) is kept as a plain statement instead of being dropped with the export.
  - A bare `@moduleAlias` with no `=<name>` fails the transform with a code frame instead of renaming references to `true.<member>`.

## 1.0.0

## 0.9.4

## 0.9.3

### Patch Changes

- The real `tsconfig.json` is honored, including aliased imports, instead of a synthesized default.
- Piped stdin is honored, loaded resources are released, and a plugin that fails to load now says so instead of being skipped in silence.

## 0.9.1

### Patch Changes

- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
  No runtime or API changes.

## 0.4.2
