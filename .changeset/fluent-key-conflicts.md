---
"@syncrona/fluent": patch
---

`compileFluentProject` now reports key conflicts the way the SDK build does: a record defined more than once (same table and sys_id, from different calls) and an explicit `$id` used for records of different tables are errors listing each definition's path and line. A build with conflicts returns no `keysText`, since the keys registry would otherwise hand the shared `$id` to whichever table claimed it last.
