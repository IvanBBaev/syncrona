import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { buildFullScriptAnalysisReport } from "../analysis";
import { toJsonText } from "../runtimeUtils";
import {
  loadAuthStoreProfile,
  runBackgroundScript,
  snRequest,
  snRequestWithConfig,
  toTableResultRows,
} from "../servicenowCore";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

type InsightToolContext = {
  timeoutMs: number;
};

const EXCERPT_RADIUS = 100;

export const SCRIPT_SEARCH_TABLES: Record<string, { scriptField: string; nameField: string }> = {
  sys_script_include: { scriptField: "script", nameField: "name" },
  sys_script: { scriptField: "script", nameField: "name" },
  sys_script_client: { scriptField: "script", nameField: "name" },
  sys_ui_script: { scriptField: "script", nameField: "name" },
  sys_ws_operation: { scriptField: "operation_script", nameField: "name" },
  sys_transform_script: { scriptField: "script", nameField: "name" },
};

function textResponse(payload: unknown, isError = false): ToolResponse {
  return {
    isError,
    content: [{ type: "text", text: toJsonText(payload) }],
  };
}

function errorResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(Math.floor(value), 1), max);
  }
  return fallback;
}

export function isoToServiceNowDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

export function defaultSinceIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
}

export function buildRecentChangesQuery(scope: string, sinceDateTime: string): string {
  const parts = [`application.scope=${scope}`];
  if (sinceDateTime) {
    parts.push(`sys_created_on>=${sinceDateTime}`);
  }
  parts.push("ORDERBYDESCsys_created_on");
  return parts.join("^");
}

export function buildScriptExcerpt(script: string, query: string): string {
  if (!script || !query) {
    return "";
  }
  const index = script.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return "";
  }
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(script.length, index + query.length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < script.length ? "…" : "";
  return `${prefix}${script.slice(start, end)}${suffix}`;
}

export function formatRecordHistory(
  rows: Record<string, unknown>[]
): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    changedBy: String(row.sys_created_by ?? ""),
    changedAt: String(row.sys_created_on ?? ""),
    field: String(row.fieldname ?? ""),
    oldValue: row.oldvalue ?? "",
    newValue: row.newvalue ?? "",
  }));
}

export function buildReleaseNotesMarkdown(
  label: string,
  rows: Record<string, unknown>[]
): string {
  const grouped = new Map<string, Array<{ action: string; name: string }>>();
  for (const row of rows) {
    const type = String(row.type ?? "unknown");
    const action = String(row.action ?? "").toUpperCase() || "UPDATE";
    const name = String(row.target_name ?? row.name ?? "");
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    grouped.get(type)?.push({ action, name });
  }

  const lines: string[] = [`# Release Notes — ${label}`, ""];
  lines.push(`Total changes: ${rows.length}`, "");

  const sortedTypes = [...grouped.keys()].sort();
  for (const type of sortedTypes) {
    lines.push(`## ${type}`);
    const items = grouped.get(type) ?? [];
    for (const item of items) {
      lines.push(`- ${item.action}: ${item.name}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function handleListRecentChanges(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const scope = typeof args.scope === "string" ? args.scope.trim() : "";
  if (!scope) {
    return errorResponse("Missing required field: scope");
  }

  const sinceIso = typeof args.since === "string" && args.since.trim() ? args.since.trim() : defaultSinceIso();
  const sinceDateTime = isoToServiceNowDateTime(sinceIso);
  const limit = clampLimit(args.limit, 50, 200);

  const params = new URLSearchParams();
  params.set("sysparm_query", buildRecentChangesQuery(scope, sinceDateTime));
  params.set("sysparm_limit", String(limit));
  params.set(
    "sysparm_fields",
    "name,type,target_name,action,sys_created_by,sys_created_on,update_set"
  );

  const response = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${params.toString()}`,
    undefined,
    timeoutMs
  );

  const rows = toTableResultRows(response.data);
  const changes = rows.map((row) => ({
    name: String(row.target_name ?? row.name ?? ""),
    type: String(row.type ?? ""),
    action: String(row.action ?? "").toUpperCase(),
    changedBy: String(row.sys_created_by ?? ""),
    changedAt: String(row.sys_created_on ?? ""),
  }));

  return textResponse(
    {
      status: response.status,
      scope,
      since: sinceIso,
      rowCount: changes.length,
      changes,
    },
    response.status < 200 || response.status > 299
  );
}

async function handleSearchScripts(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return errorResponse("Missing required field: query");
  }

  const scope = typeof args.scope === "string" ? args.scope.trim() : "";
  const requestedTables = Array.isArray(args.tables)
    ? args.tables.filter((item): item is string => typeof item === "string")
    : [];
  const tables = requestedTables.length > 0
    ? requestedTables.filter((table) => table in SCRIPT_SEARCH_TABLES)
    : Object.keys(SCRIPT_SEARCH_TABLES);
  const limit = clampLimit(args.limit, 20, 100);

  const matches: Array<Record<string, unknown>> = [];
  const errors: Array<{ table: string; status: number }> = [];

  for (const table of tables) {
    const config = SCRIPT_SEARCH_TABLES[table];
    if (!config) {
      continue;
    }

    const queryParts = [`${config.scriptField}CONTAINS${query}`];
    if (scope) {
      queryParts.push(`sys_scope.scope=${scope}`);
    }

    const params = new URLSearchParams();
    params.set("sysparm_query", queryParts.join("^"));
    params.set("sysparm_limit", String(limit));
    params.set("sysparm_fields", `sys_id,${config.nameField},${config.scriptField}`);

    const response = await snRequest(
      "GET",
      `/api/now/table/${table}?${params.toString()}`,
      undefined,
      timeoutMs
    );

    if (response.status < 200 || response.status > 299) {
      errors.push({ table, status: response.status });
      continue;
    }

    const rows = toTableResultRows(response.data);
    for (const row of rows) {
      const script = String(row[config.scriptField] ?? "");
      matches.push({
        table,
        name: String(row[config.nameField] ?? ""),
        sys_id: String(row.sys_id ?? ""),
        matchedField: config.scriptField,
        excerpt: buildScriptExcerpt(script, query),
      });
    }
  }

  return textResponse({
    query,
    scope: scope || null,
    tablesSearched: tables,
    matchCount: matches.length,
    matches,
    errors,
  });
}

async function handleRecordHistory(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const table = typeof args.table === "string" ? args.table.trim() : "";
  const sysId = typeof args.sysId === "string" ? args.sysId.trim() : "";
  if (!table) {
    return errorResponse("Missing required field: table");
  }
  if (!sysId) {
    return errorResponse("Missing required field: sysId");
  }

  const limit = clampLimit(args.limit, 20, 200);

  const params = new URLSearchParams();
  params.set(
    "sysparm_query",
    `tablename=${table}^documentkey=${sysId}^ORDERBYDESCsys_created_on`
  );
  params.set("sysparm_limit", String(limit));
  params.set("sysparm_fields", "fieldname,oldvalue,newvalue,sys_created_by,sys_created_on");

  const response = await snRequest(
    "GET",
    `/api/now/table/sys_audit?${params.toString()}`,
    undefined,
    timeoutMs
  );

  const rows = toTableResultRows(response.data);

  return textResponse(
    {
      status: response.status,
      table,
      sysId,
      entryCount: rows.length,
      history: formatRecordHistory(rows),
    },
    response.status < 200 || response.status > 299
  );
}

async function resolveUpdateSetSysId(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<{ sysId: string; label: string } | { error: string }> {
  const explicitSysId = typeof args.updateSetSysId === "string" ? args.updateSetSysId.trim() : "";
  if (explicitSysId) {
    return { sysId: explicitSysId, label: explicitSysId };
  }

  const name = typeof args.updateSetName === "string" ? args.updateSetName.trim() : "";
  if (!name) {
    return { error: "Provide either updateSetSysId or updateSetName" };
  }

  const params = new URLSearchParams();
  params.set("sysparm_query", `name=${name}`);
  params.set("sysparm_limit", "1");
  params.set("sysparm_fields", "sys_id,name");

  const response = await snRequest(
    "GET",
    `/api/now/table/sys_update_set?${params.toString()}`,
    undefined,
    timeoutMs
  );

  const rows = toTableResultRows(response.data);
  if (rows.length === 0) {
    return { error: `Update set not found: ${name}` };
  }

  return { sysId: String(rows[0].sys_id ?? ""), label: name };
}

async function handleGenerateReleaseNotes(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const format = args.format === "json" ? "json" : "markdown";
  const resolved = await resolveUpdateSetSysId(args, timeoutMs);
  if ("error" in resolved) {
    return errorResponse(resolved.error);
  }

  const params = new URLSearchParams();
  params.set("sysparm_query", `update_set=${resolved.sysId}^ORDERBYtype`);
  params.set("sysparm_limit", "1000");
  params.set("sysparm_fields", "name,type,target_name,action");

  const response = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${params.toString()}`,
    undefined,
    timeoutMs
  );

  const rows = toTableResultRows(response.data);
  const isError = response.status < 200 || response.status > 299;

  if (format === "json") {
    return textResponse(
      {
        status: response.status,
        updateSet: resolved.label,
        changeCount: rows.length,
        changes: rows.map((row) => ({
          type: String(row.type ?? ""),
          action: String(row.action ?? "").toUpperCase(),
          name: String(row.target_name ?? row.name ?? ""),
        })),
      },
      isError
    );
  }

  return {
    isError,
    content: [{ type: "text", text: buildReleaseNotesMarkdown(resolved.label, rows) }],
  };
}

// --- E1: sync_run_atf_tests ----------------------------------------------

const ATF_RUNNING_STATES = new Set(["", "pending", "running", "queued", "waiting"]);

export function buildAtfRunScript(opts: {
  scope: string;
  suiteIds: string[];
  testIds: string[];
}): string {
  const payload = JSON.stringify({
    scope: opts.scope,
    suiteIds: opts.suiteIds,
    testIds: opts.testIds,
  });
  return [
    "(function runSyncronaAtf() {",
    `  var request = ${payload};`,
    "  var triggered = { suites: [], tests: [], errors: [] };",
    "  function runSuite(id) {",
    "    try {",
    "      var runner = new sn_atf.UserTestRunner();",
    "      if (typeof runner.runSuite === 'function') { runner.runSuite(id); }",
    "      triggered.suites.push(id);",
    "    } catch (e) { triggered.errors.push('suite ' + id + ': ' + e); }",
    "  }",
    "  function runTest(id) {",
    "    try {",
    "      var runner = new sn_atf.UserTestRunner();",
    "      if (typeof runner.runTest === 'function') { runner.runTest(id); }",
    "      triggered.tests.push(id);",
    "    } catch (e) { triggered.errors.push('test ' + id + ': ' + e); }",
    "  }",
    "  request.suiteIds.forEach(runSuite);",
    "  request.testIds.forEach(runTest);",
    "  if (request.suiteIds.length === 0 && request.testIds.length === 0) {",
    "    var gr = new GlideRecord('sys_atf_test_suite');",
    "    gr.addQuery('sys_scope.scope', request.scope);",
    "    gr.addActiveQuery();",
    "    gr.query();",
    "    while (gr.next()) { runSuite(gr.getUniqueValue()); }",
    "  }",
    "  gs.print('SYNCRONA_ATF_TRIGGERED:' + JSON.stringify(triggered));",
    "})();",
  ].join("\n");
}

export function parseAtfTrigger(text: string): Record<string, unknown> {
  const marker = "SYNCRONA_ATF_TRIGGERED:";
  const index = typeof text === "string" ? text.indexOf(marker) : -1;
  if (index < 0) {
    return { suites: [], tests: [], errors: [] };
  }
  const tail = text.slice(index + marker.length).trim();
  const end = tail.indexOf("\n");
  const jsonText = end >= 0 ? tail.slice(0, end) : tail;
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch (_) {
    return { suites: [], tests: [], errors: [] };
  }
}

export function summarizeAtfResults(
  rows: Record<string, unknown>[]
): { total: number; passed: number; failed: number; results: Array<Record<string, unknown>> } {
  let passed = 0;
  let failed = 0;
  const results = rows.map((row) => {
    const status = String(row.status ?? "").toLowerCase();
    const ok = status === "success" || status === "passed";
    if (ok) {
      passed += 1;
    } else {
      failed += 1;
    }
    return {
      sys_id: String(row.sys_id ?? ""),
      name: String(row.name ?? row.test ?? row.test_suite ?? ""),
      status: status || "unknown",
      output: String(row.output ?? ""),
      duration: String(row.duration ?? row.run_time ?? ""),
    };
  });
  return { total: rows.length, passed, failed, results };
}

function isAtfTerminal(rows: Record<string, unknown>[]): boolean {
  if (rows.length === 0) {
    return false;
  }
  return rows.every((row) => !ATF_RUNNING_STATES.has(String(row.status ?? "").toLowerCase()));
}

function snSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAtfResults(
  table: string,
  query: string,
  fields: string,
  timeoutMs: number
): Promise<{ status: number; rows: Record<string, unknown>[] }> {
  const interval = 1500;
  const maxAttempts = Math.max(1, Math.min(40, Math.ceil(timeoutMs / interval)));
  let lastStatus = 0;
  let lastRows: Record<string, unknown>[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const params = new URLSearchParams();
    params.set("sysparm_query", query);
    params.set("sysparm_limit", "50");
    params.set("sysparm_fields", fields);

    const response = await snRequest(
      "GET",
      `/api/now/table/${table}?${params.toString()}`,
      undefined,
      timeoutMs
    );
    lastStatus = response.status;
    lastRows = toTableResultRows(response.data);

    if (isAtfTerminal(lastRows)) {
      return { status: lastStatus, rows: lastRows };
    }
    if (attempt < maxAttempts - 1) {
      await snSleep(interval);
    }
  }

  return { status: lastStatus, rows: lastRows };
}

async function handleRunAtfTests(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const scope = typeof args.scope === "string" ? args.scope.trim() : "";
  if (!scope) {
    return errorResponse("Missing required field: scope");
  }

  const suiteId = typeof args.suiteId === "string" ? args.suiteId.trim() : "";
  const testId = typeof args.testId === "string" ? args.testId.trim() : "";
  const runAll = args.runAll === true;

  if (!suiteId && !testId && !runAll) {
    return errorResponse("Provide suiteId, testId, or set runAll=true.");
  }

  const startedAtIso = isoToServiceNowDateTime(new Date().toISOString());
  const script = buildAtfRunScript({
    scope,
    suiteIds: suiteId ? [suiteId] : [],
    testIds: testId ? [testId] : [],
  });

  const triggerResponse = await runBackgroundScript(script, timeoutMs);
  const trigger = parseAtfTrigger(String(triggerResponse.text ?? ""));

  const useTest = Boolean(testId) && !suiteId && !runAll;
  const table = useTest ? "sys_atf_test_result" : "sys_atf_test_suite_result";
  const filterParts: string[] = [];
  if (testId && useTest) {
    filterParts.push(`test=${testId}`);
  } else if (suiteId) {
    filterParts.push(`test_suite=${suiteId}`);
  } else {
    filterParts.push(`test_suite.sys_scope.scope=${scope}`);
  }
  if (startedAtIso) {
    filterParts.push(`sys_created_on>=${startedAtIso}`);
  }
  filterParts.push("ORDERBYDESCsys_created_on");

  const poll = await pollAtfResults(
    table,
    filterParts.join("^"),
    "sys_id,status,output,duration,run_time,test,test_suite",
    timeoutMs
  );

  const summary = summarizeAtfResults(poll.rows);
  const completed = isAtfTerminal(poll.rows);

  return textResponse(
    {
      status: poll.status,
      scope,
      mode: useTest ? "test" : runAll ? "all" : "suite",
      suiteId: suiteId || null,
      testId: testId || null,
      triggered: trigger,
      completed,
      summary,
    },
    poll.status < 200 || poll.status > 299 || summary.failed > 0
  );
}

// --- E2: sync_validate_before_push ---------------------------------------

export function evaluateValidationStatus(
  report: Record<string, unknown>
): { status: "blocked" | "warning" | "ready"; high: number; medium: number; low: number } {
  const risk = report.risk && typeof report.risk === "object" ? (report.risk as Record<string, unknown>) : {};
  const active = risk.active && typeof risk.active === "object" ? (risk.active as Record<string, unknown>) : {};
  const distribution =
    active.distribution && typeof active.distribution === "object"
      ? (active.distribution as Record<string, unknown>)
      : {};
  const high = Number(distribution.high ?? 0) || 0;
  const medium = Number(distribution.medium ?? 0) || 0;
  const low = Number(distribution.low ?? 0) || 0;
  let status: "blocked" | "warning" | "ready" = "ready";
  if (high > 0) {
    status = "blocked";
  } else if (medium > 0) {
    status = "warning";
  }
  return { status, high, medium, low };
}

async function handleValidateBeforePush(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const scope = typeof args.scope === "string" ? args.scope.trim() : "";
  if (!scope) {
    return errorResponse("Missing required field: scope");
  }

  const requestedTables = Array.isArray(args.tables)
    ? args.tables.filter((item): item is string => typeof item === "string")
    : [];
  const tables = requestedTables.length > 0
    ? requestedTables.filter((table) => table in SCRIPT_SEARCH_TABLES)
    : Object.keys(SCRIPT_SEARCH_TABLES);
  const limit = clampLimit(args.limit, 50, 200);
  const conflictWindowHours = typeof args.conflictWindowHours === "number" && args.conflictWindowHours > 0
    ? Math.min(args.conflictWindowHours, 720)
    : 24;

  const files: Array<Record<string, unknown>> = [];
  let blockedCount = 0;
  let warningCount = 0;
  const errors: Array<{ table: string; status: number }> = [];

  for (const table of tables) {
    const config = SCRIPT_SEARCH_TABLES[table];
    if (!config) {
      continue;
    }

    const params = new URLSearchParams();
    params.set("sysparm_query", `sys_scope.scope=${scope}`);
    params.set("sysparm_limit", String(limit));
    params.set("sysparm_fields", `sys_id,${config.nameField},${config.scriptField}`);

    const response = await snRequest(
      "GET",
      `/api/now/table/${table}?${params.toString()}`,
      undefined,
      timeoutMs
    );

    if (response.status < 200 || response.status > 299) {
      errors.push({ table, status: response.status });
      continue;
    }

    const rows = toTableResultRows(response.data);
    for (const row of rows) {
      const script = String(row[config.scriptField] ?? "");
      const report = buildFullScriptAnalysisReport(script);
      const evaluation = evaluateValidationStatus(report);
      if (evaluation.status === "blocked") {
        blockedCount += 1;
      } else if (evaluation.status === "warning") {
        warningCount += 1;
      }
      const activeFindings =
        report.findings && typeof report.findings === "object"
          ? (report.findings as Record<string, unknown>).active
          : [];
      files.push({
        table,
        name: String(row[config.nameField] ?? ""),
        sys_id: String(row.sys_id ?? ""),
        status: evaluation.status,
        findings: {
          high: evaluation.high,
          medium: evaluation.medium,
          low: evaluation.low,
        },
        topFindings: Array.isArray(activeFindings) ? activeFindings.slice(0, 3) : [],
      });
    }
  }

  const sinceIso = defaultSinceIso(Date.now() - (conflictWindowHours - 24) * 60 * 60 * 1000);
  const conflictParams = new URLSearchParams();
  conflictParams.set(
    "sysparm_query",
    buildRecentChangesQuery(scope, isoToServiceNowDateTime(sinceIso))
  );
  conflictParams.set("sysparm_limit", "50");
  conflictParams.set("sysparm_fields", "target_name,type,action,sys_created_by,sys_created_on");

  const conflictResponse = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${conflictParams.toString()}`,
    undefined,
    timeoutMs
  );
  const conflictRows = toTableResultRows(conflictResponse.data);
  const recentChanges = conflictRows.map((row) => ({
    name: String(row.target_name ?? ""),
    type: String(row.type ?? ""),
    action: String(row.action ?? "").toUpperCase(),
    changedBy: String(row.sys_created_by ?? ""),
    changedAt: String(row.sys_created_on ?? ""),
  }));

  const ready = blockedCount === 0;

  return textResponse(
    {
      scope,
      ready,
      blockedCount,
      warningCount,
      fileCount: files.length,
      files,
      recentChanges,
      conflictWindowHours,
      errors,
    },
    !ready
  );
}

// --- E5: sync_compare_instances ------------------------------------------

export function hashRecordContent(value: unknown): string {
  return createHash("sha1").update(String(value ?? "")).digest("hex");
}

export function diffInstanceRecords(
  rowsA: Record<string, unknown>[],
  rowsB: Record<string, unknown>[],
  opts: { nameField: string; contentField: string }
): { onlyInA: string[]; onlyInB: string[]; different: Array<Record<string, unknown>> } {
  const mapA = new Map<string, string>();
  const mapB = new Map<string, string>();
  for (const row of rowsA) {
    const name = String(row[opts.nameField] ?? "");
    if (name) {
      mapA.set(name, hashRecordContent(row[opts.contentField]));
    }
  }
  for (const row of rowsB) {
    const name = String(row[opts.nameField] ?? "");
    if (name) {
      mapB.set(name, hashRecordContent(row[opts.contentField]));
    }
  }

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const different: Array<Record<string, unknown>> = [];

  for (const [name, hashA] of mapA) {
    if (!mapB.has(name)) {
      onlyInA.push(name);
    } else if (mapB.get(name) !== hashA) {
      different.push({ name, hashA, hashB: mapB.get(name) });
    }
  }
  for (const name of mapB.keys()) {
    if (!mapA.has(name)) {
      onlyInB.push(name);
    }
  }

  return {
    onlyInA: onlyInA.sort(),
    onlyInB: onlyInB.sort(),
    different: different.sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

async function fetchScopeScriptRows(
  config: { instance: string; user: string; password: string },
  table: string,
  scriptField: string,
  nameField: string,
  scope: string,
  limit: number,
  timeoutMs: number
): Promise<{ status: number; rows: Record<string, unknown>[] }> {
  const params = new URLSearchParams();
  params.set("sysparm_query", `sys_scope.scope=${scope}`);
  params.set("sysparm_limit", String(limit));
  params.set("sysparm_fields", `sys_id,${nameField},${scriptField}`);

  const response = await snRequestWithConfig(
    config,
    "GET",
    `/api/now/table/${table}?${params.toString()}`,
    undefined,
    timeoutMs
  );
  return { status: response.status, rows: toTableResultRows(response.data) };
}

async function handleCompareInstances(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const profileA = typeof args.profileA === "string" ? args.profileA.trim() : "";
  const profileB = typeof args.profileB === "string" ? args.profileB.trim() : "";
  const scope = typeof args.scope === "string" ? args.scope.trim() : "";

  if (!profileA) {
    return errorResponse("Missing required field: profileA");
  }
  if (!profileB) {
    return errorResponse("Missing required field: profileB");
  }
  if (!scope) {
    return errorResponse("Missing required field: scope");
  }

  const configA = loadAuthStoreProfile(profileA);
  if (!configA) {
    return errorResponse(`Profile not found in auth store: ${profileA}. Run 'syncrona login' for it first.`);
  }
  const configB = loadAuthStoreProfile(profileB);
  if (!configB) {
    return errorResponse(`Profile not found in auth store: ${profileB}. Run 'syncrona login' for it first.`);
  }

  const requestedTables = Array.isArray(args.tables)
    ? args.tables.filter((item): item is string => typeof item === "string")
    : [];
  const tables = requestedTables.length > 0
    ? requestedTables.filter((table) => table in SCRIPT_SEARCH_TABLES)
    : Object.keys(SCRIPT_SEARCH_TABLES);
  const limit = clampLimit(args.limit, 200, 500);

  const tableResults: Array<Record<string, unknown>> = [];
  let onlyInACount = 0;
  let onlyInBCount = 0;
  let differentCount = 0;

  for (const table of tables) {
    const config = SCRIPT_SEARCH_TABLES[table];
    if (!config) {
      continue;
    }

    const [resA, resB] = await Promise.all([
      fetchScopeScriptRows(configA, table, config.scriptField, config.nameField, scope, limit, timeoutMs),
      fetchScopeScriptRows(configB, table, config.scriptField, config.nameField, scope, limit, timeoutMs),
    ]);

    const diff = diffInstanceRecords(resA.rows, resB.rows, {
      nameField: config.nameField,
      contentField: config.scriptField,
    });

    onlyInACount += diff.onlyInA.length;
    onlyInBCount += diff.onlyInB.length;
    differentCount += diff.different.length;

    tableResults.push({
      table,
      statusA: resA.status,
      statusB: resB.status,
      onlyInA: diff.onlyInA,
      onlyInB: diff.onlyInB,
      different: diff.different,
    });
  }

  return textResponse({
    profileA,
    profileB,
    scope,
    tablesCompared: tables,
    summary: {
      onlyInA: onlyInACount,
      onlyInB: onlyInBCount,
      different: differentCount,
    },
    tables: tableResults,
  });
}

// --- E7: sync_export_update_set ------------------------------------------

export function buildUpdateSetExportPath(name: string): string {
  const safe = (name || "").replace(/[^a-zA-Z0-9._-]/g, "_") || "update_set";
  return path.join(".syncrona-mcp", "exports", `${safe}.xml`);
}

async function handleExportUpdateSet(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const resolved = await resolveUpdateSetSysId(args, timeoutMs);
  if ("error" in resolved) {
    return errorResponse(resolved.error);
  }

  const exportResponse = await snRequest(
    "GET",
    `/export_update_set.do?sysparm_sys_id=${encodeURIComponent(resolved.sysId)}`,
    undefined,
    timeoutMs
  );

  const xml = typeof exportResponse.text === "string" ? exportResponse.text : "";
  const isError = exportResponse.status < 200 || exportResponse.status > 299 || !xml.trim();

  const countParams = new URLSearchParams();
  countParams.set("sysparm_query", `update_set=${resolved.sysId}`);
  countParams.set("sysparm_limit", "1000");
  countParams.set("sysparm_fields", "type");
  const countResponse = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${countParams.toString()}`,
    undefined,
    timeoutMs
  );
  const recordCount = toTableResultRows(countResponse.data).length;

  let savedTo: string | null = null;
  if (args.writeFiles === true && xml.trim()) {
    const relativePath = buildUpdateSetExportPath(resolved.label);
    const absolutePath = path.join(process.cwd(), relativePath);
    try {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, xml, "utf8");
      savedTo = relativePath;
    } catch (error) {
      savedTo = null;
      return textResponse(
        {
          status: exportResponse.status,
          updateSet: resolved.label,
          sysId: resolved.sysId,
          recordCount,
          byteLength: Buffer.byteLength(xml, "utf8"),
          writeError: error instanceof Error ? error.message : String(error),
          xml,
        },
        true
      );
    }
  }

  return textResponse(
    {
      status: exportResponse.status,
      updateSet: resolved.label,
      sysId: resolved.sysId,
      recordCount,
      byteLength: Buffer.byteLength(xml, "utf8"),
      savedTo,
      xml,
    },
    isError
  );
}

export async function handleInsightTool(
  toolName: string,
  args: Record<string, unknown>,
  context: InsightToolContext
): Promise<ToolResponse | null> {
  const { timeoutMs } = context;

  switch (toolName) {
    case "sync_list_recent_changes":
      return handleListRecentChanges(args, timeoutMs);
    case "sn_search_scripts":
      return handleSearchScripts(args, timeoutMs);
    case "sn_get_record_history":
      return handleRecordHistory(args, timeoutMs);
    case "sync_generate_release_notes":
      return handleGenerateReleaseNotes(args, timeoutMs);
    case "sync_run_atf_tests":
      return handleRunAtfTests(args, timeoutMs);
    case "sync_validate_before_push":
      return handleValidateBeforePush(args, timeoutMs);
    case "sync_compare_instances":
      return handleCompareInstances(args, timeoutMs);
    case "sync_export_update_set":
      return handleExportUpdateSet(args, timeoutMs);
    default:
      return null;
  }
}
