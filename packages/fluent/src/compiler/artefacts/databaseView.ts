// SPDX-License-Identifier: GPL-3.0-or-later
//
// DatabaseView() → sys_db_view, with a sys_db_view_table per joined table and a
// sys_db_view_table_field per selected field of that table.

import { isSNScope, type ArtefactSpec } from "./shared";

const MAX_PREFIX_LENGTH = 30;

export const databaseView: ArtefactSpec = {
  properties: ["name", "label", "plural", "description", "tables", "protectionPolicy"],
  build(o, ctx) {
    const name = o.requiredString("name");
    const nameLoc = o.get("name")!.loc;
    const normalized = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (name && name !== normalized) {
      ctx.report(
        "error",
        `Database view name '${name}' must already be normalized to '${normalized}' (lowercase, non-alphanumeric characters replaced with '_') — the platform rewrites the name on save, which would cause the next build to create a duplicate view instead of updating this one.`,
        nameLoc,
      );
    }
    if (name && ctx.scope === "global" && !name.startsWith("u_")) {
      ctx.report("error", `Database view name '${name}' must start with the custom prefix 'u_' in the global scope.`, nameLoc);
    } else if (name && !isSNScope(ctx.scope) && ctx.scope !== "global" && !name.startsWith(`${ctx.scope}_`)) {
      ctx.report(
        "error",
        `Database view name '${name}' must start with the scope prefix '${ctx.scope}_' to match the current application scope.`,
        nameLoc,
      );
    }
    const view = ctx.factory.createRecord({
      table: "sys_db_view",
      source: o.call.loc,
      installCategory: o.installCategory,
      fields: {
        name,
        label: o.string("label") ?? "",
        plural: o.string("plural") ?? "",
        description: o.string("description") ?? "",
      },
    });
    const prefixes = new Set<string>();
    const orders = new Set<number>();
    (o.array("tables") ?? []).forEach((item, i) => {
      const key = `tables[${i}].`;
      const t = o.sub(item, key, ["$id", "table", "variablePrefix", "leftJoin", "order", "whereClause", "active", "fields"]);
      const prefix = t.string("variablePrefix");
      const order = t.number("order") ?? 100;
      if (orders.has(order)) {
        ctx.report("hint", `View "${name}" has more than one table with order ${order}.`, t.get("order")!.loc);
      }
      orders.add(order);
      if (prefix !== undefined) {
        const prefixLoc = t.get("variablePrefix")!.loc;
        if (prefix.includes("_")) {
          ctx.report("error", `Variable prefix '${prefix}' cannot contain an underscore.`, prefixLoc);
        }
        if (prefix.length > MAX_PREFIX_LENGTH) {
          ctx.report("error", `Variable prefix '${prefix}' must be ${MAX_PREFIX_LENGTH} characters or fewer.`, prefixLoc);
        }
        if (prefixes.has(prefix)) {
          ctx.report(
            "error",
            `Variable prefix '${prefix}' is used by more than one table in this view. Each joined table must use a unique prefix.`,
            prefixLoc,
          );
        }
        if (prefix) prefixes.add(prefix);
      }
      const table = t.requiredString("table");
      const viewTable = ctx.factory.createRecord({
        table: "sys_db_view_table",
        source: item.loc,
        installCategory: o.installCategory,
        explicitId: t.explicitId(),
        fields: {
          view,
          table,
          variable_prefix: prefix,
          left_join: t.boolean("leftJoin") ?? false,
          order,
          where_clause: t.string("whereClause") ?? "",
          active: t.boolean("active") ?? true,
        },
      });
      viewTable.children.push(
        ...(t.array("fields") ?? []).map((fieldItem, j) => {
          const f = o.sub(fieldItem, `${key}fields[${j}].`, ["$id", "field"]);
          return ctx.factory.createRecord({
            table: "sys_db_view_table_field",
            source: fieldItem.loc,
            installCategory: o.installCategory,
            explicitId: f.explicitId(),
            fields: { view_table: viewTable, field: f.requiredString("field"), table },
          });
        }),
      );
      view.children.push(viewTable);
    });
    return view;
  },
};
