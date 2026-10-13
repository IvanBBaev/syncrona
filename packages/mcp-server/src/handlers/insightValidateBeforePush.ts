// SPDX-License-Identifier: GPL-3.0-or-later
import { buildFullScriptAnalysisReport } from "../analysis";
import { escapeQueryValue } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import {
  buildRecentChangesQuery,
  clampLimit,
  defaultSinceIso,
  describeNonTablePayload,
  errorResponse,
  isoToServiceNowDateTime,
  SCRIPT_SEARCH_TABLES,
  textResponse,
} from "./insightShared";

// --- E2: sync_validate_before_push ---------------------------------------

// Recent changes listed for the conflict check; more are flagged, not listed.
const CONFLICT_CHANGES_LIMIT = 50;

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
  // A requested table this tool cannot read validated nothing, like sn_search_scripts.
  const unknownTables = requestedTables.filter((table) => !(table in SCRIPT_SEARCH_TABLES));
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
  const errors: Array<{ table: string; status: number; reason?: string }> = [];
  const truncatedTables: string[] = [];

  for (const table of tables) {
    const config = SCRIPT_SEARCH_TABLES[table];
    if (!config) {
      continue;
    }

    const params = new URLSearchParams();
    params.set(
      "sysparm_query",
      `sys_scope.scope=${escapeQueryValue(scope)}^ORDERBY${config.nameField}^ORDERBYsys_id`
    );
    // One row past the limit tells a fully read table from one that was cut.
    params.set("sysparm_limit", String(limit + 1));
    params.set("sysparm_fields", [...new Set(["sys_id", config.nameField, config.scriptField])].join(","));

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

    // A login or maintenance page served with a 2xx analysed nothing; read as
    // no rows it would make the table look clean.
    const badPayload = describeNonTablePayload(response.status, response.data);
    if (badPayload) {
      errors.push({ table, status: response.status, reason: badPayload });
      continue;
    }

    const allRows = toTableResultRows(response.data);
    const rows = allRows.length > limit ? allRows.slice(0, limit) : allRows;
    if (allRows.length > limit) {
      truncatedTables.push(table);
    }
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
  conflictParams.set("sysparm_limit", String(CONFLICT_CHANGES_LIMIT + 1));
  conflictParams.set("sysparm_fields", "target_name,name,type,action,sys_created_by,sys_created_on");

  const conflictResponse = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${conflictParams.toString()}`,
    undefined,
    timeoutMs
  );
  // A failed conflict query must not degrade into an empty `recentChanges` list:
  // "nobody else touched the scope" and "the conflict check never ran" are
  // opposite verdicts, and silently reporting the former invites a push over a
  // colleague's concurrent update-set changes.
  // A login or maintenance page served with a 2xx is a conflict check that
  // never ran, too.
  const conflictOk = conflictResponse.status >= 200 && conflictResponse.status <= 299;
  const conflictBadPayload = conflictOk
    ? describeNonTablePayload(conflictResponse.status, conflictResponse.data)
    : null;
  const conflictCheckPerformed = conflictOk && !conflictBadPayload;
  if (!conflictCheckPerformed) {
    errors.push({
      table: "sys_update_xml",
      status: conflictResponse.status,
      ...(conflictBadPayload ? { reason: conflictBadPayload } : {}),
    });
  }
  const allConflictRows = conflictCheckPerformed
    ? toTableResultRows(conflictResponse.data)
    : [];
  const recentChangesTruncated = allConflictRows.length > CONFLICT_CHANGES_LIMIT;
  const conflictRows = recentChangesTruncated
    ? allConflictRows.slice(0, CONFLICT_CHANGES_LIMIT)
    : allConflictRows;
  const recentChanges = conflictRows.map((row) => ({
    // An empty target_name (a deleted or unnamed target) falls back to the update
    // name (`table_sysid`), as sync_list_recent_changes does, so no change is nameless.
    name: String(row.target_name || row.name || ""),
    type: String(row.type ?? ""),
    action: String(row.action ?? "").toUpperCase(),
    changedBy: String(row.sys_created_by ?? ""),
    changedAt: String(row.sys_created_on ?? ""),
  }));

  // A table query that failed analysed zero scripts, so its verdict is unknown —
  // not clean. Only a run where every query succeeded can report a green gate,
  // and only over the tables asked for: an unknown table was never read. A table
  // with more scripts than `limit` was read only in part, so it cannot be green
  // either.
  const validated =
    errors.length === 0 &&
    unknownTables.length === 0 &&
    truncatedTables.length === 0 &&
    tables.length > 0;
  const ready = blockedCount === 0 && validated;

  return textResponse(
    {
      scope,
      ready,
      validated,
      unknownTables,
      truncatedTables,
      blockedCount,
      warningCount,
      fileCount: files.length,
      files,
      recentChanges,
      recentChangesTruncated,
      conflictCheckPerformed,
      conflictWindowHours,
      errors,
    },
    !ready
  );
}
