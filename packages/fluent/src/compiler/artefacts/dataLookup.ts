// SPDX-License-Identifier: GPL-3.0-or-later
//
// DataLookup() → dl_definition, with a dl_definition_rel_match per match rule
// and a dl_definition_rel_set per set rule.

import type { ArtefactSpec } from "./shared";

export const dataLookup: ArtefactSpec = {
  properties: ["name", "sourceTable", "matcherTable", "active", "runOnInsert", "runOnUpdate", "runOnFormChange", "matchRules", "setRules"],
  build(o, ctx) {
    const name = o.requiredString("name");
    if (name.length > 40) {
      ctx.report("error", `Data Lookup Definition name must be 40 characters or fewer (got ${name.length}).`, o.get("name")!.loc);
    }
    const tables = { sourceTable: o.requiredString("sourceTable"), matcherTable: o.requiredString("matcherTable") };
    for (const [key, table] of Object.entries(tables)) {
      ctx.dictionary.refer("DataLookup", table, o.get(key)!.loc);
      if (ctx.scope.startsWith("x_") && !table.startsWith(`${ctx.scope}_`)) {
        ctx.report(
          "error",
          `${key} '${table}' must be in the same scope as the data lookup definition. Expected a table starting with '${ctx.scope}_'.`,
          o.get(key)!.loc,
        );
      }
    }
    const { sourceTable: source_table, matcherTable: matcher_table } = tables;
    const definition = ctx.factory.createRecord({
      table: "dl_definition",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        source_table,
        matcher_table,
        active: o.boolean("active") ?? true,
        run_on_insert: o.boolean("runOnInsert") ?? true,
        run_on_update: o.boolean("runOnUpdate") ?? false,
        run_on_form_change: o.boolean("runOnFormChange") ?? true,
        sys_policy: o.protectionPolicy(),
      },
    });
    const rules = (key: string, table: string, fieldKey: string, flagKey: string, flag: string) =>
      (o.array(key) ?? []).map((item, i) => {
        const rule = o.sub(item, `${key}[${i}].`, ["$id", fieldKey, "matcherField", flagKey]);
        return ctx.factory.createRecord({
          table,
          source: item.loc,
          installCategory: o.installCategory,
          explicitId: rule.explicitId(),
          fields: {
            dl_definition: definition,
            source_table_field: rule.requiredString(fieldKey),
            matcher_table_field: rule.requiredString("matcherField"),
            [flag]: rule.boolean(flagKey) ?? false,
            source_table,
            matcher_table,
          },
        });
      });
    definition.children.push(
      ...rules("matchRules", "dl_definition_rel_match", "sourceField", "exactMatch", "exact_match"),
      ...rules("setRules", "dl_definition_rel_set", "targetField", "alwaysReplace", "always_replace"),
    );
    return definition;
  },
};
