---
"syncrona": minor
---

Add the `playbook` table preset: `refresh` and `download` write every Process Automation Designer playbook of the scope as a read-only, decoded `sys_pd_process_definition/<name>.playbook.json` document, with secret-typed values redacted. `push` skips these documents with a warning.
