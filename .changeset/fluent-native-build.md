---
"@syncrona/fluent": minor
"@syncrona/types": patch
"syncrona": minor
---

- `syncrona fluent build` runs on syncrona's native engine, so build → pack → install works without `@servicenow/sdk`. Under the default `auto` engine the build falls back to native when the SDK is not installed, and `--engine native` forces it. The native build writes the compiler's records plus the `sys_app` scope record and the `package.json` and SBOM `sys_module` rows into the app output directory, byte for byte as SDK 4.13 writes them, with the SBOM naming syncrona as its tool. It honours `--frozen-keys` and `--skip-clean`. It refuses what it cannot build yet instead of building an incomplete app: server modules, client content, `metadata/` XML, runtime policies and a logo file. A build with errors writes nothing.
- `@syncrona/fluent` exports `nativeBuild`, `moduleResolutionPath`, `sbomContent` and `FROZEN_KEYS_ERROR`.
