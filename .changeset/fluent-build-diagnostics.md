---
"@syncrona/fluent": patch
---

- `build` reports the compile errors and warnings the SDK only logs. The SDK's `Orchestrator.build` returns `{ success: false, diagnostics: [] }` when the project has TypeScript errors and prints them to the console instead, so `syncrona fluent build --json` and the MCP `sync_fluent_build` tool showed a failed build with `errorCount: 0`. The engine now hands the SDK a project logger that forwards to the console but holds back error and warn messages during a build and returns them (colour codes stripped, without the SDK's "Found N diagnostic error(s)" summary when the diagnostics themselves are listed). Structured diagnostics still win when the SDK returns them; the held-back log is then printed as before.
