// SPDX-License-Identifier: GPL-3.0-or-later
//
// NowAssistSkillConfig(definition, promptConfig) → the sys_one_extend_capability
// of the skill with its sn_nowassist_skill_config (and status), a capability
// definition and definition config per provider, a sys_generative_ai_config and
// prompt config per prompt version, the input and output attributes (the five
// standard outputs plus custom ones), the feature, strategy and resource
// mappings, and, with securityControls, an execute ACL and an agent access
// role configuration.
//
// The native compiler covers skills whose prompts run on an LLM provider:
// tools, skill and deployment settings, role-based user access, roleMap and
// glide_record/JSON attributes are not supported yet. Like the SDK, every file
// carries `[object Object]` as its root table.

import { isGUID } from "../keys";
import type { FluentValue } from "../evaluate";
import type { CompiledRecord, CreateRecordOptions } from "../record";
import { type ArtefactSpec, lookup, type Options } from "./shared";

const ROOT_TABLE = "[object Object]";
const SKILL_FAMILY = "a5efaf1c93764210aa5730f16489186d";
const TRUNCATE_STRATEGY = "2b99e1137fb20210f465c3b76d86650d";
const ACL_SECURITY_ATTRIBUTE = "239bdf0c47d23110ba46ff58936d4330";
const ACL_TYPE = "0d986410ffdd2210c0e9ffffffffffc9";
const DEFAULT_PROVIDER = "Now LLM Service";
const DEFAULT_FLOW_ID = "936e514a53b3b110f028ddeeff7b128c";
const DEFAULT_MODEL = "llm_generic_small";
const DEFAULT_MAX_TOKENS = 500;
const MAX_TOKENS_LIMIT = 130722;
const MAX_SKILL_NAME_LENGTH = 40;
const ADMIN_ROLE_SYS_ID = "2831a114c611228501d4ea6c309d626d";
const UNSUPPORTED_DATA_TYPES = ["glide_record", "simple_array", "json_object", "json_array"];

const PROVIDER_FLOWS: Record<string, string> = {
  "Now LLM Service": DEFAULT_FLOW_ID,
  "Now LLM LTS Generic": "7d01e99bffa32210a3aeffffffffff86",
  "Azure OpenAI": "a55c1c6f530221106b38ddeeff7b12b1",
  "Open AI": "3b6a84c4878621104f1c8f59dabb3525",
  "Google Gemini": "9666f54b2dca7110f877b951e3e5bf53",
  "Google Cloud Vertex AI": "9666f54b2dca7110f877b951e3e5bf53",
  "AWS Claude": "52f46aeb9f2c5210da502fca9a0a1cda",
  "Amazon Bedrock": "52f46aeb9f2c5210da502fca9a0a1cda",
  "IBM Watson": "e841ec9053190210ea08ddeeff7b12ae",
  Perplexity: "2983f6889fbad21029ead63a6a0a1cd6",
  "Custom LLM Provider": "af9702d0c3110210b0939bc8a840dd2c",
  "Aleph Alpha": "4c88a81955ea7110f877466af34cb583",
};

const STANDARD_OUTPUTS: [name: string, label: string, description: string][] = [
  ["response", "response", "Response Text"],
  ["provider", "provider", "Provider name"],
  ["errorcode", "errorCode", "Error Code"],
  ["status", "status", "Status"],
  ["error", "error", "Error Message"],
];

const APPLICABILITY_SCRIPT = [
  "(function(currentInputs, context) {",
  "    /* @param {Object} currentInputs - Inputs provided for the current step.*/",
  "    /* @param {Object} context - Execution context, which may include:*/",
  "    /*                         - Previous tool outputs/inputs (e.g., context['ToolName.attributeName'] or context.getValue('ToolName.attributeName')).*/",
  "    /*                         - Additional context information (e.g., context.getAllValues()).*/",
  "    /* @returns {Boolean} - Return 'true' if the condition is met; otherwise 'false'.*/",
  "    return true;",
  "})(currentInputs, context);",
].join("\n");

const INPUT_PROPERTIES = ["$id", "name", "description", "mandatory", "testValues", "dataType", "truncate", "tableName", "tableSysId"];
const OUTPUT_PROPERTIES = ["$id", "name", "description", "dataType", "tableName"];

function unsupported(o: Options, key: string, what = `'${o.path}${key}'`): void {
  const v = o.get(key);
  if (v !== undefined) o.error(`${o.call.api}(): ${what} is not supported by the native compiler yet.`, v);
}

/** Rejects names AI Studio does not accept: only letters, digits and spaces. */
function validateName(o: Options, name: string, kind: string, source: FluentValue | undefined): void {
  if (/^[a-zA-Z0-9 ]+$/.test(name)) return;
  const invalid = [...new Set(name.match(/[^a-zA-Z0-9 ]/g) ?? [])].join(", ");
  o.error(
    `${kind} '${name}' contains invalid character(s): ${invalid}. ${kind}s must contain only letters, numbers, and spaces. Please remove special characters, underscores, and punctuation.`,
    source,
  );
}

/** 'Travel Destination' → 'travel_destination'. */
function internalName(displayName: string): string {
  return displayName.toLowerCase().trim().replace(/\s+/g, "_");
}

function sanitizeSkillName(name: string): string {
  return name.trim().replace(/\\/g, "").replace(/\s+/g, "_").toLowerCase();
}

/** A flag the SDK accepts as `true`, `'true'` or `'1'`. */
function flag(o: Options, key: string): boolean {
  const v = o.get(key);
  if (v === undefined) return false;
  if (v.kind !== "boolean" && v.kind !== "string") o.error(`${o.call.api}(): '${o.path}${key}' must be a boolean.`, v);
  return v.value === true || v.value === "true" || v.value === "1";
}

/** The attribute's data type; the record and JSON types are not supported yet. */
function dataType(o: Options): string {
  const type = o.string("dataType") ?? "string";
  if (UNSUPPORTED_DATA_TYPES.includes(type)) unsupported(o, "dataType", `dataType '${type}'`);
  return type;
}

/** The `$id` of an attribute, which must be a Now.ID. */
function attributeId(o: Options, kind: string): string {
  const id = o.get("$id");
  if (id?.kind !== "nowId") o.error(`${kind} attribute '$id' is required and must use Now.ID['key'].`, o.object);
  return id.key;
}

/** The attribute's display name, validated. */
function attributeName(o: Options): string {
  const name = o.string("name") ?? "";
  if (name.trim() === "") o.error("Attribute name is required and cannot be empty", o.object);
  validateName(o, name, "Attribute name", o.object);
  return name;
}

interface Version {
  o: Options;
  promptName: string;
  isDefault: boolean;
}

interface Provider {
  o: Options;
  name: string;
  flowId: string;
  flowType: string;
  isDefault: boolean;
  versions: Version[];
}

function readProviders(config: Options): Provider[] {
  const items = config.array("providers") ?? [];
  if (items.length === 0) config.error("providers array cannot be empty", config.get("providers") ?? config.object);
  const providers = items.map((item, i) => config.sub(item, `providers[${i}].`, ["provider", "providerAPI", "prompts", "defaultPrompt", "defaultPromptVersion", "providerConfig"]));
  const names = providers.map((p) => p.string("provider") || DEFAULT_PROVIDER);
  const defaultProvider = config.string("defaultProvider") || names[0];
  const promptNames = new Set<string>();
  const resolved = providers.map((p, i): Provider => {
    unsupported(p, "defaultPromptVersion");
    unsupported(p, "providerConfig");
    const name = names[i];
    let flowId: string;
    let flowType = "sys_hub_flow";
    const api = p.get("providerAPI");
    if (api?.kind === "string") flowId = api.value || DEFAULT_FLOW_ID;
    else if (api !== undefined) {
      const a = p.sub(api, "providerAPI.", ["type", "id"]);
      flowType = a.string("type") || flowType;
      flowId = a.string("id") || DEFAULT_FLOW_ID;
    } else {
      flowId =
        lookup(PROVIDER_FLOWS, name) ??
        p.error(
          `Unknown provider "${name}". Please either:\n1. Use a known provider: ${Object.keys(PROVIDER_FLOWS).join(", ")}\n2. Provide explicit providerAPI: { type: 'sys_hub_flow', id: 'your_flow_sys_id' }`,
          p.get("provider"),
        );
    }

    const prompts = (p.array("prompts") ?? []).map((item, j) => p.sub(item, `prompts[${j}].`, ["name", "versions"]));
    const versions: Version[] = [];
    const providerPrompts = prompts.map((prompt) => prompt.string("name") ?? "");
    const defaultPrompt = p.string("defaultPrompt") || providerPrompts[0];
    prompts.forEach((prompt, j) => {
      const promptName = providerPrompts[j];
      validateName(prompt, promptName, "Prompt name", prompt.get("name") ?? prompt.object);
      if (promptNames.has(promptName)) {
        prompt.error(`Duplicate prompt name '${promptName}'. Each prompt must have a unique name across the entire skill.`, prompt.get("name"));
      }
      promptNames.add(promptName);
      const items = prompt.array("versions") ?? [];
      if (items.length === 0) prompt.error(`Prompt '${promptName}' must have at least one version in the versions array.`, prompt.object);
      if (items.length > 1) unsupported(prompt, "versions", "more than one prompt version");
      const version = prompt.sub(items[0], "versions[0].", ["$id", "version", "model", "temperature", "prompt", "promptState", "maxTokens", "filterCondition"]);
      const number = version.get("version");
      const raw = number?.kind === "number" || number?.kind === "string" ? number.value : undefined;
      const value = Number(raw || 1);
      if (!Number.isInteger(value) || value < 1) {
        version.error(`Version '${String(raw)}' of prompt '${promptName}' must be a positive integer (e.g., 1, 2, 3).`, number);
      }
      versions.push({ o: version, promptName, isDefault: promptName === defaultPrompt });
    });
    if (p.get("defaultPrompt") !== undefined && !providerPrompts.includes(defaultPrompt)) {
      p.error(
        `defaultPrompt '${defaultPrompt}' does not match any prompt name in provider '${name}'. Available prompts: ${providerPrompts.join(", ")}`,
        p.get("defaultPrompt"),
      );
    }
    return { o: p, name, flowId, flowType, isDefault: name === defaultProvider, versions };
  });
  if (!names.includes(defaultProvider)) {
    config.error(`defaultProvider '${defaultProvider}' does not match any provider name. Available providers: ${names.join(", ")}`, config.get("defaultProvider"));
  }
  return resolved;
}

export const nowAssistSkillConfig: ArtefactSpec = {
  properties: ["name", "shortDescription", "description", "state", "inputs", "outputs", "tools", "skillSettings", "deploymentSettings", "securityControls"],
  twoArguments: {
    first: "NowAssistSkillConfig requires a definition object as the first argument",
    second: "NowAssistSkillConfig requires a prompt configuration object as the second argument",
  },
  build(o, ctx) {
    for (const key of ["tools", "skillSettings", "deploymentSettings"]) unsupported(o, key);
    const config = o.sub(o.call.args[1], "promptConfig.", ["providers", "defaultProvider"]);

    const name = o.string("name") ?? "";
    if (name.trim() === "") o.error("NowAssistSkillConfig requires a name", o.get("name"));
    if (name.length > MAX_SKILL_NAME_LENGTH) {
      o.error(`Skill name must not exceed ${MAX_SKILL_NAME_LENGTH} characters (current length: ${name.length})`, o.get("name"));
    }
    validateName(o, name, "Skill name", o.get("name"));
    const providers = readProviders(config);

    const skillKey = o.explicitId();
    if (skillKey === undefined) o.error(`${o.call.api}(): '$id' is required.`);
    const description = o.string("description") ?? "";
    const published = o.string("state") === "published";

    const capability = ctx.factory.createRecord({
      table: "sys_one_extend_capability",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: skillKey,
      fields: {
        active: true,
        description: o.string("description"),
        name,
        short_description: o.string("shortDescription") ?? `${name} Skill`,
        type: "skill",
      },
    });
    capability.rootTable = ROOT_TABLE;
    const child = (table: string, source: FluentValue, explicitId: string | undefined, fields: CreateRecordOptions["fields"]): CompiledRecord => {
      const record = ctx.factory.createRecord({ table, source: source.loc, installCategory: o.installCategory, explicitId, fields });
      record.rootTable = ROOT_TABLE;
      capability.children.push(record);
      return record;
    };

    const skill = child("sn_nowassist_skill_config", o.object, undefined, {
      description,
      name,
      nap_skill_applicability: "",
      skill_family: SKILL_FAMILY,
      skill_id: capability,
      skill_table: "sys_one_extend_capability",
      state: published ? "1" : "0",
    });
    // The SDK merges the internal name in after the sorted fields and writes it twice.
    skill.fields.set("internal_name", `${sanitizeSkillName(name)}.${skill.id.getValue()}`);
    skill.trailingFields = ["internal_name"];
    child("sn_nowassist_skill_config_status", o.object, undefined, { skill_config: skill });

    let publishedPrompt = false;
    for (const provider of providers) {
      const definition = child("sys_one_extend_capability_definition", provider.o.object, undefined, {
        api: provider.flowId,
        api_type: provider.flowType,
        capability,
        description: `Definition for ${name}`,
        name: `${name} (${provider.name})`,
        truncate_strategy: TRUNCATE_STRATEGY,
      });
      child("sys_one_extend_definition_config", provider.o.object, undefined, {
        active: true,
        capability,
        default: provider.isDefault,
        definition,
      });
      for (const { o: v, promptName, isDefault } of provider.versions) {
        unsupported(v, "filterCondition");
        const prompt = v.get("prompt");
        if (prompt !== undefined && prompt.kind !== "string") unsupported(v, "prompt", "a prompt that is not a string literal");
        const maxTokens = v.number("maxTokens") ?? DEFAULT_MAX_TOKENS;
        if (maxTokens < 0 || maxTokens > MAX_TOKENS_LIMIT) {
          v.error(
            `max_tokens value '${maxTokens}' is out of range. max_tokens must be between 0 and ${MAX_TOKENS_LIMIT}. Please adjust the value.`,
            v.get("maxTokens"),
          );
        }
        const state = v.string("promptState") || "draft";
        const promptPublished = state === "published";
        if (promptPublished && !published) {
          v.error(
            `Cannot set prompt '${promptName}' state to 'published' because the skill state is not 'published'. Please set the skill state to 'published' before publishing any prompts.`,
            v.get("promptState"),
          );
        }
        publishedPrompt ||= promptPublished;
        v.number("temperature");
        const id = v.explicitId();
        const aiConfig = child("sys_generative_ai_config", v.object, id === undefined ? undefined : String(id), {
          active: promptPublished,
          capability: capability.id.getValue(),
          definition,
          definition_table: "sys_one_extend_capability_definition",
          description,
          max_tokens: String(maxTokens),
          min_word_count: -1,
          model: v.string("model") || DEFAULT_MODEL,
          name: promptName,
          prompt: prompt?.kind === "string" ? prompt.value : "",
          show_in_prompt_library: promptPublished,
          state,
          temperature: 0.2,
          version: v.get("version") === undefined ? "1" : v.scalar("version"),
        });
        child("sys_generative_ai_prompt_config", v.object, undefined, {
          ai_config: aiConfig,
          definition,
          filter_properties: "",
          filter_type: "default",
          is_default: isDefault,
        });
      }
    }
    if (published && !publishedPrompt) {
      o.error(
        "Cannot publish skill without at least one published prompt. Please ensure at least one prompt has promptState set to 'published'.",
        o.get("state"),
      );
    }

    const attribute = (source: Options, id: string, fields: CreateRecordOptions["fields"]) =>
      child("sys_one_extend_definition_attribute", source.object, id, { active: true, capability, ...fields });

    const inputs = (o.array("inputs") ?? []).map((item, i) => o.sub(item, `inputs[${i}].`, INPUT_PROPERTIES));
    const inputNames = new Set<string>();
    const normalized = new Map<string, string>();
    for (const input of inputs) {
      const display = input.string("name") ?? "";
      const norm = display.toLowerCase().replace(/ +/g, "_");
      if (inputNames.has(display)) input.error(`Duplicate input name '${display}'. Each input must have a unique name.`, input.object);
      const existing = normalized.get(norm);
      if (existing !== undefined) {
        input.error(
          `Input name '${display}' conflicts with '${existing}'. Both normalize to '${norm}' internally. Input names must be unique when normalized to lowercase.`,
          input.object,
        );
      }
      inputNames.add(display);
      normalized.set(norm, display);
    }
    for (const input of inputs) {
      const id = attributeId(input, "Input");
      const display = attributeName(input);
      unsupported(input, "tableName");
      unsupported(input, "tableSysId");
      const type = dataType(input);
      const testValues = input.string("testValues") ?? "";
      if (testValues.trim() !== "") {
        if (type === "numeric" && Number.isNaN(Number(testValues))) {
          input.error(`Input attribute '${display}': testValues '${testValues}' is not valid for dataType 'numeric'. Please provide a valid number.`, input.get("testValues"));
        }
        if (type === "boolean" && !["true", "false", "1", "0"].includes(testValues.toLowerCase())) {
          input.error(
            `Input attribute '${display}': testValues '${testValues}' is not valid for dataType 'boolean'. Please provide 'true', 'false', '1', or '0'.`,
            input.get("testValues"),
          );
        }
      }
      attribute(input, id, {
        data_type: type,
        default_value: testValues,
        description: input.string("description") ?? "",
        label: display,
        mandatory: flag(input, "mandatory"),
        name: internalName(display),
        truncate: flag(input, "truncate"),
        type: "input",
      });
    }

    const outputs = (o.array("outputs") ?? []).map((item, i) => o.sub(item, `outputs[${i}].`, OUTPUT_PROPERTIES));
    const standardIds = new Map<string, string>();
    const custom: Options[] = [];
    for (const output of outputs) {
      const display = output.string("name") ?? "";
      if (display && STANDARD_OUTPUTS.some(([std]) => std === internalName(display))) {
        const id = output.explicitId();
        if (id !== undefined) standardIds.set(display, String(id));
      } else custom.push(output);
    }
    for (const [std, label, text] of STANDARD_OUTPUTS) {
      attribute(o, standardIds.get(std) ?? `${String(skillKey)}__output_${std}`, { data_type: "string", description: text, label, name: std, type: "output" });
    }
    const outputNames = new Set<string>();
    for (const output of custom) {
      const display = output.string("name") ?? "unknown";
      if (outputNames.has(display)) output.error(`Duplicate output name '${display}'. Each output must have a unique name.`, output.object);
      if (inputNames.has(display)) {
        output.error(`Output name '${display}' conflicts with an input name. Input and output names must be unique across both.`, output.object);
      }
      outputNames.add(display);
    }
    for (const output of custom) {
      const id = attributeId(output, "Output");
      const display = attributeName(output);
      unsupported(output, "tableName");
      attribute(output, id, {
        data_type: dataType(output),
        description: output.string("description") ?? "",
        label: display,
        name: internalName(display),
        type: "output",
      });
    }

    const feature = child("sys_gen_ai_feature_mapping", o.object, undefined, {
      active: true,
      document: capability.id.getValue(),
      document_table: "sys_one_extend_capability",
      feature_name: name,
      licensable: true,
    });
    child("sys_gen_ai_strategy_mapping", o.object, undefined, { active: true, feature, strategy: "CAPABILITY_EXECUTION" });
    child("sys_one_extend_resource_mapping", o.object, undefined, {
      active: true,
      applicability_script: APPLICABILITY_SCRIPT,
      depends_on_list: "",
      metadata: "{}",
      parent_capability: capability,
      resource_capability: capability,
      resource_name: name,
    });

    const security: Options | undefined = o.nested("securityControls", ["userAccess", "roleRestrictions", "roleMap"]);
    if (security) {
      const access = security.get("userAccess");
      if (access?.kind !== "object") return security.error("securityControls.userAccess is required and must be an object", security.object);
      const user: Options = security.sub(access, "userAccess.", ["$id", "type", "roles"]);
      const type = user.string("type");
      if (type !== "authenticated" && type !== "roles") {
        user.error(`securityControls.userAccess.type must be 'authenticated' or 'roles'. Got: ${type}`, user.object);
      }
      if (type === "roles") unsupported(user, "type", "userAccess type 'roles'");
      unsupported(user, "roles");
      unsupported(security, "roleMap");
      const roles = security.stringArray("roleRestrictions") ?? [];
      for (const role of roles) {
        if (!isGUID(role)) {
          security.error(
            `roleRestrictions must contain only role sys_ids (GUIDs), not role names. Got: '${role}'. Use the role sys_id when using roleRestrictions (e.g., '${ADMIN_ROLE_SYS_ID}' for admin).`,
            security.get("roleRestrictions"),
          );
        }
      }
      if (roles.length === 0) security.error("securityControls must have at least one of roleRestrictions or roleMap defined.", security.object);
      const aclId = user.get("$id");
      if (aclId?.kind !== "nowId") user.error(`${o.call.api}(): 'securityControls.userAccess.$id' must be a Now.ID[...].`, aclId ?? user.object);
      child("sys_security_acl", user.object, aclId.key, {
        active: true,
        admin_overrides: true,
        advanced: false,
        decision_type: "allow",
        local_or_existing: "Existing",
        name: `${sanitizeSkillName(name)}.${skill.id.getValue()}`,
        operation: "execute",
        security_attribute: ACL_SECURITY_ATTRIBUTE,
        type: ACL_TYPE,
      });
      child("sys_agent_access_role_configuration", security.object, undefined, {
        action: "limit_to_roles",
        agent: skill.id.getValue(),
        agent_table: "sn_nowassist_skill_config",
        name,
        role_list: roles.join(","),
      });
    }
    return capability;
  },
};
