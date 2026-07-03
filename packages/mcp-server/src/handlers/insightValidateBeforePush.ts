// SPDX-License-Identifier: GPL-3.0-or-later
import { buildFullScriptAnalysisReport } from "../analysis";
import { escapeQueryValue } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import {
  buildRecentChangesQuery,
  clampLimit,
  defaultSinceIso,
  errorResponse,
  isoToServiceNowDateTime,
  SCRIPT_SEARCH_TABLES,
  textResponse,
} from "./insightShared";

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

export async function handleValidateBeforePush(
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
    params.set("sysparm_query", `sys_scope.scope=${escapeQueryValue(scope)}`);
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
