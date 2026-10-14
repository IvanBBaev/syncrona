---
"syncrona": patch
---

- `push` never sends `sys_id` or the audit stamps (`sys_created_by`, `sys_created_on`, `sys_updated_by`, `sys_updated_on`, `sys_mod_count`) from a `.meta.json` sidecar, even when an explicit `tableOptions.<table>.metaFields` lists them so they are pulled for reading; they are dropped and reported like read-only columns, so a hand-edited `sys_id` can no longer retarget the update and a stale audit stamp is no longer written back.
