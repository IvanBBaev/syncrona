// SPDX-License-Identifier: GPL-3.0-or-later
import { buildTableApiCoverageMatrix } from "./analysis";

/**
 * Table policy for `sn_create_record`.
 *
 * The generic create tool would otherwise write to any ServiceNow table,
 * including security-sensitive ones (users, roles, system properties, CMDB).
 * The policy allows only the scoped-app artifact tables the server already
 * manages through its metadata registry, plus any extra tables the operator
 * explicitly opts into via the environment variable below. A small deny set of
 * high-risk system tables stays denied no matter how the allowlist is widened.
 *
 * The policy is evaluated before the dry-run preview and before the
 * confirmDestructive gate: a policy violation is an error even as a rehearsal.
 */

export const CREATE_TABLE_ALLOWLIST_ENV = "SYNCRONA_MCP_CREATE_TABLE_ALLOWLIST";

// High-risk system tables that remain denied even when the allowlist is
// extended: user/role/group records grant access, sys_properties changes
// instance behaviour globally, and cmdb_ci writes pollute the CMDB.
const DENIED_CREATE_TABLES = new Set([
  "sys_user",
  "sys_user_has_role",
  "sys_user_role",
  "sys_user_group",
  "sys_properties",
  "cmdb_ci",
]);

let cachedDefaultAllowlist: Set<string> | null = null;

// The default allowlist is derived from the metadata table registry (the same
// tables `sn_list/get/update_metadata_record` operate on) so the two policies
// cannot drift apart. `sys_script_include` is added because the dedicated
// `sync_create_script_include` tool already creates records there.
function getDefaultCreateTableAllowlist(): Set<string> {
  if (!cachedDefaultAllowlist) {
    const tables = new Set<string>();
    for (const row of buildTableApiCoverageMatrix()) {
      if (typeof row.table === "string" && row.table.length > 0) {
        tables.add(row.table);
      }
    }
    tables.add("sys_script_include");
    cachedDefaultAllowlist = tables;
  }
  return cachedDefaultAllowlist;
}

function parseExtraAllowedTables(rawValue: string | undefined): Set<string> {
  const extras = new Set<string>();
  if (typeof rawValue !== "string") {
    return extras;
  }
  for (const entry of rawValue.split(",")) {
    const normalized = entry.trim().toLowerCase();
    // Denied tables must remain denied regardless of the env var, so they are
    // never admitted into the extras set in the first place.
    if (normalized.length > 0 && !DENIED_CREATE_TABLES.has(normalized)) {
      extras.add(normalized);
    }
  }
  return extras;
}

export type CreateTablePolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function evaluateCreateTablePolicy(
  table: string,
  env: Record<string, string | undefined> = process.env
): CreateTablePolicyDecision {
  const normalized = table.trim().toLowerCase();

  if (DENIED_CREATE_TABLES.has(normalized)) {
    return {
      allowed: false,
      reason:
        `Table "${normalized}" is denied for sn_create_record: creating records in ` +
        "high-risk system tables (users, roles, groups, system properties, CMDB) is " +
        "refused even with confirmDestructive=true, and the deny list cannot be " +
        `overridden via ${CREATE_TABLE_ALLOWLIST_ENV}.`,
    };
  }

  const defaults = getDefaultCreateTableAllowlist();
  const extras = parseExtraAllowedTables(env[CREATE_TABLE_ALLOWLIST_ENV]);
  if (!defaults.has(normalized) && !extras.has(normalized)) {
    return {
      allowed: false,
      reason:
        `Table "${normalized}" is not on the sn_create_record table allowlist. By default ` +
        `only scoped-app artifact tables are allowed (${[...defaults].sort().join(", ")}). ` +
        `To create records in additional tables, set the ${CREATE_TABLE_ALLOWLIST_ENV} ` +
        "environment variable to a comma-separated list of extra table names.",
    };
  }

  return { allowed: true };
}
