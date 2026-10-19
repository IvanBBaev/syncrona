// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const ACL = "2831a114c611228501d4ea6c309d626d";
const NOW_LLM_FLOW = "936e514a53b3b110f028ddeeff7b128c";
const version = (options = "") => `{ $id: Now.ID['v'], prompt: 'Hi', ${options} }`;
const provider = (options = "", prompts = `[{ name: 'P', versions: [${version()}] }]`) => `{ prompts: ${prompts}, ${options} }`;
const skill = (definition = "", config = `{ providers: [${provider()}] }`) =>
  `NowAssistSkillConfig({ $id: Now.ID['s'], name: 'Skill', ${definition} }, ${config})\n`;

describe("NowAssistSkillConfig()", () => {
  it("compiles a minimal skill with defaults", () => {
    const result = compile(skill());
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_one_extend_capability")[0]).toMatchObject({ short_description: "Skill Skill", description: undefined });
    expect(only(result, "sys_one_extend_capability_definition")[0]).toMatchObject({
      api: NOW_LLM_FLOW,
      api_type: "sys_hub_flow",
      name: "Skill (Now LLM Service)",
    });
    expect(only(result, "sys_generative_ai_config")[0]).toMatchObject({ version: "1", max_tokens: "500", model: "llm_generic_small", state: "draft", active: "false" });
    expect(only(result, "sys_generative_ai_prompt_config")[0]).toMatchObject({ is_default: "true" });
    expect(only(result, "sys_one_extend_definition_attribute").map((r) => r.name)).toEqual(["response", "provider", "errorcode", "status", "error"]);
    expect(only(result, "sys_security_acl")).toEqual([]);
    expect(result.records.every((r) => r.rootTable === "[object Object]")).toBe(true);
  });

  it("publishes a skill with a published prompt and resolves providers", () => {
    const providers = [
      provider("provider: 'Azure OpenAI', defaultPrompt: 'B'", `[{ name: 'A', versions: [${version("version: '2', maxTokens: 10, promptState: 'published', model: 'gpt'")}] }, { name: 'B', versions: [{ $id: Now.ID['v2'] }] }]`),
      provider("provider: 'Mine', providerAPI: 'abc'", "[]"),
      provider("provider: 'Other', providerAPI: { type: 'sys_script', id: 'def' }", "[]"),
      provider("provider: 'Empty', providerAPI: {}", "[]"),
    ];
    const result = compile(skill("state: 'published'", `{ defaultProvider: 'Mine', providers: [${providers.join(", ")}] }`));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sn_nowassist_skill_config")[0]).toMatchObject({ state: "1" });
    expect(only(result, "sys_one_extend_capability_definition").map((r) => [r.api, r.api_type])).toEqual([
      ["a55c1c6f530221106b38ddeeff7b12b1", "sys_hub_flow"],
      ["abc", "sys_hub_flow"],
      ["def", "sys_script"],
      [NOW_LLM_FLOW, "sys_hub_flow"],
    ]);
    expect(only(result, "sys_one_extend_definition_config").map((r) => r.default)).toEqual(["false", "true", "false", "false"]);
    expect(only(result, "sys_generative_ai_config").map((r) => [r.version, r.max_tokens, r.state, r.model])).toEqual([
      ["2", "10", "published", "gpt"],
      ["1", "500", "draft", "llm_generic_small"],
    ]);
    expect(only(result, "sys_generative_ai_prompt_config").map((r) => r.is_default)).toEqual(["false", "true"]);
    expect(only(result, "sys_generative_ai_config")[1]).toMatchObject({ prompt: "" });
  });

  it("falls back to the default flow for an empty providerAPI and a provider without prompts", () => {
    const result = compile(skill("", "{ providers: [{ providerAPI: '' } as any] }"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_one_extend_capability_definition")[0]).toMatchObject({ api: NOW_LLM_FLOW });
    expect(only(result, "sys_generative_ai_config")).toEqual([]);
  });

  it("maps standard output ids and writes custom outputs", () => {
    const inputs = "inputs: [{ $id: Now.ID['i1'], name: 'Count', dataType: 'numeric', testValues: '3', mandatory: 'true', truncate: '1' }, { $id: Now.ID['i2'], name: 'On', dataType: 'boolean', testValues: 'TRUE', truncate: false }, { $id: Now.ID['i3'], name: 'Text', testValues: ' ' }]";
    const outputs = "outputs: [{ $id: Now.ID['resp'], name: 'response' }, { name: 'status' }, { $id: Now.ID['o1'], name: 'Summary Text' }]";
    const result = compile(skill(`${inputs}, ${outputs}`));
    expect(messages(result)).toEqual([]);
    const attributes = only(result, "sys_one_extend_definition_attribute");
    expect(attributes.map((r) => [r.type, r.name, r.data_type, r.mandatory, r.truncate, r.default_value])).toEqual([
      ["input", "count", "numeric", "true", "true", "3"],
      ["input", "on", "boolean", "false", "false", "TRUE"],
      ["input", "text", "string", "false", "false", " "],
      ["output", "response", "string", undefined, undefined, undefined],
      ["output", "provider", "string", undefined, undefined, undefined],
      ["output", "errorcode", "string", undefined, undefined, undefined],
      ["output", "status", "string", undefined, undefined, undefined],
      ["output", "error", "string", undefined, undefined, undefined],
      ["output", "summary_text", "string", undefined, undefined, undefined],
    ]);
  });

  it("writes an ACL and the agent access role configuration", () => {
    const result = compile(skill(`securityControls: { userAccess: { $id: Now.ID['acl'], type: 'authenticated' }, roleRestrictions: ['${ACL}', '${ACL}'] }`));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_security_acl")[0]).toMatchObject({ operation: "execute", decision_type: "allow" });
    expect(only(result, "sys_agent_access_role_configuration")[0]).toMatchObject({ role_list: `${ACL},${ACL}`, name: "Skill" });
  });

  it.each([
    ["NowAssistSkillConfig('x' as any, {} as any)\n", "NowAssistSkillConfig requires a definition object as the first argument"],
    ["NowAssistSkillConfig({ name: 'S' } as any)\n", "NowAssistSkillConfig requires a prompt configuration object as the second argument"],
    ["NowAssistSkillConfig({ name: 'S' } as any, 'x' as any)\n", "NowAssistSkillConfig requires a prompt configuration object as the second argument"],
    [skill("tools: []"), "NowAssistSkillConfig(): 'tools' is not supported by the native compiler yet."],
    [skill("", "{ providers: [], other: 1 } as any"), "NowAssistSkillConfig() has no property 'promptConfig.other'."],
    ["NowAssistSkillConfig({ $id: Now.ID['s'] } as any, { providers: [] })\n", "NowAssistSkillConfig requires a name"],
    ["NowAssistSkillConfig({ $id: Now.ID['s'], name: ' ' }, { providers: [] })\n", "NowAssistSkillConfig requires a name"],
    [`NowAssistSkillConfig({ $id: Now.ID['s'], name: '${"a".repeat(41)}' }, { providers: [] })\n`, "Skill name must not exceed 40 characters (current length: 41)"],
    ["NowAssistSkillConfig({ $id: Now.ID['s'], name: 'a_b-c_' }, { providers: [] })\n", "Skill name 'a_b-c_' contains invalid character(s): _, -. Skill names must contain only letters, numbers, and spaces. Please remove special characters, underscores, and punctuation."],
    [skill("", "{ providers: [] }"), "providers array cannot be empty"],
    [skill("", "{} as any"), "providers array cannot be empty"],
    [skill("", `{ providers: [${provider("defaultPromptVersion: 1")}] }`), "NowAssistSkillConfig(): 'promptConfig.providers[0].defaultPromptVersion' is not supported by the native compiler yet."],
    [skill("", `{ providers: [${provider("provider: 'Nope'")}] }`), expect.stringContaining('Unknown provider "Nope". Please either:\n1. Use a known provider: Now LLM Service, ')],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version()}] }, { name: 'P', versions: [${version()}] }]`)}] }`), "Duplicate prompt name 'P'. Each prompt must have a unique name across the entire skill."],
    [skill("", `{ providers: [${provider("", "[{ versions: [] } as any]")}] }`), "Prompt name '' contains invalid character(s): . Prompt names must contain only letters, numbers, and spaces. Please remove special characters, underscores, and punctuation."],
    [skill("", `{ providers: [${provider("", "[{ name: 'P', versions: [] }]")}] }`), "Prompt 'P' must have at least one version in the versions array."],
    [skill("", `{ providers: [${provider("", "[{ name: 'P' } as any]")}] }`), "Prompt 'P' must have at least one version in the versions array."],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version()}, ${version()}] }]`)}] }`), "NowAssistSkillConfig(): more than one prompt version is not supported by the native compiler yet."],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version("version: 1.5")}] }]`)}] }`), "Version '1.5' of prompt 'P' must be a positive integer (e.g., 1, 2, 3)."],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version("version: -1")}] }]`)}] }`), "Version '-1' of prompt 'P' must be a positive integer (e.g., 1, 2, 3)."],
    [skill("", `{ providers: [${provider("defaultPrompt: 'Q'")}] }`), "defaultPrompt 'Q' does not match any prompt name in provider 'Now LLM Service'. Available prompts: P"],
    [skill("", `{ defaultProvider: 'Q', providers: [${provider()}] }`), "defaultProvider 'Q' does not match any provider name. Available providers: Now LLM Service"],
    ["NowAssistSkillConfig({ name: 'S' }, { providers: [{ prompts: [] }] })\n", "NowAssistSkillConfig(): '$id' is required."],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version("filterCondition: 'a=b'")}] }]`)}] }`), "NowAssistSkillConfig(): 'promptConfig.providers[0].prompts[0].versions[0].filterCondition' is not supported by the native compiler yet."],
    [skill("", `{ providers: [${provider("", "[{ name: 'P', versions: [{ prompt: 1 as any }] }]")}] }`), "NowAssistSkillConfig(): a prompt that is not a string literal is not supported by the native compiler yet."],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version("maxTokens: 130723")}] }]`)}] }`), "max_tokens value '130723' is out of range. max_tokens must be between 0 and 130722. Please adjust the value."],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version("maxTokens: -1")}] }]`)}] }`), "max_tokens value '-1' is out of range. max_tokens must be between 0 and 130722. Please adjust the value."],
    [skill("", `{ providers: [${provider("", `[{ name: 'P', versions: [${version("promptState: 'published'")}] }]`)}] }`), "Cannot set prompt 'P' state to 'published' because the skill state is not 'published'. Please set the skill state to 'published' before publishing any prompts."],
    [skill("", `{ providers: [${provider("", "[{ name: 'P', versions: [{ prompt: 'x' }] }]")}] }`), "Cannot determine the sys_id of this sys_generative_ai_config record: give it a $id."],
    [skill("state: 'published'"), "Cannot publish skill without at least one published prompt. Please ensure at least one prompt has promptState set to 'published'."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A B' }, { $id: Now.ID['b'], name: 'A B' }]"), "Duplicate input name 'A B'. Each input must have a unique name."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A B' }, { $id: Now.ID['b'], name: 'a  b' }]"), "Input name 'a  b' conflicts with 'A B'. Both normalize to 'a_b' internally. Input names must be unique when normalized to lowercase."],
    [skill("inputs: [{ name: 'A' } as any]"), "Input attribute '$id' is required and must use Now.ID['key']."],
    [skill("inputs: [{ $id: 'x', name: 'A' } as any]"), "Input attribute '$id' is required and must use Now.ID['key']."],
    [skill("inputs: [{ $id: Now.ID['a'] } as any]"), "Attribute name is required and cannot be empty"],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'a.b' }]"), "Attribute name 'a.b' contains invalid character(s): .. Attribute names must contain only letters, numbers, and spaces. Please remove special characters, underscores, and punctuation."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A', tableName: 'incident' } as any]"), "NowAssistSkillConfig(): 'inputs[0].tableName' is not supported by the native compiler yet."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A', dataType: 'glide_record' } as any]"), "NowAssistSkillConfig(): dataType 'glide_record' is not supported by the native compiler yet."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A', dataType: 'numeric', testValues: 'x' }]"), "Input attribute 'A': testValues 'x' is not valid for dataType 'numeric'. Please provide a valid number."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A', dataType: 'boolean', testValues: 'yes' }]"), "Input attribute 'A': testValues 'yes' is not valid for dataType 'boolean'. Please provide 'true', 'false', '1', or '0'."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A', mandatory: 1 as any }]"), "NowAssistSkillConfig(): 'inputs[0].mandatory' must be a boolean."],
    [skill("outputs: [{ $id: Now.ID['a'], name: 'A' }, { $id: Now.ID['b'], name: 'A' }]"), "Duplicate output name 'A'. Each output must have a unique name."],
    [skill("inputs: [{ $id: Now.ID['a'], name: 'A' }], outputs: [{ $id: Now.ID['b'], name: 'A' }]"), "Output name 'A' conflicts with an input name. Input and output names must be unique across both."],
    [skill("outputs: [{ $id: Now.ID['a'] } as any]"), "Attribute name is required and cannot be empty"],
    [skill("outputs: [{ name: 'A' } as any]"), "Output attribute '$id' is required and must use Now.ID['key']."],
    [skill("outputs: [{ $id: Now.ID['a'], name: 'A', dataType: 'json_array' } as any]"), "NowAssistSkillConfig(): dataType 'json_array' is not supported by the native compiler yet."],
    [skill("securityControls: {} as any"), "securityControls.userAccess is required and must be an object"],
    [skill("securityControls: { userAccess: 'x' } as any"), "securityControls.userAccess is required and must be an object"],
    [skill(`securityControls: { userAccess: { $id: Now.ID['acl'], type: 'x' }, roleRestrictions: ['${ACL}'] } as any`), "securityControls.userAccess.type must be 'authenticated' or 'roles'. Got: x"],
    [skill(`securityControls: { userAccess: { $id: Now.ID['acl'], type: 'roles' }, roleRestrictions: ['${ACL}'] } as any`), "NowAssistSkillConfig(): userAccess type 'roles' is not supported by the native compiler yet."],
    [skill(`securityControls: { userAccess: { $id: Now.ID['acl'], type: 'authenticated' }, roleMap: {} } as any`), "NowAssistSkillConfig(): 'securityControls.roleMap' is not supported by the native compiler yet."],
    [skill("securityControls: { userAccess: { $id: Now.ID['acl'], type: 'authenticated' }, roleRestrictions: ['admin'] }"), `roleRestrictions must contain only role sys_ids (GUIDs), not role names. Got: 'admin'. Use the role sys_id when using roleRestrictions (e.g., '${ACL}' for admin).`],
    [skill("securityControls: { userAccess: { $id: Now.ID['acl'], type: 'authenticated' } } as any"), "securityControls must have at least one of roleRestrictions or roleMap defined."],
    [skill(`securityControls: { userAccess: { type: 'authenticated' }, roleRestrictions: ['${ACL}'] } as any`), "NowAssistSkillConfig(): 'securityControls.userAccess.$id' must be a Now.ID[...]."],
  ])("rejects %s", (source, error) => {
    expect(messages(compile(source))).toEqual([error]);
  });
});
