// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "crypto";
import { escapeQueryValue } from "../runtimeUtils";
import {
  describeNonTablePayload,
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
// scope has more matching records than the cap, the rest are silently dropped, so
// a partial comparison used to be reported as if it were the whole picture. Each
// side reads one row past the limit, and a count above the limit is the truncation
// signal (a scope of exactly `limit` records is complete); surface an explicit
// per-type notice so a capped comparison is never mistaken for a complete one.
export function buildTruncationNote(
  table: string,
  rowCountA: number,
  rowCountB: number,
  limit: number
): string | null {
  const truncatedA = rowCountA > limit;
  const truncatedB = rowCountB > limit;
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
  // Names are not unique (two business rules in a scope can share one), so every
  // record under a name counts: one record keeps its own hash, several hash their
  // sorted hashes together. Keeping only the last row read made the verdict depend
  // on the order each instance returned them and hid a change to any other copy.
  const hashByName = (rows: Record<string, unknown>[]): Map<string, string> => {
    const hashes = new Map<string, string[]>();
    for (const row of rows) {
      const name = String(row[opts.nameField] ?? "");
      if (name) {
        const list = hashes.get(name) ?? [];
        list.push(hashRecordContent(row[opts.contentField]));
        hashes.set(name, list);
      }
    }
    const result = new Map<string, string>();
    for (const [name, list] of hashes) {
      result.set(name, list.length === 1 ? list[0] : hashRecordContent(list.sort().join("\n")));
    }
    return result;
  };
  const mapA = hashByName(rowsA);
  const mapB = hashByName(rowsB);

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
): Promise<{ status: number; rows: Record<string, unknown>[]; badPayload: string | null }> {
  // Without an order the instance returns rows in no defined order, so a capped
  // read took a different subset on each side and on each run. Ordering by the
  // name the diff keys on (sys_id breaks ties) makes both sides read the same
  // leading slice of the scope.
  const params = new URLSearchParams();
  params.set(
    "sysparm_query",
    `sys_scope.scope=${escapeQueryValue(scope)}^ORDERBY${nameField}^ORDERBYsys_id`
  );
  params.set("sysparm_limit", String(limit + 1));
  params.set("sysparm_fields", `sys_id,${nameField},${scriptField}`);

  const response = await snRequestWithConfig(
    config,
    "GET",
    `/api/now/table/${table}?${params.toString()}`,
    undefined,
    timeoutMs
  );
  // A 2xx login or maintenance page has no `result` array either, and its "no
  // rows" would read as every record on the other side being missing here.
  const badPayload = isSuccessStatus(response.status)
    ? describeNonTablePayload(response.status, response.data)
    : null;
  return { status: response.status, rows: toTableResultRows(response.data), badPayload };
}

// Whether `scope` is installed on the instance, or an error message when the
// lookup itself could not be read.
async function lookupScope(
  config: { instance: string; user: string; password: string },
  scope: string,
  timeoutMs: number
): Promise<{ found: boolean } | { error: string }> {
  const params = new URLSearchParams();
  params.set("sysparm_query", `scope=${escapeQueryValue(scope)}`);
  params.set("sysparm_fields", "sys_id");
  params.set("sysparm_limit", "1");
  try {
    const response = await snRequestWithConfig(
      config,
      "GET",
      `/api/now/table/sys_scope?${params.toString()}`,
      undefined,
      timeoutMs
    );
    if (!isSuccessStatus(response.status)) {
      return { error: `HTTP ${response.status}` };
    }
    const badPayload = describeNonTablePayload(response.status, response.data);
    if (badPayload) {
      return { error: badPayload };
    }
    return { found: toTableResultRows(response.data).length > 0 };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
  // A requested table this tool cannot read was never compared, like sn_search_scripts.
  const unknownTables = requestedTables.filter((table) => !(table in SCRIPT_SEARCH_TABLES));
  const tables = requestedTables.length > 0
    ? requestedTables.filter((table) => table in SCRIPT_SEARCH_TABLES)
    : Object.keys(SCRIPT_SEARCH_TABLES);
  const limit = clampLimit(args.limit, 200, 500);

  const tableResults: Array<Record<string, unknown>> = [];
  let onlyInACount = 0;
  let onlyInBCount = 0;
  let differentCount = 0;
  let errorCount = 0;
  let rowsRead = 0;
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

    if (resA.badPayload || resB.badPayload) {
      errorCount += 1;
      tableResults.push({
        table,
        statusA: resA.badPayload ? `error: ${resA.badPayload}` : resA.status,
        statusB: resB.badPayload ? `error: ${resB.badPayload}` : resB.status,
        onlyInA: [],
        onlyInB: [],
        different: [],
        error:
          "Comparison skipped for this table because an instance answered without a Table API result.",
      });
      continue;
    }

    // The extra row only signals truncation; diffing it would compare a record
    // one side read and the other may not have.
    const diff = diffInstanceRecords(resA.rows.slice(0, limit), resB.rows.slice(0, limit), {
      nameField: config.nameField,
      contentField: config.scriptField,
    });

    rowsRead += resA.rows.length + resB.rows.length;
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

  // Zero records on both sides compares as "identical" under `complete: true`,
  // which is also what a scope neither instance has (a typo) looks like. Only
  // then is it worth asking the instances whether the scope exists at all.
  if (rowsRead === 0 && errorCount === 0 && tables.length > 0) {
    const [scopeA, scopeB] = await Promise.all([
      lookupScope(configA, scope, timeoutMs),
      lookupScope(configB, scope, timeoutMs),
    ]);
    for (const [profile, lookup] of [[profileA, scopeA], [profileB, scopeB]] as const) {
      if ("error" in lookup) {
        return errorResponse(`Could not look up scope ${scope} on ${profile}: ${lookup.error}`);
      }
    }
    const missing = [
      "found" in scopeA && !scopeA.found ? profileA : "",
      "found" in scopeB && !scopeB.found ? profileB : "",
    ].filter((profile) => profile.length > 0);
    if (missing.length > 0) {
      return errorResponse(
        `Scope ${scope} is not installed on ${missing.join(" or ")}; nothing was compared.`
      );
    }
  }

  return textResponse(
    {
      profileA,
      profileB,
      scope,
      tablesCompared: tables,
      unknownTables,
      summary: {
        onlyInA: onlyInACount,
        onlyInB: onlyInBCount,
        different: differentCount,
        errors: errorCount,
        // REV-101: complete only when there were no errors AND no table was capped
        // by the row limit; truncated tables are listed so the gap is user-visible.
        // A requested table that was never compared leaves the comparison partial too.
        complete:
          errorCount === 0 && truncatedTables.length === 0 && unknownTables.length === 0 && tables.length > 0,
        truncated: truncatedTables.length > 0,
        truncatedTables,
        limit,
      },
      tables: tableResults,
    },
    errorCount > 0
  );
}
