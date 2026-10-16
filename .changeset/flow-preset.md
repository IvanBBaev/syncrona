---
"syncrona": minor
---

Add the `flow` table preset: `refresh` and `download` write every Flow Designer flow and subflow of the scope as a read-only, decoded `sys_hub_flow/<name>.flow.json` document, with secret-typed values redacted. `push` skips these documents with a warning.
