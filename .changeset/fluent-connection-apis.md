---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `RetryPolicy()` (`sys_retry_policy`), `Alias()` (`sys_alias`) and `DataLookup()` (`dl_definition` with its `dl_definition_rel_match` and `dl_definition_rel_set` rules), byte for byte as SDK 4.13.6 writes them, with the SDK's validations and messages.
- A `protectionPolicy` is no longer copied onto the child records of an API whose builder writes the root record's `sys_policy` itself, as the SDK does.
