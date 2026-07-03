// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeQueryValue, toJsonText } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";

export type InsightToolContext = {
  timeoutMs: number;
  dryRun: boolean;
  startedAt: number;
  makeDryRunAuditResponse: (
    toolName: string,
    args: Record<string, unknown>,
    details: Record<string, unknown>
  ) => ToolResponse;
  auditMutatingTool: (
    toolName: string,
    args: Record<string, unknown>,
    outcome: Record<string, unknown>,
    durationMs?: number
  ) => void;
};

export const SCRIPT_SEARCH_TABLES: Record<string, { scriptField: string; nameField: string }> = {
  sys_script_include: { scriptField: "script", nameField: "name" },
  sys_script: { scriptField: "script", nameField: "name" },
  sys_script_client: { scriptField: "script", nameField: "name" },
  sys_ui_script: { scriptField: "script", nameField: "name" },
  sys_ws_operation: { scriptField: "operation_script", nameField: "name" },
  sys_transform_script: { scriptField: "script", nameField: "name" },
};

export function textResponse(payload: unknown, isError = false): ToolResponse {
  return {
    isError,
    content: [{ type: "text", text: toJsonText(payload) }],
  };
}

export function errorResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function clampLimit(value: unknown, fallback: number, max: number): number {
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
  const parts = [`application.scope=${escapeQueryValue(scope)}`];
  if (sinceDateTime) {
    parts.push(`sys_created_on>=${sinceDateTime}`);
  }
  parts.push("ORDERBYDESCsys_created_on");
  return parts.join("^");
}

export async function resolveUpdateSetSysId(
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
  params.set("sysparm_query", `name=${escapeQueryValue(name)}`);
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
