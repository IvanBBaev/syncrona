---
"@syncrona/fluent": minor
---

- Adds `compileFluentProject`, a native compiler for a subset of the Fluent (`.now.ts`) core APIs: `Property`, `Role` and `ScriptInclude`, plus `Now.ID`, `Now.include` and imports between project files. It reads `now.config.json` and `generated/keys.ts`, assigns sys_ids through the keys registry the way SDK 4.13 does, and returns the record updates the SDK build would write together with the updated keys.ts text and diagnostics; it writes no files itself. An API or option outside the supported subset is a diagnostic, never a silent drop.
- `typescript` (`>=5`) is a new optional peer dependency, loaded from the Fluent project on the first compile; `FluentTypeScriptMissingError` is thrown when it cannot be found.
