# fixes.md — Master TODO

## Ред на изпълнение

| # | Проект | Файл | Проблем | Приоритет |
|---|--------|------|---------|-----------|
| S1 | syncrona | `tsconfig.json` | `"module": "umd"` → трябва `"commonjs"` — причинява `args.options is not a function` при `syncrona download` | ✅ ФИКСНАТО (верифицирано 2026-06-12: module=commonjs) |
| S2 | syncrona | `packages/core/package.json` | `"main": "./dist./index.js"` typo → трябва `"./dist/index.js"` | ✅ ФИКСНАТО (верифицирано 2026-06-12: main=./dist/index.js) |
| S3 | syncrona | rebuild core | `npm --workspace @syncrona/core run build` след S1+S2 | ✅ ФИКСНАТО (dist е изграден след S1+S2) |
| S4 | syncrona | `packages/core/src/commander.ts` | function builders за download/push/build/mcp → замени с options обекти | 🟡 ВАЖНО |
| S5 | syncrona | вече оправено в сесията | wizard fresh machine, fresh SN instance, .env credentials | ✅ rebuild |
| D1 | desktop-app | `src/index.ts` | Добави `servicenow.queryRecords` tool | 🟡 ВАЖНО |
| D2 | desktop-app | `src/index.ts` | Добави `servicenow.getRecord` tool | 🟡 ВАЖНО |
| D3 | desktop-app | `src/index.ts` | Добави `servicenow.createRecord` tool | 🟡 ВАЖНО |
| D4 | desktop-app | `src/index.ts` | Добави `servicenow.updateRecord` tool (нужен PATCH) | 🟡 ВАЖНО |
| D5 | desktop-app | `src/index.ts` | Добави `servicenow.analyzeScript` tool (local regex) | 🟢 ДОБАВКА |
| D6 | desktop-app | `src/index.ts` | Добави `servicenow.executeBackgroundScript` tool | 🟢 ДОБАВКА |
| S6 | syncrona | `packages/mcp-server/src/servicenowCore.ts` | Добави PATCH метод в `snRequest` | 🟢 ДОБАВКА |

## Детайлни планове
- [Desktop/app план](docs/desktop-app-plan.md)
- [Syncrona план](docs/syncrona-plan.md)
