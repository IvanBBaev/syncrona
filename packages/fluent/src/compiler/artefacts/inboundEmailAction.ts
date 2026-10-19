// SPDX-License-Identifier: GPL-3.0-or-later
//
// InboundEmailAction() → sysevent_in_email_action.

import { isGUID } from "../keys";
import { CData, type CompiledRecord } from "../record";
import { roleNames, type ArtefactSpec, type BuildContext, type Options } from "./shared";

const TYPES = ["new", "reply", "forward"];
const ACTIONS = ["record_action", "reply_email"];

/** A script-like option as CDATA, or empty when left out. */
function cdata(o: Options, key: string): CData | string {
  const value = o.string(key);
  return value === undefined ? "" : new CData(value);
}

/** `from`: a sys_user Record() or a sys_id string. */
function sender(o: Options, ctx: BuildContext): string | CompiledRecord {
  const v = o.get("from");
  if (v?.kind === "call") {
    const user = ctx.recordOf(v);
    if (user.table !== "sys_user") o.error("InboundEmailAction(): 'from' must be a sys_id or a Record<'sys_user'>.", v);
    return user;
  }
  const value = o.string("from") ?? "";
  if (value !== "" && !isGUID(value)) {
    ctx.report("error", `'from' must be a valid GUID or a Record<'sys_user'>. Received: '${value}'`, v!.loc);
  }
  return value;
}

function oneOf(o: Options, key: string, values: string[], fallback: string): string {
  const value = o.string(key) ?? fallback;
  if (!values.includes(value)) o.error(`InboundEmailAction(): '${key}' must be one of ${values.join(", ")}.`, o.get(key));
  return value;
}

export const inboundEmailAction: ArtefactSpec = {
  properties: [
    "name",
    "description",
    "table",
    "type",
    "action",
    "active",
    "order",
    "eventName",
    "stopProcessing",
    "conditionScript",
    "filterCondition",
    "from",
    "requiredRoles",
    "script",
    "fieldAction",
    "assignmentOperator",
    "replyEmail",
  ],
  build(o, ctx) {
    const action = oneOf(o, "action", ACTIONS, "record_action");
    const table = o.string("table") ?? "";
    const fieldAction = o.string("fieldAction") ?? "";
    if (action === "record_action" && fieldAction !== "" && table === "") {
      ctx.report("error", "Field 'fieldAction' can only be used when 'table' is specified.", o.get("fieldAction")!.loc);
    }
    const roles = o.array("requiredRoles");
    return ctx.factory.createRecord({
      table: "sysevent_in_email_action",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name") ?? "",
        description: o.string("description") ?? "",
        table,
        type: oneOf(o, "type", TYPES, "new"),
        action,
        active: o.boolean("active") ?? false,
        order: o.number("order") ?? 100,
        event_name: o.string("eventName") ?? "email.read",
        stop_processing: o.boolean("stopProcessing") ?? false,
        script: cdata(o, "script"),
        condition_script: cdata(o, "conditionScript"),
        filter_condition: o.string("filterCondition") ?? "",
        template: cdata(o, "fieldAction"),
        from: sender(o, ctx),
        reply_email: cdata(o, "replyEmail"),
        required_roles: roles === undefined ? "" : roleNames(o, ctx, roles, "requiredRoles"),
        assignment_operator: o.string("assignmentOperator") ?? "",
      },
    });
  },
};
