---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `ChoiceSet()`: the `sys_choice_set` and its `sys_choice` rows are written to the same legacy `author_elective_update/sys_choice_<table>_<field>.xml` file a `Table()` choice column produces, byte for byte with SDK 4.13.6 (string shorthand, choice objects and per-language arrays). Like the SDK, it reports a field the project's own `Table()` defines, a table outside the app in a scoped app, and a choice without a label; a `legacyChoices` other than `true` is refused.
