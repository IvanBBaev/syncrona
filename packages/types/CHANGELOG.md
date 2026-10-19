# @syncrona/types

## 1.2.0-beta.0

### Minor Changes

- 3cef151: Let the Fluent engine run `pack`, `install` and `installStatus` without `@servicenow/sdk`. The new `engine` option (`SN.FluentEngineChoice`) forces the SDK (`sdk`) or the native engine (`native`); the default `auto` keeps the SDK when it is installed and otherwise falls back to the native engine with a one-line notice. Every other action still needs the SDK, and the native engine refuses them with `FLUENT_NATIVE_UNSUPPORTED`.
- bc33b76: Inject a UI session into the Fluent tier, the counterpart of now-sdk's `SN_SDK_SESSION_TOKEN` / `SN_SDK_SESSION_COOKIE`. When `SN_SESSION_COOKIE` (with its `SN_SESSION_TOKEN` CSRF token) is set, the `fluent` actions hand that session to the SDK as is, ahead of the profile's method and without a login; a token without a cookie is refused. `FluentCredentialInput` gains a `session` kind, which `createFluentAuthResolver` returns unchanged. The variables are environment-only: `syncrona login` never stores them and clears stale ones from `.env`, and syncrona never renews the session. Other commands, and `fluent types --native`, keep using the profile.
- f76f295: - The `Sync` and `SN` declarations are re-authored as syncrona's own contract: grouped by area (project configuration, build plugins, CLI arguments, build and push pipeline, instance session, application manifest, instance records), with a doc comment on every type and member. The plugin call shape `run(context, content, options) → Promise<{ success, output }>` and every `sync.config.js` key are unchanged.
  - `Sync.PluginFunc` and `Sync.Plugin` take an optional `TOptions` type parameter for the shape of a rule's `options` (default `any`, so existing plugins compile unchanged).
  - Removed declarations nothing used: `Sync.FileSyncParams` (its fields are now declared on `Sync.FileContext` itself), `Sync.ServerRequestConfig`, `Sync.RecordContextMap`, `Sync.TableContextTree`, `Sync.AppFileContextTree`, `Sync.BuildRecord`, `SN.Field`, `SN.Record`, `SN.TableAPIResult`, `SN.TypeMap` and the top-level `TSFIXME`. The four sys_id-only instance rows (`SN.UserRecord`, `SN.UserPrefRecord`, `SN.ScopeRecord`, `SN.UpdateSetRecord`) are aliases of the new `SN.RecordRef`.

### Patch Changes

- 6eb735b: - `syncrona fluent build` runs on syncrona's native engine, so build → pack → install works without `@servicenow/sdk`. Under the default `auto` engine the build falls back to native when the SDK is not installed, and `--engine native` forces it. The native build writes the compiler's records plus the `sys_app` scope record and the `package.json` and SBOM `sys_module` rows into the app output directory, byte for byte as SDK 4.13 writes them, with the SBOM naming syncrona as its tool. It honours `--frozen-keys` and `--skip-clean`. It refuses what it cannot build yet instead of building an incomplete app: server modules, client content, `metadata/` XML, runtime policies and a logo file. A build with errors writes nothing.
  - `@syncrona/fluent` exports `nativeBuild`, `moduleResolutionPath`, `sbomContent` and `FROZEN_KEYS_ERROR`.
- f88a98e: Docs: package READMEs drop the legacy upstream references. The fluent README states the ServiceNow SDK licensing notes inline, the MCP server examples use a neutral `x_acme_*` scope, and the repository `NOTICE` now carries only the project copyright and the ServiceNow trademark notice.
- 278f9bd: - New opt-in `tablePresets` config (`"uib"`, `"workspace"`, `"ai"`): the JSON columns of UI Builder, workspace and AI Agent configuration tables are synced as `.json` field files instead of strings in the `.meta.json` sidecar — every `json` / `json_translations` column plus the string columns the preset names (for example `sys_ux_macroponent.composition`), on both the Table API build and the scoped-endpoint manifest. Unknown preset names fail config validation; tables switched off in `includes`/`excludes` stay off.
  - Download pretty-prints a JSON field file only when the stored value is canonical minified JSON, and writes every other value byte for byte. Push refuses a `.json` field file that is not valid JSON and minifies a file that is exactly the 2-space form of its value, so a round trip leaves the instance unchanged. This applies to every `json`-typed field file, not only preset tables: an existing minified `.json` field file is rewritten pretty-printed by the next download.
  - A JSON field whose value holds a non-empty string under a credential-named key (`password`, `api_key`, `client_secret`, `access_token`, …) is withheld on download with a warning naming the key path.
  - `push` refuses `sys_uxf_snapshot` records, which UI Builder generates on publish.

## 1.1.0

No changes in this release.

## 1.0.0

## 0.9.4

## 0.9.3

### Patch Changes

- Contracts for the `.meta.json` sidecar: the discovered column list, the read-only columns withheld from a push, and the manifest fields that record both.

## 0.9.1

### Patch Changes

- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
  No runtime or API changes.

## 0.4.2
