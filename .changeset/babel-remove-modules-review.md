---
"@syncrona/babel-plugin-remove-modules": patch
---

- `export * from "./x"` is removed like an export list; it used to be emitted verbatim, and an `export` statement does not parse on the instance.
- A default-exported expression with side effects (`export default init();`) is kept as a plain statement instead of being dropped with the export.
