// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeQueryValue, wrapUntrustedData } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import { clampLimit, describeNonTablePayload, errorResponse, textResponse } from "./insightShared";

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
    // One audited update stamps every changed field with the same
    // sys_created_on; the sys_id tiebreak keeps the cut at `limit` stable.
    `tablename=${escapeQueryValue(table)}^documentkey=${escapeQueryValue(sysId)}^ORDERBYDESCsys_created_on^ORDERBYsys_id`
  );
  // One row past the limit tells a full page from a cut one.
  params.set("sysparm_limit", String(limit + 1));
  params.set("sysparm_fields", "fieldname,oldvalue,newvalue,sys_created_by,sys_created_on");

  const response = await snRequest(
    "GET",
    `/api/now/table/sys_audit?${params.toString()}`,
    undefined,
    timeoutMs
  );

  const isError = response.status < 200 || response.status > 299;
  // A login or maintenance page served with a 2xx must not read as a record
  // with no history.
  const badPayload = isError ? null : describeNonTablePayload(response.status, response.data);
  if (badPayload) {
    return errorResponse(`Record history request returned ${badPayload}.`);
  }

  const allRows = toTableResultRows(response.data);
  const truncated = allRows.length > limit;
  const rows = truncated ? allRows.slice(0, limit) : allRows;

  return textResponse(
    {
      status: response.status,
      table,
      sysId,
      entryCount: rows.length,
      truncated,
      history: formatRecordHistory(rows),
    },
    isError
  );
}
