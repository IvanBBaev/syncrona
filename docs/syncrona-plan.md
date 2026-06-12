# Syncrona — Подробен план

**Проект:** `/Users/Ivan.Baev/Development/Incubation/syncrona`
**Статус:** Частично счупен. Критични бъгове блокират CLI download и npm publish.
**Stack:** Node 22, TypeScript, UMD (трябва CommonJS), yargs v17, axios, inquirer, monorepo.

---

## Архитектура на проекта

```
packages/
  core/           — CLI (syncrona init/download/push/dev/...)
  mcp-server/     — MCP сървър (tools за Claude/Cursor/VS Code)
  types/          — споделени типове
  babel-plugin/   — ServiceNow babel трансформации
  ...
```

---

## Критични бъгове — трябва незабавно

### S1. `tsconfig.json` — `"module": "umd"` е грешен

**Файл:** `/Users/Ivan.Baev/Development/Incubation/syncrona/tsconfig.json`

**Проблем:**
```json
"module": "umd"
```

Node.js CLI приложение НИКОГА не трябва да се компилира като UMD. UMD е за browser/AMD среди. Yargs v17 при UMD формат регистрира builder функцията като handler — затова `args.options is not a function`.

**Грешката в production:**
```
TypeError: args.options is not a function
    at Object.handler (dist/commander.js:75:18)
```

**Fix:**
```json
"module": "commonjs"
```

**Засяга:** Всички команди с function builder — `download`, `push`, `build`, `mcp`. `refresh`, `dev`, `deploy` (с object builder) работят случайно.

**След fix:** `npm --workspace @syncrona/core run build`

---

### S2. `packages/core/package.json` — typo в `main`

**Файл:** `/Users/Ivan.Baev/Development/Incubation/syncrona/packages/core/package.json`

**Проблем:**
```json
"main": "./dist./index.js"
```

Двойна точка (`./dist./`) — Node.js не може да намери entry point при `require("@syncrona/core")`.

**Fix:**
```json
"main": "./dist/index.js"
```

**Засяга:** npm publish, локално зареждане като пакет.

---

### S3. Rebuild след S1 + S2

```bash
npm --workspace @syncrona/core run build
```

Потвърждение че работи:
```bash
node packages/core/dist/index.js download --help
# трябва да покаже help без грешка
```

---

### S4. `packages/core/src/commander.ts` — function builders

**Файл:** `packages/core/src/commander.ts`

**Проблем:** След S1 (CommonJS) грешката изчезва, но кодът остава fragile. Function builders връщат `cmdArgs` — излишно.

**Сегашен код (push като пример):**
```typescript
.command(["push [target]"], "...",
  cmdArgs => {
    cmdArgs.options({ ...sharedOptions, diff: {...}, scopeSwap: {...}, updateSet: {...}, ci: {...} });
    return cmdArgs;  // ← излишно
  },
  (args) => { pushCommand(args); }
)
```

**По-чист вариант:**
```typescript
.command(["push [target]"], "...",
  { ...sharedOptions, diff: {...}, scopeSwap: {...}, updateSet: {...}, ci: {...} },
  (args) => { pushCommand(args); }
)
```

Засяга: `download`, `push`, `build`, `mcp` команди.

**Важно:** S4 е clean-up. S1 е истинският fix. Не е задължително за работа.

---

## Вече оправени в тази сесия (нужен само rebuild)

### S5. `wizard.ts` — fresh machine без `syncrona login`

**Старо поведение:** `getWizardCredentials()` хвърляше веднага ако няма active instance в store.

**Ново поведение:** Ако няма active instance → вика `promptForCredentials()` → user въвежда credentials → запазва в store → продължава.

**Файл:** `packages/core/src/wizard.ts` — `getWizardCredentials()` функция.

---

### S6. `wizard.ts` — fresh SN instance без scoped apps

**Старо поведение:** `listAppsFromTableAPI()` → empty → `throw new Error("No scoped apps were found")`.

**Ново поведение:**
1. Показва guidance: "Create a scoped app in ServiceNow Studio"
2. Пита: "Enter scope code manually?"
3. Ако да → user въвежда scope → продължава
4. Ако не → излиза gracefully

**Файл:** `packages/core/src/wizard.ts` — `startWizard()` функция, след двата `if (apps.length === 0)` checks.

---

### S7. `.env` с plain-text credentials

**Три промени:**

**7a. `wizard.ts` `setupDotEnv()`** — вече пише само `SN_INSTANCE=...`, без `SN_USER` и `SN_PASSWORD`. Prezisva съществуващи `.env` файлове с credentials.

**7b. `snClient.ts` `resolveCredentials()`** — `hasEnvCreds` вече е `true` само ако `SN_USER` е наличен. `SN_INSTANCE`-only `.env` вече не блокира encrypted credential store.

**7c. `wizard.ts` `startWizard()`** — `preloadStoredCredentials(instance)` се вика след `saveCredentials()`. `downloadApp()` → `defaultClient()` използва store, не env vars.

**Ефект:** Стар `.env` с грешна парола вече не блокира `syncrona login`.

---

## MCP сървър — анализ

### Какво работи в MCP сървъра

- Session context (current scope, update set)
- Script analysis tools (local regex)
- Workspace tools (refresh, status, push) — викат `syncrona` CLI subprocess
- CRUD tools (sn_query_records, sn_create_record)
- Background script execution

### Проблем: auto scope pull

**Код:** `packages/mcp-server/src/index.ts` около ред 1972

```typescript
const downloadResult = await runSyncroCliCommand(
  "download",
  [scope.scope, "--logLevel", "warn", "--ci"],
  timeoutMs,
  scopeDir,
  forwardedEnv
);
```

`runSyncroCliCommand` вика `node dist/index.js download <scope>`.

При UMD module → yargs грешка → exit=1 → "Auto scope pull failed".

**Fix:** S1 (CommonJS) + S3 (rebuild) → автоматично се оправя.

---

### `servicenowCore.ts` — липсващ PATCH метод

**Файл:** `packages/mcp-server/src/servicenowCore.ts`

**Проблем:** `snRequest` поддържа `"GET" | "POST"`, но не `"PATCH"`.

```typescript
// Сега:
export async function snRequest(
  method: "GET" | "POST",
  ...
)
```

Нужен е PATCH за `sn_update_metadata_record` и бъдещи update tools.

**Fix:**
```typescript
export async function snRequest(
  method: "GET" | "POST" | "PATCH",
  ...
)
```

Fetch логиката вече предава body — PATCH работи без друга промяна.

---

## Credential flow — пълна картина

```
syncrona login
  → saveCredentials(instance, user, pass)  // ~/.syncrona/credentials/{instance}.enc
  → setActiveInstance(instance)            // ~/.syncrona/config.json

syncrona init / syncrona dev / syncrona push
  → bootstrap.ts:
      dotenv.config()                      // зарежда .env (само SN_INSTANCE вече)
      preloadStoredCredentials()           // зарежда store в памет
  → resolveCredentials():
      if (SN_USER в env) → env wins
      else → storedCredentialsCache        // ← нормалният path след fix

syncrona download (MCP subprocess)
  → наследява env от MCP процеса
  → ако няма SN_USER в env → store
```

---

## Ред на изпълнение за Syncrona

```
1. S1  — tsconfig.json: "module": "commonjs"          ← 1 ред промяна
2. S2  — package.json main typo fix                    ← 1 ред промяна
3. S3  — npm --workspace @syncrona/core run build      ← rebuild
4.      — тест: node packages/core/dist/index.js download --help
5. S4  — commander.ts: function builders → objects     ← clean-up (незадължително)
6. S6  — snRequest PATCH в servicenowCore.ts           ← за update tools
7.      — npm run check (full typecheck)
8. B3  — npm publish (от TODO в DONE файла)            ← след всичко горе
```

---

## Build команди

```bash
# Само core
npm --workspace @syncrona/core run build

# Само MCP server
npm --workspace @syncrona/mcp-server run build

# Пълен check (typecheck + lint + tests)
npm run check

# Тест на download командата
node packages/core/dist/index.js download --help
```

---

## Файлове засегнати от промените (quick reference)

| Файл | Промяна | Статус |
|------|---------|--------|
| `tsconfig.json` | `"module": "commonjs"` | ❌ чака |
| `packages/core/package.json` | `"main": "./dist/index.js"` | ❌ чака |
| `packages/core/src/commander.ts` | function builders → objects | ❌ чака (clean-up) |
| `packages/core/src/wizard.ts` | fresh machine + fresh instance + .env | ✅ оправено |
| `packages/core/src/snClient.ts` | hasEnvCreds само по SN_USER | ✅ оправено |
| `packages/mcp-server/src/servicenowCore.ts` | PATCH метод | ❌ чака |
