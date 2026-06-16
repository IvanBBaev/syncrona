# Syncrona — Detailed Plan

**Project:** `/Users/Ivan.Baev/Development/Incubation/syncrona`
**Status:** Partially broken. Critical bugs block CLI download and npm publish.
**Stack:** Node 22, TypeScript, UMD (should be CommonJS), yargs v17, axios, inquirer, monorepo.

---

## Project architecture

```
packages/
  core/           — CLI (syncrona init/download/push/dev/...)
  mcp-server/     — MCP server (tools for Claude/Cursor/VS Code)
  types/          — shared types
  babel-plugin/   — ServiceNow babel transformations
  ...
```

---

## Critical bugs — fix immediately

### S1. `tsconfig.json` — `"module": "umd"` is wrong

**File:** `/Users/Ivan.Baev/Development/Incubation/syncrona/tsconfig.json`

**Problem:**
```json
"module": "umd"
```

A Node.js CLI application must NEVER be compiled as UMD. UMD is for browser/AMD environments. With the UMD format, yargs v17 registers the builder function as the handler — hence `args.options is not a function`.

**The production error:**
```
TypeError: args.options is not a function
    at Object.handler (dist/commander.js:75:18)
```

**Fix:**
```json
"module": "commonjs"
```

**Affects:** All commands with a function builder — `download`, `push`, `build`, `mcp`. `refresh`, `dev`, `deploy` (with an object builder) work by accident.

**After the fix:** `npm --workspace @syncrona/core run build`

---

### S2. `packages/core/package.json` — typo in `main`

**File:** `/Users/Ivan.Baev/Development/Incubation/syncrona/packages/core/package.json`

**Problem:**
```json
"main": "./dist./index.js"
```

Double dot (`./dist./`) — Node.js cannot find the entry point on `require("@syncrona/core")`.

**Fix:**
```json
"main": "./dist/index.js"
```

**Affects:** npm publish, loading locally as a package.

---

### S3. Rebuild after S1 + S2

```bash
npm --workspace @syncrona/core run build
```

Confirm it works:
```bash
node packages/core/dist/index.js download --help
# should show help without an error
```

---

### S4. `packages/core/src/commander.ts` — function builders

**File:** `packages/core/src/commander.ts`

**Problem:** After S1 (CommonJS) the error disappears, but the code stays fragile. Function builders return `cmdArgs` — redundant.

**Current code (push as an example):**
```typescript
.command(["push [target]"], "...",
  cmdArgs => {
    cmdArgs.options({ ...sharedOptions, diff: {...}, scopeSwap: {...}, updateSet: {...}, ci: {...} });
    return cmdArgs;  // ← redundant
  },
  (args) => { pushCommand(args); }
)
```

**Cleaner variant:**
```typescript
.command(["push [target]"], "...",
  { ...sharedOptions, diff: {...}, scopeSwap: {...}, updateSet: {...}, ci: {...} },
  (args) => { pushCommand(args); }
)
```

Affects: `download`, `push`, `build`, `mcp` commands.

**Important:** S4 is clean-up. S1 is the real fix. Not required to make it work.

---

## Already fixed in this session (rebuild only)

### S5. `wizard.ts` — fresh machine without `syncrona login`

**Old behavior:** `getWizardCredentials()` threw immediately if there was no active instance in the store.

**New behavior:** If there is no active instance → calls `promptForCredentials()` → user enters credentials → saves to the store → continues.

**File:** `packages/core/src/wizard.ts` — `getWizardCredentials()` function.

---

### S6. `wizard.ts` — fresh SN instance without scoped apps

**Old behavior:** `listAppsFromTableAPI()` → empty → `throw new Error("No scoped apps were found")`.

**New behavior:**
1. Shows guidance: "Create a scoped app in ServiceNow Studio"
2. Asks: "Enter scope code manually?"
3. If yes → user enters scope → continues
4. If no → exits gracefully

**File:** `packages/core/src/wizard.ts` — `startWizard()` function, after the two `if (apps.length === 0)` checks.

---

### S7. `.env` with plain-text credentials

**Three changes:**

**7a. `wizard.ts` `setupDotEnv()`** — now writes only `SN_INSTANCE=...`, without `SN_USER` and `SN_PASSWORD`. Overwrites existing `.env` files that contain credentials.

**7b. `snClient.ts` `resolveCredentials()`** — `hasEnvCreds` is now `true` only if `SN_USER` is present. An `SN_INSTANCE`-only `.env` no longer blocks the encrypted credential store.

**7c. `wizard.ts` `startWizard()`** — `preloadStoredCredentials(instance)` is called after `saveCredentials()`. `downloadApp()` → `defaultClient()` uses the store, not env vars.

**Effect:** An old `.env` with a wrong password no longer blocks `syncrona login`.

---

## MCP server — analysis

### What works in the MCP server

- Session context (current scope, update set)
- Script analysis tools (local regex)
- Workspace tools (refresh, status, push) — call the `syncrona` CLI subprocess
- CRUD tools (sn_query_records, sn_create_record)
- Background script execution

### Problem: auto scope pull

**Code:** `packages/mcp-server/src/index.ts` around line 1972

```typescript
const downloadResult = await runSyncroCliCommand(
  "download",
  [scope.scope, "--logLevel", "warn", "--ci"],
  timeoutMs,
  scopeDir,
  forwardedEnv
);
```

`runSyncroCliCommand` calls `node dist/index.js download <scope>`.

With a UMD module → yargs error → exit=1 → "Auto scope pull failed".

**Fix:** S1 (CommonJS) + S3 (rebuild) → fixed automatically.

---

### `servicenowCore.ts` — missing PATCH method

**File:** `packages/mcp-server/src/servicenowCore.ts`

**Problem:** `snRequest` supports `"GET" | "POST"`, but not `"PATCH"`.

```typescript
// Now:
export async function snRequest(
  method: "GET" | "POST",
  ...
)
```

PATCH is needed for `sn_update_metadata_record` and future update tools.

**Fix:**
```typescript
export async function snRequest(
  method: "GET" | "POST" | "PATCH",
  ...
)
```

The fetch logic already passes the body — PATCH works with no other change.

---

## Credential flow — full picture

```
syncrona login
  → saveCredentials(instance, user, pass)  // ~/.syncrona/credentials/{instance}.enc
  → setActiveInstance(instance)            // ~/.syncrona/config.json

syncrona init / syncrona dev / syncrona push
  → bootstrap.ts:
      dotenv.config()                      // loads .env (only SN_INSTANCE now)
      preloadStoredCredentials()           // loads the store into memory
  → resolveCredentials():
      if (SN_USER in env) → env wins
      else → storedCredentialsCache        // ← the normal path after the fix

syncrona download (MCP subprocess)
  → inherits env from the MCP process
  → if no SN_USER in env → store
```

---

## Execution order for Syncrona

```
1. S1  — tsconfig.json: "module": "commonjs"           ← 1-line change
2. S2  — package.json main typo fix                    ← 1-line change
3. S3  — npm --workspace @syncrona/core run build      ← rebuild
4.      — test: node packages/core/dist/index.js download --help
5. S4  — commander.ts: function builders → objects     ← clean-up (optional)
6. S6  — snRequest PATCH in servicenowCore.ts          ← for update tools
7.      — npm run check (full typecheck)
8. B3  — npm publish (from the TODO in the DONE file)  ← after everything above
```

---

## Build commands

```bash
# Core only
npm --workspace @syncrona/core run build

# MCP server only
npm --workspace @syncrona/mcp-server run build

# Full check (typecheck + lint + tests)
npm run check

# Test the download command
node packages/core/dist/index.js download --help
```

---

## Files affected by the changes (quick reference)

| File | Change | Status |
|------|--------|--------|
| `tsconfig.json` | `"module": "commonjs"` | ❌ pending |
| `packages/core/package.json` | `"main": "./dist/index.js"` | ❌ pending |
| `packages/core/src/commander.ts` | function builders → objects | ❌ pending (clean-up) |
| `packages/core/src/wizard.ts` | fresh machine + fresh instance + .env | ✅ fixed |
| `packages/core/src/snClient.ts` | hasEnvCreds by SN_USER only | ✅ fixed |
| `packages/mcp-server/src/servicenowCore.ts` | PATCH method | ❌ pending |
