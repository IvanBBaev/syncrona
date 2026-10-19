---
"@syncrona/fluent": patch
---

- The native Fluent compiler checks the table of a `Record()` and every column its `data` sets against the project's tables and dictionary types, warning about the names it cannot find. An unknown table is reported once per call.
