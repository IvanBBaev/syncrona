---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `ScheduledScript()` (`sysauto_script`) and `ScriptAction()` (`sysevent_script_action`), byte for byte as SDK 4.13.6 writes them. The evaluator understands the global `Duration()` and `Time()` helpers with the SDK's checks; durations, times of day and the run window are converted with the SDK's time-zone arithmetic, and its schedule validations are reported with the SDK's messages.
