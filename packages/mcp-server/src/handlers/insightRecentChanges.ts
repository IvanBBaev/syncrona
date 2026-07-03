// SPDX-License-Identifier: GPL-3.0-or-later
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import {
  buildRecentChangesQuery,
  clampLimit,
  defaultSinceIso,
  errorResponse,
  isoToServiceNowDateTime,
  textResponse,
} from "./insightShared";

export async function handleListRecentChanges(
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
