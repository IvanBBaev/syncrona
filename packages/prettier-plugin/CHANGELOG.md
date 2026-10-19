# @syncrona/prettier-plugin

## 1.2.0

### Patch Changes

- - The build plugin packages (babel, babel-plugin-remove-modules, babel-preset-servicenow, eslint, prettier, sass, typescript, webpack) are re-implemented from their documented behaviour; options, exports and output are unchanged.
  - `babel-plugin-remove-modules` rejects `@expandModule` on an import with a string name (`import { "a-b" as x }`) instead of leaving that name unbound; without `@expandModule` such an import is still removed.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @syncrona/types@1.2.0

## 1.1.0

### Patch Changes

- @syncrona/types@1.1.0

## 1.0.0

### Patch Changes

- @syncrona/types@1.0.0

## 0.9.4

### Patch Changes

- @syncrona/types@0.9.4

## 0.9.3

### Patch Changes

- Piped stdin is honored, loaded resources are released, and a plugin that fails to load now says so instead of being skipped in silence.

## 0.9.1

### Patch Changes

- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
  No runtime or API changes.
- Updated dependencies
  - @syncrona/types@0.9.1

## 0.4.2
