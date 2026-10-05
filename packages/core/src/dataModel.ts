// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";

/**
 * R4 — the data model as editable local records.
 *
 * A data-model table (a table definition, a dictionary entry, a choice, a
 * property, a role, an ACL, …) is mostly made of plain columns, so most of its
 * records have no field file at all. Such a record is represented by its
 * `.meta.json` sidecar alone. The feature is opt-in: `dataModelTables` in
 * sync.config.js names the tables to track, and the default is an empty list.
 * See docs/DATA_MODEL.md.
 */

/**
 * The tables docs/DATA_MODEL.md documents as the data model. It is the list to
 * copy into `dataModelTables`; it is NOT applied by default, because several of
 * these tables are excluded by default and silently re-including them would
 * change every existing workspace on its next refresh.
 */
export const DATA_MODEL_DEFAULT_TABLES: readonly string[] = Object.freeze([
  "sys_db_object",
  "sys_dictionary",
  "sys_dictionary_override",
  "sys_documentation",
  "sys_choice",
  "sys_properties",
  "sys_user_role",
  "sys_user_role_contains",
  "sys_security_acl",
  "sys_security_acl_role",
  "sys_scope_privilege",
  "sys_ui_policy",
  "sys_ui_policy_action",
]);

/**
 * Data-model tables that have NO `sys_scope` column.
 *
 * `sys_choice` does not extend `sys_metadata`: it carries neither `sys_scope`
 * nor `sys_class_name`. The Table API ignores an encoded-query term on a column
 * the table does not have (unless the instance sets
 * `glide.invalid_query.returns_no_rows`), so `sys_scope=<id>` on such a table
 * matches every row on the instance instead of the scope's rows. A table listed
 * here must never be filtered by `sys_scope`: the manifest builder attributes
 * its records to a scope by a rule of its own (see docs/DATA_MODEL.md), and any
 * other reader has to bring one too.
 */
export const DATA_MODEL_TABLES_WITHOUT_SCOPE: readonly string[] = Object.freeze(["sys_choice"]);

/** True when `table` is a data-model table that cannot be filtered by `sys_scope`. */
export const isScopelessDataModelTable = (table: string): boolean =>
  DATA_MODEL_TABLES_WITHOUT_SCOPE.includes(table);

/**
 * Stable record names for data-model tables whose display value is not unique.
 *
 * Every column listed is read from the record (a dotted entry is a Table API
 * dot-walk such as `operation.name`); the non-empty values are joined with ".".
 * The display value of a dictionary entry is its table name, so without these
 * rules every column of a table would collide into one name and be told apart
 * only by a sys_id suffix — a name nobody can read or type.
 *
 * Names still collide in rare cases (two choices with the same value in two
 * languages, two ACLs on the same object and operation). The manifest builder
 * then suffixes every member of the group with `_<sys_id>`, which depends on
 * the record set and not on the order the instance returned it in.
 */
export const DATA_MODEL_NAME_FIELDS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    sys_dictionary: ["name", "element"],
    sys_dictionary_override: ["name", "element"],
    sys_documentation: ["name", "element", "language"],
    sys_choice: ["name", "element", "value"],
    sys_security_acl: ["name", "operation.name"],
    sys_security_acl_role: [
      "sys_security_acl.name",
      "sys_security_acl.operation.name",
      "sys_user_role.name",
    ],
    sys_user_role_contains: ["role.name", "contains.name"],
    sys_scope_privilege: ["target_scope.scope", "target_name", "operation"],
    sys_ui_policy_action: ["ui_policy.short_description", "field"],
  });

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/** True when `value` can be a ServiceNow table name in `dataModelTables`. */
export const isValidDataModelTableName = (value: unknown): value is string =>
  typeof value === "string" && TABLE_NAME_PATTERN.test(value);

/**
 * The tables this workspace tracks as data model, deduplicated, in the order
 * the config lists them. Anything that is not a plausible table name is
 * ignored here; config validation reports it.
 */
export const getDataModelTables = (
  config: Pick<Sync.Config, "dataModelTables"> | undefined
): string[] => {
  const raw = config?.dataModelTables;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isValidDataModelTableName))];
};

/** The stable-name columns for `table`, or undefined when it has no rule. */
export const getDataModelNameFields = (table: string): readonly string[] | undefined =>
  Object.prototype.hasOwnProperty.call(DATA_MODEL_NAME_FIELDS, table)
    ? DATA_MODEL_NAME_FIELDS[table]
    : undefined;

/**
 * The plain column a name field is stored in on the record itself: the first
 * segment of a dot-walk (`operation.name` lives in `operation`).
 */
export const nameFieldColumn = (field: string): string => field.split(".")[0];

/**
 * `tableOptions` with the stable-name rule attached to every opted-in table.
 *
 * A table whose options already set `displayField` or `nameFields` keeps them:
 * the operator decided how its records are named, and renaming them would move
 * every folder of an existing workspace.
 */
export const applyDataModelTableOptions = (
  config: Pick<Sync.Config, "dataModelTables" | "tableOptions">
): Sync.ITableOptionsMap => {
  const base = config.tableOptions || {};
  const tables = getDataModelTables(config);
  if (tables.length === 0) return base;
  const result: Sync.ITableOptionsMap = { ...base };
  for (const table of tables) {
    const nameFields = getDataModelNameFields(table);
    if (!nameFields) continue;
    const own = Object.prototype.hasOwnProperty.call(base, table) ? base[table] : undefined;
    if (own?.displayField || (Array.isArray(own?.nameFields) && own.nameFields.length > 0)) {
      continue;
    }
    result[table] = { ...(own ?? { query: "" }), nameFields: [...nameFields] };
  }
  return result;
};

/**
 * `includes` with every opted-in table re-included. Opting in overrides a
 * default (or user) exclude of the same table — that is the point of naming it
 * — but an explicit `includes.<table>: false` still wins, so a workspace can
 * share one `dataModelTables` list and switch a single table off.
 */
export const applyDataModelIncludes = (
  config: Pick<Sync.Config, "dataModelTables" | "includes">
): Sync.TablePropMap => {
  const base = config.includes || {};
  const tables = getDataModelTables(config);
  if (tables.length === 0) return base;
  const result: Sync.TablePropMap = { ...base };
  for (const table of tables) {
    const own = Object.prototype.hasOwnProperty.call(base, table) ? base[table] : undefined;
    // Already named — `false` (switched off) or a field map — is left alone.
    if (own !== undefined) continue;
    result[table] = true;
  }
  return result;
};

/**
 * True when `table` is a data-model table for `push --create`: either one of
 * the documented defaults or one the config opts in. A sidecar-only record in
 * such a table is created even when the manifest does not know the table yet
 * (its metadata columns are read from the dictionary at create time).
 */
export const isDataModelTable = (
  table: string,
  config: Pick<Sync.Config, "dataModelTables"> | undefined
): boolean =>
  DATA_MODEL_DEFAULT_TABLES.includes(table) || getDataModelTables(config).includes(table);

/**
 * Deleting a data-model record deletes a column, a table, a role or an ACL —
 * and with it data or access on the instance. Pruning (deleting instance
 * records whose local files are gone) is therefore never allowed for these
 * tables, whether or not the workspace opts them in. Any prune implementation
 * must consult this before it sends a DELETE.
 */
export const isPruneDeniedTable = (table: string): boolean =>
  DATA_MODEL_DEFAULT_TABLES.includes(table);
