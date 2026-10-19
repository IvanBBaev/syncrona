// SPDX-License-Identifier: GPL-3.0-or-later
//
// BusinessRule() → sys_script.

import { CData } from "../record";
import { lookup, roleNames, type ArtefactSpec } from "./shared";

/** The script a new business rule gets on the instance; a rule left at it is not advanced. */
export const DEFAULT_BUSINESS_RULE_SCRIPT =
  "(function executeRule(current, previous /*null when async*/) {\n\n\t// Add your code here\n\n})(current, previous);";

const WHEN: Record<string, string> = {
  async: "async_always",
  async_deprecated: "async",
  display: "before_display",
  before: "before",
  after: "after",
};
const ACTIONS = ["insert", "update", "delete", "query"];

export const businessRule: ArtefactSpec = {
  properties: [
    "name",
    "table",
    "order",
    "active",
    "message",
    "addMessage",
    "condition",
    "filterCondition",
    "description",
    "script",
    "when",
    "action",
    "setFieldValue",
    "roleConditions",
    "abortAction",
    "priority",
    "rest",
    "changeFields",
    "clientCallable",
    "executeFunction",
    "access",
  ],
  aliases: {
    add_message: "addMessage",
    abort_action: "abortAction",
    set_field_value: "setFieldValue",
    filter_condition: "filterCondition",
    role_conditions: "roleConditions",
    sys_policy: "protectionPolicy",
  },
  build(o, ctx) {
    const name = o.requiredString("name");
    const script = o.string("script");
    const when = o.string("when");
    const actions = new Set(o.stringArray("action"));
    for (const action of actions) {
      if (!ACTIONS.includes(action))
        o.error(`BusinessRule(): 'action' must hold ${ACTIONS.map((a) => `'${a}'`).join(", ")}.`, o.get("action"));
    }
    const rest = o.nested("rest", ["webService", "variables", "method", "methodText", "service", "serviceText"]);
    const roleConditions = o.array("roleConditions");
    const table = o.requiredString("table");
    ctx.dictionary.refer("BusinessRule", table, o.get("table")!.loc);
    return ctx.factory.createRecord({
      table: "sys_script",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        order: o.number("order") ?? 100,
        active: o.boolean("active") ?? true,
        message: o.string("message"),
        add_message: o.boolean("addMessage") ?? false,
        condition: o.string("condition"),
        filter_condition: o.string("filterCondition"),
        description: o.string("description"),
        advanced: script !== undefined && script !== DEFAULT_BUSINESS_RULE_SCRIPT,
        script: script !== undefined ? new CData(script) : DEFAULT_BUSINESS_RULE_SCRIPT,
        collection: table,
        when:
          when === undefined
            ? "before"
            : (lookup(WHEN, when) ??
              o.error(
                `BusinessRule(): 'when' must be one of ${Object.keys(WHEN)
                  .map((w) => `'${w}'`)
                  .join(", ")}.`,
                o.get("when"),
              )),
        action_insert: actions.has("insert"),
        action_update: actions.has("update"),
        action_query: actions.has("query"),
        action_delete: actions.has("delete"),
        template: o.string("setFieldValue"),
        role_conditions: roleConditions && roleNames(o, ctx, roleConditions, "roleConditions"),
        abort_action: o.boolean("abortAction") ?? false,
        priority: o.number("priority") ?? 100,
        is_rest: rest?.boolean("webService") ?? false,
        rest_variables: rest?.string("variables"),
        rest_method: rest?.string("method"),
        rest_method_text: rest?.string("methodText"),
        rest_service: rest?.string("service"),
        rest_service_text: rest?.string("serviceText"),
        change_fields: o.boolean("changeFields") ?? false,
        client_callable: o.boolean("clientCallable") ?? false,
        execute_function: o.boolean("executeFunction") ?? false,
        access: o.string("access") ?? "package_private",
        sys_policy: o.protectionPolicy(),
        sys_name: name,
      },
    });
  },
};
