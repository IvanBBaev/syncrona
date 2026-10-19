// SPDX-License-Identifier: GPL-3.0-or-later
//
// StateModel() → sttrm_model (chg_model, prb_model or prb_task_model by the
// target table), its user-criteria m2m rows, sttrm_state (+ sttrm_state_attribute)
// rows, and sttrm_state_transition rows with their sttrm_transition_condition
// (+ sttrm_transition_condition_field) rows.

import type { FluentValue } from "../evaluate";
import { isGUID } from "../keys";
import { CData, type CompiledRecord } from "../record";
import { lookup, roleRecord, type ArtefactSpec, type BuildContext, type Options } from "./shared";

const MODEL_TABLE_BY_TARGET: Record<string, string> = {
  change_request: "chg_model",
  problem: "prb_model",
  problem_task: "prb_task_model",
};

const DEFAULT_FLAG_BY_MODEL_TABLE: Record<string, string> = {
  chg_model: "default_change_model",
  prb_model: "default_prb_model",
  prb_task_model: "default_prb_task_model",
};

const DEFAULT_CONDITION_SCRIPT =
  "(function (current) {\n    // This function should return a true/false value to determine if the condition has passed or not\n    // Do NOT use: gs.addErrorMessage, gs.addInfoMessage because evaluation of transition conditions happens frequently and in multiple different channels so should not contain UI specific code e.g. REST, Flow.\n})(current);";

const CONDITION_TYPE_BY_NAME: Record<string, string> = {
  "Transition Condition": "325636985303101034d1ddeeff7b12ed",
  "Transition Script": "eb8676985303101034d1ddeeff7b1291",
  Authorized: "f6ec3dd4736b10108ef62d2b04f6a72e",
  "Mandatory Fields": "532c46339f901210ac2fe02e2b0a1cd2",
  "Not On hold": "7a790272c303101035ae3f52c1d3aeae",
  "Risk evaluation": "b11e0a59ff222210ec80ffffffffffed",
  "Task has been through Approval": "da0596ef5323101034d1ddeeff7b12e6",
  "Task is Approved": "7d160f945303101034d1ddeeff7b12cb",
  "Task is Rejected": "2ac5b9aac30f101035ae3f52c1d3ae48",
};

const ATTRIBUTE_BY_NAME: Record<string, string> = {
  allowImplementation: "2ca2cbd5ff2031107f54ffffffffff6c",
  allowCiModification: "9fbfd18affa431107f54ffffffffff03",
};

const USER_CRITERIA_TABLES: [string, string][] = [
  ["availableFor", "sttrm_model_user_criteria_read_mtom"],
  ["writableFor", "sttrm_model_user_criteria_write_mtom"],
  ["notAvailableFor", "sttrm_model_user_criteria_hide_mtom"],
];

const STATE_PROPERTIES = ["$id", "label", "value", "sequence", "initial", "attributes"];
const TRANSITION_PROPERTIES = ["$id", "from", "to", "automatic", "conditions"];
const CONDITION_PROPERTIES = ["$id", "name", "condition", "conditionScript", "conditionType", "active", "order", "description", "fields"];

/** read_roles / write_roles: role names or Role() records, comma-separated as given. */
function joinRoles(o: Options, ctx: BuildContext, key: string): string {
  const names = (o.array(key) ?? []).map((item) => {
    if (item.kind === "string") return item.value;
    if (item.kind === "call") return roleRecord(o, ctx, item, key).name;
    return o.error(`StateModel(): '${key}' must hold role names or Role() records.`, item);
  });
  return names.filter(Boolean).join(",");
}

/** templateApprovalUsers / templateApprovalGroups: sys_ids or records, comma-separated. */
function guidList(o: Options, ctx: BuildContext, key: string, table: string): string {
  const ids: string[] = [];
  (o.array(key) ?? []).forEach((item, index) => {
    if (item.kind === "call") ids.push(ctx.recordOf(item).id.getValue());
    else if (item.kind !== "string") o.error(`StateModel(): '${key}' must hold sys_ids or records.`, item);
    else if (isGUID(item.value)) ids.push(item.value);
    else ctx.report("error", `'${key}[${index}]' must be a valid GUID or a Record<'${table}'>. Received: '${item.value}'`, item.loc);
  });
  return ids.join(",");
}

function userCriterion(o: Options, ctx: BuildContext, key: string, item: FluentValue): string | CompiledRecord {
  if (item.kind === "string") return item.value;
  if (item.kind === "call") return ctx.recordOf(item);
  return o.error(`StateModel(): '${key}' must hold sys_ids or Record<'user_criteria'> records.`, item);
}

function attributeRecords(state: Options, ctx: BuildContext, stateRecord: CompiledRecord): CompiledRecord[] {
  const records: CompiledRecord[] = [];
  for (const item of state.array("attributes") ?? []) {
    const attribute = state.sub(item, "attributes[].", ["$id", "attribute", "active"]);
    const nameOrId = attribute.string("attribute");
    const active = attribute.boolean("active") ?? true;
    if (!nameOrId) continue;
    const id = lookup(ATTRIBUTE_BY_NAME, nameOrId) ?? (isGUID(nameOrId) ? nameOrId : undefined);
    if (!id) {
      ctx.report(
        "error",
        `Unknown state attribute '${nameOrId}'. Use one of: ${Object.keys(ATTRIBUTE_BY_NAME).join(", ")} — or an sttrm_attribute sys_id.`,
        item.loc,
      );
      continue;
    }
    records.push(
      ctx.factory.createRecord({
        table: "sttrm_state_attribute",
        source: item.loc,
        installCategory: "update",
        explicitId: attribute.explicitId(),
        fields: { sttrm_state: stateRecord, sttrm_attribute: id, active },
      }),
    );
  }
  return records;
}

function conditionRecords(cond: Options, ctx: BuildContext, transition: CompiledRecord): CompiledRecord[] {
  const name = cond.string("name") ?? "";
  const query = cond.string("condition");
  const script = cond.string("conditionScript");
  if (query && script !== undefined) {
    ctx.report("error", `Condition '${name}' sets both 'condition' and 'conditionScript' — they are mutually exclusive.`, cond.get("condition")!.loc);
  }
  const type = cond.string("conditionType");
  let typeId = "";
  if (type) {
    typeId = lookup(CONDITION_TYPE_BY_NAME, type) ?? (isGUID(type) ? type : "");
    if (!typeId) {
      ctx.report(
        "error",
        `Unknown conditionType '${type}'. Use one of: ${Object.keys(CONDITION_TYPE_BY_NAME).join(", ")} — or an sttrm_condition_type sys_id.`,
        cond.get("conditionType")!.loc,
      );
    }
  }
  const record = ctx.factory.createRecord({
    table: "sttrm_transition_condition",
    source: cond.object.loc,
    installCategory: "update",
    explicitId: cond.explicitId(),
    fields: {
      sttrm_state_transition: transition,
      name,
      condition: query ?? "",
      condition_script: script === undefined ? DEFAULT_CONDITION_SCRIPT : new CData(script),
      condition_type: typeId,
      active: cond.boolean("active") ?? true,
      order: cond.number("order") ?? 100,
      description: cond.string("description") ?? "",
    },
  });
  const records = [record];
  for (const item of cond.array("fields") ?? []) {
    const field = cond.sub(item, "fields[].", ["$id", "name"]);
    const fieldName = field.string("name");
    if (!fieldName) continue;
    records.push(
      ctx.factory.createRecord({
        table: "sttrm_transition_condition_field",
        source: item.loc,
        installCategory: "update",
        explicitId: field.explicitId(),
        fields: { transition_condition: record, name: fieldName },
      }),
    );
  }
  return records;
}

export const stateModel: ArtefactSpec = {
  properties: [
    "name",
    "table",
    "stateField",
    "active",
    "advancedSecurity",
    "readRoles",
    "writeRoles",
    "availableFor",
    "writableFor",
    "notAvailableFor",
    "templateProposalAccess",
    "templateApprovalUsers",
    "templateApprovalGroups",
    "availableInUI",
    "defaultModel",
    "description",
    "taskType",
    "recordPreset",
    "color",
    "itilChangeProcess",
    "states",
    "transitions",
  ],
  build(o, ctx) {
    const target = o.string("table") ?? "";
    const modelTable = lookup(MODEL_TABLE_BY_TARGET, target) ?? "sttrm_model";
    const isChange = modelTable === "chg_model";
    const isProblemTask = modelTable === "prb_task_model";
    const defaultFlag = lookup(DEFAULT_FLAG_BY_MODEL_TABLE, modelTable);
    const hint = (key: string, message: string) => {
      const value = o.get(key);
      if (value !== undefined) ctx.report("hint", message, value.loc);
    };

    const statesValue = o.get("states");
    if (statesValue !== undefined && statesValue.kind !== "object") return o.error("StateModel(): 'states' must be an object.", statesValue);
    const stateEntries = [...(statesValue?.props ?? [])].map(([key, value]) => [key, o.sub(value, `states.${key}.`, STATE_PROPERTIES)] as const);
    const states = new Map(stateEntries);
    const transitions = (o.array("transitions") ?? []).map((item) => o.sub(item, "transitions[].", TRANSITION_PROPERTIES));
    for (const transition of transitions) {
      for (const endpoint of ["from", "to"]) {
        const key = transition.string(endpoint);
        if (key && !states.has(key)) {
          ctx.report("error", `Transition '${endpoint}' references state '${key}' which is not defined in 'states'.`, transition.get(endpoint)!.loc);
        }
      }
    }

    if (!isChange) {
      for (const key of ["availableInUI", "recordPreset", "color", "itilChangeProcess"]) {
        hint(key, `'${key}' applies only to change_request (chg_model) state models and is ignored for table '${target}'.`);
      }
    }
    if (!isProblemTask) hint("taskType", `'taskType' applies only to problem_task (prb_task_model) state models and is ignored for table '${target}'.`);
    if (!defaultFlag) hint("defaultModel", `'defaultModel' is not supported for the base sttrm_model and is ignored for table '${target}'.`);
    if (modelTable === "sttrm_model") {
      hint(
        "description",
        `'description' is stored only on subclass model tables (chg_model / prb_model / prb_task_model) and is ignored for table '${target}'.`,
      );
    }
    const advancedSecurity = o.boolean("advancedSecurity");
    if (!advancedSecurity) {
      for (const [key] of USER_CRITERIA_TABLES) hint(key, `'${key}' only takes effect when 'advancedSecurity' is enabled.`);
    }

    const recordPreset = o.string("recordPreset") ?? "";
    const model = ctx.factory.createRecord({
      table: modelTable,
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name") ?? "",
        table_name: target,
        state_field: o.string("stateField") ?? "state",
        active: o.boolean("active") ?? true,
        advanced_security: advancedSecurity ?? false,
        read_roles: joinRoles(o, ctx, "readRoles"),
        write_roles: joinRoles(o, ctx, "writeRoles"),
        template_proposal_access: o.string("templateProposalAccess") ?? "",
        template_approval_users: guidList(o, ctx, "templateApprovalUsers", "sys_user"),
        template_approval_groups: guidList(o, ctx, "templateApprovalGroups", "sys_user_group"),
        ...(isChange
          ? {
              available_in_ui: o.boolean("availableInUI") ?? true,
              record_preset: recordPreset,
              apply_record_preset: recordPreset !== "",
              color: o.string("color") ?? "",
              itil_change_process: o.string("itilChangeProcess") ?? "",
            }
          : {}),
        ...(isProblemTask ? { prb_task_type: o.string("taskType") ?? "" } : {}),
        ...(defaultFlag ? { [defaultFlag]: o.boolean("defaultModel") ?? false, description: o.string("description") ?? "" } : {}),
      },
    });

    for (const [key, table] of USER_CRITERIA_TABLES) {
      for (const item of o.array(key) ?? []) {
        model.children.push(
          ctx.factory.createRecord({
            table,
            source: item.loc,
            installCategory: "update",
            fields: { sttrm_model: model, user_criteria: userCriterion(o, ctx, key, item) },
          }),
        );
      }
    }

    const stateRecords = new Map<string, CompiledRecord>();
    for (const [key, state] of states) {
      const record = ctx.factory.createRecord({
        table: "sttrm_state",
        source: state.object.loc,
        installCategory: "update",
        explicitId: state.explicitId(),
        fields: {
          sttrm_model: model,
          state_label: state.string("label") ?? "",
          state_value: state.scalar("value") ?? "",
          state_sequence: state.number("sequence") ?? 0,
          initial_state: state.boolean("initial") ?? false,
        },
      });
      stateRecords.set(key, record);
      model.children.push(record, ...attributeRecords(state, ctx, record));
    }

    for (const transition of transitions) {
      const fromKey = transition.string("from") ?? "";
      const toKey = transition.string("to") ?? "";
      const from = stateRecords.get(fromKey);
      const to = stateRecords.get(toKey);
      if (!from || !to) continue;
      const record = ctx.factory.createRecord({
        table: "sttrm_state_transition",
        source: transition.object.loc,
        installCategory: "update",
        explicitId: transition.explicitId(),
        fields: {
          from_state: from,
          to_state: to,
          automatic: transition.boolean("automatic") ?? false,
          name: `${String(from.fields.get("state_label"))} to ${String(to.fields.get("state_label"))}`,
        },
      });
      model.children.push(record);
      for (const item of transition.array("conditions") ?? []) {
        model.children.push(...conditionRecords(transition.sub(item, "conditions[].", CONDITION_PROPERTIES), ctx, record));
      }
    }
    return model;
  },
};
