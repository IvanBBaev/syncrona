---
"syncrona": minor
---

Add the reverse of the flow decoder for the WP2 write path: `flowDocumentRecords` turns a `.flow.json` document back into the `sys_hub_*` rows it was assembled from (payloads re-encoded in their stored format, `flow` / `model` / `parent_ui_id` restored), and `flowDocumentChanges` returns only the rows an edit changes, inserts or deletes. Both return `record_update`-shaped records and refuse documents that would lose data on the way back (redacted secrets, re-parented steps, bad sys_ids). Nothing is written to an instance yet.
