// SPDX-License-Identifier: GPL-3.0-or-later
//
// DataPolicy() → sys_data_policy2, plus a sys_data_policy_rule row per entry
// of `rules` (keyed by field name).

import { isSNScope, type ArtefactSpec, type Options } from "./shared";

const RULE_PROPERTIES = ["$id", "mandatory", "readOnly", "table"];

/** Whether a table belongs to `scope`, or the scope may target any table. */
function inScope(scope: string, table: string): boolean {
  return table.startsWith(`${scope}_`) || isSNScope(scope) || scope === "global";
}

/** `mandatory` / `readOnly`: a boolean or 'ignore', stored as a string ('ignore' when left out). */
function tristate(rule: Options, key: string): boolean | "ignore" | undefined {
  const v = rule.get(key);
  if (v === undefined) return undefined;
  if (v.kind === "boolean") return v.value;
  if (v.kind === "string" && v.value === "ignore") return "ignore";
  return rule.error(`DataPolicy(): '${rule.path}${key}' must be a boolean or 'ignore'.`, v);
}

export const dataPolicy: ArtefactSpec = {
  properties: [
    "table",
    "shortDescription",
    "active",
    "applyToImportSets",
    "applyToSOAP",
    "conditions",
    "description",
    "useAsUiPolicyOnClient",
    "inherit",
    "modelId",
    "reverseIfFalse",
    "rules",
  ],
  build(o, ctx) {
    const table = o.string("table");
    if (table !== undefined && !inScope(ctx.scope, table)) {
      ctx.report(
        "error",
        `'table' property should start with scope prefix '${ctx.scope}_'. Data Policies in scoped apps can only be created for tables within the same scope.`,
        o.get("table")!.loc,
      );
    }
    const policy = ctx.factory.createRecord({
      table: "sys_data_policy2",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        model_table: table ?? "",
        short_description: o.string("shortDescription") ?? "",
        active: o.boolean("active") ?? true,
        apply_import_set: o.boolean("applyToImportSets") ?? true,
        apply_soap: o.boolean("applyToSOAP") ?? true,
        conditions: o.string("conditions") ?? "",
        description: o.string("description") ?? "",
        enforce_ui: o.boolean("useAsUiPolicyOnClient") ?? true,
        inherit: o.boolean("inherit") ?? false,
        model_id: o.string("modelId") ?? "",
        reverse_if_false: o.boolean("reverseIfFalse") ?? true,
      },
    });

    const rules = o.get("rules");
    if (rules !== undefined && rules.kind !== "object") return o.error("DataPolicy(): 'rules' must be an object.", rules);
    for (const [field, item] of rules?.props ?? []) {
      // The SDK skips a rule that is not an object.
      if (item.kind !== "object") continue;
      const rule = o.sub(item, `rules.${field}.`, RULE_PROPERTIES);
      const mandatory = tristate(rule, "mandatory");
      const readOnly = tristate(rule, "readOnly");
      if (mandatory === true && readOnly === true) {
        ctx.report("error", `Rule for field '${field}': mandatory and readOnly cannot both be true - these are mutually exclusive`, item.loc);
        continue;
      }
      const ruleTable = rule.string("table");
      if (mandatory === true && ruleTable !== undefined && ruleTable !== (table ?? "") && !inScope(ctx.scope, ruleTable)) {
        ctx.report(
          "error",
          `Rule for field '${field}': cannot set mandatory=true for table '${ruleTable}' which is outside the current scope '${ctx.scope}'. For tables in a different scope than the data policy record, you cannot make a field mandatory.`,
          rule.get("table")!.loc,
        );
        continue;
      }
      policy.children.push(
        ctx.factory.createRecord({
          table: "sys_data_policy_rule",
          source: item.loc,
          installCategory: o.installCategory,
          explicitId: rule.explicitId(),
          fields: {
            sys_data_policy: policy,
            table: ruleTable ?? table ?? "",
            field,
            mandatory: String(mandatory ?? "ignore"),
            disabled: String(readOnly ?? "ignore"),
          },
        }),
      );
    }
    return policy;
  },
};
