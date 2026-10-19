// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const ADMIN = "2831a114c611228501d4ea6c309d626d";
const ITIL = "282bf1fac6112285017366cb5f867469";
const ACL = "securityAcl: { $id: Now.ID['acl'], type: 'Any authenticated user' }";
const agent = (options = "", acl = ACL) => `AiAgent({ $id: Now.ID['agent'], name: 'Agent', ${acl}, ${options} })\n`;
const tool = (options: string) => agent(`tools: [{ name: 'T', ${options} }]`);

describe("AiAgent()", () => {
  it("compiles a minimal agent with defaults", () => {
    const result = compile(agent());
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_security_acl")[0]).toMatchObject({
      name: "global.x_snc_bprobe.Agent",
      security_attribute: "239bdf0c47d23110ba46ff58936d4330",
      operation: "execute",
    });
    expect(only(result, "sys_security_acl_role")).toEqual([]);
    expect(only(result, "sn_aia_agent")[0]).toMatchObject({
      agent_type: "internal",
      channel: "nap_and_va",
      instructions: "",
      internal_name: "global.x_snc_bprobe.Agent",
      record_type: "template",
      sys_domain: "global",
    });
    expect(only(result, "sn_aia_agent")[0].context_processing_script).toMatch(/^\/\*\n \* Available Variables:/);
    expect(only(result, "sn_aia_agent_config")[0]).toMatchObject({ active: "true", public: "false", run_as_user: "" });
    expect(only(result, "sn_aia_version")).toEqual([
      expect.objectContaining({ state: "draft", instructions: "", version_name: "Agent", version_number: "1" }),
    ]);
    expect(only(result, "sys_agent_access_role_configuration")).toEqual([]);
  });

  it("names a draft version V1 and the ACL after an empty name in a custom domain", () => {
    const result = compile(`AiAgent({ $id: Now.ID['agent'], sysDomain: 'acme', ${ACL} })\n`);
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_security_acl")[0]).toMatchObject({ name: "acme.x_snc_bprobe." });
    expect(only(result, "sn_aia_agent")[0]).toMatchObject({ sys_domain: "acme" });
    expect(only(result, "sn_aia_version")[0]).toMatchObject({ version_name: "V1" });
  });

  it("takes instructions from the one published version and defaults version fields", () => {
    const result = compile(agent("versionDetails: [{ state: 'draft', instructions: 'Old', name: 'V2', number: 2 }, { state: 'published' }, { name: 'V3', number: 3, condition: 'c' }]"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sn_aia_agent")[0]).toMatchObject({ instructions: "" });
    expect(only(result, "sn_aia_version").map((r) => [r.state, r.version_name, r.version_number, r.instructions])).toEqual([
      ["draft", "V2", "2", "Old"],
      ["published", "V1", "1", undefined],
      ["published", "V3", "3", undefined],
    ]);
  });

  it("grants a public ACL to the public role", () => {
    const result = compile(agent("", "securityAcl: { $id: Now.ID['acl'], type: 'Public' }"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_security_acl")[0]).toMatchObject({ security_attribute: "" });
    expect(only(result, "sys_security_acl_role")[0]).toMatchObject({ sys_user_role: "b0593b350a0a0aa7001d689e4542dc28" });
  });

  it("grants a role ACL to role sys_ids, names and Role() records", () => {
    const source = `const r = Role({ name: 'x_snc_bprobe.agent_user' })\n${agent("", `securityAcl: { $id: Now.ID['acl'], type: 'Specific role', roles: ['${ADMIN}', 'itil', r] }`)}`;
    const result = compile(source);
    expect(messages(result)).toEqual([]);
    const roles = only(result, "sys_security_acl_role");
    expect(roles.map((r) => r["sys_user_role@name"])).toEqual([undefined, "itil", "x_snc_bprobe.agent_user"]);
    expect(roles[0].sys_user_role).toBe(ADMIN);
  });

  it("limits data access to roleList sys_ids and roleMap names and records", () => {
    const source = `const r = Role({ name: 'x_snc_bprobe.reader' })\n${agent(`dataAccess: { roleList: ['${ADMIN}', '', r], roleMap: ['itil', ' ', r], description: 'D' }`)}`;
    const result = compile(source);
    expect(messages(result)).toEqual([]);
    const config = only(result, "sys_agent_access_role_configuration")[0];
    expect(config).toMatchObject({ action: "limit_to_roles", description: "D", agent_table: "sn_aia_agent" });
    expect(config.role_list).toMatch(new RegExp(`^${ADMIN},[0-9a-f]{32}$`));
    expect(only(result, "sys_agent_access_role_mapping").map((r) => r["role@name"])).toEqual(["itil", "x_snc_bprobe.reader"]);
  });

  it("accepts empty data access with a runAsUser", () => {
    const result = compile(agent(`runAsUser: '${ITIL}', dataAccess: { roleList: [] }`));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_agent_access_role_configuration")[0]).toMatchObject({ role_list: "", description: "" });
  });

  it("writes triggers and their use case links", () => {
    const triggers = [
      "{ name: 'Daily', domain: 'acme', objectiveTemplate: 'Go', active: true, sysOverrides: 'a', m2mSysOverrides: 'b', schedule: { runDayOfMonth: 1, runDayOfWeek: 2, repeatInterval: '1970-01-01 01:00:00', starting: '2026-01-01 00:00:00', time: '1970-01-01 08:00:00', triggerStrategy: 'every' } }",
      "{}",
      "'ignored'",
    ];
    const result = compile(agent(`triggerConfig: [${triggers.join(", ")}] as any`));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sn_aia_trigger_configuration").map((r) => [r.internal_name, r.sys_domain, r.objective_template, r.run_dayofmonth, r.run_dayofweek, r.run_period, r.run_start, r.run_time, r.trigger_strategy, r.condition, r.sys_overrides])).toEqual([
      ["acme.x_snc_bprobe.Daily", "acme", "Go", "1", "2", "1970-01-01 01:00:00", "2026-01-01 00:00:00", "1970-01-01 08:00:00", "every", "", "a"],
      ["global.x_snc_bprobe.", "global", "", undefined, undefined, undefined, undefined, undefined, undefined, "", ""],
    ]);
    expect(only(result, "sn_aia_trigger_agent_usecase_m2m").map((r) => [r.active, r.objective_template, r.sys_domain, r.sys_overrides])).toEqual([
      ["true", "Go", "acme", "b"],
      ["false", undefined, "global", ""],
    ]);
  });

  it("links out-of-the-box tools without a tool record", () => {
    const result = compile(agent("tools: [{ name: 'S', type: 'web_automation' }, { name: 'K', type: 'knowledge_graph', inputs: [{ name: 'q', value: 1, extra: null, nested: [true, null] }] }, { name: 'W', type: 'web_automation', inputs: [] }]"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sn_aia_tool")).toEqual([]);
    expect(only(result, "sn_aia_agent_tool_m2m").map((r) => [r.tool, r.inputs])).toEqual([
      ["576cf8eaffd922101dbaffffffffff66", '[{"name":"search_type","value":"ai_answers","metadata":{"_MODE_":"user"}}]'],
      ["3b8c4f4fc3e022100e94313a05013167", '[{"name":"q","value":1,"nested":[true,null]}]'],
      ["576cf8eaffd922101dbaffffffffff66", '[{"name":"search_type","value":"ai_answers","metadata":{"_MODE_":"user"}}]'],
    ]);
  });

  it("writes tool records with their target documents", () => {
    const tools = [
      "{ name: 'Cap', type: 'capability', capabilityId: 'cap1', widgets: ['w1', 'w2'], timeout: 30 }",
      "{ name: 'Topic', type: 'topic_block', virtualAgentId: r, widgets: 'w3' }",
      "{ name: 'Mcp', type: 'mcp', targetDocument: 'doc' }",
      "{ name: 'Custom', type: 'other', inputs: [{ name: 'crudInputs', description: 'x', mandatory: false }, {}] }",
      "{ name: 'Plain' }",
    ];
    const source = `const r = Role({ name: 'x_snc_bprobe.topic' })\n${agent(`tools: [${tools.join(", ")}] as any`)}`;
    const result = compile(source);
    expect(messages(result)).toEqual([]);
    expect(only(result, "sn_aia_tool").map((r) => [r.name, r.type, r.target_document, r.target_document_table, r.input_schema, r.script])).toEqual([
      ["Cap", "capability", "cap1", "sn_nowassist_skill_config", "[]", ""],
      ["Topic", "topic_block", expect.stringMatching(/^[0-9a-f]{32}$/), "sys_cs_topic", "[]", ""],
      ["Mcp", "mcp", "doc", "sn_aia_tool", "[]", ""],
      ["Custom", "other", "", "", '[{"name":"crudInputs","description":"x","mandatory":false},{}]', ""],
      ["Plain", undefined, "", "", "[]", ""],
    ]);
    expect(only(result, "sn_aia_agent_tool_m2m").map((r) => [r.widgets, r.timeout, r.tool_attributes, r.max_auto_executions])).toEqual([
      ["w1,w2", "30", "{}", "10"],
      ["w3", undefined, "{}", "10"],
      [undefined, undefined, "{}", "10"],
      [undefined, undefined, "{}", "10"],
      [undefined, undefined, "{}", "10"],
    ]);
  });

  it("accepts a tool without a name", () => {
    expect(messages(compile(agent("tools: [{ type: 'web_automation' }] as any")))).toEqual([]);
  });

  it("maps known memory categories and drops unknown ones", () => {
    const result = compile(agent("memoryCategories: ['projects', 'unknown', 1] as any"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sn_aia_ltm_category_mapping").map((r) => r.category)).toEqual(["6b49e262431312107c4d14020ab8f2a9"]);
  });

  it.each([
    [`AiAgent({ $id: Now.ID['agent'] })`, "AI Agent must have a securityAcl field."],
    [agent("", "securityAcl: { $id: Now.ID['acl'], type: 'Everyone' }"), "securityAcl.type must be 'Any authenticated user', 'Specific role', or 'Public'. Got: 'Everyone'"],
    [agent("", "securityAcl: { $id: Now.ID['acl'] }"), "securityAcl.type must be 'Any authenticated user', 'Specific role', or 'Public'. Got: 'undefined'"],
    [agent("", "securityAcl: { $id: Now.ID['acl'], type: 'Specific role' }"), "securityAcl.roles must be an array when type is 'Specific role'"],
    [agent("", "securityAcl: { $id: Now.ID['acl'], type: 'Specific role', roles: [] }"), "securityAcl.roles must contain at least one role"],
    [agent("", "securityAcl: { $id: Now.ID['acl'], type: 'Specific role', roles: [1] }"), "AiAgent(): 'securityAcl.roles' must hold role names, sys_ids or Role() records."],
    [agent("", "securityAcl: { $id: 'acl', type: 'Public' }"), "AiAgent(): 'securityAcl.$id' must be a Now.ID[...]."],
    [agent("", "securityAcl: { type: 'Public' }"), "AiAgent(): 'securityAcl.$id' must be a Now.ID[...]."],
    [agent("versionDetails: [{ state: 'published' }, { state: 'published' }]"), "AI Agent 'Agent' has multiple versions with state 'published'. Only one version can be published at a time."],
    [agent("dataAccess: {}"), "dataAccess must have at least one of roleList or roleMap non-empty: provide sys_ids in roleList, role names in roleMap, or both."],
    [agent("dataAccess: { roleList: ['admin'] }"), "roleList must contain only role sys_ids (GUIDs), not role names. Got: 'admin'. Use the role sys_id when using roleList (e.g., '2831a114c611228501d4ea6c309d626d' for admin), or use roleMap for role names."],
    [agent("dataAccess: { roleList: [1] } as any"), "AiAgent(): 'dataAccess.roleList' must hold role sys_ids or Role() records."],
    [agent(`dataAccess: { roleMap: ['${ADMIN}'] }`), `roleMap must contain role names, not sys_ids. Got: '${ADMIN}'. Use the role name (e.g., 'admin'), or move the sys_id to dataAccess.roleList.`],
    [agent("dataAccess: { roleMap: [1] } as any"), "AiAgent(): 'dataAccess.roleMap' must hold role names or Role() records."],
    [agent("tools: [{ name: 'A' }, { name: 'A' }]"), 'Duplicate tool name "A". Each tool must have a unique name.'],
    [tool("type: 'rag'"), "AiAgent(): tool type 'rag' is not supported by the native compiler yet."],
    [tool("type: 'crud'"), "AiAgent(): tool type 'crud' is not supported by the native compiler yet."],
    [tool("inputs: {} as any"), "AiAgent(): 'tools[0].inputs' other than an array is not supported by the native compiler yet."],
    [tool("inputs: [{ name: 1 }] as any"), "AiAgent(): 'tools[0].inputs[].name' must be a string."],
    [tool("type: 'web_automation', inputs: [{ value: Now.ID['x'] }] as any"), "AiAgent(): 'tools[0].inputs' must be JSON data."],
    [tool("timeout: [] as any"), "AiAgent(): 'tools[0].timeout' must be a string, number or boolean."],
    [tool("widgets: [1] as any"), "AiAgent(): 'tools[0].widgets' must be a sys_id or a record."],
    [tool("type: 'subflow', subflowId: 1 as any"), "AiAgent(): 'tools[0].subflowId' must be a sys_id or a record."],
    [agent("colour: 1 as any"), "AiAgent() has no property 'colour'."],
  ])("rejects %s", (source, message) => {
    expect(messages(compile(source))).toContain(message);
  });
});
