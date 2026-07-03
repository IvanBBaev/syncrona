// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeQueryValue } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import { errorResponse, resolveUpdateSetSysId, textResponse } from "./insightShared";

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
  params.set("sysparm_query", `update_set=${escapeQueryValue(resolved.sysId)}^ORDERBYtype`);
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
