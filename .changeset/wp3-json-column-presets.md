---
"syncrona": patch
"@syncrona/types": patch
---

- New opt-in `tablePresets` config (`"uib"`, `"workspace"`, `"ai"`): the JSON columns of UI Builder, workspace and AI Agent configuration tables are synced as `.json` field files instead of strings in the `.meta.json` sidecar — every `json` / `json_translations` column plus the string columns the preset names (for example `sys_ux_macroponent.composition`), on both the Table API build and the scoped-endpoint manifest. Unknown preset names fail config validation; tables switched off in `includes`/`excludes` stay off.
- Download pretty-prints a JSON field file only when the stored value is canonical minified JSON, and writes every other value byte for byte. Push refuses a `.json` field file that is not valid JSON and minifies a file that is exactly the 2-space form of its value, so a round trip leaves the instance unchanged. This applies to every `json`-typed field file, not only preset tables: an existing minified `.json` field file is rewritten pretty-printed by the next download.
- A JSON field whose value holds a non-empty string under a credential-named key (`password`, `api_key`, `client_secret`, `access_token`, …) is withheld on download with a warning naming the key path.
- `push` refuses `sys_uxf_snapshot` records, which UI Builder generates on publish.
