# Desktop/app — Подробен план

**Проект:** `/Users/Ivan.Baev/Desktop/app`
**Статус:** Работи. Нужно: добавяне на нови tools.
**Stack:** Node 22, TypeScript 5.7, ESM (`"type": "module"`), `"module": "NodeNext"`, fetch-based, без axios.

---

## Текущо състояние — работи ✅

### Инфраструктура
- `serviceNowRequest(method, path, body?)` — централна fetch функция, поддържа GET + POST
- Auth: basic / oauth / auto — чете от `.env` чрез zod schema
- `SN_INSECURE_TLS=true` → `NODE_TLS_REJECT_UNAUTHORIZED=0`
- MCP SDK: `@modelcontextprotocol/sdk ^1.12.0`

### Съществуващи tools

#### `servicenow.runScript`
- POST към `SN_SCRIPT_API_PATH` (default: `/api/x_copilot_exec/v1/run`)
- Params: `script` (required), `scope?`, `timeoutMs?`, `returnGlideRecordPreview?`
- Връща: `{ ok, output?, error? }`

#### `servicenow.countTablesByPrefix`
- GET `sys_db_object` → filter по `nameSTARTSWITH{prefix}`
- За всяка таблица: GET `/api/now/stats/{table}?sysparm_count=true`
- Връща: `{ tableCount, totalRows, denied, tables[] }`

#### `servicenow.buildMetadataManifest`
- GET `sys_db_object` → всички таблици с prefix
- За всяка: GET `sys_dictionary` → fields с types
- Опционално: записва JSON в `reports/{prefix}_metadata_manifest.json`
- Връща: `{ tableCount, fieldCount, tables[{ name, label, superClass, fields[] }] }`

---

## Какво трябва да се добави

### D1. `servicenow.queryRecords`

**Цел:** Общ query към произволна SN таблица.

**Input:**
```typescript
{
  table: string;          // задължително — напр. "sys_script_include"
  query?: string;         // encoded query — напр. "active=true^nameSTARTSWITHx_"
  fields?: string[];      // кои полета — празен = всички
  limit?: number;         // 1–500, default 50
}
```

**Имплементация:**
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

**Бележки:**
- `serviceNowRequest` вече поддържа GET — директно използване
- Без промяна на инфраструктурата

---

### D2. `servicenow.getRecord`

**Цел:** Вземи един конкретен запис по sys_id.

**Input:**
```typescript
{
  table: string;     // задължително
  sysId: string;     // задължително
  fields?: string[]; // кои полета
}
```

**Имплементация:**
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

**Цел:** Създай нов запис в таблица.

**Input:**
```typescript
{
  table: string;
  record: Record<string, unknown>;   // field → value
  confirmDestructive: boolean;        // задължително true
}
```

**Guard:** Ако `confirmDestructive !== true` → връща error без SN call.

**Имплементация:**
```
POST /api/now/table/{table}
Body: record
```

**Output:**
```typescript
{
  table: string;
  status: number;
  result: Record<string, unknown>; // новосъздаденият запис от SN
}
```

---

### D4. `servicenow.updateRecord`

**Цел:** Обнови съществуващ запис по sys_id.

**Input:**
```typescript
{
  table: string;
  sysId: string;
  fields: Record<string, unknown>;  // само полетата за промяна
  confirmDestructive: boolean;       // задължително true
}
```

**Guard:** Ако `confirmDestructive !== true` → error без SN call.

**Имплементация:**
```
PATCH /api/now/table/{table}/{sysId}
Body: fields
```

**Важно:** `serviceNowRequest` в момента поддържа само `"GET" | "POST"`.
Трябва да се добави `"PATCH"` в сигнатурата и fetch логиката.

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

**Цел:** Локален статичен анализ на SN server-side script. Без SN connection.

**Input:**
```typescript
{
  script: string;
  suppressIds?: string[]; // finding IDs за изключване от репорта
}
```

**Имплементация — regex checks (порт от syncrona):**

Security findings:
| ID | Level | Pattern | Съобщение |
|----|-------|---------|-----------|
| `sec.encoded.query.concat` | high | `addEncodedQuery(...+input` | Dynamic query concatenation — injection risk |
| `sec.workflow.bypass` | medium | `setWorkflow(false)` | Bypass на business rules |
| `sec.gliderecord.review` | low | `new GlideRecord(...)` | Провери ACL и query constraints |

Architecture findings:
| ID | Level | Pattern | Съобщение |
|----|-------|---------|-----------|
| `arch.logging.noise` | low | `gs.log(` | Noisy log usage |
| `arch.empty.catch` | medium | `catch () {}` | Empty catch скрива грешки |

Performance findings:
| ID | Level | Pattern | Съобщение |
|----|-------|---------|-----------|
| `perf.nested.gr` | high | `while(gr.next())` + `new GlideRecord(` | Nested GlideRecord в loop |
| `perf.orderby.review` | low | `orderBy(` | Ordering без индекс |

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

**Цел:** Изпълни background script директно (без scope context wrapper).

**Input:**
```typescript
{
  script: string;
  confirmDestructive: boolean; // задължително true
}
```

**Guard:** `confirmDestructive !== true` → error.

**Имплементация:**
- Използва `SN_SCRIPT_API_PATH` (вече конфигуриран)
- Разликата от `runScript`: без `scope` / `returnGlideRecordPreview` overhead

**Output:**
```typescript
{
  ok: boolean;
  output?: unknown;
  error?: string;
}
```

---

## Промени в инфраструктурата

### `serviceNowRequest` — добави PATCH

```typescript
// Сега:
async function serviceNowRequest(method: "GET" | "POST", path: string, body?: unknown)

// Трябва:
async function serviceNowRequest(method: "GET" | "POST" | "PATCH", path: string, body?: unknown)
```

Fetch логиката вече предава `body` ако е наличен — PATCH работи по същия начин като POST.

---

## Ред на изпълнение за Desktop/app

```
1. D7  — добави PATCH в serviceNowRequest (базова инфраструктура)
2. D1  — queryRecords (най-прост, само GET)
3. D2  — getRecord (GET по sys_id)
4. D3  — createRecord (POST с guard)
5. D4  — updateRecord (PATCH с guard)
6. D5  — analyzeScript (local, без SN)
7. D6  — executeBackgroundScript
8.      — npm run build && npm run check
```

---

## Build команди

```bash
cd /Users/Ivan.Baev/Desktop/app
npm run check    # TypeScript typecheck
npm run build    # компилира в dist/
npm run dev      # tsx директно (без build)
```
