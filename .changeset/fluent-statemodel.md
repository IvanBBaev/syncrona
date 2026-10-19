---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `StateModel()`: the model record (`sttrm_model`, or `chg_model` / `prb_model` / `prb_task_model` for change_request, problem and problem_task), its read/write/hide user-criteria rows, and its states, state attributes, transitions, transition conditions and condition fields, byte for byte with SDK 4.13.6. Roles take names or `Role()` records, template approvers and user criteria take sys_ids or records, and attribute and condition type names resolve to their sys_ids. Like the SDK, it reports transitions to undefined states, conditions setting both `condition` and `conditionScript`, unknown attribute and condition type names and non-GUID approvers, and hints at fields the model table or a disabled `advancedSecurity` ignores.
