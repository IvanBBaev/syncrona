---
"syncrona": minor
---

The `flow` table preset now also writes every custom Flow Designer action of the scope as a read-only, decoded `sys_hub_action_type_definition/<name>.action.json` document: the action, its inputs, outputs and output mappings, and its ordered steps with their added inputs and outputs, static input values and data-pill mappings. Secret-typed values are redacted, and `push` skips these documents with a warning.
