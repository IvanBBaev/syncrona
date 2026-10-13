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
  const text = toJsonText(payload);
  const response: ToolResponse = {
    isError,
    content: [{ type: "text", text }],
  };
  // Mirror plain-object success payloads into MCP structuredContent so text
  // and structured consumers see identical data. The mirror is re-parsed from
  // the serialized text (not the raw payload) so JSON.stringify normalization
  // (dropped undefined values, Date -> string) cannot make the two diverge.
  // Error results are exempt from output-schema conformance per the MCP spec,
  // so they stay text-only. structuredContent without a declared outputSchema
  // is spec-legal, so this is safe for every tool routed through this helper.
  if (!isError && payload && typeof payload === "object" && !Array.isArray(payload)) {
    response.structuredContent = JSON.parse(text) as Record<string, unknown>;
  }
  return response;
}

export function errorResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

// snRequest falls back to the raw text when a body is not JSON, and
// toTableResultRows reads anything without a `result` array as no rows. A 2xx
// that is not a Table API JSON object (a login or maintenance page served as
// HTML, for instance) must therefore be rejected before it is read as an empty
// result. Returns a description of the bad payload, or null for a Table API one.
export function describeNonTablePayload(status: number, data: unknown): string | null {
  const isTablePayload =
    !!data && typeof data === "object" && !Array.isArray(data) &&
    Array.isArray((data as Record<string, unknown>).result);
  if (isTablePayload) {
    return null;
  }
  const kind = typeof data === "string" ? "a non-JSON body" : "an unexpected JSON payload";
  return (
    `HTTP ${status} with ${kind} instead of a Table API result; ` +
    "the instance may be serving a login or maintenance page"
  );
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
  // One commit stamps many sys_update_xml rows with the same sys_created_on;
  // the sys_id tiebreak keeps the cut at the row limit stable.
  parts.push("ORDERBYDESCsys_created_on", "ORDERBYsys_id");
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

  // snRequest resolves with the status instead of throwing: a rejected lookup
  // (401, 403, 5xx) carries no rows and must not read as a missing update set.
  if (response.status < 200 || response.status > 299) {
    return { error: `Update set lookup failed with HTTP ${response.status}: ${name}` };
  }
  // A login or maintenance page served with a 2xx must not read as a missing
  // update set either.
  const badPayload = describeNonTablePayload(response.status, response.data);
  if (badPayload) {
    return { error: `Update set lookup returned ${badPayload}: ${name}` };
  }
  const rows = toTableResultRows(response.data);
  if (rows.length === 0) {
    return { error: `Update set not found: ${name}` };
  }

  return { sysId: String(rows[0].sys_id ?? ""), label: name };
}
