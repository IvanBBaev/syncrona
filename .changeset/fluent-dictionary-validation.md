---
"@syncrona/fluent": minor
---

- The native Fluent compiler checks the table and column names a project refers to (`Acl`, `BusinessRule`, `ClientScript`, `UiAction`, a `Table()` parent and a `ReferenceColumn` target). Columns are checked against the project's own `Table()` schemas and, when the project has `@types/syncrona/tables.d.ts` from `syncrona fluent types --native`, tables and inherited columns are checked against it too. Unknown names are warnings, since SDK 4.13.6 accepts any name; a column is checked only when its table's whole `extends` chain is known, and an unreadable types file is skipped with a warning.
