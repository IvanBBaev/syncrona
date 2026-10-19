---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `Sla()`: the `contract_sla` record, byte for byte with SDK 4.13.6. Durations take `Duration()`, and the schedule, duration type, flow, workflow, overrides, vendor and condition type take a sys_id or a record. Like the SDK, it reports the fields a duration, schedule source or retroactive start requires, and hints at the fields their settings ignore; `no_schedule` writes the SDK's default schedule.
