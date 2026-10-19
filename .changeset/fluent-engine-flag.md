---
"syncrona": minor
---

Add `--engine sdk|native` to `syncrona fluent pack`, `install` and `status`. Without the flag those actions use `@servicenow/sdk` when it is installed and otherwise run on the native engine in `@syncrona/fluent`, so they no longer fail with the install hint when only the SDK is missing; `--dry-run` reports the fallback. `status` reports the engine it used (`engine` in `--json`). Any other action refuses `--engine`.
