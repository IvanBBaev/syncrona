// SPDX-License-Identifier: GPL-3.0-or-later
import {
  assembleFlowDocument,
  FLOW_DOCUMENT_SCHEMA,
  serializeFlowDocument,
  type FlowRow,
  type FlowRows,
  type FlowStep,
} from "../flow/flowDocument.js";
import { detectFlowValues, encodeFlowValues } from "../flow/flowValues.js";
import {
  FLOW_ID,
  flowRows,
  gz,
  LEGACY_UI,
  legacyFlowRows,
  TRIGGER_INPUTS,
  UI,
  UPDATE_VALUES,
} from "./fixtures/flowRows.js";

const shape = (steps: FlowStep[]): unknown => steps.map((s) => ({ [s.kind]: s.ui_id, children: shape(s.children) }));

const emptyRows = (steps: Partial<Pick<FlowRows, "actions" | "logic" | "subflows">>): FlowRows => ({
  flow: { sys_id: FLOW_ID },
  triggers: [],
  actions: [],
  logic: [],
  subflows: [],
  inputs: [],
  outputs: [],
  variables: [],
  stages: [],
  ...steps,
});

const step = (sysId: string, uiId: string, parent: string, order: string): FlowRow => ({
  sys_id: sysId,
  ui_id: uiId,
  parent_ui_id: parent,
  order,
});

describe("assembleFlowDocument", () => {
  const doc = assembleFlowDocument(flowRows());

  it("nests steps by parent_ui_id and orders siblings by order", () => {
    expect(doc.schema).toBe(FLOW_DOCUMENT_SCHEMA);
    expect(shape(doc.steps)).toEqual([
      { action: UI.update, children: [] },
      { logic: UI.ifBlock, children: [{ subflow: UI.subflow, children: [] }] },
      { logic: UI.elseBlock, children: [{ action: UI.notify, children: [] }] },
    ]);
    expect(doc.warnings).toEqual([]);
  });

  it("lifts step identity out of fields and decodes payloads", () => {
    const [update] = doc.steps;
    expect(update).toMatchObject({ kind: "action", sys_id: "a0000000000000000000000000000001", order: 1 });
    expect(update.fields).toEqual({
      action_type: "d0000000000000000000000000000001",
    });
    expect(update.payloads).toEqual({ values: { format: "base64-gzip-json", value: UPDATE_VALUES } });
    expect(doc.steps[2].fields).toMatchObject({ connected_to: UI.ifBlock });
    expect(doc.steps[1].children[0].payloads?.subflow_inputs.format).toBe("base64-gzip-json");
  });

  it("drops audit stamps and empty columns and flattens reference cells", () => {
    expect(doc.flow).toEqual({
      sys_id: FLOW_ID,
      fields: {
        name: "Example Flow",
        internal_name: "example_flow",
        type: "flow",
        active: "true",
        status: "published",
        sys_scope: "fedcba9876543210fedcba9876543210",
        latest_snapshot: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(doc.flow.payloads).toBeUndefined();
  });

  it("decodes trigger inputs", () => {
    expect(doc.triggers).toHaveLength(1);
    expect(doc.triggers[0].payloads).toEqual({ trigger_inputs: { format: "base64-gzip-json", value: TRIGGER_INPUTS } });
    expect(doc.triggers[0].fields).not.toHaveProperty("flow");
  });

  it("orders inputs, variables and stages by order, then name", () => {
    expect(doc.inputs.map((r) => r.fields.element)).toEqual(["changed_fields", "current", "table_name"]);
    expect(doc.inputs[0].fields).not.toHaveProperty("model");
    expect(doc.variables.map((r) => r.fields.element)).toEqual(["approval_link"]);
    expect(doc.stages.map((r) => r.fields.value)).toEqual(["started", "done"]);
    expect(doc.outputs).toEqual([]);
  });

  it("keeps payloads re-encodable", () => {
    const payload = doc.steps[0].payloads?.values;
    if (payload === undefined || payload.format === "unknown") throw new Error("payload not decoded");
    const reencoded = encodeFlowValues(payload.value, payload.format);
    expect(detectFlowValues(reencoded)).toMatchObject({ format: payload.format, value: UPDATE_VALUES });
  });

  it("sorts steps without a numeric order last, then by ui_id", () => {
    const result = assembleFlowDocument(
      emptyRows({
        actions: [step("s3", "c", "", ""), step("s2", "b", "", "x"), step("s1", "a", "", "2"), step("s0", "z", "", "1")],
      })
    );
    expect(result.steps.map((s) => [s.ui_id, s.order])).toEqual([
      ["z", 1],
      ["a", 2],
      ["b", null],
      ["c", null],
    ]);
  });

  it("breaks order and ui_id ties by sys_id", () => {
    const result = assembleFlowDocument(
      emptyRows({ actions: [step("s2", "", "", "1"), step("s1", "", "", "1")] })
    );
    expect(result.steps.map((s) => s.sys_id)).toEqual(["s1", "s2"]);
  });

  it("places steps with unusable parents at the top level and says why", () => {
    const result = assembleFlowDocument(
      emptyRows({
        actions: [
          step("s1", "", "", "1"),
          step("s2", "dup", "", "2"),
          step("s3", "dup", "", "3"),
          step("s4", "orphan", "missing", "4"),
          step("s5", "self", "self", "5"),
        ],
      })
    );
    expect(result.steps.map((s) => s.sys_id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(result.warnings).toEqual([
      "action s1 has no ui_id; placed at the top level",
      "action s3 repeats ui_id dup; placed at the top level",
      "action s4 names parent missing, which is not a step of this flow; placed at the top level",
      "action s5 is its own parent; placed at the top level",
    ]);
  });

  it("cuts a parent cycle so the tree stays finite", () => {
    const result = assembleFlowDocument(
      emptyRows({
        logic: [step("s1", "a", "b", "1"), step("s2", "b", "a", "2"), step("s3", "c", "b", "3")],
      })
    );
    expect(shape(result.steps)).toEqual([
      { logic: "a", children: [{ logic: "b", children: [{ logic: "c", children: [] }] }] },
    ]);
    expect(result.warnings).toEqual(["logic s1 is part of a parent cycle; placed at the top level"]);
    expect(() => serializeFlowDocument(result)).not.toThrow();
  });

  it("keeps an undecodable payload column raw and warns", () => {
    const result = assembleFlowDocument(
      emptyRows({ actions: [{ ...step("s1", "a", "", "1"), values: "H4sI-broken" }] })
    );
    expect(result.steps[0].payloads).toEqual({
      values: { format: "unknown", value: "H4sI-broken", reason: "not JSON and not base64 + gzip JSON" },
    });
    expect(result.warnings).toEqual(["action s1: values could not be decoded (not JSON and not base64 + gzip JSON)"]);
  });

  it("decodes gzip found in an unlisted column but keeps look-alike text as a field", () => {
    const result = assembleFlowDocument(
      emptyRows({
        actions: [{ ...step("s1", "a", "", "1"), extra_inputs: gz({ a: 1 }), label: "H4sI is a word here", attributes: null }],
      })
    );
    expect(result.steps[0].payloads).toEqual({ extra_inputs: { format: "base64-gzip-json", value: { a: 1 } } });
    expect(result.steps[0].fields).toEqual({ label: "H4sI is a word here" });
    expect(result.warnings).toEqual([]);
  });

  it("orders records without an order last and breaks ties by name, then sys_id", () => {
    const input = (sysId: string, element: string, order: string): FlowRow => ({ sys_id: sysId, element, order });
    const result = assembleFlowDocument({
      ...emptyRows({}),
      inputs: [input("i4", "b", ""), input("i3", "a", ""), input("i2", "a", "1"), input("i1", "a", "1"), input("i0", "z", "0")],
    });
    expect(result.inputs.map((r) => r.sys_id)).toEqual(["i0", "i1", "i2", "i3", "i4"]);
  });

  it("reads a reference cell without a value as empty", () => {
    const result = assembleFlowDocument({ ...emptyRows({}), flow: { sys_id: FLOW_ID, sys_scope: { link: "x" }, run_as: { value: null } } });
    expect(result.flow.fields).toEqual({});
  });

  it("reads a plain-JSON payload column as json", () => {
    const result = assembleFlowDocument(emptyRows({ logic: [{ ...step("s1", "a", "", "1"), values: '{"x":1}' }] }));
    expect(result.steps[0].payloads).toEqual({ values: { format: "json", value: { x: 1 } } });
  });

  // Live rows: instances store these as comma-separated names, not payloads.
  it("keeps the assigned-name lists of a logic step as plain fields", () => {
    const result = assembleFlowDocument(
      emptyRows({
        logic: [
          { ...step("s1", "a", "", "1"), outputs_assigned: "state", flow_variables_assigned: "status,status_message,error" },
        ],
      })
    );
    expect(result.steps[0].fields).toMatchObject({
      outputs_assigned: "state",
      flow_variables_assigned: "status,status_message,error",
    });
    expect(result.steps[0].payloads).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  // Live rows: some payloads start with the indentation of an XML export.
  it("decodes a gzip payload that starts with whitespace", () => {
    const result = assembleFlowDocument(emptyRows({ actions: [{ ...step("s1", "a", "", "1"), values: `\n      ${gz(UPDATE_VALUES)}` }] }));
    expect(result.steps[0].payloads?.values).toEqual({ format: "base64-gzip-json", value: UPDATE_VALUES });
    expect(result.warnings).toEqual([]);
  });
});

describe("assembleFlowDocument on the older step model", () => {
  const doc = assembleFlowDocument(legacyFlowRows());

  it("builds the step tree from the older tables", () => {
    expect(shape(doc.steps)).toEqual([{ logic: LEGACY_UI.root, children: [{ action: LEGACY_UI.lookup, children: [] }] }]);
    expect(doc.steps[0].fields.sys_class_name).toBe("sys_hub_flow_logic");
    expect(doc.warnings).toEqual([]);
  });

  it("gives each step and trigger its sys_variable_value inputs, in order", () => {
    const lookup = doc.steps[0].children[0];
    expect(lookup.variableValues?.map((v) => [v.fields["variable.element"], v.fields.value])).toEqual([
      ["table_name", "x_example_record"],
      ["conditions", "state=0"],
    ]);
    expect(lookup.variableValues?.[0].fields).not.toHaveProperty("document_key");
    expect(lookup.variableValues?.[0].fields).not.toHaveProperty("sys_updated_on");
    expect(doc.triggers[0].variableValues?.map((v) => v.fields.value)).toEqual(["x_example_record"]);
    expect(doc.steps[0].variableValues).toBeUndefined();
  });

  it("reports a value whose owner is not part of the flow", () => {
    const rows = legacyFlowRows();
    rows.variableValues.push({ sys_id: "v9", document: "sys_hub_action_instance", document_key: "x".repeat(32), value: "a" });
    expect(assembleFlowDocument(rows).warnings).toEqual([
      `variable value v9 belongs to sys_hub_action_instance ${"x".repeat(32)}, which is not a trigger or step of this flow; left out`,
    ]);
  });

  it("serializes the same whatever order the values arrive in", () => {
    const rows = legacyFlowRows();
    const reversed = { ...rows, variableValues: [...rows.variableValues].reverse() };
    expect(serializeFlowDocument(assembleFlowDocument(reversed))).toBe(serializeFlowDocument(doc));
  });
});

describe("serializeFlowDocument", () => {
  it("produces the same bytes whatever the row and column order", () => {
    const rows = flowRows();
    const shuffled: FlowRows = {
      ...rows,
      flow: Object.fromEntries(Object.entries(rows.flow).reverse()),
      actions: [...rows.actions].reverse().map((r) => Object.fromEntries(Object.entries(r).reverse())),
      logic: [...rows.logic].reverse(),
      inputs: [...rows.inputs].reverse(),
      stages: [...rows.stages].reverse(),
    };
    const a = serializeFlowDocument(assembleFlowDocument(rows));
    const b = serializeFlowDocument(assembleFlowDocument(shuffled));
    expect(b).toBe(a);
  });

  it("sorts keys, indents by two spaces and ends with a newline", () => {
    const text = serializeFlowDocument(assembleFlowDocument(emptyRows({})));
    expect(text).toBe(
      [
        "{",
        '  "flow": {',
        '    "fields": {},',
        `    "sys_id": "${FLOW_ID}"`,
        "  },",
        '  "inputs": [],',
        '  "outputs": [],',
        `  "schema": "${FLOW_DOCUMENT_SCHEMA}",`,
        '  "stages": [],',
        '  "steps": [],',
        '  "triggers": [],',
        '  "variables": [],',
        '  "warnings": []',
        "}",
        "",
      ].join("\n")
    );
  });

  it("sorts keys inside decoded payloads too", () => {
    const text = serializeFlowDocument(
      assembleFlowDocument(emptyRows({ actions: [{ ...step("s1", "a", "", "1"), values: gz({ b: 1, a: [{ d: 1, c: 2 }] }) }] }))
    );
    const value = JSON.parse(text).steps[0].payloads.values.value;
    expect(Object.keys(value)).toEqual(["a", "b"]);
    expect(Object.keys(value.a[0])).toEqual(["c", "d"]);
  });
});
