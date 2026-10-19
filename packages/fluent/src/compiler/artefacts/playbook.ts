// SPDX-License-Identifier: GPL-3.0-or-later
//
// PlaybookDefinition() → one composite sys_pd_process_definition file, as the
// SDK's PlaybookPlugin writes it: delete_multiple clean-ups of the lanes,
// activities and variants the playbook no longer declares, the playbook, each
// lane followed by its activities (each with a sys_variable_value and a
// sys_element_mapping per input and experience property), the triggers with
// their input values, and the parent-record process input.
//
// This first slice compiles record-driven playbooks with record triggers,
// Run.Immediately()/Run.After() start rules and the Instruction and Two Step
// Instruction activities; everything else is an error rather than a guess.

import type { FluentAutomation, FluentValue } from "../evaluate";
import { RecordId, type CompiledRecord, type FieldValue } from "../record";
import { element } from "./list";
import { lookup, Options, type ArtefactSpec, type BuildContext } from "./shared";

const INSERT = 'action="INSERT_OR_UPDATE" apply_defaults="true"';
/** The sys_id of the "Standard playbook" process type. */
const STANDARD_PROCESS_TYPE = "52c6d3eeff1be2102c2fffffffffff44";
const PROCESS_INPUT_ATTRIBUTES = "element_mapping_provider=com.snc.pd.designer.elementmapping.PlaybookInputElementMapper";
const RESTARTABLE = ["RESTARTABLE_TRUE", "RESTARTABLE_FALSE"];
const RESTART_RULES = ["RUN_ALWAYS", "RUN_ONLY_ONCE", "RUN_ONLY_ON_RESTART"];
const UNSUPPORTED = "is not supported by the native compiler yet";

/** SDK options this slice does not compile yet; using one is an error, not an unknown property. */
const PLAYBOOK_UNSUPPORTED = [
  "allowAsNested",
  "access",
  "publicAccess",
  "runStrategy",
  "executionType",
  "processType",
  "evaluateVariantChildrenAfter",
  "dataRetentionPeriodOverride",
  "snapshot",
  "designerState",
  "nowAssistPrompt",
  "nowAssistKb",
  "copiedFrom",
  "copiedFromLabel",
  "launcherTitle",
  "launcherDescription",
  "launcherShowRecordForm",
  "launcherRecordFormView",
  "launcherTemplateFields",
  "launcherInputs",
  "active",
  "status",
  "schemaVersion",
  "inputs",
  "outputs",
];
const LANE_UNSUPPORTED = ["conditionToRun", "startWithDelay", "permissions"];
const ACTIVITY_UNSUPPORTED = [
  "conditionToRun",
  "startWithDelay",
  "actionOverrides",
  "variant",
  "variantOverrides",
  "enableAiAgent",
  "aiAgentExecutionMode",
  "aiAgentObjective",
  "aiAgentObjAdditionalDetail",
  "aiAgentRunWithRoles",
  "aiAgentSupportedActions",
  "aiAgentRunAs",
  "aiAgentUser",
  "conversationalAgents",
  "launchAgentWhenActivityStart",
];

interface TriggerType {
  sysId: string;
  /** Input name → its sys_hub_trigger_input sys_id. */
  inputs: Record<string, string>;
}

const TRIGGER_TYPES: Record<string, TriggerType> = {
  RecordCreate: {
    sysId: "ab6951170f1200108c87f4f0ff767e4f",
    inputs: {
      table: "a8ae38d1ff2200108c8733af793bf15c",
      condition: "2a8a7851ff2200108c8733af793bf131",
      runTriggerOnExtendedTables: "38c838790f0010108c87f4f0ff767e5a",
    },
  },
  RecordUpdate: {
    sysId: "b08951170f1200108c87f4f0ff767e54",
    inputs: {
      table: "82be38d1ff2200108c8733af793bf1a7",
      condition: "52ce78d1ff2200108c8733af793bf1b3",
      runTrigger: "ea38f4790f0010108c87f4f0ff767edb",
      runTriggerOnExtendedTables: "fb1af07d0f0010108c87f4f0ff767e00",
      triggerOnUniqueChange: "506eded1a3d312104818f363041e61b1",
    },
  },
  RecordCreateOrUpdate: {
    sysId: "789911170f1200108c87f4f0ff767e27",
    inputs: {
      table: "28eef8d1ff2200108c8733af793bf14a",
      condition: "610f3cd1ff2200108c8733af793bf11d",
      runTrigger: "0e12b4790f0010108c87f4f0ff767e90",
      runTriggerOnExtendedTables: "726a747d0f0010108c87f4f0ff767e4b",
      triggerOnUniqueChange: "6fc42b59a35712104818f363041e6179",
    },
  },
};

interface ActivityType {
  sysId: string;
  /** Experience properties in the type's order: name → [variable sys_id, column default]. */
  properties: [string, string, string | undefined][];
}

const INSTRUCTIONAL: ActivityType = {
  sysId: "d4dde0875b00001070e4492c11f91a90",
  properties: [
    ["associated_record", "eb0474b8c763001085f5532bb4c260f5", undefined],
    ["associated_table", "78f334b8c763001085f5532bb4c26009", "sys_flow_data"],
    ["description", "267e68875b00001070e4492c11f91a34", undefined],
    ["experience_status_record", "55628762c3211010381b60bc0eba8fec", undefined],
    ["experience_status_table", "9c6b7e22c3211010381b60bc0eba8f98", "sys_flow_data"],
    ["footer", "8793d6feb70100101a6ddb91de11a98f", undefined],
    ["icon", "24bdf44673030010fe4a6da44cf6a707", undefined],
    ["is_automated", "ec5d96eac7e60010bfbaf89f51c2605d", undefined],
    ["tagline", "661d304673030010fe4a6da44cf6a7b1", undefined],
    ["title", "49ed24875b00001070e4492c11f91aa5", undefined],
  ],
};

interface ActivityDefinition {
  sysId: string;
  /** The backing flow, whose inputs the activity's inputs map to. */
  flowId: string;
  type: ActivityType;
  /** Input name → its sys_hub_flow_input sys_id. */
  inputs: Record<string, string>;
  /** Input values the definition sets when the activity does not, in the definition's order. */
  defaultInputs: [string, string][];
  /** Experience property defaults of the definition, over the type's column defaults. */
  experience: Record<string, string>;
}

/** The experience defaults of an instruction backed by the flow `flow`. */
function instructionExperience(flow: string, description: string, automated: string): Record<string, string> {
  const record = `{{vl.${flow}.e17e6678-8e97-4584-a903-cfa6e47fd378./end.record}}`;
  return {
    associated_record: record,
    associated_table: "sys_flow_data",
    description,
    experience_status_record: record,
    icon: "circle_info_outline",
    is_automated: automated,
    tagline: "Instructional",
    title: "{{act.act_instance.label}}",
  };
}

const ACTIVITY_DEFINITIONS: Record<string, ActivityDefinition> = {
  "Core.Instruction": {
    sysId: "b0c35e2b1b630010affd0e55cc4bcbca",
    flowId: "2b8b42e31b630010affd0e55cc4bcbe9",
    type: INSTRUCTIONAL,
    inputs: { message: "6c9c4ee31b630010affd0e55cc4bcbbf", wait: "c23322e91bbb001094630f28cc4bcbae" },
    defaultInputs: [
      ["message", "{{act.act_instance.description}}"],
      ["wait", "yes"],
    ],
    experience: instructionExperience(
      "Simple Instruction",
      "{{vl.Simple Instruction./start.message}}",
      "{{vl.Simple Instruction./start.automated}}",
    ),
  },
  "Core.TwoStepInstruction": {
    sysId: "d8f4d66b1b630010affd0e55cc4bcbc7",
    flowId: "a7cd02671b630010affd0e55cc4bcbd1",
    type: INSTRUCTIONAL,
    inputs: {
      assignment_group: "f8b3aae91bbb001094630f28cc4bcb2b",
      assigned_to: "ffcd02671b630010affd0e55cc4bcbdf",
      initial_message: "a73fce671b630010affd0e55cc4bcbbb",
      completed_message: "233fce671b630010affd0e55cc4bcbcd",
      skipped_message: "e33fce671b630010affd0e55cc4bcbd2",
    },
    defaultInputs: [
      ["assigned_to", "{{pd.inputRecord.assigned_to}}"],
      ["assignment_group", "{{pd.inputRecord.assignment_group}}"],
    ],
    experience: instructionExperience("Two Step Instruction", "{{vl.Two Step Instruction./end.message}}", "0"),
  },
};

/** The SDK's slugifyString: a label as a lowercase identifier. */
export function slugify(value: string): string {
  const slug = value
    .trim()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (/^[0-9]/.test(slug) ? `_${slug}` : slug).toLowerCase();
}

/** The SDK's deduplicateNames: explicit names claim theirs first, the others get `_1`, `_2`, … on a clash. */
export function deduplicateNames(entries: { name: string; isExplicit: boolean }[]): string[] {
  const used = new Set<string>();
  const result: string[] = new Array<string>(entries.length);
  const claim = (index: number): void => {
    const base = entries[index].name;
    let name = base;
    for (let n = 1; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    result[index] = name;
  };
  entries.forEach((e, i) => e.isExplicit && claim(i));
  entries.forEach((e, i) => !e.isExplicit && claim(i));
  return result;
}

function isPill(value: string): boolean {
  return /\{\{.*\}\}/.test(value);
}

function text(value: FieldValue): string {
  return value instanceof RecordId ? value.getValue() : String(value);
}

function recordLines(record: CompiledRecord, ctx: BuildContext): string[] {
  const lines = [
    `  <${record.table} ${INSERT}>`,
    element("    ", "sys_id", record.id.getValue()),
    element("    ", "sys_scope", ctx.scopeId, { display_value: ctx.scope }),
    element("    ", "sys_update_name", text(record.fields.get("sys_update_name"))),
  ];
  const names = [...record.fields.keys()].filter((k) => k !== "sys_scope" && k !== "sys_update_name").sort();
  for (const name of names) lines.push(element("    ", name, text(record.fields.get(name))));
  lines.push(`  </${record.table}>`);
  return lines;
}

/** One automation call of `path` (`playbook.lane`), or an error naming what was expected. */
function automation(o: Options, value: FluentValue | undefined, path: string, what: string): FluentAutomation {
  if (value?.kind !== "automation" || value.path.join(".") !== path) {
    return o.error(`PlaybookDefinition(): ${what} must be a wfa.${path}() call.`, value);
  }
  return value;
}

/** The object a `lanes`/`activities` function returns. */
function returnedEntries(o: Options, value: FluentValue | undefined, key: string): FluentValue[] {
  if (value?.kind !== "function") return o.error(`PlaybookDefinition(): '${key}' must be a function returning an object.`, value);
  if (value.body.kind !== "object") return o.error(`PlaybookDefinition(): '${key}' must return an object literal.`, value.body);
  return [...value.body.props.values()];
}

/** Rejects the SDK options this slice does not compile. */
function rejectUnsupported(o: Options, keys: readonly string[], owner: string): void {
  for (const key of keys) {
    const value = o.get(key);
    if (value !== undefined) o.error(`PlaybookDefinition(): ${owner} '${key}' ${UNSUPPORTED}.`, value);
  }
}

function restartRule(o: Options): string {
  const rule = o.string("restartRule") ?? "RUN_ONLY_ONCE";
  if (!RESTART_RULES.includes(rule)) o.error(`PlaybookDefinition(): '${o.path}restartRule' must be ${RESTART_RULES.map((r) => `'${r}'`).join(", ")}.`, o.get("restartRule"));
  return rule;
}

interface StartRule {
  rule: "immediate" | "after_items";
  after: FluentAutomation[];
}

function startRule(o: Options, fallback: boolean): StartRule {
  const value = o.get("startRule");
  if (value === undefined && fallback) return { rule: "immediate", after: [] };
  if (value?.kind !== "automation" || value.path.slice(0, 2).join(".") !== "playbook.run" || value.path.length !== 3) {
    return o.error(`PlaybookDefinition(): '${o.path}startRule' must be wfa.playbook.run.Immediately() or wfa.playbook.run.After(...).`, value);
  }
  const kind = value.path[2];
  if (kind === "Immediately") return { rule: "immediate", after: [] };
  if (kind !== "After") return o.error(`PlaybookDefinition(): wfa.playbook.run.${kind}() ${UNSUPPORTED}.`, value);
  const after = value.args.map((arg) =>
    arg.kind === "automation" ? arg : o.error("PlaybookDefinition(): wfa.playbook.run.After() takes lanes and activities.", arg),
  );
  if (after.length === 0) o.error("PlaybookDefinition(): wfa.playbook.run.After() needs at least one lane or activity.", value);
  return { rule: "after_items", after };
}

/** The ids of the `after` dependencies, which must be among `siblings`. */
function dependencyIds(o: Options, rule: StartRule, siblings: Map<FluentAutomation, CompiledRecord>, what: string): string {
  return rule.after
    .map((dep) => {
      const record = siblings.get(dep);
      if (!record) return o.error(`PlaybookDefinition(): wfa.playbook.run.After() must reference ${what}.`, dep);
      return record.id.getValue();
    })
    .join(",");
}

function checkOrders(entries: { config: Options; order: number; label: string }[]): void {
  const seen = new Map<number, string>();
  for (const { config, order, label } of entries) {
    const prior = seen.get(order);
    if (prior !== undefined) config.error(`Duplicate order ${order}: '${label}' and '${prior}' share order ${order}`, config.get("order"));
    seen.set(order, label);
  }
}

/** A string input or experience value; pills in values are not compiled yet. */
function staticValue(o: Options, key: string): string {
  const value = o.get(key)!;
  if (value.kind !== "string") return o.error(`PlaybookDefinition(): '${o.path}${key}' must be a string.`, value);
  if (isPill(value.value)) o.error(`PlaybookDefinition(): data pills in '${o.path}${key}' are ${UNSUPPORTED.slice(3)}.`, value);
  return value.value;
}

interface Mapping {
  field: string;
  variable: string;
  table: string;
  /** The static value, written by the variable value. */
  value: string;
  /** The pill, written by the element mapping. */
  pill: string;
}

function mapping(field: string, variable: string, table: string, value: string, activityId: string): Mapping {
  return isPill(value)
    ? { field, variable, table, value: "", pill: value.replaceAll("{{act.act_instance.", `{{act.${activityId}.`) }
    : { field, variable, table, value, pill: "" };
}

/** The keys of `o` with a value, in source order. */
function presentKeys(o: Options | undefined): string[] {
  return o ? [...o.object.props.keys()].filter((key) => o.get(key) !== undefined) : [];
}

/** The input and experience mappings of an activity, in the SDK's order. */
function activityMappings(def: ActivityDefinition, inputs: Options | undefined, experience: Options | undefined, activityId: string): Mapping[] {
  const inputTable = `var__m_sys_hub_flow_input_${def.flowId}`;
  const typeTable = `var__m_sys_pd_activity_type_prop_${def.type.sysId}`;
  const result: Mapping[] = [];
  const given = new Set<string>();
  for (const key of presentKeys(inputs)) {
    given.add(key);
    result.push({ field: key, variable: def.inputs[key], table: inputTable, value: staticValue(inputs!, key), pill: "" });
  }
  for (const [key, value] of def.defaultInputs) {
    if (!given.has(key)) result.push(mapping(key, def.inputs[key], inputTable, value, activityId));
  }
  const set = new Set<string>();
  for (const key of presentKeys(experience)) {
    set.add(key);
    const [, variable] = def.type.properties.find(([name]) => name === key)!;
    result.push({ field: key, variable, table: typeTable, value: staticValue(experience!, key), pill: "" });
  }
  for (const [name, variable, fallback] of def.type.properties) {
    const value = lookup(def.experience, name) ?? fallback;
    if (!set.has(name) && value !== undefined) result.push(mapping(name, variable, typeTable, value, activityId));
  }
  return result;
}

/** An options object of an automation call argument. */
function argOptions(o: Options, value: FluentValue | undefined, path: string, properties: readonly string[], required = true, what = `'${path.replace(/\.$/, "")}'`): Options | undefined {
  if (value === undefined && !required) return undefined;
  if (value?.kind !== "object") return o.error(`PlaybookDefinition(): ${what} must be an object.`, value);
  return o.sub(value, path, properties);
}

interface Built {
  playbook: CompiledRecord;
  /** Records in file order, after the playbook. */
  body: CompiledRecord[];
  laneIds: string[];
  activityIds: string[];
}

function createChild(o: Options, ctx: BuildContext, table: string, fields: Record<string, FieldValue | CompiledRecord>, source: FluentValue, explicitId?: string | number): CompiledRecord {
  return ctx.factory.createRecord({ table, source: source.loc, installCategory: o.installCategory, explicitId, emit: false, fields });
}

function buildActivities(o: Options, ctx: BuildContext, laneOptions: Options, laneRecord: CompiledRecord, playbook: CompiledRecord, built: Built): void {
  const activities = returnedEntries(laneOptions, laneOptions.get("activities"), `${laneOptions.path}activities`).map((value, i) => {
    const call = automation(o, value, "playbook.activity", `'${laneOptions.path}activities' entries`);
    const [defRef, configValue, inputsValue, experienceValue] = call.args;
    if (call.args.length > 4) o.error("PlaybookDefinition(): wfa.playbook.activity() takes a definition, a config, inputs and experience properties.", call);
    const key = defRef?.kind === "sdkRef" && defRef.name === "ActivityDefinitions" ? defRef.path.join(".") : undefined;
    if (key === undefined) o.error("PlaybookDefinition(): an activity's definition must be an ActivityDefinitions.* entry.", defRef ?? call);
    const def = lookup(ACTIVITY_DEFINITIONS, key);
    if (!def) o.error(`PlaybookDefinition(): the activity definition ActivityDefinitions.${key} ${UNSUPPORTED}.`, defRef);
    const path = `${laneOptions.path}activities[${i}].`;
    const config = argOptions(o, configValue, path, ["$id", "label", "name", "order", "description", "startRule", "restartRule", ...ACTIVITY_UNSUPPORTED])!;
    rejectUnsupported(config, ACTIVITY_UNSUPPORTED, "activity");
    const order = config.number("order");
    if (order === undefined) return config.error(`PlaybookDefinition(): '${path}order' is required.`);
    const label = config.requiredString("label");
    const name = config.string("name");
    return { call, def, config, order, label, name, explicit: config.explicitId(), inputsValue, experienceValue, path };
  });
  checkOrders(activities);
  const names = deduplicateNames(activities.map((a) => (a.name ? { name: a.name, isExplicit: true } : { name: slugify(a.label), isExplicit: false })));
  const records = new Map<FluentAutomation, CompiledRecord>();
  const rules = activities.map((a) => startRule(a.config, false));
  for (const a of activities) records.set(a.call, createChild(o, ctx, "sys_pd_activity", {}, a.call, a.explicit));
  activities.forEach((a, i) => {
    const record = records.get(a.call)!;
    const fields: Record<string, FieldValue> = {
      active: true,
      activity_definition: a.def.sysId,
      ai_agent_execution_mode: "",
      ai_agent_obj_additional_detail: "",
      ai_agent_objective: "",
      ai_agent_run_as: "",
      ai_agent_run_with_roles: "",
      ai_agent_supported_actions: "",
      ai_agent_user: "",
      condition_to_run: "",
      conversational_agents: "",
      description: a.config.string("description") ?? "",
      enable_ai_agent: "",
      label: a.label,
      lane: laneRecord.id,
      launch_agent_when_activity_start: "",
      name: names[i],
      order: a.order,
      process_definition: playbook.id,
      restart_rule: restartRule(a.config),
      start_rule_name: rules[i].rule,
      starts_after_activities: dependencyIds(a.config, rules[i], records, "activities of the same lane"),
      starts_after_branches: "",
      starts_after_lanes: "",
      variant: "",
    };
    for (const [k, v] of Object.entries(fields)) record.fields.set(k, v);
    built.activityIds.push(record.id.getValue());
    built.body.push(record);
    const inputs = argOptions(o, a.inputsValue, `${a.path}inputs.`, Object.keys(a.def.inputs), false);
    const experience = argOptions(o, a.experienceValue, `${a.path}experienceProperties.`, a.def.type.properties.map(([n]) => n), false);
    for (const m of activityMappings(a.def, inputs, experience, record.id.getValue())) {
      built.body.push(
        createChild(o, ctx, "sys_variable_value", { document: "sys_pd_activity", document_key: record, value: m.value, variable: m.variable }, a.call),
        createChild(o, ctx, "sys_element_mapping", { field: m.field, id: record, table: m.table, value: m.pill }, a.call),
      );
    }
  });
}

function buildLanes(o: Options, ctx: BuildContext, body: Options, playbook: CompiledRecord, built: Built): void {
  const lanes = returnedEntries(body, body.get("lanes"), "lanes").map((value, i) => {
    const call = automation(o, value, "playbook.lane", "a lane");
    if (call.args.length !== 1) o.error("PlaybookDefinition(): wfa.playbook.lane() takes one object.", call);
    const lane = argOptions(o, call.args[0], `lanes[${i}].`, ["config", "activities"])!;
    const config = lane.nested("config", ["$id", "label", "name", "order", "description", "startRule", "restartRule", ...LANE_UNSUPPORTED]);
    if (!config) return o.error(`PlaybookDefinition(): 'lanes[${i}].config' is required.`, call);
    rejectUnsupported(config, LANE_UNSUPPORTED, "lane");
    const label = config.requiredString("label");
    return { call, lane, config, order: config.number("order") ?? 1, label, name: config.string("name"), explicit: config.explicitId() };
  });
  checkOrders(lanes);
  const names = deduplicateNames(lanes.map((l) => (l.name ? { name: l.name, isExplicit: true } : { name: slugify(l.label), isExplicit: false })));
  const records = new Map<FluentAutomation, CompiledRecord>();
  for (const l of lanes) records.set(l.call, createChild(o, ctx, "sys_pd_lane", {}, l.call, l.explicit));
  lanes.forEach((l, i) => {
    const record = records.get(l.call)!;
    const rule = startRule(l.config, true);
    const fields: Record<string, FieldValue> = {
      active: true,
      condition_to_run: "",
      description: l.config.string("description") ?? "",
      label: l.label,
      name: names[i],
      order: l.order,
      permission: "{}",
      process_definition: playbook.id,
      restart_rule: restartRule(l.config),
      start_rule: rule.rule,
      start_rule_name: rule.rule,
      starts_after_activities: "",
      starts_after_branches: "",
      starts_after_lanes: dependencyIds(l.config, rule, records, "other lanes of the playbook"),
    };
    for (const [k, v] of Object.entries(fields)) record.fields.set(k, v);
    built.laneIds.push(record.id.getValue());
    built.body.push(record);
    buildActivities(o, ctx, l.lane, record, playbook, built);
  });
}

function buildTriggers(o: Options, ctx: BuildContext, dependent: Options, playbook: CompiledRecord, parentTable: string | undefined, processInput: CompiledRecord | undefined): CompiledRecord[] {
  const result: CompiledRecord[] = [];
  for (const [i, value] of (dependent.array("triggers") ?? []).entries()) {
    const call = automation(o, value, "playbook.trigger", `'triggers[${i}]'`);
    const [typeRef, configValue, inputsValue] = call.args;
    if (call.args.length > 3) o.error("PlaybookDefinition(): wfa.playbook.trigger() takes a trigger type, a config and inputs.", call);
    const typeName = typeRef?.kind === "sdkRef" && typeRef.name === "PlaybookTriggerTypes" ? typeRef.path.join(".") : undefined;
    if (typeName === undefined) o.error("PlaybookDefinition(): a trigger's type must be a PlaybookTriggerTypes.* entry.", typeRef ?? call);
    const type = lookup(TRIGGER_TYPES, typeName);
    if (!type) o.error(`PlaybookDefinition(): the trigger type PlaybookTriggerTypes.${typeName} ${UNSUPPORTED}.`, typeRef);
    const config = argOptions(o, configValue, `triggers[${i}].`, ["$id", "label"])!;
    const label = config.string("label") ?? "";
    const inputs = argOptions(o, inputsValue, `triggers[${i}].inputs.`, Object.keys(type.inputs))!;
    const table = inputs.requiredString("table");
    if (parentTable !== undefined && table !== parentTable) {
      inputs.error(`PlaybookDefinition(): a trigger on a table other than 'parentTable' needs a mapper, which ${UNSUPPORTED}.`, inputs.get("table"));
    }
    const trigger = createChild(
      o,
      ctx,
      "sys_pd_trigger_instance",
      {
        label,
        name: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
        process_definition: playbook,
        trigger_type: type.sysId,
      },
      call,
      config.explicitId(),
    );
    result.push(trigger);
    for (const key of inputs.object.props.keys()) {
      const v = inputs.scalar(key);
      if (v === undefined) continue;
      result.push(
        createChild(o, ctx, "sys_variable_value", { document: "sys_pd_trigger_instance", document_key: trigger, value: v, variable: type.inputs[key] }, call),
      );
    }
    if (processInput) {
      result.push(
        createChild(
          o,
          ctx,
          "sys_element_mapping",
          { field: "parent_record", id: trigger, table: `var__m_sys_pd_process_input_${playbook.id.getValue()}`, value: "{{triggerRecord}}" },
          call,
        ),
        createChild(o, ctx, "sys_variable_value", { document: "sys_pd_trigger_instance", document_key: trigger, value: "", variable: processInput }, call),
      );
    }
  }
  return result;
}

function deleteMultiple(table: string, playbookId: string, ids?: string[]): string {
  const query = ids ? `process_definition=${playbookId}^sys_idNOT IN${ids.join(",")}` : `process_definition=${playbookId}`;
  return `  <${table} action="delete_multiple" query="${query}"/>`;
}

export const playbookDefinition: ArtefactSpec = {
  properties: ["label", "name", "description", "restartable", "parentTable", ...PLAYBOOK_UNSUPPORTED],
  extraArguments: 2,
  extraArgumentsLabel: ", its triggers object and its lanes object",
  build(o, ctx) {
    if (o.call.args.length !== 3) o.error("PlaybookDefinition() takes one options object, its triggers object and its lanes object.");
    rejectUnsupported(o, PLAYBOOK_UNSUPPORTED, "config");
    for (const key of ["$override", "protectionPolicy"]) {
      if (o.get(key) !== undefined) o.error(`PlaybookDefinition(): '${key}' ${UNSUPPORTED}.`, o.get(key));
    }
    const [, dependentValue, bodyValue] = o.call.args;
    const dependent = argOptions(o, dependentValue, "", ["triggers", "permissions", "variants", "preservedAttachment"], true, "the triggers argument")!;
    rejectUnsupported(dependent, ["permissions", "variants", "preservedAttachment"], "dependent config");
    const body = argOptions(o, bodyValue, "", ["lanes"], true, "the lanes argument")!;
    const label = o.requiredString("label");
    const restartable = o.string("restartable") ?? "RESTARTABLE_FALSE";
    if (!RESTARTABLE.includes(restartable)) o.error("PlaybookDefinition(): 'restartable' must be 'RESTARTABLE_TRUE' or 'RESTARTABLE_FALSE'.", o.get("restartable"));
    const parentTable = o.string("parentTable");
    const playbook = ctx.factory.createRecord({
      table: "sys_pd_process_definition",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      emit: false,
      fields: {
        access: "public",
        active: true,
        allow_as_nested: false,
        copied_from: "",
        copied_from_label: "",
        data_retention_period_override: "6_week",
        description: o.string("description") ?? "",
        designer_state: "",
        engine_major_version: "",
        execution_type: "record_driven",
        label,
        launcher_description: "",
        launcher_record_form_view: "",
        launcher_show_record_form: false,
        launcher_template_fields: "",
        launcher_title: "",
        name: o.string("name") || slugify(label),
        now_assist_kb: "",
        now_assist_prompt: "",
        permission: "{}",
        process_type: STANDARD_PROCESS_TYPE,
        public_access: false,
        restartable,
        run_on_pad_engine: false,
        run_strategy: "run_once",
        run_strategy_on_process_definition: true,
        schema_version: 3,
        snapshot: "",
        start_non_blocking: true,
        status: "draft",
        view_type: "DIAGRAM",
      },
    });
    const pbId = playbook.id.getValue();
    const built: Built = { playbook, body: [], laneIds: [], activityIds: [] };
    buildLanes(o, ctx, body, playbook, built);
    const processInput =
      parentTable === undefined
        ? undefined
        : ctx.factory.createRecord({
            table: "sys_pd_process_input",
            source: o.call.loc,
            installCategory: o.installCategory,
            emit: false,
            fields: {
              active: true,
              attributes: PROCESS_INPUT_ATTRIBUTES,
              element: "parent_record",
              internal_type: "reference",
              label: "Parent record",
              mandatory: false,
              max_length: 32,
              model: pbId,
              model_id: pbId,
              model_table: "",
              name: `var__m_sys_pd_process_input_${pbId}`,
              order: 1,
              reference: parentTable,
            },
          });
    const triggers = buildTriggers(o, ctx, dependent, playbook, parentTable, processInput);
    const records = [...built.body, ...triggers, ...(processInput ? [processInput] : [])];
    playbook.children.push(...records);
    const lines = [
      '<?xml version="1.0"?>',
      '<record_update table="sys_pd_process_definition">',
      deleteMultiple("sys_pd_lane", pbId, built.laneIds),
      deleteMultiple("sys_pd_activity", pbId, built.activityIds),
      deleteMultiple("sys_pd_process_variant", pbId),
      ...[playbook, ...records].flatMap((r) => recordLines(r, ctx)),
      "</record_update>",
    ];
    ctx.emitFile(`${o.installCategory}/sys_pd_process_definition_${pbId}.xml`, lines.join("\n"));
    return playbook;
  },
};
