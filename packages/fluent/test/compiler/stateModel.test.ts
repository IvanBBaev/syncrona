// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const GUID = "0c441abbc6112275000025157c651c89";
const model = (options: string) => `StateModel({ $id: Now.ID['m'], name: 'M', ${options} })\n`;
const states = "states: { a: { $id: Now.ID['a'], label: 'A', value: 1 }, b: { $id: Now.ID['b'], label: 'B', value: 'two' } }";

describe("StateModel()", () => {
  it("writes the SDK's defaults", () => {
    const result = compile(model("table: 'x_snc_bprobe_t'"));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([]);
    expect(only(result, "sttrm_model")).toEqual([
      expect.objectContaining({
        name: "M",
        table_name: "x_snc_bprobe_t",
        state_field: "state",
        active: "true",
        advanced_security: "false",
        read_roles: "",
        write_roles: "",
        template_proposal_access: "",
        template_approval_users: "",
        template_approval_groups: "",
      }),
    ]);
    expect(only(compile(model("")), "sttrm_model")[0]!.table_name).toBe("");
    const bare = compile("StateModel({ $id: Now.ID['m'], table: 'problem_task', states: { a: { $id: Now.ID['a'] } } })\n");
    expect(only(bare, "prb_task_model")[0]).toEqual(expect.objectContaining({ name: "", prb_task_type: "" }));
    expect(only(bare, "sttrm_state")[0]).toEqual(expect.objectContaining({ state_label: "", state_value: "" }));
  });

  it("picks the subclass model table and its fields by the target table", () => {
    const change = compile(model("table: 'change_request', recordPreset: 'p'"));
    expect(only(change, "chg_model")[0]).toEqual(
      expect.objectContaining({
        available_in_ui: "true",
        record_preset: "p",
        apply_record_preset: "true",
        color: "",
        itil_change_process: "",
        default_change_model: "false",
        description: "",
      }),
    );
    expect(only(compile(model("table: 'problem', defaultModel: true")), "prb_model")[0]).toEqual(
      expect.objectContaining({ default_prb_model: "true", description: "" }),
    );
    expect(only(compile(model("table: 'problem_task', taskType: 'rca'")), "prb_task_model")[0]).toEqual(
      expect.objectContaining({ prb_task_type: "rca", default_prb_task_model: "false" }),
    );
  });

  it("hints at fields the model table ignores", () => {
    const result = compile(
      model(
        "table: 't', availableInUI: false, recordPreset: 'p', color: 'blue', itilChangeProcess: 'normal', taskType: 'rca', defaultModel: true, description: 'd', availableFor: ['" +
          GUID +
          "'], writableFor: [], notAvailableFor: []",
      ),
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([
      ...["availableInUI", "recordPreset", "color", "itilChangeProcess"].map(
        (f) => `'${f}' applies only to change_request (chg_model) state models and is ignored for table 't'.`,
      ),
      "'taskType' applies only to problem_task (prb_task_model) state models and is ignored for table 't'.",
      "'defaultModel' is not supported for the base sttrm_model and is ignored for table 't'.",
      "'description' is stored only on subclass model tables (chg_model / prb_model / prb_task_model) and is ignored for table 't'.",
      ...["availableFor", "writableFor", "notAvailableFor"].map((f) => `'${f}' only takes effect when 'advancedSecurity' is enabled.`),
    ]);
    expect(only(result, "sttrm_model_user_criteria_read_mtom")).toEqual([expect.objectContaining({ user_criteria: GUID })]);
  });

  it("joins roles and template approvers", () => {
    const result = compile(
      "const r = Role({ name: 'x_snc_bprobe.r' })\n" +
        "const u = Record({ $id: Now.ID['u'], table: 'sys_user', data: { user_name: 'u' } })\n" +
        model(`table: 't', readRoles: ['itil', r, ''], writeRoles: [r], templateApprovalUsers: [u, '${GUID}'], templateApprovalGroups: ['${GUID}']`),
    );
    expect(messages(result)).toEqual([]);
    const user = only(result, "sys_user")[0]!.sys_id;
    expect(only(result, "sttrm_model")[0]).toEqual(
      expect.objectContaining({
        read_roles: "itil,x_snc_bprobe.r",
        write_roles: "x_snc_bprobe.r",
        template_approval_users: `${user},${GUID}`,
        template_approval_groups: GUID,
      }),
    );
  });

  it("writes states, attributes, transitions, conditions and fields", () => {
    const result = compile(
      model(
        `table: 't', states: { a: { $id: Now.ID['a'], label: 'A', value: 1, initial: true, sequence: 2, attributes: [{ $id: Now.ID['a1'], attribute: 'allowCiModification', active: false }, { $id: Now.ID['a2'], attribute: '${GUID}' }, { attribute: '' }] }, b: { $id: Now.ID['b'], label: 'B', value: 'two' } }, ` +
          "transitions: [{ $id: Now.ID['t'], from: 'a', to: 'b', automatic: true, conditions: [" +
          "{ $id: Now.ID['c1'], name: 'C1', condition: 'x=1', conditionType: 'Transition Condition', fields: [{ $id: Now.ID['f'], name: 'x' }, { name: '' }] }, " +
          `{ $id: Now.ID['c2'], name: 'C2', conditionScript: 'return true', conditionType: '${GUID}', active: false, order: 5, description: 'd' }, ` +
          "{ $id: Now.ID['c3'] }]}]",
      ),
    );
    expect(messages(result)).toEqual([]);
    const [a, b] = only(result, "sttrm_state");
    expect(a).toEqual(expect.objectContaining({ state_label: "A", state_value: "1", state_sequence: "2", initial_state: "true" }));
    expect(b).toEqual(expect.objectContaining({ state_value: "two", state_sequence: "0", initial_state: "false" }));
    expect(only(result, "sttrm_state_attribute")).toEqual([
      expect.objectContaining({ sttrm_attribute: "9fbfd18affa431107f54ffffffffff03", active: "false" }),
      expect.objectContaining({ sttrm_attribute: GUID, active: "true" }),
    ]);
    expect(only(result, "sttrm_state_transition")).toEqual([
      expect.objectContaining({ name: "A to B", automatic: "true", from_state: a!.sys_id, to_state: b!.sys_id }),
    ]);
    const [c1, c2, c3] = only(result, "sttrm_transition_condition");
    expect(c1).toEqual(expect.objectContaining({ name: "C1", condition: "x=1", condition_type: "325636985303101034d1ddeeff7b12ed", order: "100" }));
    expect(c2).toEqual(expect.objectContaining({ condition_script: "return true", condition_type: GUID, active: "false", order: "5", description: "d" }));
    expect(c3).toEqual(expect.objectContaining({ name: "", condition_type: "" }));
    expect(c3!.condition_script).toMatch(/^\(function \(current\) \{/);
    expect(only(result, "sttrm_transition_condition_field")).toEqual([expect.objectContaining({ name: "x", transition_condition: c1!.sys_id })]);
  });

  it("reports the SDK's errors", () => {
    expect(
      messages(
        compile(
          model(
            `table: 't', ${states}, transitions: [{ $id: Now.ID['t1'], from: 'a', to: 'z' }, { $id: Now.ID['t2'], from: 'y', to: 'b' }, { $id: Now.ID['t3'] }]`,
          ),
        ),
      ),
    ).toEqual([
      "Transition 'to' references state 'z' which is not defined in 'states'.",
      "Transition 'from' references state 'y' which is not defined in 'states'.",
    ]);
    expect(
      messages(
        compile(
          model(
            `table: 't', ${states}, transitions: [{ $id: Now.ID['t'], from: 'a', to: 'b', conditions: [{ $id: Now.ID['c'], name: 'C', condition: 'x=1', conditionScript: 's', conditionType: 'Bogus' }] }]`,
          ),
        ),
      ),
    ).toEqual([
      "Condition 'C' sets both 'condition' and 'conditionScript' — they are mutually exclusive.",
      "Unknown conditionType 'Bogus'. Use one of: Transition Condition, Transition Script, Authorized, Mandatory Fields, Not On hold, Risk evaluation, Task has been through Approval, Task is Approved, Task is Rejected — or an sttrm_condition_type sys_id.",
    ]);
    expect(messages(compile(model("table: 't', states: { a: { $id: Now.ID['a'], label: 'A', value: 1, attributes: [{ attribute: 'bogus' }] } }")))).toEqual([
      "Unknown state attribute 'bogus'. Use one of: allowImplementation, allowCiModification — or an sttrm_attribute sys_id.",
    ]);
    expect(messages(compile(model("table: 't', templateApprovalUsers: ['x'], templateApprovalGroups: ['y']")))).toEqual([
      "'templateApprovalUsers[0]' must be a valid GUID or a Record<'sys_user'>. Received: 'x'",
      "'templateApprovalGroups[0]' must be a valid GUID or a Record<'sys_user_group'>. Received: 'y'",
    ]);
  });

  it.each([
    [model("readRoles: [1]"), "StateModel(): 'readRoles' must hold role names or Role() records."],
    [model("templateApprovalUsers: [1]"), "StateModel(): 'templateApprovalUsers' must hold sys_ids or records."],
    [model("advancedSecurity: true, availableFor: [1]"), "StateModel(): 'availableFor' must hold sys_ids or Record<'user_criteria'> records."],
    [model("states: []"), "StateModel(): 'states' must be an object."],
    [model("states: { a: { colour: 1 } }"), "StateModel() has no property 'states.a.colour'."],
    [model("transitions: [{ when: 1 }]"), "StateModel() has no property 'transitions[].when'."],
    [model("severity: 1"), "StateModel() has no property 'severity'."],
  ])("rejects %s", (source, message) => {
    const result = compile(source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(message);
  });
});
