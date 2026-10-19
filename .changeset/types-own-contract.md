---
"@syncrona/types": minor
---

- The `Sync` and `SN` declarations are re-authored as syncrona's own contract: grouped by area (project configuration, build plugins, CLI arguments, build and push pipeline, instance session, application manifest, instance records), with a doc comment on every type and member. The plugin call shape `run(context, content, options) → Promise<{ success, output }>` and every `sync.config.js` key are unchanged.
- `Sync.PluginFunc` and `Sync.Plugin` take an optional `TOptions` type parameter for the shape of a rule's `options` (default `any`, so existing plugins compile unchanged).
- Removed declarations nothing used: `Sync.FileSyncParams` (its fields are now declared on `Sync.FileContext` itself), `Sync.ServerRequestConfig`, `Sync.RecordContextMap`, `Sync.TableContextTree`, `Sync.AppFileContextTree`, `Sync.BuildRecord`, `SN.Field`, `SN.Record`, `SN.TableAPIResult`, `SN.TypeMap` and the top-level `TSFIXME`. The four sys_id-only instance rows (`SN.UserRecord`, `SN.UserPrefRecord`, `SN.ScopeRecord`, `SN.UpdateSetRecord`) are aliases of the new `SN.RecordRef`.
