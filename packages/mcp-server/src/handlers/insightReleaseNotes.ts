// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeQueryValue } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import { describeNonTablePayload, errorResponse, resolveUpdateSetSysId, textResponse } from "./insightShared";

// The Table API answers one page; this tool reads one page and says so when the
// update set holds more. One row past the cap is requested so a set of exactly
// RELEASE_NOTES_MAX_CHANGES changes is not reported as truncated.
export const RELEASE_NOTES_MAX_CHANGES = 1000;

// An update record can hold an empty target_name (a deleted or unnamed target);
// `??` kept that empty string, so the change was listed without a name. Fall back
// to the update name (`table_sysid`), as sync_list_recent_changes does.
function changeName(row: Record<string, unknown>): string {
  return String(row.target_name || row.name || "");
}

export function buildReleaseNotesMarkdown(
  label: string,
  rows: Record<string, unknown>[],
  truncated = false
): string {
  const grouped = new Map<string, Array<{ action: string; name: string }>>();
  for (const row of rows) {
    const type = String(row.type ?? "unknown");
    const action = String(row.action ?? "").toUpperCase() || "UPDATE";
    const name = changeName(row);
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    grouped.get(type)?.push({ action, name });
  }

  const lines: string[] = [`# Release Notes — ${label}`, ""];
  lines.push(`Total changes: ${rows.length}`, "");
  if (truncated) {
    lines.push(
      `> Truncated: the update set holds more than ${rows.length} changes; only the first ${rows.length} are listed.`,
      ""
    );
  }

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

export async function handleGenerateReleaseNotes(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const format = args.format === "json" ? "json" : "markdown";
  const resolved = await resolveUpdateSetSysId(args, timeoutMs);
  if ("error" in resolved) {
    return errorResponse(resolved.error);
  }

  const params = new URLSearchParams();
  // The sys_id tiebreak keeps a cut at the cap stable across calls.
  params.set("sysparm_query", `update_set=${escapeQueryValue(resolved.sysId)}^ORDERBYtype^ORDERBYsys_id`);
  params.set("sysparm_limit", String(RELEASE_NOTES_MAX_CHANGES + 1));
  params.set("sysparm_fields", "name,type,target_name,action");

  const response = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${params.toString()}`,
    undefined,
    timeoutMs
  );

  const isError = response.status < 200 || response.status > 299;
  // A login or maintenance page served with a 2xx carries no rows; reading it
  // as an empty update set would report a release with no changes as success.
  const badPayload = isError ? null : describeNonTablePayload(response.status, response.data);
  if (badPayload) {
    return errorResponse(`Release notes request returned ${badPayload}.`);
  }

  const allRows = toTableResultRows(response.data);
  const truncated = allRows.length > RELEASE_NOTES_MAX_CHANGES;
  const rows = truncated ? allRows.slice(0, RELEASE_NOTES_MAX_CHANGES) : allRows;

  if (format === "json") {
    return textResponse(
      {
        status: response.status,
        updateSet: resolved.label,
        changeCount: rows.length,
        truncated,
        changes: rows.map((row) => ({
          type: String(row.type ?? ""),
          action: String(row.action ?? "").toUpperCase(),
          name: changeName(row),
        })),
      },
      isError
    );
  }

  return {
    isError,
    content: [{ type: "text", text: buildReleaseNotesMarkdown(resolved.label, rows, truncated) }],
  };
}
