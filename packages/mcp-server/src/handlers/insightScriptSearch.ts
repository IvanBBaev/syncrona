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
  // REV-198: an unrecognized table name used to be dropped in silence. `tables` is a
  // free-form string array in the schema (no enum) and sn_search_scripts has no input
  // validator, so `tables: ["sys_ui_action"]` — a real script-bearing table that is
  // simply not one of the six this tool knows — searched NOTHING and still returned
  // `searchComplete: true, matchCount: 0`. That is the same false "clean search" verdict
  // REV-152 removed for failed queries, arrived at from the other direction.
  const knownTables = requestedTables.filter((table) => table in SCRIPT_SEARCH_TABLES);
  const unknownTables =
    requestedTables.length > 0
      ? requestedTables.filter((table) => !(table in SCRIPT_SEARCH_TABLES))
      : [];
  const tables = requestedTables.length > 0
    ? knownTables
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

  // REV-152: a table query that failed searched NOTHING, so "no matches" is unknown, not
  // absent. The old response was always a success with `errors` buried at the end of the
  // payload, so a run where every single table 401'd or 500'd came back as
  // `matchCount: 0` — indistinguishable from a genuine clean search, which is exactly the
  // answer that gets acted on ("that identifier is unused, safe to delete"). Flag it, and
  // say explicitly whether the search was complete, mirroring insightValidateBeforePush
  // and insightCompareInstances.
  // REV-198: a request naming only tables this tool cannot search is not a complete
  // search either, so both gaps fold into the one verdict the caller acts on.
  const searchComplete =
    errors.length === 0 && unknownTables.length === 0 && tables.length > 0;

  return textResponse(
    {
      query,
      scope: scope || null,
      tablesSearched: tables,
      unknownTables,
      searchableTables: Object.keys(SCRIPT_SEARCH_TABLES),
      searchComplete,
      matchCount: matches.length,
      matches,
      errors,
    },
    !searchComplete
  );
}
