---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `InboundEmailAction()`: the `sysevent_in_email_action` record, byte for byte with SDK 4.13.6. Required roles take names or `Role()` records and `from` takes a sys_id or a `sys_user` `Record()`. Like the SDK, it reports a `fieldAction` without a `table` on a record action and a `from` that is not a sys_id; its script must be a string.
