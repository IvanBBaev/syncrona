// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "crypto";
import { escapeQueryValue } from "../runtimeUtils";
import {
  loadAuthStoreProfile,
  snRequestWithConfig,
  toTableResultRows,
} from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import {
  clampLimit,
  errorResponse,
  SCRIPT_SEARCH_TABLES,
  textResponse,
} from "./insightShared";

// --- E5: sync_compare_instances ------------------------------------------

export function hashRecordContent(value: unknown): string {
  return createHash("sha1").update(String(value ?? "")).digest("hex");
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status <= 299;
}

// REV-101: a per-table fetch is capped at `limit` (default 200, max 500). When a
// scope has more matching records than the cap, the ServiceNow table API returns
// exactly `limit` rows and the rest are silently dropped, so a partial comparison
// used to be reported as if it were the whole picture. A row count that reaches
// the limit is the truncation signal; surface an explicit per-type notice so a
// capped comparison is never mistaken for a complete one.
export function buildTruncationNote(
  table: string,
  rowCountA: number,
  rowCountB: number,
  limit: number
): string | null {
  const truncatedA = rowCountA >= limit;
  const truncatedB = rowCountB >= limit;
  if (!truncatedA && !truncatedB) {
    return null;
  }
  const sides = [truncatedA ? "profileA" : "", truncatedB ? "profileB" : ""]
    .filter((side) => side.length > 0)
    .join(" and ");
  return (
    `Result set for table '${table}' hit the ${limit}-row limit on ${sides}; ` +
    `records beyond ${limit} were not fetched, so this comparison may be incomplete.`
  );
}

export function diffInstanceRecords(
  rowsA: Record<string, unknown>[],
  rowsB: Record<string, unknown>[],
  opts: { nameField: string; contentField: string }
): { onlyInA: string[]; onlyInB: string[]; different: Array<Record<string, unknown>> } {
  const mapA = new Map<string, string>();
  const mapB = new Map<string, string>();
  for (const row of rowsA) {
    const name = String(row[opts.nameField] ?? "");
    if (name) {
      mapA.set(name, hashRecordContent(row[opts.contentField]));
    }
  }
  for (const row of rowsB) {
    const name = String(row[opts.nameField] ?? "");
    if (name) {
      mapB.set(name, hashRecordContent(row[opts.contentField]));
    }
  }

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const different: Array<Record<string, unknown>> = [];

  for (const [name, hashA] of mapA) {
    if (!mapB.has(name)) {
      onlyInA.push(name);
    } else if (mapB.get(name) !== hashA) {
      different.push({ name, hashA, hashB: mapB.get(name) });
    }
  }
  for (const name of mapB.keys()) {
    if (!mapA.has(name)) {
      onlyInB.push(name);
    }
  }

  return {
    onlyInA: onlyInA.sort(),
    onlyInB: onlyInB.sort(),
    different: different.sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

async function fetchScopeScriptRows(
  config: { instance: string; user: string; password: string },
  table: string,
  scriptField: string,
  nameField: string,
  scope: string,
  limit: number,
  timeoutMs: number
): Promise<{ status: number; rows: Record<string, unknown>[] }> {
  const params = new URLSearchParams();
  params.set("sysparm_query", `sys_scope.scope=${escapeQueryValue(scope)}`);
  params.set("sysparm_limit", String(limit));
  params.set("sysparm_fields", `sys_id,${nameField},${scriptField}`);

  const response = await snRequestWithConfig(
    config,
    "GET",
    `/api/now/table/${table}?${params.toString()}`,
    undefined,
    timeoutMs
  );
  return { status: response.status, rows: toTableResultRows(response.data) };
}

export async function handleCompareInstances(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const profileA = typeof args.profileA === "string" ? args.profileA.trim() : "";
  const profileB = typeof args.profileB === "string" ? args.profileB.trim() : "";
  const scope = typeof args.scope === "string" ? args.scope.trim() : "";

  if (!profileA) {
    return errorResponse("Missing required field: profileA");
  }
  if (!profileB) {
    return errorResponse("Missing required field: profileB");
  }
  if (!scope) {
    return errorResponse("Missing required field: scope");
  }

  const configA = loadAuthStoreProfile(profileA);
  if (!configA) {
    return errorResponse(`Profile not found in auth store: ${profileA}. Run 'syncrona login' for it first.`);
  }
  const configB = loadAuthStoreProfile(profileB);
  if (!configB) {
    return errorResponse(`Profile not found in auth store: ${profileB}. Run 'syncrona login' for it first.`);
  }

  const requestedTables = Array.isArray(args.tables)
    ? args.tables.filter((item): item is string => typeof item === "string")
    : [];
  const tables = requestedTables.length > 0
    ? requestedTables.filter((table) => table in SCRIPT_SEARCH_TABLES)
    : Object.keys(SCRIPT_SEARCH_TABLES);
  const limit = clampLimit(args.limit, 200, 500);

  const tableResults: Array<Record<string, unknown>> = [];
  let onlyInACount = 0;
  let onlyInBCount = 0;
  let differentCount = 0;
  let errorCount = 0;
  const truncatedTables: string[] = [];

  for (const table of tables) {
    const config = SCRIPT_SEARCH_TABLES[table];
    if (!config) {
      continue;
    }

    // Use allSettled so one table (or one instance) failing does not abort the
    // entire comparison — record the per-table error and keep going.
    const [settledA, settledB] = await Promise.allSettled([
      fetchScopeScriptRows(configA, table, config.scriptField, config.nameField, scope, limit, timeoutMs),
      fetchScopeScriptRows(configB, table, config.scriptField, config.nameField, scope, limit, timeoutMs),
    ]);

    if (settledA.status === "rejected" || settledB.status === "rejected") {
      const reasonMessage = (reason: unknown): string =>
        reason instanceof Error ? reason.message : String(reason);
      errorCount += 1;
      tableResults.push({
        table,
        statusA:
          settledA.status === "fulfilled"
            ? settledA.value.status
            : `error: ${reasonMessage(settledA.reason)}`,
        statusB:
          settledB.status === "fulfilled"
            ? settledB.value.status
            : `error: ${reasonMessage(settledB.reason)}`,
        onlyInA: [],
        onlyInB: [],
        different: [],
        error: "Comparison skipped for this table because an instance request failed.",
      });
      continue;
    }

    const resA = settledA.value;
    const resB = settledB.value;

    // A fulfilled response carrying a non-2xx status has no `result` array, so
    // toTableResultRows yields []. Diffing that would fabricate onlyInA/onlyInB
    // entries for every record on the healthy side, so treat it exactly like a
    // rejection instead of reporting a confident, wrong comparison.
    if (!isSuccessStatus(resA.status) || !isSuccessStatus(resB.status)) {
      errorCount += 1;
      tableResults.push({
        table,
        statusA: resA.status,
        statusB: resB.status,
        onlyInA: [],
        onlyInB: [],
        different: [],
        error:
          "Comparison skipped for this table because an instance request returned a non-2xx status.",
      });
      continue;
    }

    const diff = diffInstanceRecords(resA.rows, resB.rows, {
      nameField: config.nameField,
      contentField: config.scriptField,
    });

    onlyInACount += diff.onlyInA.length;
    onlyInBCount += diff.onlyInB.length;
    differentCount += diff.different.length;

    // REV-101: flag (rather than silently swallow) a per-table cap so the caller
    // knows this table's comparison may be based on a truncated result set.
    const truncationNote = buildTruncationNote(table, resA.rows.length, resB.rows.length, limit);
    const tableResult: Record<string, unknown> = {
      table,
      statusA: resA.status,
      statusB: resB.status,
      onlyInA: diff.onlyInA,
      onlyInB: diff.onlyInB,
      different: diff.different,
      truncated: truncationNote !== null,
    };
    if (truncationNote) {
      tableResult.truncationNote = truncationNote;
      truncatedTables.push(table);
    }
    tableResults.push(tableResult);
  }

  return textResponse(
    {
      profileA,
      profileB,
      scope,
      tablesCompared: tables,
      summary: {
        onlyInA: onlyInACount,
        onlyInB: onlyInBCount,
        different: differentCount,
        errors: errorCount,
        // REV-101: complete only when there were no errors AND no table was capped
        // by the row limit; truncated tables are listed so the gap is user-visible.
        complete: errorCount === 0 && truncatedTables.length === 0,
        truncated: truncatedTables.length > 0,
        truncatedTables,
        limit,
      },
      tables: tableResults,
    },
    errorCount > 0
  );
}
