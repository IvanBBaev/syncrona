// SPDX-License-Identifier: GPL-3.0-or-later
//
// Table() → sys_db_object, with its columns' sys_dictionary rows (and their
// documentation and choices), the table's sys_documentation, its collection
// sys_dictionary row and its licensing row, the way SDK 4.13.6 builds them.
// Besides the record updates a table writes its bootstrap dictionary file and
// one choice set file per column with choices (see tableFiles.ts). The SDK
// writes the licensing row only when it differs from the default, which a
// table without `licensingConfig` never does.

import type { CompiledRecord, FieldValue, RecordId } from "../record";
import { buildColumn, COLUMN_MTOM, attributesText, defaultLanguageLabel, documentation, joinAttributes, type TableTarget } from "./column";
import { generateLabel } from "./labels";
import { isSNScope, roleRecord, type ArtefactSpec, type BuildContext, type Options } from "./shared";
import { bootstrapFile, choiceSetFile, type TableFileColumn } from "./tableFiles";

const TABLE_NAME = /^[a-z_][a-z0-9_]*[a-z0-9]$/;
const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;
const CALLER_ACCESS = ["none", "tracking", "restricted"];
const ACTIONS = ["read", "update", "delete", "create"];

/** sys_db_object access flags, written only when the definition sets them. */
const ACCESS_FLAGS: readonly (readonly [string, string])[] = [
  ["allowClientScripts", "client_scripts_access"],
  ["allowConfiguration", "configuration_access"],
  ["allowNewFields", "alter_access"],
  ["allowUiActions", "actions_access"],
  ["allowWebServiceAccess", "ws_access"],
];

function unsupported(o: Options, key: string): void {
  const v = o.get(key);
  if (v !== undefined) o.error(`Table(): '${key}' is not supported by the native compiler yet.`, v);
}

/** `actions` as read/update/delete/create flags: the array form lists the true ones, the object form sets any of them. */
function actionFlags(o: Options, ctx: BuildContext): Record<string, boolean | undefined> {
  const value = o.get("actions");
  if (value === undefined) return {};
  if (value.kind === "array") {
    ctx.report(
      "hint",
      "Passing 'actions' as an array is deprecated: it writes false for every action it omits. Use the object form, which writes only the actions you set, for example: actions: { read: true, create: false }.",
      value.loc,
    );
    const listed = new Set(value.items.map((item) => (item.kind === "string" ? item.value : undefined)));
    return Object.fromEntries(ACTIONS.map((a) => [a, listed.has(a)]));
  }
  const actions = o.nested("actions", ACTIONS);
  return Object.fromEntries(ACTIONS.map((a) => [a, actions?.boolean(a)]));
}

function superClass(o: Options, ctx: BuildContext): { ref?: RecordId | CompiledRecord; name?: string } {
  const value = o.get("extends");
  if (value === undefined) return {};
  if (value.kind === "string") {
    ctx.dictionary.refer("Table", value.value, value.loc);
    return { ref: ctx.factory.createReference("sys_db_object", undefined, { name: value.value }), name: value.value };
  }
  if (value.kind === "call") {
    const parent = ctx.recordOf(value);
    if (parent.table !== "sys_db_object") o.error("Table(): 'extends' must be a table name or a Table().", value);
    return { ref: parent, name: String(parent.fields.get("name")) };
  }
  return o.error("Table(): 'extends' must be a table name or a Table().", value);
}

function userRole(o: Options, ctx: BuildContext): RecordId | CompiledRecord | undefined {
  const value = o.get("userRole");
  if (value === undefined) return undefined;
  if (value.kind === "string") {
    return value.value === "" ? undefined : ctx.factory.createReference("sys_user_role", undefined, { name: value.value });
  }
  if (value.kind === "call") return roleRecord(o, ctx, value, "userRole").role;
  return o.error("Table(): 'userRole' must be a role name or a Role().", value);
}

function build(o: Options, ctx: BuildContext): CompiledRecord {
  if (ctx.tableConfigError) o.error(ctx.tableConfigError);
  for (const key of ["augments", "index", "autoNumber", "licensingConfig"]) unsupported(o, key);
  if (o.boolean("dbObjectId")) unsupported(o, "dbObjectId");

  const nameValue = o.get("name");
  const name = o.requiredString("name");
  const nameLoc = nameValue!.loc;
  if (!TABLE_NAME.test(name)) {
    ctx.report(
      "error",
      "Table name must only contain lowercase letters, numbers, and underscores and end with a letter or number",
      nameLoc,
    );
  }
  const scope = ctx.scope;
  const global = scope === "global";
  const scopePrefix = global ? "u_" : `${scope}_`;
  const prefixed = name.startsWith(scopePrefix);
  let ignoreColumnNameCheck = false;
  if (!prefixed && !isSNScope(scope) && !global) {
    if (nameValue?.kind === "string" && nameValue.cast) ignoreColumnNameCheck = true;
    else ctx.report("error", `'name' property should start with scope prefix '${scopePrefix}'`, nameLoc);
  }
  const binding = o.call.binding;
  if (!binding?.exported || binding.name !== name) {
    ctx.report("error", `Table definition should be exported as a named export with the name '${name}'`, o.call.loc);
  }

  const schema = o.get("schema");
  if (schema === undefined) o.error("Table(): 'schema' is required.");
  if (schema.kind !== "object") o.error("Table(): 'schema' must be an object.", schema);
  if (global && !prefixed) {
    if ([...schema.props.keys()].some((c) => !c.startsWith(scopePrefix))) {
      ctx.report("error", "Global table 'name' property should start with custom prefix 'u_'", nameLoc);
    }
  } else if (global) ignoreColumnNameCheck = true;

  const target: TableTarget = { name, installCategory: o.installCategory, defaultLanguage: ctx.defaultLanguage };
  const display = o.string("display");
  const columns: CompiledRecord[] = [];
  for (const [column, value] of schema.props) {
    if (!COLUMN_NAME.test(column)) {
      ctx.report("error", "Column name must only contain lowercase letters, numbers, and underscores", value.loc);
    }
    if (!ignoreColumnNameCheck && !prefixed && !isSNScope(scope) && !global && !column.startsWith(scopePrefix)) {
      ctx.report("error", `Column name should be prefixed with scope '${scopePrefix}' if table name does not contain prefix`, value.loc);
    } else if (global && !prefixed && !column.startsWith(scopePrefix)) {
      ctx.report(
        "error",
        `Column name should be prefixed with '${scopePrefix}' custom prefix if table name does not contain this prefix, such as when adding columns to an existing global table`,
        value.loc,
      );
    }
    columns.push(buildColumn(o, ctx, target, column, value, display === column));
  }

  const licensing = ctx.factory.createRecord({
    table: "ua_table_licensing_config",
    source: o.call.loc,
    installCategory: target.installCategory,
    emit: false,
    fields: { name, license_model: "none", is_fulfillment: false, op_delete: true, op_insert: true, op_update: true },
  });
  const docs = documentation(o, ctx, target, undefined, "");

  const attributes = o.get("attributes")?.kind === "object" ? joinAttributes(attributesText(o, "attributes")) : undefined;
  const collection = ctx.factory.createRecord({
    table: "sys_dictionary",
    source: o.call.loc,
    installCategory: target.installCategory,
    updateName: `sys_dictionary_${name}_null`,
    elementAttributes: { element: "", table: name },
    fields: {
      name,
      element: undefined,
      internal_type: "collection",
      active: true,
      attributes: o.get("attributes") === undefined ? "" : attributes,
      audit: o.boolean("audit") ?? false,
      read_only: o.boolean("readOnly") ?? false,
      sizeclass: o.number("sizeClass"),
      text_index: o.boolean("textIndex") ?? false,
    },
  });

  const callerAccess = o.string("callerAccess");
  const callerAccessIndex = callerAccess ? CALLER_ACCESS.indexOf(callerAccess) : -1;
  const actions = actionFlags(o, ctx);
  const parent = superClass(o, ctx);
  ctx.dictionary.declareTable(name, parent.name, [...schema.props.keys()], prefixed);
  const fields: Record<string, FieldValue | CompiledRecord> = {
    number_ref: undefined,
    access: o.string("accessibleFrom") ?? "public",
    caller_access: callerAccessIndex > 0 ? callerAccessIndex : undefined,
    super_class: parent.ref,
    is_extendable: o.boolean("extensible") ?? false,
    label: defaultLanguageLabel(docs, ctx.defaultLanguage) ?? generateLabel(name),
    live_feed_enabled: o.boolean("liveFeed") ?? false,
    name,
    create_access_controls: o.boolean("createAccessControls") ?? false,
    user_role: userRole(o, ctx),
    scriptable_table: o.boolean("scriptableTable") ?? false,
  };
  for (const [option, field] of ACCESS_FLAGS) {
    const flag = o.boolean(option);
    if (flag !== undefined) fields[field] = flag;
  }
  for (const action of ACTIONS) {
    if (actions[action] !== undefined) fields[`${action}_access`] = actions[action];
  }
  const record = ctx.factory.createRecord({
    table: "sys_db_object",
    source: o.call.loc,
    installCategory: target.installCategory,
    explicitId: o.explicitId(),
    fields,
  });
  record.children.push(...columns, licensing, ...docs, collection);

  const fileColumns: TableFileColumn[] = columns.map((c) => {
    const choiceSet = c.children.find((r) => r.table === "sys_choice_set");
    return {
      dictionary: c,
      docs: c.children.filter((r) => r.table === "sys_documentation"),
      choices: c.children.filter((r) => r.table === "sys_choice"),
      ...(choiceSet ? { choiceSet } : {}),
      ...(COLUMN_MTOM.has(c) ? { mtom: COLUMN_MTOM.get(c) } : {}),
    };
  });
  const model = {
    name,
    scope,
    scopeId: ctx.scopeId,
    snScope: isSNScope(scope),
    dbObject: record,
    collection,
    docs,
    columns: fileColumns,
    ...(parent.name === undefined ? {} : { extendsName: parent.name }),
    ...(display !== undefined && schema.props.has(display) ? { display } : {}),
  };
  const files = [bootstrapFile(model), ...fileColumns.map((c) => choiceSetFile(model, c))];
  for (const file of files) if (file) ctx.emitFile(file.path, file.content);
  return record;
}

export const table: ArtefactSpec = {
  properties: [
    "name",
    "label",
    "schema",
    "extends",
    "extensible",
    "display",
    "accessibleFrom",
    "allowClientScripts",
    "allowConfiguration",
    "allowNewFields",
    "allowUiActions",
    "allowWebServiceAccess",
    "actions",
    "attributes",
    "audit",
    "autoNumber",
    "augments",
    "callerAccess",
    "createAccessControls",
    "dbObjectId",
    "index",
    "licensingConfig",
    "liveFeed",
    "readOnly",
    "scriptableTable",
    "sizeClass",
    "textIndex",
    "userRole",
  ],
  aliases: {
    read_only: "readOnly",
    text_index: "textIndex",
    allow_web_service_access: "allowWebServiceAccess",
    allow_new_fields: "allowNewFields",
    allow_ui_actions: "allowUiActions",
    allow_client_scripts: "allowClientScripts",
    licensing_config: "licensingConfig",
    live_feed: "liveFeed",
    accessible_from: "accessibleFrom",
    caller_access: "callerAccess",
    scriptable_table: "scriptableTable",
    auto_number: "autoNumber",
  },
  build,
};
