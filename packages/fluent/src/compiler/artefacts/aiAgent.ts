// SPDX-License-Identifier: GPL-3.0-or-later
//
// AiAgent(...) → the sn_aia_agent with its sn_aia_agent_config, an sn_aia_version
// per version (a draft one without versionDetails), the execute ACL of
// securityAcl (with its sys_security_acl_role records), the dataAccess
// sys_agent_access_role_configuration (and a sys_agent_access_role_mapping per
// roleMap role), an sn_aia_trigger_configuration and its
// sn_aia_trigger_agent_usecase_m2m per trigger, an sn_aia_agent_tool_m2m per
// tool (with an sn_aia_tool unless the tool is an out-of-the-box one) and an
// sn_aia_ltm_category_mapping per memory category.
//
// The native compiler covers tools whose inputs are an array: RAG, search
// retrieval and CRUD tools are not supported yet.

import { isGUID } from "../keys";
import type { FluentValue } from "../evaluate";
import { CData, type CompiledRecord, type CreateRecordOptions, type FieldValue, type RecordId } from "../record";
import { type ArtefactSpec, type BuildContext, lookup, type Options, roleRecord } from "./shared";

const AGENT_TABLE = "sn_aia_agent";
const REACT_STRATEGY = "f0bff21f9f13c6108f431597d90a1c74";
const ACL_TYPE = "fc55e9f79f8222109570e67e8a0a1c34";
const ACL_SECURITY_ATTRIBUTE = "239bdf0c47d23110ba46ff58936d4330";
const PUBLIC_ROLE = "b0593b350a0a0aa7001d689e4542dc28";
const WEB_SEARCH_TOOL = "576cf8eaffd922101dbaffffffffff66";
const WEB_SEARCH_DEFAULT_INPUTS = JSON.stringify([{ name: "search_type", value: "ai_answers", metadata: { _MODE_: "user" } }]);
const ACCESS_TYPES = ["Any authenticated user", "Specific role", "Public"];
const UNSUPPORTED_TOOL_TYPES = ["rag", "search_retrieval", "crud"];

const OOB_TOOLS: Record<string, string> = {
  web_automation: WEB_SEARCH_TOOL,
  knowledge_graph: "3b8c4f4fc3e022100e94313a05013167",
  file_upload: "b064af48ffb822101dbaffffffffff20",
};

const MEMORY_CATEGORIES: Record<string, string> = {
  device_and_software: "7634aaae43db52107c4d14020ab8f294",
  meetings_and_events: "66442eae43db52107c4d14020ab8f26f",
  projects: "6b49e262431312107c4d14020ab8f2a9",
  workplace: "5c446eae43db52107c4d14020ab8f218",
};

const TARGET_TABLES: Record<string, string> = {
  action: "sys_hub_action_type_definition",
  capability: "sn_nowassist_skill_config",
  subflow: "sys_hub_flow",
  catalog: "sc_cat_item",
  topic: "sys_cs_topic",
  topic_block: "sys_cs_topic",
  script: "sn_aia_tool",
  desktop_automation: "sn_aia_tool",
  deep_research: "sn_aia_tool",
  file_upload: "sn_aia_tool",
  mcp: "sn_aia_tool",
  knowledge_graph: "sn_aia_tool",
  web_automation: "sn_aia_tool",
};

/** The option naming a tool's target document, by tool type; other types use `targetDocument`. */
const TARGET_DOCUMENT_OPTIONS: Record<string, string> = {
  capability: "capabilityId",
  subflow: "subflowId",
  action: "flowActionId",
  catalog: "catalogItemId",
  topic: "virtualAgentId",
  topic_block: "virtualAgentId",
};

const DEFAULT_CONTEXT_PROCESSING_SCRIPT = [
  "/*",
  " * Available Variables:",
  " * - task: The task provided to agent to solve either by orchestrator or user(incase of only agent execution i.e agent is invoked as seperate entity instead from a workflow).",
  " * - user_utterance: The user utterance provided. and task = user_utterance in case of individual agent execution.",
  " * - agent_id: The agent id.",
  " * - context: An object that carries additional contextual information for the agent.",
  ' * It always includes a "pageContext" and may include a "triggerContext",',
  " * depending on how and from where the agent is invoked.",
  " *",
  " * Behavior by invocation type:",
  " * ---------------------------------",
  " * - When invoked via the startAiAgentConversation API:",
  ' * If a "contextMemory" parameter is provided in the API request,',
  ' * it will be available here as the "triggerContext".',
  ' * The "pageContext" is always present in this call, regardless',
  " * of whether the agent is executed individually or as part of a use case.",
  " * Example:",
  " * {",
  " * pageContext: { ... },",
  " * triggerContext: { ... } // Derived from contextMemory (if passed)",
  " * }",
  " *",
  " * - When invoked as part of a use case or workflow:",
  ' * The "pageContext" and "triggerContext" objects available here',
  " * may have been *modified* by the use case's context processing script.",
  " * This means the use case may alter, extend, or overwrite values",
  ' * from the original "pageContext" or "triggerContext"',
  " * before the context reaches the agent.",
  " * If the use case was originally triggered via the API,",
  ' * the initial "triggerContext" is still derived from the',
  ' * "contextMemory" parameter, but its contents may have been updated',
  " * by the use case logic.",
  " *",
  " * - When executed directly (standalone agent execution):",
  ' * The "pageContext" will always be present (default or empty),',
  ' * and the "triggerContext" will only be populated if explicitly',
  " * passed through the API call.",
  " * Return an modified context like: { pageContext : {},triggerContext:{} }",
  " */",
  "(function(task, user_utterance, agent_id, context) {",
  "\treturn {",
  "\t\tpageContext : context?.pageContext,",
  "\t\ttriggerContext : context?.triggerContext",
  "\t};",
  "})(task,user_utterance, agent_id, context);",
].join("\n");

const ACL_PROPERTIES = ["$id", "type", "roles"];
const DATA_ACCESS_PROPERTIES = ["roleList", "roleMap", "description"];
const VERSION_PROPERTIES = ["condition", "instructions", "state", "name", "number"];
const SCHEDULE_PROPERTIES = ["runDayOfMonth", "runDayOfWeek", "repeatInterval", "starting", "time", "triggerStrategy"];
const INPUT_PROPERTIES = ["name", "description", "mandatory", "value", "invalidMessage"];
const TRIGGER_PROPERTIES = [
  "active",
  "businessRule",
  "channel",
  "description",
  "domain",
  "enableDiscovery",
  "m2mSysOverrides",
  "name",
  "notificationScript",
  "objectiveTemplate",
  "portal",
  "profile",
  "runAs",
  "runAsScript",
  "runAsUser",
  "schedule",
  "showNotifications",
  "sysOverrides",
  "targetTable",
  "triggerCondition",
  "triggerFlow",
  "triggerFlowDefinitionType",
  "usecase",
  "usecaseDiscovery",
];
const TOOL_PROPERTIES = [
  "active",
  "capabilityId",
  "catalogItemId",
  "description",
  "displayOutput",
  "documentStatus",
  "executionMode",
  "flowActionId",
  "inputs",
  "m2mSysOverrides",
  "maxAutoExecutions",
  "name",
  "outputTransformationStrategy",
  "postMessage",
  "postProcessingScript",
  "preMessage",
  "preRun",
  "recordType",
  "script",
  "subflowId",
  "sysOverrides",
  "targetDocument",
  "timeout",
  "toolAttributes",
  "transformationInstructions",
  "type",
  "virtualAgentId",
  "widgets",
];

type Create = (table: string, source: FluentValue, fields: CreateRecordOptions["fields"], explicitId?: string | number) => CompiledRecord;

function unsupported(o: Options, key: string, what: string): never {
  return o.error(`${o.call.api}(): ${what} is not supported by the native compiler yet.`, o.get(key));
}

/** A string, number or boolean as written; other values are an error. */
function literal(o: Options, key: string): string | number | boolean | undefined {
  const v = o.get(key);
  if (v === undefined) return undefined;
  if (v.kind !== "string" && v.kind !== "number" && v.kind !== "boolean") {
    o.error(`${o.call.api}(): '${o.path}${key}' must be a string, number or boolean.`, v);
  }
  return v.value;
}

/** A string as a CDATA section, the way the SDK writes scripts and templates. */
function cdata(text: string | undefined): CData | undefined {
  return text === undefined ? undefined : new CData(text);
}

/** A tool input as the plain value the SDK serializes: object properties that are null or undefined are dropped. */
function inputJson(o: Options, value: FluentValue): unknown {
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "null":
      return null;
    case "array":
      return value.items.map((item) => inputJson(o, item));
    case "object":
      return Object.fromEntries(
        [...value.props].filter(([, v]) => v.kind !== "undefined" && v.kind !== "null").map(([k, v]) => [k, inputJson(o, v)]),
      );
    default:
      return o.error(`${o.call.api}(): '${o.path}inputs' must be JSON data.`, value);
  }
}

/** A sys_id given as a string or a record, the way the SDK reads tool target documents and widgets. */
function sysId(o: Options, ctx: BuildContext, value: FluentValue | undefined, key: string): string {
  if (value === undefined) return "";
  if (value.kind === "string") return value.value;
  if (value.kind === "call") return ctx.recordOf(value).id.getValue();
  return o.error(`${o.call.api}(): '${o.path}${key}' must be a sys_id or a record.`, value);
}

export const aiAgent: ArtefactSpec = {
  properties: [
    "active",
    "advancedMode",
    "agentConfigSysOverrides",
    "agentDescriptor",
    "agentLearning",
    "agentRole",
    "agentType",
    "channel",
    "compiledHandbook",
    "condition",
    "contextProcessingScript",
    "dataAccess",
    "description",
    "docUrl",
    "external",
    "externalAgentConfiguration",
    "iconUrl",
    "memoryCategories",
    "name",
    "parent",
    "postProcessingMessage",
    "processingMessage",
    "public",
    "recordType",
    "runAsUser",
    "securityAcl",
    "sourceId",
    "sysDomain",
    "tools",
    "triggerConfig",
    "versionDetails",
  ],
  build(o, ctx) {
    const aclValue = o.get("securityAcl");
    if (aclValue?.kind !== "object") return o.error("AI Agent must have a securityAcl field.", o.object);
    const acl = o.sub(aclValue, "securityAcl.", ACL_PROPERTIES);
    const name = o.string("name") ?? "";
    const sysDomain = o.string("sysDomain") || "global";
    const internalName = `${sysDomain}.${ctx.scope}.${name}`;

    const versions = (o.array("versionDetails") ?? []).map((v, i) => o.sub(v, `versionDetails[${i}].`, VERSION_PROPERTIES));
    const published = versions.filter((v) => v.string("state") === "published");
    if (published.length > 1) {
      o.error(
        `AI Agent '${name}' has multiple versions with state 'published'. Only one version can be published at a time.`,
        o.get("versionDetails"),
      );
    }
    const instructions = published.length === 1 ? published[0].string("instructions") || "" : "";

    const records: CompiledRecord[] = [];
    const create: Create = (table, source, fields, explicitId) => {
      const record = ctx.factory.createRecord({ table, source: source.loc, installCategory: o.installCategory, explicitId, fields });
      records.push(record);
      return record;
    };

    // securityAcl: the execute ACL and its roles.
    const accessType = acl.string("type");
    if (!ACCESS_TYPES.includes(accessType ?? "")) {
      acl.error(`securityAcl.type must be 'Any authenticated user', 'Specific role', or 'Public'. Got: '${accessType}'`, acl.object);
    }
    let aclRoles: FluentValue[] = [];
    if (accessType === "Specific role") {
      const roles = acl.get("roles");
      if (roles?.kind !== "array") return acl.error("securityAcl.roles must be an array when type is 'Specific role'", acl.object);
      if (roles.items.length === 0) acl.error("securityAcl.roles must contain at least one role", roles);
      aclRoles = roles.items;
    }
    const aclId = acl.get("$id");
    if (aclId?.kind !== "nowId") return acl.error(`${o.call.api}(): 'securityAcl.$id' must be a Now.ID[...].`, aclId ?? acl.object);
    const aclRecord = create(
      "sys_security_acl",
      acl.object,
      {
        active: true,
        admin_overrides: true,
        advanced: false,
        decision_type: "allow",
        local_or_existing: "Existing",
        name: internalName,
        operation: "execute",
        security_attribute: accessType === "Any authenticated user" ? ACL_SECURITY_ATTRIBUTE : "",
        type: ACL_TYPE,
      },
      aclId.key,
    );
    const aclRole = (source: FluentValue, role: RecordId | CompiledRecord) =>
      create("sys_security_acl_role", source, { sys_security_acl: aclRecord, sys_user_role: role });
    if (accessType === "Public") aclRole(acl.object, ctx.factory.createReference("sys_user_role", PUBLIC_ROLE));
    for (const role of aclRoles) {
      if (role.kind === "string") {
        const guid = isGUID(role.value);
        aclRole(role, ctx.factory.createReference("sys_user_role", guid ? role.value : undefined, guid ? undefined : { name: role.value }));
      } else if (role.kind === "call") {
        aclRole(role, roleRecord(acl, ctx, role, "securityAcl.roles").role);
      } else {
        acl.error(`${o.call.api}(): 'securityAcl.roles' must hold role names, sys_ids or Role() records.`, role);
      }
    }

    // The agent itself.
    const script = o.string("contextProcessingScript");
    const agent = ctx.factory.createRecord({
      table: AGENT_TABLE,
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        acl: aclRecord.id.getValue(),
        active: o.boolean("active") ?? true,
        advanced_mode: o.boolean("advancedMode") ?? false,
        agent_type: o.string("agentType") ?? "internal",
        channel: o.string("channel") ?? "nap_and_va",
        compiled_handbook: o.string("compiledHandbook") ?? "",
        condition: o.string("condition"),
        context_processing_script: script === undefined ? DEFAULT_CONTEXT_PROCESSING_SCRIPT : new CData(script),
        description: o.string("description"),
        external: o.boolean("external") ?? false,
        external_agent_configuration: o.string("externalAgentConfiguration") ?? "",
        instructions,
        internal_name: internalName,
        name: o.string("name"),
        parent: o.string("parent") ?? "",
        post_processing_message: o.string("postProcessingMessage"),
        processing_message: o.string("processingMessage"),
        record_type: o.string("recordType") ?? "template",
        role: o.string("agentRole"),
        source_id: o.string("sourceId") ?? "",
        strategy: REACT_STRATEGY,
        sys_domain: o.string("sysDomain") ?? "global",
      },
    });

    create("sn_aia_agent_config", o.object, {
      active: o.boolean("active") ?? true,
      agent,
      agent_descriptor: o.string("agentDescriptor") ?? "",
      agent_learning: o.boolean("agentLearning") ?? false,
      doc_url: o.string("docUrl"),
      icon_url: o.string("iconUrl"),
      public: o.boolean("public") ?? false,
      run_as_user: o.string("runAsUser") ?? "",
      sys_domain: "global",
      sys_overrides: o.string("agentConfigSysOverrides") ?? "",
    });

    const version = { sys_domain: "global", target_id: agent, target_table: AGENT_TABLE };
    if (o.get("versionDetails") === undefined) {
      create("sn_aia_version", o.object, { ...version, instructions: "", state: "draft", version_name: name || "V1", version_number: 1 });
    }
    for (const v of versions) {
      create("sn_aia_version", v.object, {
        ...version,
        condition: v.string("condition"),
        instructions: v.string("instructions"),
        state: v.string("state") ?? "published",
        version_name: v.string("name") ?? "V1",
        version_number: v.number("number") ?? 1,
      });
    }

    const dataAccess = o.nested("dataAccess", DATA_ACCESS_PROPERTIES);
    if (dataAccess) buildDataAccess(dataAccess, ctx, agent, !!o.string("runAsUser"), create);

    const triggers = (o.array("triggerConfig") ?? []).flatMap((value, i) =>
      value.kind === "object" ? [o.sub(value, `triggerConfig[${i}].`, TRIGGER_PROPERTIES)] : [],
    );
    const triggerRecords = triggers.map((t) => buildTrigger(t, ctx, create));
    triggers.forEach((t, i) => {
      create("sn_aia_trigger_agent_usecase_m2m", t.object, {
        active: t.boolean("active") ?? false,
        objective_template: cdata(t.string("objectiveTemplate")),
        related_resource_record: agent,
        related_resource_table: AGENT_TABLE,
        sys_domain: t.string("domain") ?? "global",
        sys_overrides: t.string("m2mSysOverrides") ?? "",
        trigger_configuration: triggerRecords[i],
      });
    });

    const tools = (o.array("tools") ?? []).map((value, i) => o.sub(value, `tools[${i}].`, TOOL_PROPERTIES));
    const toolNames = new Set<string>();
    for (const tool of tools) {
      const toolName = tool.string("name");
      if (toolName && toolNames.has(toolName)) {
        tool.error(`Duplicate tool name "${toolName}". Each tool must have a unique name.`, tool.get("name"));
      }
      if (toolName) toolNames.add(toolName);
      const type = tool.string("type");
      if (type && UNSUPPORTED_TOOL_TYPES.includes(type)) unsupported(tool, "type", `tool type '${type}'`);
    }
    for (const tool of tools) buildTool(tool, ctx, agent, create);

    for (const value of o.array("memoryCategories") ?? []) {
      const category = value.kind === "string" ? lookup(MEMORY_CATEGORIES, value.value) : undefined;
      if (category) create("sn_aia_ltm_category_mapping", value, { category, entity_id: agent, entity_table: AGENT_TABLE });
    }

    agent.children.push(...records);
    return agent;
  },
};

/** dataAccess: the role configuration that limits the agent to roles, and a mapping per roleMap role. */
function buildDataAccess(d: Options, ctx: BuildContext, agent: CompiledRecord, hasRunAsUser: boolean, create: Create): void {
  const guids = (d.array("roleList") ?? []).flatMap((role): string[] => {
    if (role.kind === "call") return [ctx.recordOf(role).id.getValue()];
    if (role.kind !== "string") return d.error(`${d.call.api}(): 'dataAccess.roleList' must hold role sys_ids or Role() records.`, role);
    if (role.value === "") return [];
    if (!isGUID(role.value)) {
      d.error(
        `roleList must contain only role sys_ids (GUIDs), not role names. Got: '${role.value}'. Use the role sys_id when using roleList (e.g., '2831a114c611228501d4ea6c309d626d' for admin), or use roleMap for role names.`,
        role,
      );
    }
    return [role.value];
  });
  const roles = (d.array("roleMap") ?? []).flatMap((role): (RecordId | CompiledRecord)[] => {
    if (role.kind === "call") return [roleRecord(d, ctx, role, "dataAccess.roleMap").role];
    if (role.kind !== "string") return d.error(`${d.call.api}(): 'dataAccess.roleMap' must hold role names or Role() records.`, role);
    if (isGUID(role.value)) {
      d.error(
        `roleMap must contain role names, not sys_ids. Got: '${role.value}'. Use the role name (e.g., 'admin'), or move the sys_id to dataAccess.roleList.`,
        role,
      );
    }
    return role.value.trim() === "" ? [] : [ctx.factory.createReference("sys_user_role", undefined, { name: role.value })];
  });
  if (!hasRunAsUser && guids.length === 0 && roles.length === 0) {
    d.error(
      "dataAccess must have at least one of roleList or roleMap non-empty: provide sys_ids in roleList, role names in roleMap, or both.",
      d.object,
    );
  }
  const config = create("sys_agent_access_role_configuration", d.object, {
    action: "limit_to_roles",
    agent: agent.id.getValue(),
    agent_table: AGENT_TABLE,
    description: d.string("description") ?? "",
    name: agent.id.getValue(),
    role_list: guids.join(","),
  });
  for (const role of roles) create("sys_agent_access_role_mapping", d.object, { agent_access_config: config, role });
}

/** A trigger's sn_aia_trigger_configuration. */
function buildTrigger(t: Options, ctx: BuildContext, create: Create): CompiledRecord {
  const schedule = t.nested("schedule", SCHEDULE_PROPERTIES);
  const scheduled = (key: string) => (schedule ? literal(schedule, key) : undefined);
  return create("sn_aia_trigger_configuration", t.object, {
    active: t.boolean("active") ?? false,
    business_rule: t.string("businessRule") ?? "",
    channel: t.string("channel") ?? "",
    condition: t.string("triggerCondition") ?? "",
    description: t.string("description"),
    enable_discovery: t.boolean("enableDiscovery") ?? false,
    internal_name: `${t.string("domain") || "global"}.${ctx.scope}.${t.string("name") || ""}`,
    name: t.string("name"),
    notification_script: t.string("notificationScript") ?? "",
    objective_template: cdata(t.string("objectiveTemplate")) ?? "",
    portal: t.string("portal") ?? "",
    profile: t.string("profile") ?? "",
    run_as: t.string("runAs"),
    run_as_script: t.string("runAsScript") ?? "",
    run_as_user: t.string("runAsUser"),
    run_dayofmonth: scheduled("runDayOfMonth"),
    run_dayofweek: scheduled("runDayOfWeek"),
    run_period: scheduled("repeatInterval"),
    run_start: scheduled("starting"),
    run_time: scheduled("time"),
    show_notifications: t.boolean("showNotifications") ?? false,
    sys_domain: t.string("domain") ?? "global",
    sys_overrides: t.string("sysOverrides") ?? "",
    target_table: t.string("targetTable"),
    trigger_flow: t.string("triggerFlow") ?? "",
    trigger_flow_definition_type: t.string("triggerFlowDefinitionType"),
    trigger_strategy: scheduled("triggerStrategy"),
    usecase: t.string("usecase") ?? "",
    usecase_discovery: t.boolean("usecaseDiscovery") ?? false,
  });
}

/** A tool's input schema: each input's name, description and mandatory flag, as given. */
function inputSchema(t: Options, items: FluentValue[]): string {
  const schema = items.map((item) => {
    const input = t.sub(item, "inputs[].", INPUT_PROPERTIES);
    const entry: Record<string, string | boolean> = {};
    const inputName = input.string("name");
    if (inputName !== undefined) entry.name = inputName;
    const description = input.string("description");
    if (description !== undefined) entry.description = description;
    const mandatory = input.boolean("mandatory");
    if (mandatory !== undefined) entry.mandatory = mandatory;
    return entry;
  });
  return JSON.stringify(schema);
}

/** A tool: its sn_aia_tool (unless out of the box) and the sn_aia_agent_tool_m2m linking it to the agent. */
function buildTool(t: Options, ctx: BuildContext, agent: CompiledRecord, create: Create): void {
  const type = t.string("type");
  const inputs = t.get("inputs");
  if (inputs !== undefined && inputs.kind !== "array") unsupported(t, "inputs", `'${t.path}inputs' other than an array`);
  const items = inputs?.kind === "array" ? inputs.items : undefined;
  let tool = type === undefined ? undefined : lookup(OOB_TOOLS, type);
  if (tool === undefined) {
    const option = type === undefined ? undefined : (lookup(TARGET_DOCUMENT_OPTIONS, type) ?? "targetDocument");
    const record = create("sn_aia_tool", t.object, {
      active: t.boolean("active") ?? true,
      description: t.string("description"),
      input_schema: inputSchema(t, items ?? []),
      name: t.string("name"),
      post_processing_script: t.string("postProcessingScript") ?? "",
      record_type: t.string("recordType") ?? "template",
      script: new CData(t.string("script") ?? ""),
      sys_domain: "global",
      sys_overrides: t.string("sysOverrides") ?? "",
      target_document: option === undefined ? "" : sysId(t, ctx, t.get(option), option),
      target_document_table: (type && lookup(TARGET_TABLES, type)) ?? "",
      type,
    });
    tool = record.id.getValue();
  }
  const widgets = t.get("widgets");
  let widgetsField: FieldValue;
  if (widgets?.kind === "array") widgetsField = widgets.items.map((w) => sysId(t, ctx, w, "widgets")).join(",");
  else widgetsField = t.string("widgets");
  create("sn_aia_agent_tool_m2m", t.object, {
    active: t.boolean("active") ?? true,
    agent,
    description: t.string("description"),
    display_output: t.boolean("displayOutput") ?? false,
    document_status: t.string("documentStatus"),
    execution_mode: t.string("executionMode") ?? "autopilot",
    inputs:
      tool === WEB_SEARCH_TOOL && !items?.length
        ? WEB_SEARCH_DEFAULT_INPUTS
        : JSON.stringify((items ?? []).map((item) => inputJson(t, item))),
    max_auto_executions: t.number("maxAutoExecutions") ?? 10,
    name: t.string("name"),
    output_transformation_strategy: t.string("outputTransformationStrategy"),
    post_message: t.string("postMessage"),
    post_processing_script: t.string("postProcessingScript") ?? "",
    pre_message: t.string("preMessage"),
    pre_run: t.boolean("preRun") ?? false,
    sys_domain: "global",
    sys_overrides: t.string("m2mSysOverrides") ?? "",
    timeout: literal(t, "timeout"),
    tool,
    tool_attributes: t.string("toolAttributes") ?? "{}",
    transformation_instructions: t.string("transformationInstructions"),
    widgets: widgetsField,
  });
}
