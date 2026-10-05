// SPDX-License-Identifier: GPL-3.0-or-later
import {
  MCP_CREATE_TABLE_ALLOWLIST_ENV,
  evaluateCreateTablePolicy as evaluateSharedCreateTablePolicy,
  type CreateTablePolicyDecision,
} from "@syncrona/sn-transport";
import { buildTableApiCoverageMatrix } from "./analysis";

/**
 * Table policy for `sn_create_record`.
 *
 * The deny list, allowlist parsing and refusal wording live in
 * `@syncrona/sn-transport` (`createPolicy.ts`), shared with the core CLI's
 * `push --create` so the two cannot drift. What stays here is the MCP default:
 * the scoped-app artifact tables the server already manages through its
 * metadata registry. Operators widen it with `SYNCRONA_MCP_CREATE_TABLE_ALLOWLIST`
 * or the shared `SYNCRONA_CREATE_TABLE_ALLOWLIST` (the MCP-specific name wins
 * when both are set); the high-risk deny set stays denied regardless.
 *
 * The policy is evaluated before the dry-run preview and before the
 * confirmDestructive gate: a policy violation is an error even as a rehearsal.
 */

export const CREATE_TABLE_ALLOWLIST_ENV = MCP_CREATE_TABLE_ALLOWLIST_ENV;

export type { CreateTablePolicyDecision };

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

export function evaluateCreateTablePolicy(
  table: string,
  env: Record<string, string | undefined> = process.env
): CreateTablePolicyDecision {
  const defaults = getDefaultCreateTableAllowlist();
  return evaluateSharedCreateTablePolicy(table, {
    consumer: "sn_create_record",
    env,
    preferredEnvName: MCP_CREATE_TABLE_ALLOWLIST_ENV,
    denyNote: " even with confirmDestructive=true",
    isAllowedByDefault: (normalized) => defaults.has(normalized),
    defaultDescription: `only scoped-app artifact tables are allowed (${[...defaults].sort().join(", ")})`,
  });
}
