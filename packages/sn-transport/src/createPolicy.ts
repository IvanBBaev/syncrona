// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Table policy for record creation, shared by every client that can create
 * ServiceNow records: the MCP `sn_create_record` tool and the core CLI's
 * `push --create`.
 *
 * Both used to be able to write to any table, including security-sensitive
 * ones (users, roles, system properties, CMDB). The policy has three tiers:
 *
 *  1. An always-deny set of high-risk system tables. Nothing widens it — not
 *     the allowlist environment variables, not a consumer's own config.
 *  2. An operator allowlist read from the environment
 *     ({@link CREATE_TABLE_ALLOWLIST_ENV}, plus a consumer-specific name that
 *     wins when both are set) and any consumer-supplied extras.
 *  3. The consumer's default rule — the MCP's metadata registry, or core's
 *     "the table extends sys_metadata" check. That rule may need I/O, so it is
 *     injected rather than implemented here: this module stays pure.
 *
 * The module is pure (no I/O, no node globals): callers pass the environment in.
 */

/** Allowlist env var read by every consumer. */
export const CREATE_TABLE_ALLOWLIST_ENV = "SYNCRONA_CREATE_TABLE_ALLOWLIST";

/** MCP-specific allowlist env var; it wins over the shared one when both are set. */
export const MCP_CREATE_TABLE_ALLOWLIST_ENV = "SYNCRONA_MCP_CREATE_TABLE_ALLOWLIST";

/**
 * High-risk system tables that stay denied however the allowlist is extended:
 * user/role/group records grant access, sys_properties changes instance
 * behaviour globally, and cmdb_ci writes pollute the CMDB.
 */
export const DENIED_CREATE_TABLES: readonly string[] = [
  "sys_user",
  "sys_user_has_role",
  "sys_user_role",
  "sys_user_group",
  "sys_properties",
  "cmdb_ci",
];

const deniedCreateTableSet = new Set<string>(DENIED_CREATE_TABLES);

/** Canonical form of a table name for every policy comparison. */
export function normalizeCreateTableName(table: string): string {
  return table.trim().toLowerCase();
}

/** Whether the table is on the always-deny list (input is normalized first). */
export function isDeniedCreateTable(table: string): boolean {
  return deniedCreateTableSet.has(normalizeCreateTableName(table));
}

/**
 * Parse a comma-separated allowlist. Entries are trimmed and lower-cased, empty
 * entries are ignored, and denied tables are never admitted, so an allowlist
 * can never re-open the deny list.
 */
export function parseCreateTableAllowlist(rawValue: string | undefined): Set<string> {
  const tables = new Set<string>();
  if (typeof rawValue !== "string") {
    return tables;
  }
  for (const entry of rawValue.split(",")) {
    const normalized = normalizeCreateTableName(entry);
    if (normalized.length > 0 && !deniedCreateTableSet.has(normalized)) {
      tables.add(normalized);
    }
  }
  return tables;
}

/**
 * The operator allowlist from the environment. A consumer-specific variable
 * (`preferredEnvName`) wins over {@link CREATE_TABLE_ALLOWLIST_ENV} whenever it
 * is set at all — even to an empty string, which is how an operator narrows one
 * consumer back to its defaults while the shared variable widens the others.
 */
export function readCreateTableAllowlist(
  env: Record<string, string | undefined>,
  preferredEnvName?: string
): Set<string> {
  if (preferredEnvName !== undefined && env[preferredEnvName] !== undefined) {
    return parseCreateTableAllowlist(env[preferredEnvName]);
  }
  return parseCreateTableAllowlist(env[CREATE_TABLE_ALLOWLIST_ENV]);
}

/** Outcome of the policy tiers that need no I/O. */
export type CreateTableClassification = "denied" | "allowlisted" | "unlisted";

export interface CreateTableClassifyOptions {
  env: Record<string, string | undefined>;
  /** Consumer-specific env var that wins over the shared one. */
  preferredEnvName?: string;
  /** Extra tables the consumer's own configuration allows. */
  extraAllowed?: Iterable<string>;
}

/**
 * Apply the deny list and the explicit allowlists. "unlisted" means neither
 * spoke, and the consumer's default rule decides.
 */
export function classifyCreateTable(
  table: string,
  options: CreateTableClassifyOptions
): CreateTableClassification {
  const normalized = normalizeCreateTableName(table);
  if (deniedCreateTableSet.has(normalized)) {
    return "denied";
  }
  if (normalized.length === 0) {
    return "unlisted";
  }
  if (readCreateTableAllowlist(options.env, options.preferredEnvName).has(normalized)) {
    return "allowlisted";
  }
  for (const extra of options.extraAllowed ?? []) {
    if (
      typeof extra === "string" &&
      normalizeCreateTableName(extra) === normalized
    ) {
      return "allowlisted";
    }
  }
  return "unlisted";
}

export type CreateTablePolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface CreateTableMessageOptions {
  /** What is creating the record, e.g. "sn_create_record" or "push --create". */
  consumer: string;
  /** Consumer-specific env var, named first in remedies. */
  preferredEnvName?: string;
  /** Appended to the deny sentence, e.g. " even with confirmDestructive=true". */
  denyNote?: string;
  /** Extra remedy sentence for the unlisted case (e.g. a config key). */
  extraRemedy?: string;
}

const envNamesFor = (preferredEnvName?: string): string =>
  preferredEnvName !== undefined && preferredEnvName !== CREATE_TABLE_ALLOWLIST_ENV
    ? `${preferredEnvName} (or ${CREATE_TABLE_ALLOWLIST_ENV})`
    : CREATE_TABLE_ALLOWLIST_ENV;

/** Reason text for a table on the always-deny list. */
export function describeDeniedCreateTable(
  table: string,
  options: CreateTableMessageOptions
): string {
  return (
    `Table "${normalizeCreateTableName(table)}" is denied for ${options.consumer}: creating records in ` +
    "high-risk system tables (users, roles, groups, system properties, CMDB) is " +
    `refused${options.denyNote ?? ""}, and the deny list cannot be ` +
    `overridden via ${envNamesFor(options.preferredEnvName)}.`
  );
}

/**
 * Reason text for a table neither allowlisted nor admitted by the default rule.
 * `defaultDescription` completes "By default ..." — e.g. "only scoped-app
 * artifact tables are allowed (a, b, c)".
 */
export function describeUnlistedCreateTable(
  table: string,
  defaultDescription: string,
  options: CreateTableMessageOptions
): string {
  return (
    `Table "${normalizeCreateTableName(table)}" is not on the ${options.consumer} table allowlist. ` +
    `By default ${defaultDescription}. ` +
    `To create records in additional tables, set the ${envNamesFor(options.preferredEnvName)} ` +
    "environment variable to a comma-separated list of extra table names." +
    (options.extraRemedy ? ` ${options.extraRemedy}` : "")
  );
}

export interface CreateTablePolicyOptions
  extends CreateTableClassifyOptions,
    CreateTableMessageOptions {
  /** The consumer's synchronous default rule, given the normalized name. */
  isAllowedByDefault: (normalizedTable: string) => boolean;
  /** Completes "By default ..." in the refusal message. */
  defaultDescription: string;
}

/**
 * Full policy decision for a consumer whose default rule is synchronous.
 * Consumers with an asynchronous default rule (core's table-hierarchy lookup)
 * compose {@link classifyCreateTable} and the describe helpers instead.
 */
export function evaluateCreateTablePolicy(
  table: string,
  options: CreateTablePolicyOptions
): CreateTablePolicyDecision {
  const classification = classifyCreateTable(table, options);
  if (classification === "denied") {
    return { allowed: false, reason: describeDeniedCreateTable(table, options) };
  }
  if (
    classification === "allowlisted" ||
    options.isAllowedByDefault(normalizeCreateTableName(table))
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: describeUnlistedCreateTable(table, options.defaultDescription, options),
  };
}
