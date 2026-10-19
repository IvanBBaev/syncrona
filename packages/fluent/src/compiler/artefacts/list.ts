// SPDX-License-Identifier: GPL-3.0-or-later
//
// List() → sys_ui_list and a sys_ui_list_element per column. Like the SDK's
// ListPlugin, both are written by one composite file named after the list's
// table, parent, relationship, view and domain, not as record updates.

import { escapeXmlAttribute, escapeXmlText } from "../../recordXml";
import type { FluentValue } from "../evaluate";
import { RecordId, type CompiledRecord, type FieldValue } from "../record";
import { Options, type ArtefactSpec, type BuildContext } from "./shared";

/** The platform's default view, the id of the `default_view` reference. */
const DEFAULT_VIEW = "Default view";
const COLUMN = ["element", "position", "sum", "maxValue", "minValue", "averageValue"];
const COLUMN_ALIASES = { max_value: "maxValue", min_value: "minValue", average_value: "averageValue" };
/** The aggregate fields of a column, in the order the file writes them. */
const AGGREGATES = ["min_value", "max_value", "average_value", "sum"];
const ROOT_ATTRIBUTES: [string, string][] = [
  ["table", "name"],
  ["parent", "parent"],
  ["relationship", "relationship"],
  ["sys_domain", "sys_domain"],
];

function viewReference(o: Options, ctx: BuildContext, value: FluentValue): RecordId | CompiledRecord {
  switch (value.kind) {
    case "string":
      return ctx.factory.createReference("sys_ui_view", undefined, { name: value.value });
    case "call":
      return ctx.recordOf(value);
    case "ref":
      return ctx.factory.createReference(
        value.table,
        value.guid,
        value.keys && Object.fromEntries([...value.keys].map(([k, v]) => [k, v.kind === "string" ? v.value : o.error("List(): Now.ref() keys of 'view' must be strings.", v)])),
      );
    default:
      return o.error("List(): 'view' must be default_view, a sys_ui_view record or a view name.", value);
  }
}

function relationshipValue(o: Options, ctx: BuildContext): string | CompiledRecord | undefined {
  const value = o.get("relationship");
  if (value === undefined) return undefined;
  if (value.kind === "string") return value.value;
  if (value.kind === "call") return ctx.recordOf(value);
  return o.error("List(): 'relationship' must be a sys_relationship record or a sys_id.", value);
}

/** The coalesce keys of a reference with nested references flattened to their ids. */
function resolveKeys(id: RecordId): Record<string, string> {
  return Object.fromEntries(
    Object.entries(id.getKeys() ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : v.getValue()]),
  );
}

function text(value: FieldValue): string {
  return value instanceof RecordId ? value.getValue() : String(value);
}

export function element(indent: string, name: string, value: string, attributes: Record<string, string> = {}): string {
  const attrs = Object.entries(attributes)
    .map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`)
    .join("");
  return value === "" ? `${indent}<${name}${attrs}/>` : `${indent}<${name}${attrs}>${escapeXmlText(value)}</${name}>`;
}

/** `sys_ui_list_<…>`, the SDK's update name of a list. */
function updateName(table: string, view: RecordId, parent: string | undefined, relationship: string | undefined, domain: string): string {
  const viewKey = view.getKeys()?.name;
  const viewName =
    view.getValue() === DEFAULT_VIEW || viewKey === DEFAULT_VIEW ? "NULL" : typeof viewKey === "string" ? viewKey : "NULL";
  const parts = parent
    ? relationship
      ? [parent, relationship, viewName]
      : [table, parent, viewName]
    : relationship
      ? ["NULL", relationship, viewName]
      : [table, viewName];
  const name = ["sys_ui_list", ...parts].join("_").toLowerCase();
  return domain !== "global" && domain !== "" ? `${name}_${domain}` : name;
}

function listFile(list: CompiledRecord, columns: CompiledRecord[], ctx: BuildContext): string {
  const keys = resolveKeys(list.id);
  const table = String(list.fields.get("name"));
  const view = list.fields.get("view") as RecordId;
  const rootAttributes = Object.fromEntries(
    ROOT_ATTRIBUTES.map(([attr, key]) => [attr, keys[key] === "NULL" ? "" : keys[key]]),
  );
  const viewKey = view.getKeys()?.name;
  const primaryKey = typeof viewKey === "string" ? viewKey : view.getValue();
  rootAttributes.view = primaryKey === DEFAULT_VIEW || primaryKey === "NULL" ? "" : primaryKey;
  const lines = ['<?xml version="1.0"?>', "<record_update>", `  <sys_ui_list${attributes(rootAttributes)}>`];
  for (const column of columns) {
    lines.push(
      '    <sys_ui_list_element action="INSERT_OR_UPDATE" apply_defaults="true">',
      element("      ", "sys_id", column.id.getValue()),
      element("      ", "list_id", list.id.getValue(), { display_value: table, ...keys }),
    );
    for (const name of ["element", "position", ...AGGREGATES]) {
      const value = column.fields.get(name);
      if (value !== undefined) lines.push(element("      ", name, text(value)));
    }
    lines.push("    </sys_ui_list_element>");
  }
  lines.push(
    '    <sys_ui_list action="INSERT_OR_UPDATE" apply_defaults="true">',
    element("      ", "sys_id", list.id.getValue()),
    element("      ", "sys_scope", ctx.scopeId, { display_value: ctx.scope }),
    element("      ", "view", view.getValue(), resolveKeys(view)),
    element("      ", "name", table),
  );
  const policy = list.fields.get("sys_policy");
  if (policy) lines.push(element("      ", "sys_policy", text(policy)));
  const parent = list.fields.get("parent");
  if (parent !== undefined) lines.push(element("      ", "parent", text(parent)));
  const relationship = list.fields.get("relationship");
  if (relationship !== undefined) {
    lines.push(element("      ", "relationship", text(relationship), relationship instanceof RecordId ? resolveKeys(relationship) : {}));
  }
  lines.push(element("      ", "sys_domain", text(list.fields.get("sys_domain") as FieldValue)));
  lines.push("    </sys_ui_list>", "  </sys_ui_list>", "</record_update>");
  return lines.join("\n");
}

export function attributes(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`)
    .join("");
}

export const list: ArtefactSpec = {
  properties: ["table", "view", "columns", "parent", "relationship", "domain"],
  build(o, ctx) {
    const table = o.requiredString("table");
    const viewValue = o.get("view");
    if (viewValue === undefined) return o.error("List(): 'view' is required.");
    const viewTarget = viewReference(o, ctx, viewValue);
    const view = viewTarget instanceof RecordId ? viewTarget : viewTarget.id;
    const parent = o.string("parent");
    const relationship = relationshipValue(o, ctx);
    const domain = o.string("domain") ?? "global";
    const relationshipId = typeof relationship === "string" ? relationship : relationship?.id.getValue();
    const name = updateName(table, view, parent, relationshipId || undefined, domain);
    const policy = o.protectionPolicy();
    const created = ctx.factory.createRecord({
      table: "sys_ui_list",
      source: o.call.loc,
      installCategory: o.installCategory,
      emit: false,
      updateName: name,
      fields: { name: table, view, parent, relationship, sys_domain: domain, sys_policy: policy },
    });
    const columns = (o.array("columns") ?? []).map((item, i) => {
      if (item.kind === "string") {
        return ctx.factory.createRecord({
          table: "sys_ui_list_element",
          source: item.loc,
          installCategory: o.installCategory,
          emit: false,
          fields: { list_id: created, position: i, element: item.value },
        });
      }
      if (item.kind !== "object") return o.error(`List(): 'columns[${i}]' must be a string or an object.`, item);
      const c = new Options(o.call, item, { properties: COLUMN, aliases: COLUMN_ALIASES }, ctx, `columns[${i}].`);
      return ctx.factory.createRecord({
        table: "sys_ui_list_element",
        source: item.loc,
        installCategory: o.installCategory,
        emit: false,
        fields: {
          list_id: created,
          position: c.number("position") ?? i,
          element: c.requiredString("element"),
          max_value: c.boolean("maxValue"),
          min_value: c.boolean("minValue"),
          average_value: c.boolean("averageValue"),
          sum: c.boolean("sum"),
        },
      });
    });
    created.children.push(...columns);
    ctx.emitFile(`${o.installCategory}/${name}.xml`, listFile(created, columns, ctx));
    return created;
  },
};
