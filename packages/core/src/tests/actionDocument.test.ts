// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP2: custom Flow Designer actions — reading their rows, assembling them into
// one document, and withholding secrets.
import { jest } from "@jest/globals";
import {
  ACTION_DOCUMENT_SCHEMA,
  assembleActionDocument,
  serializeActionDocument,
  type ActionRows,
} from "../flow/actionDocument.js";
import { listScopeActions, readActionDocument, readActionRows, STEP_VALUE_FIELDS } from "../flow/actionReader.js";
import { redactActionSecrets } from "../flow/actionSecrets.js";
import type { FlowReadClient } from "../flow/flowReader.js";

const ACTION = "a".repeat(32);
const STEP1 = "1".repeat(32);
const STEP2 = "2".repeat(32);
const OTHER = "f".repeat(32);
const audit = { sys_created_by: "maint", sys_updated_on: "2024-05-23 20:21:43", sys_mod_count: "3" };

function actionRows(): ActionRows {
  return {
    action: {
      sys_id: ACTION,
      name: "Create Device Snapshot",
      internal_name: "create_device_snapshot",
      state: "published",
      label_cache: '[{"name":"action.groups","label":"Groups"}]',
      outputs: "",
      ...audit,
    },
    inputs: [
      { sys_id: "i2", model: ACTION, element: "users", order: "200", internal_type: "string" },
      { sys_id: "i1", model: ACTION, element: "groups", order: "100", internal_type: "string", ...audit },
    ],
    outputs: [{ sys_id: "o1", model: ACTION, element: "return_value", internal_type: "boolean" }],
    outputMappings: [
      {
        sys_id: "m2",
        id: ACTION,
        table: `var__m_sys_hub_action_output_${ACTION}`,
        field: "return_value",
        value: "{{step[c-2].has_role}}",
      },
      { sys_id: "m1", id: ACTION, table: `var__m_sys_hub_action_output_${ACTION}`, field: "__action_status__" },
    ],
    steps: [
      { sys_id: STEP2, action: ACTION, label: "Create", order: "2", cid: "c-2", step_type: "t-create" },
      { sys_id: STEP1, action: ACTION, label: "Script", order: "1", cid: "c-1", step_type: "t-script", ...audit },
    ],
    stepInputs: [{ sys_id: "si1", model: STEP1, element: "device", order: "1", internal_type: "reference" }],
    stepOutputs: [
      { sys_id: "so1", model: STEP1, element: "has_role", internal_type: "boolean" },
      { sys_id: "so9", model: OTHER, element: "stray" },
    ],
    stepValues: [
      {
        sys_id: "v2",
        document: "sys_hub_step_instance",
        document_key: STEP2,
        order: "100",
        variable: "var-table",
        "variable.element": "create_record_table_name",
        "variable.internal_type": "table_name",
        value: "incident",
      },
      {
        sys_id: "v1",
        document: "sys_hub_step_instance",
        document_key: STEP1,
        order: "100",
        variable: "var-script",
        "variable.element": "script",
        "variable.internal_type": "script_plain",
        value: "(function execute(inputs, outputs) {})(inputs, outputs);",
      },
    ],
    stepMappings: [
      {
        sys_id: "sm1",
        id: STEP2,
        table: "var__m_sys_flow_step_definition_input_x",
        field: "create_record_field_values",
        value: "groups={{action.groups}}",
      },
    ],
  };
}

describe("assembleActionDocument", () => {
  it("assembles the action, its inputs, outputs, mappings and ordered steps", () => {
    const doc = assembleActionDocument(actionRows());
    expect(doc.schema).toBe(ACTION_DOCUMENT_SCHEMA);
    expect(doc.action.sys_id).toBe(ACTION);
    expect(doc.action.fields).toEqual({
      name: "Create Device Snapshot",
      internal_name: "create_device_snapshot",
      state: "published",
    });
    expect(doc.action.payloads).toEqual({
      label_cache: { format: "json", value: [{ name: "action.groups", label: "Groups" }] },
    });
    expect(doc.inputs.map((r) => r.fields.element)).toEqual(["groups", "users"]);
    expect(doc.inputs[0].fields).not.toHaveProperty("model");
    expect(doc.inputs[0].fields).not.toHaveProperty("sys_created_by");
    expect(doc.outputMappings.map((r) => r.fields.field)).toEqual(["__action_status__", "return_value"]);

    expect(doc.steps.map((s) => s.sys_id)).toEqual([STEP1, STEP2]);
    const [script, create] = doc.steps;
    expect(script.order).toBe(1);
    expect(script.fields).toEqual({ label: "Script", cid: "c-1", step_type: "t-script" });
    expect(script.inputs.map((r) => r.sys_id)).toEqual(["si1"]);
    expect(script.outputs.map((r) => r.sys_id)).toEqual(["so1"]);
    expect(script.values).toEqual([
      {
        sys_id: "v1",
        fields: {
          order: "100",
          variable: "var-script",
          "variable.element": "script",
          "variable.internal_type": "script_plain",
          value: "(function execute(inputs, outputs) {})(inputs, outputs);",
        },
      },
    ]);
    expect(script.mappings).toEqual([]);
    expect(create.values.map((r) => r.fields.value)).toEqual(["incident"]);
    expect(create.mappings.map((r) => r.fields.value)).toEqual(["groups={{action.groups}}"]);
    expect(doc.warnings).toEqual([
      `step output so9 names step ${OTHER}, which is not a step of this action; left out`,
    ]);
  });

  it("serializes the same rows to the same bytes in any row order", () => {
    const rows = actionRows();
    const reversed: ActionRows = {
      ...rows,
      inputs: [...rows.inputs].reverse(),
      steps: [...rows.steps].reverse(),
      stepValues: [...rows.stepValues].reverse(),
      outputMappings: [...rows.outputMappings].reverse(),
    };
    const text = serializeActionDocument(assembleActionDocument(rows));
    expect(serializeActionDocument(assembleActionDocument(reversed))).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("breaks order ties by cid, then sys_id, and puts unordered steps last", () => {
    const rows = actionRows();
    rows.steps = [
      { sys_id: "s4", action: ACTION },
      { sys_id: "s3", action: ACTION, order: "1", cid: "b" },
      { sys_id: "s2", action: ACTION, order: "1", cid: "a" },
      { sys_id: "s1", action: ACTION, order: "1", cid: "a" },
    ];
    rows.stepInputs = [];
    rows.stepOutputs = [];
    rows.stepValues = [];
    rows.stepMappings = [];
    expect(assembleActionDocument(rows).steps.map((s) => s.sys_id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("reports a row that names no step", () => {
    const rows = actionRows();
    rows.stepValues = [{ sys_id: "v0", document_key: "" }];
    expect(assembleActionDocument(rows).warnings).toContain(
      "step value v0 names step (none), which is not a step of this action; left out"
    );
  });
});

describe("redactActionSecrets", () => {
  it("withholds secret defaults and secret step values, and lists each one", () => {
    const rows = actionRows();
    rows.inputs.push({ sys_id: "i3", model: ACTION, element: "token", internal_type: "password2", default_value: "s3cr3t" });
    rows.stepInputs.push({ sys_id: "si2", model: STEP1, element: "key", internal_type: "masked", default_value: "k3y" });
    rows.stepValues.push({
      sys_id: "v3",
      document_key: STEP2,
      "variable.element": "rest_password",
      "variable.internal_type": "password2",
      value: "hunter2",
    });
    const before = assembleActionDocument(rows);
    const doc = redactActionSecrets(before);
    const text = serializeActionDocument(doc);
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("k3y");
    expect(text).not.toContain("hunter2");
    expect(doc.steps[1].values.find((v) => v.sys_id === "v3")?.fields.value).toBe("<redacted:password2>");
    expect(doc.steps[1].values.find((v) => v.sys_id === "v2")?.fields.value).toBe("incident");
    expect(doc.warnings).toEqual([
      ...before.warnings,
      "input i3: default_value withheld (password2)",
      "step input si2: default_value withheld (masked)",
      "step value v3: value withheld (password2)",
    ]);
    // The input document is left as it was.
    expect(serializeActionDocument(before)).toContain("hunter2");
  });
});

// An in-memory Table API that understands the `=`, `IN` and `STARTSWITH`
// conditions the reader sends, joined by `^`.
type Rows = Record<string, Record<string, unknown>[]>;
type Call = { table: string; query: string; fields: string };

function fakeClient(tables: Rows) {
  const calls: Call[] = [];
  const matches = (row: Record<string, unknown>, condition: string): boolean => {
    const startsWith = /^([\w.]+)STARTSWITH(.*)$/.exec(condition);
    if (startsWith) return String(row[startsWith[1]] ?? "").startsWith(startsWith[2]);
    const inList = /^([\w.]+)IN(.*)$/.exec(condition);
    if (inList) return inList[2].split(",").includes(String(row[inList[1]] ?? ""));
    const [column, value] = condition.split("=");
    return String(row[column] ?? "") === value;
  };
  const tableAPIGet = jest.fn(async (table: string, query: string, fields: string, limit = 500, offset = 0) => {
    calls.push({ table, query, fields });
    const conditions = query.split("^").filter((c) => !c.startsWith("ORDERBY"));
    const rows = (tables[table] ?? []).filter((row) => conditions.every((c) => matches(row, c)));
    return { data: { result: rows.slice(offset, offset + limit) }, headers: { "x-total-count": String(rows.length) } };
  });
  return { client: { tableAPIGet } as unknown as FlowReadClient, calls };
}

function instanceTables(): Rows {
  const rows = actionRows();
  return {
    sys_hub_action_type_definition: [{ ...rows.action, "sys_scope.scope": "x_demo" }],
    sys_hub_action_input: rows.inputs,
    sys_hub_action_output: rows.outputs,
    sys_element_mapping: [
      ...rows.outputMappings,
      ...rows.stepMappings,
      // An action instance's input mapping inside a flow: not part of the action.
      { sys_id: "mx", id: ACTION, table: "var__m_sys_hub_action_input_snap", field: "groups" },
    ],
    sys_hub_step_instance: rows.steps,
    sys_hub_step_ext_input: rows.stepInputs,
    sys_hub_step_ext_output: rows.stepOutputs.filter((row) => row.model !== OTHER),
    sys_variable_value: rows.stepValues,
  };
}

describe("readActionRows", () => {
  it("reads the action and every part of it, sequentially and read-only", async () => {
    const { client, calls } = fakeClient(instanceTables());
    const rows = await readActionRows(client, ACTION);
    expect(rows.action.sys_id).toBe(ACTION);
    expect(rows.inputs).toHaveLength(2);
    expect(rows.outputMappings.map((r) => r.sys_id).sort()).toEqual(["m1", "m2"]);
    expect(rows.stepMappings.map((r) => r.sys_id)).toEqual(["sm1"]);
    expect(rows.stepValues).toHaveLength(2);
    expect(calls.map((c) => c.table)).toEqual([
      "sys_hub_action_type_definition",
      "sys_hub_action_input",
      "sys_hub_action_output",
      "sys_element_mapping",
      "sys_hub_step_instance",
      "sys_hub_step_ext_input",
      "sys_hub_step_ext_output",
      "sys_variable_value",
      "sys_element_mapping",
    ]);
    const valueCall = calls[7];
    expect(valueCall.query).toContain(`document=sys_hub_step_instance^document_keyIN${STEP2},${STEP1}`);
    expect(valueCall.fields).toBe(STEP_VALUE_FIELDS);
  });

  it("skips the step tables for an action without steps", async () => {
    const tables = instanceTables();
    tables.sys_hub_step_instance = [];
    const { client, calls } = fakeClient(tables);
    const rows = await readActionRows(client, ACTION);
    expect(rows.steps).toEqual([]);
    expect(rows.stepValues).toEqual([]);
    expect(calls).toHaveLength(5);
  });

  it("refuses a malformed sys_id and reports a missing action", async () => {
    const { client } = fakeClient({});
    await expect(readActionRows(client, "abc^ORactive=true")).rejects.toThrow("is not a sys_id");
    await expect(readActionRows(client, ACTION)).rejects.toThrow(
      `Action ${ACTION} was not found in sys_hub_action_type_definition.`
    );
  });

  it("reads straight into a document", async () => {
    const { client } = fakeClient(instanceTables());
    const doc = await readActionDocument(client, ACTION);
    expect(doc.steps.map((s) => s.sys_id)).toEqual([STEP1, STEP2]);
    expect(doc.warnings).toEqual([]);
  });
});

describe("listScopeActions", () => {
  it("lists the scope's actions by name", async () => {
    const tables = instanceTables();
    tables.sys_hub_action_type_definition.push({ sys_id: "not-an-id", "sys_scope.scope": "x_demo" });
    const { client, calls } = fakeClient(tables);
    expect(await listScopeActions(client, "x_demo")).toEqual([
      { sys_id: ACTION, name: "Create Device Snapshot", internal_name: "create_device_snapshot" },
    ]);
    expect(calls[0].fields).toBe("sys_id,name,internal_name");
  });

  it("refuses a scope that would add query conditions", async () => {
    const { client } = fakeClient({});
    await expect(listScopeActions(client, "x_demo^ORactive=true")).rejects.toThrow("is not a scope name");
  });
});
