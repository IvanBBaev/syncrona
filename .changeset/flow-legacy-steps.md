---
"syncrona": patch
---

- Flow documents now hold the steps of flows built on the older step model. Such flows (many shipped ones among them) have no rows in the `*_instance_v2` tables, so their documents used to have empty step lists. The reader now falls back to `sys_hub_trigger_instance`, `sys_hub_action_instance`, `sys_hub_flow_logic` and `sys_hub_sub_flow_instance` where the v2 tables are empty (the trigger is decided on its own; the steps are decided as a group). It attaches each step's inputs from `sys_variable_value` as `variableValues`, and inputs of a secret type are redacted like the v2 ones. A migrated flow's stale pre-migration copies are left out, so they no longer show up as `repeats ui_id` warnings.
- `outputs_assigned` and `flow_variables_assigned` are kept as plain fields (they are comma-separated name lists), so they no longer raise false "could not be decoded" warnings. A gzip `values` payload with leading whitespace now decodes.
- Writing a flow document back (`flowDocumentRecords` / `flowDocumentChanges`) sends older-model triggers and steps to their own tables and their inputs to `sys_variable_value`.
