---
"@syncrona/fluent": minor
"@syncrona/types": minor
---

Let the Fluent engine run `pack`, `install` and `installStatus` without `@servicenow/sdk`. The new `engine` option (`SN.FluentEngineChoice`) forces the SDK (`sdk`) or the native engine (`native`); the default `auto` keeps the SDK when it is installed and otherwise falls back to the native engine with a one-line notice. Every other action still needs the SDK, and the native engine refuses them with `FLUENT_NATIVE_UNSUPPORTED`.
