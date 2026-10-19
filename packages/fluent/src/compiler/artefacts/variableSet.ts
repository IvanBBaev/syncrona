// SPDX-License-Identifier: GPL-3.0-or-later
//
// VariableSet() → item_option_new_set, with its variables (item_option_new,
// question_choice, fx_price) as children.

import { roleNames, type ArtefactSpec } from "./shared";
import { buildVariables, validateSetVariables, variableEntries } from "./variables";

const INTERNAL_NAME = /^[a-z][a-z0-9_]*$/;

export const variableSet: ArtefactSpec = {
  properties: [
    "title",
    "internalName",
    "name",
    "description",
    "type",
    "layout",
    "order",
    "displayTitle",
    "setAttributes",
    "version",
    "readRoles",
    "writeRoles",
    "createRoles",
    "variables",
  ],
  build(o, ctx) {
    const title = o.requiredString("title");
    const given = o.string("internalName");
    if (given !== undefined && !INTERNAL_NAME.test(given)) {
      o.error(
        "VariableSet internalName must start with a lowercase letter and contain only lowercase letters, numbers, and underscores (snake_case format). No spaces, hyphens, or uppercase letters allowed.",
        o.get("internalName"),
      );
    }
    if (given !== undefined && given.length > 80) {
      o.error(`VariableSet internalName must be 80 characters or less. Current length: ${given.length}`, o.get("internalName"));
    }
    const internalName =
      given ??
      title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const type = o.string("type") ?? "singleRow";
    const entries = variableEntries(o);
    if (entries) validateSetVariables(o, entries, type === "multiRow");

    const roles = (key: string) => roleNames(o, ctx, o.array(key) ?? [], key);
    const record = ctx.factory.createRecord({
      table: "item_option_new_set",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        title,
        internal_name: internalName,
        name: o.string("name") ?? "",
        description: o.string("description") ?? "",
        type: type === "multiRow" ? "one_to_many" : "one_to_one",
        layout: o.string("layout") ?? "normal",
        order: o.number("order") ?? 100,
        display_title: o.boolean("displayTitle") ?? false,
        set_attributes: o.string("setAttributes") ?? "",
        version: o.number("version") ?? 1,
        read_roles: roles("readRoles"),
        write_roles: roles("writeRoles"),
        create_roles: roles("createRoles"),
      },
    });
    if (entries) record.children.push(...buildVariables(o, ctx, entries, { kind: "set", record }));
    return record;
  },
};
