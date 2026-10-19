---
"syncrona": minor
"@syncrona/fluent": minor
---

WP2 flow write path, offline part: `flowCompositeUpdate(doc, base?)` turns a flow document into the composite update the instance tracks a flow as (`sys_hub_flow_<sys_id>`: the flow followed by every row it owns, plus a `DELETE` for each row dropped from `base`), and `@syncrona/fluent` gains `serializeCompositeRecordUpdate(table, records)` to write it as one `record_update` document. Flow documents stay read-only in `push`; installing the result is not yet verified against a live instance.
