---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `Table()` and its column APIs. It writes the `sys_db_object`, collection `sys_dictionary`, `sys_documentation` and column records, plus the bootstrap `dictionary/<table>.xml` and the `author_elective_update/sys_choice_<table>_<column>.xml` choice set files, byte for byte as SDK 4.13.6 does. `compileFluentProject` returns those files in a new `files` list and `nativeBuild` writes them next to the records. Table and column names, scope prefixes, labels in several languages, choices, references and the deprecated array `actions` are validated with the SDK's messages; `now.config.json` table settings other than the defaults are an error.
