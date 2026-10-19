---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `$override` on every supported API and on columns, and top-level `Now.del()` statements, byte for byte as SDK 4.13.6 does. `$override` merges raw fields into the record (a column's into its `sys_dictionary` record), warns about fields the API already set and rejects framework-managed fields with the SDK's messages. `Now.del(table, sysId | keys)` writes a `DELETE` record update to `author_elective_update/<table>_<sys_id>.xml`.
