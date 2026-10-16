---
"syncrona": minor
---

- Add the playbook document writer in `packages/core/src/flow/`, the playbook counterpart of `flowFiles.ts`. `listScopePlaybooks` lists the `sys_pd_process_definition` rows of a scope, refusing a scope name that would add encoded-query conditions. `writePlaybookDocuments` / `syncPlaybookDocuments` write every playbook of a scope as `<source>/sys_pd_process_definition/<name>.playbook.json`, with the same file-naming rules as flow documents (unsafe characters become `_`, and names that collide case-insensitively get the sys_id appended). Files are written atomically and only when their bytes change; a playbook that cannot be read is reported without stopping the others, and documents left on disk that no listed playbook produced are reported as stale but kept. `isPlaybookDocumentPath` recognises the files. No command calls it yet; a `playbook` table preset will.
