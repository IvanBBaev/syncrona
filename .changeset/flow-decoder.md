---
"syncrona": minor
---

- Add a read-only Flow Designer reader in `packages/core/src/flow/`, the first step of native flow support. `readFlowDocument` reads one flow's `sys_hub_flow` row and every row that belongs to it (trigger, action, logic and subflow instances, inputs, outputs, variables and stages) through the Table API, decodes the base64 + gzip JSON payload columns (`values`, `trigger_inputs`, `subflow_inputs`, ...), and assembles the steps into a tree by `ui_id` / `parent_ui_id`, ordered by `order`. `serializeFlowDocument` writes the result as deterministic JSON (sorted keys, stable row order), so the same flow always produces the same bytes. Audit stamps are dropped; every other non-empty column is kept and each payload records its storage format, so it can be encoded back later. Steps with a missing parent, a repeated `ui_id` or a parent cycle stay in the document at the top level and are listed in `warnings`. No command uses it yet.
