// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeQueryValue, wrapUntrustedData } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import {
  clampLimit,
  errorResponse,
  SCRIPT_SEARCH_TABLES,
  textResponse,
} from "./insightShared";

const EXCERPT_RADIUS = 100;

export function buildScriptExcerpt(script: string, query: string): string {
  if (!script || !query) {
    return "";
  }
  const index = script.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return "";
  }
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(script.length, index + query.length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < script.length ? "…" : "";
  return `${prefix}${script.slice(start, end)}${suffix}`;
}

export async function handleSearchScripts(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return errorResponse("Missing required field: query");
  }

  const scope = typeof args.scope === "string" ? args.scope.trim() : "";
  const requestedTables = Array.isArray(args.tables)
    ? args.tables.filter((item): item is string => typeof item === "string")
    : [];
  const tables = requestedTables.length > 0
    ? requestedTables.filter((table) => table in SCRIPT_SEARCH_TABLES)
    : Object.keys(SCRIPT_SEARCH_TABLES);
  const limit = clampLimit(args.limit, 20, 100);

  const matches: Array<Record<string, unknown>> = [];
  const errors: Array<{ table: string; status: number }> = [];

  for (const table of tables) {
    const config = SCRIPT_SEARCH_TABLES[table];
    if (!config) {
      continue;
    }

    const queryParts = [`${config.scriptField}CONTAINS${escapeQueryValue(query)}`];
    if (scope) {
      queryParts.push(`sys_scope.scope=${escapeQueryValue(scope)}`);
    }

    const params = new URLSearchParams();
    params.set("sysparm_query", queryParts.join("^"));
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
      matches.push({
        table,
        name: String(row[config.nameField] ?? ""),
        sys_id: String(row.sys_id ?? ""),
        matchedField: config.scriptField,
        // Script excerpt is instance-authored source — fence it as untrusted.
        excerpt: wrapUntrustedData(buildScriptExcerpt(script, query), "servicenow"),
      });
    }
  }

  return textResponse({
    query,
    scope: scope || null,
    tablesSearched: tables,
    matchCount: matches.length,
    matches,
    errors,
  });
}
