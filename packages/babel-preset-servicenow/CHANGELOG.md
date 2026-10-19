# @syncrona/babel-preset-servicenow

## 1.2.0

### Patch Changes

- - The build plugin packages (babel, babel-plugin-remove-modules, babel-preset-servicenow, eslint, prettier, sass, typescript, webpack) are re-implemented from their documented behaviour; options, exports and output are unchanged.
  - `babel-plugin-remove-modules` rejects `@expandModule` on an import with a string name (`import { "a-b" as x }`) instead of leaving that name unbound; without `@expandModule` such an import is still removed.

## 1.1.0

### Patch Changes

- f232292: Quote reserved-word keys of object literal methods and accessors (`get default() {}`, `delete() {}`) as well as plain properties, so the output stays valid for ServiceNow's ES3-era Rhino parser.
- 3096cd9: The ServiceNow Babel preset rewrites a property named after any ES3 reserved word to bracket syntax. `delete`, `function`, `in`, `typeof`, `with`, `debugger` and `export` were missing from its list, so code such as `set.delete(key)` reached Rhino unchanged and failed to parse.

  Object literal keys named after a reserved word (`{ default: x }`, `{ class: y }`) are now quoted as well; ES3 rejects them there for the same reason.

- db33dca: - A reserved-word optional member access (`a?.default`) moves to bracket syntax like the plain one.

## 1.0.0

## 0.9.4

## 0.9.3

### Patch Changes

- Piped stdin is honored, loaded resources are released, and a plugin that fails to load now says so instead of being skipped in silence.

## 0.9.1

### Patch Changes

- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
  No runtime or API changes.

## 0.4.2
