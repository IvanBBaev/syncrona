# Desktop/app — Detailed Plan

**Project:** `/Users/Ivan.Baev/Desktop/app`
**Status:** Working. Needed: add new tools.
**Stack:** Node 22, TypeScript 5.7, ESM (`"type": "module"`), `"module": "NodeNext"`, fetch-based, no axios.

---

## Current state — working ✅

### Infrastructure
- `serviceNowRequest(method, path, body?)` — central fetch function, supports GET + POST
- Auth: basic / oauth / auto — reads from `.env` via a zod schema
- `SN_INSECURE_TLS=true` → `NODE_TLS_REJECT_UNAUTHORIZED=0`
- MCP SDK: `@modelcontextprotocol/sdk ^1.12.0`

### Existing tools

#### `servicenow.runScript`
- POST to `SN_SCRIPT_API_PATH` (default: `/api/x_copilot_exec/v1/run`)
- Params: `script` (required), `scope?`, `timeoutMs?`, `returnGlideRecordPreview?`
- Returns: `{ ok, output?, error? }`

#### `servicenow.countTablesByPrefix`
- GET `sys_db_object` → filter by `nameSTARTSWITH{prefix}`
- For each table: GET `/api/now/stats/{table}?sysparm_count=true`
- Returns: `{ tableCount, totalRows, denied, tables[] }`

#### `servicenow.buildMetadataManifest`
- GET `sys_db_object` → all tables with the prefix
- For each: GET `sys_dictionary` → fields with types
- Optional: writes JSON to `reports/{prefix}_metadata_manifest.json`
- Returns: `{ tableCount, fieldCount, tables[{ name, label, superClass, fields[] }] }`

---

## What needs to be added

### D1. `servicenow.queryRecords`

**Goal:** Generic query against an arbitrary SN table.

**Input:**
```typescript
{
  table: string;          // required — e.g. "sys_script_include"
  query?: string;         // encoded query — e.g. "active=true^nameSTARTSWITHx_"
  fields?: string[];      // which fields — empty = all
  limit?: number;         // 1–500, default 50
}
```

**Implementation:**
```
GET /api/now/table/{table}
  ?sysparm_query={query}
  &sysparm_fields={fields.join(",")}
  &sysparm_limit={limit}
```

**Output:**
```typescript
{
  table: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}
```

**Notes:**
- `serviceNowRequest` already supports GET — use it directly
- No infrastructure change

---

### D2. `servicenow.getRecord`

**Goal:** Fetch one specific record by sys_id.

**Input:**
```typescript
{
  table: string;     // required
  sysId: string;     // required
  fields?: string[]; // which fields
}
```

**Implementation:**
```
GET /api/now/table/{table}/{sysId}
  ?sysparm_fields={fields.join(",")}
```

**Output:**
```typescript
{
  table: string;
  sysId: string;
  record: Record<string, unknown>;
}
```

---

### D3. `servicenow.createRecord`

**Goal:** Create a new record in a table.

**Input:**
```typescript
{
  table: string;
  record: Record<string, unknown>;   // field → value
  confirmDestructive: boolean;        // must be true
}
```

**Guard:** If `confirmDestructive !== true` → returns an error without an SN call.

**Implementation:**
```
POST /api/now/table/{table}
Body: record
```

**Output:**
```typescript
{
  table: string;
  status: number;
  result: Record<string, unknown>; // the newly created record from SN
}
```

---

### D4. `servicenow.updateRecord`

**Goal:** Update an existing record by sys_id.

**Input:**
```typescript
{
  table: string;
  sysId: string;
  fields: Record<string, unknown>;  // only the fields to change
  confirmDestructive: boolean;       // must be true
}
```

**Guard:** If `confirmDestructive !== true` → error without an SN call.

**Implementation:**
```
PATCH /api/now/table/{table}/{sysId}
Body: fields
```

**Important:** `serviceNowRequest` currently supports only `"GET" | "POST"`.
`"PATCH"` must be added to the signature and the fetch logic.

**Output:**
```typescript
{
  table: string;
  sysId: string;
  status: number;
  result: Record<string, unknown>;
}
```

---

### D5. `servicenow.analyzeScript`

**Goal:** Local static analysis of an SN server-side script. No SN connection.

**Input:**
```typescript
{
  script: string;
  suppressIds?: string[]; // finding IDs to exclude from the report
}
```

**Implementation — regex checks (port from syncrona):**

Security findings:
| ID | Level | Pattern | Message |
|----|-------|---------|---------|
| `sec.encoded.query.concat` | high | `addEncodedQuery(...+input` | Dynamic query concatenation — injection risk |
| `sec.workflow.bypass` | medium | `setWorkflow(false)` | Bypass of business rules |
| `sec.gliderecord.review` | low | `new GlideRecord(...)` | Check ACL and query constraints |

Architecture findings:
| ID | Level | Pattern | Message |
|----|-------|---------|---------|
| `arch.logging.noise` | low | `gs.log(` | Noisy log usage |
| `arch.empty.catch` | medium | `catch () {}` | Empty catch hides errors |

Performance findings:
| ID | Level | Pattern | Message |
|----|-------|---------|---------|
| `perf.nested.gr` | high | `while(gr.next())` + `new GlideRecord(` | Nested GlideRecord in a loop |
| `perf.orderby.review` | low | `orderBy(` | Ordering without an index |

**Risk score:** high=5, medium=3, low=1

**Output:**
```typescript
{
  findings: {
    active: Finding[];
    suppressed: Finding[];
  };
  risk: {
    score: number;
    distribution: { high: number; medium: number; low: number };
  };
  sections: {
    security: { findings: Finding[]; };
    architecture: { findings: Finding[]; };
    performance: { findings: Finding[]; };
  };
}
```

---

### D6. `servicenow.executeBackgroundScript`

**Goal:** Execute a background script directly (without the scope context wrapper).

**Input:**
```typescript
{
  script: string;
  confirmDestructive: boolean; // must be true
}
```

**Guard:** `confirmDestructive !== true` → error.

**Implementation:**
- Uses `SN_SCRIPT_API_PATH` (already configured)
- Difference from `runScript`: no `scope` / `returnGlideRecordPreview` overhead

**Output:**
```typescript
{
  ok: boolean;
  output?: unknown;
  error?: string;
}
```

---

## Infrastructure changes

### `serviceNowRequest` — add PATCH

```typescript
// Now:
async function serviceNowRequest(method: "GET" | "POST", path: string, body?: unknown)

// Needed:
async function serviceNowRequest(method: "GET" | "POST" | "PATCH", path: string, body?: unknown)
```

The fetch logic already passes `body` if present — PATCH works the same way as POST.

---

## Execution order for Desktop/app

```
1. D7  — add PATCH to serviceNowRequest (base infrastructure)
2. D1  — queryRecords (simplest, GET only)
3. D2  — getRecord (GET by sys_id)
4. D3  — createRecord (POST with guard)
5. D4  — updateRecord (PATCH with guard)
6. D5  — analyzeScript (local, no SN)
7. D6  — executeBackgroundScript
8.      — npm run build && npm run check
```

---

## Build commands

```bash
cd /Users/Ivan.Baev/Desktop/app
npm run check    # TypeScript typecheck
npm run build    # compiles to dist/
npm run dev      # tsx directly (no build)
```
