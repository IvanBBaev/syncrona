// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeQueryValue, wrapUntrustedData } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import { clampLimit, errorResponse, textResponse } from "./insightShared";

export function formatRecordHistory(
  rows: Record<string, unknown>[]
): Array<Record<string, unknown>> {
  // oldValue/newValue are instance-authored free text (an audit record can hold
  // anything an end user typed). Fence them as untrusted so a value crafted to
  // read as instructions cannot steer the model. See runtimeUtils.wrapUntrustedData.
  return rows.map((row) => ({
    changedBy: String(row.sys_created_by ?? ""),
    changedAt: String(row.sys_created_on ?? ""),
    field: String(row.fieldname ?? ""),
    oldValue: wrapUntrustedData(row.oldvalue, "servicenow"),
    newValue: wrapUntrustedData(row.newvalue, "servicenow"),
  }));
}

export async function handleRecordHistory(
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
    `tablename=${escapeQueryValue(table)}^documentkey=${escapeQueryValue(sysId)}^ORDERBYDESCsys_created_on`
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
