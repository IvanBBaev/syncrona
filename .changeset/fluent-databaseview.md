---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `DatabaseView()`: a `sys_db_view` keyed by its name, with a `sys_db_view_table` per joined table and a `sys_db_view_table_field` per selected field, byte for byte with SDK 4.13.6. Like the SDK, it reports a name that is not normalized or lacks the scope prefix (`u_` in global), and a variable prefix with an underscore, over 30 characters or shared by two tables, and hints at two tables with the same order.
