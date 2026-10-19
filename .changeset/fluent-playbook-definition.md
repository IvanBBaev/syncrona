---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `PlaybookDefinition()` (`sys_pd_process_definition`, `sys_pd_lane`, `sys_pd_activity`, `sys_pd_trigger_instance`, `sys_pd_process_input`, `sys_variable_value` and `sys_element_mapping`), byte for byte as SDK 4.13.6 writes it: one composite file per playbook with the SDK's lane, activity and variant clean-ups, record-driven playbooks with RecordCreate/RecordUpdate/RecordCreateOrUpdate triggers and the parent-record process input, lanes and activities built in `wfa.playbook.lane()`/`wfa.playbook.activity()` functions with `Run.Immediately()`/`Run.After()` start rules, restart rules, names slugified and deduplicated as the SDK does, and the Instruction and Two Step Instruction activities with their inputs and experience properties. Options this slice does not compile yet are errors rather than guesses.
