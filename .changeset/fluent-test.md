---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `Test()` (`sys_atf_test`, `sys_atf_step`, `sys_variable_value` and `sys_element_mapping`), byte for byte as SDK 4.13.6 writes it: one composite step file per `atf.<category>.<step>()` call of the steps function, input variables serialized by their type (lists, templates, name/value objects, booleans, records and relationships), earlier steps' outputs (directly or in template literals) written as GEM expressions with their element mappings, step timeouts from their configuration's default or a duration object, and the SDK's diagnostics for invalid, unknown-category and unknown steps.
