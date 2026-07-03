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

    const diff = diffInstanceRecords(resA.rows, resB.rows, {
      nameField: config.nameField,
      contentField: config.scriptField,
    });

    onlyInACount += diff.onlyInA.length;
    onlyInBCount += diff.onlyInB.length;
    differentCount += diff.different.length;

    tableResults.push({
      table,
      statusA: resA.status,
      statusB: resB.status,
      onlyInA: diff.onlyInA,
      onlyInB: diff.onlyInB,
      different: diff.different,
    });
  }

  return textResponse({
    profileA,
    profileB,
    scope,
    tablesCompared: tables,
    summary: {
      onlyInA: onlyInACount,
      onlyInB: onlyInBCount,
      different: differentCount,
    },
    tables: tableResults,
  });
}
