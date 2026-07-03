// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeQueryValue, wrapUntrustedData } from "../runtimeUtils";
import { runBackgroundScript, snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import type { InsightToolContext } from "./insightShared";
import { errorResponse, isoToServiceNowDateTime, textResponse } from "./insightShared";

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
      // ATF step output is instance-authored free text — fence as untrusted.
      output: wrapUntrustedData(row.output, "servicenow"),
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

export async function handleRunAtfTests(
  args: Record<string, unknown>,
  context: InsightToolContext
): Promise<ToolResponse> {
  const { timeoutMs } = context;
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

  // Triggering ATF runs a background script that mutates the instance, so gate
  // it behind the same confirmDestructive / dryRun / audit contract as the
  // other mutating tools.
  if (args.confirmDestructive !== true) {
    return errorResponse(
      "Running ATF tests executes a background script on the instance. Re-run with confirmDestructive=true."
    );
  }

  if (context.dryRun) {
    return context.makeDryRunAuditResponse("sync_run_atf_tests", args, {
      scope,
      suiteId: suiteId || null,
      testId: testId || null,
      runAll,
    });
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
    filterParts.push(`test=${escapeQueryValue(testId)}`);
  } else if (suiteId) {
    filterParts.push(`test_suite=${escapeQueryValue(suiteId)}`);
  } else {
    filterParts.push(`test_suite.sys_scope.scope=${escapeQueryValue(scope)}`);
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

  context.auditMutatingTool(
    "sync_run_atf_tests",
    args,
    {
      status: poll.status,
      scope,
      mode: useTest ? "test" : runAll ? "all" : "suite",
      completed,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
    },
    Date.now() - context.startedAt
  );

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
