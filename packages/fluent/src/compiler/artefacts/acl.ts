// SPDX-License-Identifier: GPL-3.0-or-later
//
// Acl() → sys_security_acl, plus one sys_security_acl_role row per role.

import { isGUID } from "../keys";
import { CData, RecordId } from "../record";
import { lookup, roleReference, type ArtefactSpec } from "./shared";

/** ACL types whose stored value differs from the Fluent name, or that the platform defines. */
const TYPES: Record<string, string> = {
  pd_action: "pd_action",
  record: "record",
  client_callable_flow_object: "client_callable_flow_object",
  client_callable_script_include: "client_callable_script_include",
  graphql: "GraphQL",
  processor: "processor",
  rest_endpoint: "REST_Endpoint",
  ui_page: "ui_page",
  ux_page: "b9eb8a1b873303002941b53046cb0b18",
  ux_route: "b9eb8a1b873303002941b53046cb1234",
  aiux_page: "f7ca0655ff258310ef9affffffffff73",
  aiux_widget: "3bca0655ff258310ef9affffffffff78",
  aiux_experience: "fe7c98ae06cd5e401fb2469d3397df2b",
  ux_data_broker: "6d9c40e9531210101cb3ddeeff7b12f6",
};

/** Operations stored by sys_id; the five basic ones are stored by name. */
const OPERATIONS: Record<string, string> = {
  execute: "execute",
  create: "create",
  read: "read",
  write: "write",
  delete: "delete",
  conditional_table_query_range: "7aad4c50b7f4621062b62181ce11a918",
  data_fabric: "e60cd19b4f602210f2c160cc32ce0b06",
  query_match: "521c7497b7300210240b06dd1e11a979",
  query_range: "e66cf897b7300210240b06dd1e11a9fd",
  edit_task_relations: "b718b0e2c0a80204005b2705d3b6a0a0",
  edit_ci_relations: "b7199572c0a8020400ee6d907c07d6cc",
  save_as_template: "e5a2b9c50a0a0bc5005dd4a3096ac37b",
  add_to_list: "394af8150a0a0b270096f5ac9d6bac47",
  report_on: "f6861c32c0a8016400647951e901525d",
  list_edit: "54f535270a0a0b8c007c67009ab2bdc0",
  report_view: "0997ab83733303005978e4b9cdf6a7b9",
  personalize_choices: "76742c60c0a801657735f3789a7327d0",
};

const ATTRIBUTES: Record<string, string> = {
  user_is_authenticated: "239bdf0c47d23110ba46ff58936d4330", // gitleaks:allow -- platform sys_id, not a secret
  has_admin_role: "8637f144b732111074f706dd1e11a981",
};

const EXECUTE_ONLY = new Set(["client_callable_flow_object", "client_callable_script_include", "graphql", "processor", "rest_endpoint"]);

export const acl: ArtefactSpec = {
  properties: [
    "type",
    "operation",
    "active",
    "script",
    "description",
    "condition",
    "roles",
    "localOrExisting",
    "decisionType",
    "securityAttribute",
    "adminOverrides",
    "table",
    "field",
    "appliesTo",
    "name",
    "dataBroker",
  ],
  aliases: {
    admin_overrides: "adminOverrides",
    decision_type: "decisionType",
    local_or_existing: "localOrExisting",
    security_attribute: "securityAttribute",
    applies_to: "appliesTo",
  },
  build(o, ctx) {
    const at = (key: string) => o.get(key)!.loc;
    const type = o.requiredString("type");
    const operation = o.requiredString("operation");
    if (operation !== "execute" && EXECUTE_ONLY.has(type)) {
      ctx.report("error", `ACL must use operation 'execute', because it is of type '${type}'`, at("operation"));
    }
    const script = o.string("script");
    if (script !== undefined && type === "graphql") {
      ctx.report("error", "ACL does not support scripts, because it is of type graphql", at("script"));
    }
    const appliesTo = o.string("appliesTo");
    if (appliesTo !== undefined && type !== "record") {
      ctx.report("error", "ACL cannot set applies_to unless its type is 'record'", at("appliesTo"));
    }
    const name = o.string("name");
    const table = o.string("table");
    const field = o.string("field");
    if (lookup(TYPES, type) === undefined) {
      if (name !== undefined && (table !== undefined || field !== undefined)) {
        ctx.report(
          "error",
          "'name' and 'table'/'field' are mutually exclusive. Use either 'name' alone or 'table' with an optional 'field', not both.",
          at("name"),
        );
      }
      if (appliesTo !== undefined && name !== undefined) {
        ctx.report(
          "error",
          "'appliesTo' can only be used with 'table' and 'field' properties. Remove 'appliesTo' when using 'name'.",
          at("appliesTo"),
        );
      }
    }
    if ((type === "ux_route" || type === "ux_page") && (table !== undefined || field !== undefined)) {
      ctx.report(
        "warning",
        `The 'table' and 'field' properties are deprecated for '${type}' ACLs and will be ignored. Use the 'name' property instead.`,
        at(table !== undefined ? "table" : "field"),
      );
    }
    const dataBroker = o.string("dataBroker");
    if (type === "ux_data_broker") {
      if (dataBroker === undefined && table === undefined && field === undefined) {
        ctx.report(
          "error",
          "ACL of type 'ux_data_broker' must have either a 'dataBroker' property or 'table' and 'field' properties defined",
          o.call.loc,
        );
      }
      if (dataBroker !== undefined && (table !== undefined || field !== undefined)) {
        ctx.report(
          "error",
          "ACL of type 'ux_data_broker' cannot have both 'dataBroker' and 'table'/'field' properties defined",
          at("dataBroker"),
        );
      }
      if (dataBroker !== undefined && !isGUID(dataBroker)) {
        ctx.report(
          "error",
          `'dataBroker' must be a valid GUID or a Record<'sys_ux_data_broker'>. Received: '${dataBroker}'`,
          at("dataBroker"),
        );
      }
    }
    const condition = o.string("condition");
    if (operation === "add_to_list") {
      if (script !== undefined) ctx.report("error", "ACL cannot have a script due to its 'add_to_list' operation", at("script"));
      else if (condition !== undefined) {
        ctx.report("error", "ACL cannot have a condition due to its 'add_to_list' operation", at("condition"));
      }
    }
    const securityAttribute = o.string("securityAttribute");
    const localOrExisting = o.string("localOrExisting");
    const aclName = dataBroker ?? name ?? (field !== undefined ? `${table}.${field}` : table);
    const record = ctx.factory.createRecord({
      table: "sys_security_acl",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        active: o.boolean("active") ?? true,
        decision_type: o.string("decisionType") ?? "allow",
        description: o.string("description") ?? "",
        admin_overrides: o.boolean("adminOverrides") ?? true,
        ...(localOrExisting !== undefined ? { local_or_existing: localOrExisting } : {}),
        condition: condition ?? "",
        applies_to: appliesTo ?? "",
        name: aclName,
        sys_name: aclName,
        type: lookup(TYPES, type) ?? type,
        operation: new RecordId("sys_security_operation", lookup(OPERATIONS, operation) ?? operation).withAttribute(
          "display_value",
          operation,
        ),
        advanced: script !== undefined,
        script: script !== undefined ? new CData(script) : undefined,
        security_attribute: securityAttribute !== undefined ? (lookup(ATTRIBUTES, securityAttribute) ?? securityAttribute) : undefined,
      },
    });

    const roles = o.array("roles") ?? [];
    if (roles.length === 0 && !securityAttribute && script === undefined && !condition) {
      ctx.report("warning", "ACLs must have at least one of the following: roles, security_attribute, condition, or script", o.call.loc);
    }
    for (const entry of roles) {
      const config = entry.kind === "object" ? o.sub(entry, "roles[].", ["role", "protectionPolicy"]) : undefined;
      const value = config ? (config.get("role") ?? config.error("Acl(): 'roles[].role' is required.", entry)) : entry;
      const policy = config?.protectionPolicy();
      const { role, name: roleName } = roleReference(o, ctx, value, "roles");
      record.children.push(
        ctx.factory.createRecord({
          table: "sys_security_acl_role",
          source: o.call.loc,
          installCategory: o.installCategory,
          fields: {
            sys_security_acl: record,
            sys_user_role: role,
            ...(roleName !== undefined ? { sys_name: `${aclName}.${roleName}` } : {}),
            ...(policy !== undefined ? { sys_policy: policy } : {}),
          },
        }),
      );
    }
    return record;
  },
};
