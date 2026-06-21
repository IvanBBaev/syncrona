# fixes.md — Master TODO

## Execution order

| # | Project | File | Problem | Priority |
|---|--------|------|---------|-----------|
| S1 | syncrona | `tsconfig.json` | `"module": "umd"` → must be `"commonjs"` — caused `args.options is not a function` on `syncrona download` | ✅ FIXED (verified 2026-06-12: module=commonjs) |
| S2 | syncrona | `packages/core/package.json` | `"main": "./dist./index.js"` typo → must be `"./dist/index.js"` | ✅ FIXED (verified 2026-06-12: main=./dist/index.js) |
| S3 | syncrona | rebuild core | `npm --workspace @syncro-now-ai/core run build` after S1+S2 | ✅ FIXED (dist rebuilt after S1+S2) |
| S4 | syncrona | `packages/core/src/commander.ts` | function builders for download/push/build/mcp → replace with options objects | ✅ superseded by the cliCommands.ts registry (2026-06-12) |
| S5 | syncrona | already fixed in session | wizard fresh machine, fresh SN instance, .env credentials | ✅ rebuild |
| D1 | desktop-app | `src/index.ts` | Add `servicenow.queryRecords` tool | 🟡 IMPORTANT |
| D2 | desktop-app | `src/index.ts` | Add `servicenow.getRecord` tool | 🟡 IMPORTANT |
| D3 | desktop-app | `src/index.ts` | Add `servicenow.createRecord` tool | 🟡 IMPORTANT |
| D4 | desktop-app | `src/index.ts` | Add `servicenow.updateRecord` tool (needs PATCH) | 🟡 IMPORTANT |
| D5 | desktop-app | `src/index.ts` | Add `servicenow.analyzeScript` tool (local regex) | 🟢 NICE-TO-HAVE |
| D6 | desktop-app | `src/index.ts` | Add `servicenow.executeBackgroundScript` tool | 🟢 NICE-TO-HAVE |
| S6 | syncrona | `packages/mcp-server/src/servicenowCore.ts` | Add a PATCH method to `snRequest` | 🟢 NICE-TO-HAVE |

## Detailed plans
- [Desktop/app plan](docs/desktop-app-plan.md)
- [Syncrona plan](docs/syncrona-plan.md)
