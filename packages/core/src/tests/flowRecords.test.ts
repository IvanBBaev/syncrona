// SPDX-License-Identifier: GPL-3.0-or-later
import { assembleFlowDocument, type FlowDocument, type FlowRow, type FlowStep } from "../flow/flowDocument.js";
import { FLOW_TABLES } from "../flow/flowReader.js";
import {
  FlowEncodeError,
  flowCompositeUpdate,
  flowDocumentChanges,
  flowDocumentRecords,
  type FlowRecordUpdate,
} from "../flow/flowRecords.js";
import { redactFlowSecrets } from "../flow/flowSecrets.js";
import { detectFlowValues } from "../flow/flowValues.js";
import { FLOW_ID, flowRows, gz, legacyFlowRows, UI } from "./fixtures/flowRows.js";

const AUDIT = new Set(["sys_created_by", "sys_created_on", "sys_mod_count", "sys_tags", "sys_updated_by", "sys_updated_on"]);
const PAYLOADS = new Set(["values", "trigger_inputs", "subflow_inputs", "flow_variables_assigned", "outputs_assigned"]);

// Compare decoded payloads, not gzip bytes: the bytes depend on the encoder.
const normalize = (name: string, value: string): unknown => {
  if (!PAYLOADS.has(name) && !value.startsWith("H4sI")) return value;
  const detected = detectFlowValues(value);
  return detected.decoded ? detected.value : value;
};

const fromRow = (row: FlowRow): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(row)) {
    const text = raw !== null && typeof raw === "object" ? String((raw as { value: unknown }).value) : String(raw);
    if (!AUDIT.has(name) && text !== "") out[name] = normalize(name, text);
  }
  return out;
};

const fromUpdate = (update: FlowRecordUpdate): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const { name, value } of update.fields) if (value !== "") out[name] = normalize(name, value);
  return out;
};

const clone = (doc: FlowDocument): FlowDocument => JSON.parse(JSON.stringify(doc)) as FlowDocument;

const findIn = (steps: FlowStep[], uiId: string): FlowStep | undefined => {
  for (const step of steps) {
    const hit = step.ui_id === uiId ? step : findIn(step.children, uiId);
    if (hit) return hit;
  }
  return undefined;
};
const findStep = (steps: FlowStep[], uiId: string): FlowStep => {
  const step = findIn(steps, uiId);
  if (!step) throw new Error(`no step ${uiId}`);
  return step;
};

const encodeError = (fn: () => unknown): FlowEncodeError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowEncodeError) return error;
    throw error;
  }
  throw new Error("expected FlowEncodeError");
};

describe("flowDocumentRecords", () => {
  const rows = flowRows();
  const records = flowDocumentRecords(assembleFlowDocument(rows));

  it("gives back every row the document was assembled from, minus audit stamps", () => {
    const tableOf: Record<string, string> = {
      triggers: FLOW_TABLES.triggers.table,
      actions: FLOW_TABLES.actions.table,
      logic: FLOW_TABLES.logic.table,
      subflows: FLOW_TABLES.subflows.table,
      inputs: FLOW_TABLES.inputs.table,
      outputs: FLOW_TABLES.outputs.table,
      variables: FLOW_TABLES.variables.table,
      stages: FLOW_TABLES.stages.table,
    };
    const expected = new Map<string, { table: string; row: Record<string, unknown> }>();
    expected.set(FLOW_ID, { table: "sys_hub_flow", row: fromRow(rows.flow) });
    for (const [key, table] of Object.entries(tableOf)) {
      for (const row of rows[key as keyof typeof tableOf] as FlowRow[]) {
        expected.set(String(row.sys_id), { table, row: fromRow(row) });
      }
    }
    expect(records).toHaveLength(expected.size);
    for (const update of records) {
      expect(update.action).toBe("INSERT_OR_UPDATE");
      expect({ table: update.table, row: fromUpdate(update) }).toEqual(expected.get(update.sys_id));
    }
  });

  it("emits rows in document order with sys_id first and the other fields sorted", () => {
    expect(records.map((r) => r.sys_id)).toEqual([
      FLOW_ID,
      "b0000000000000000000000000000001",
      "a0000000000000000000000000000001",
      "e0000000000000000000000000000002",
      "50000000000000000000000000000004",
      "e0000000000000000000000000000003",
      "a0000000000000000000000000000005",
      "70000000000000000000000000000003",
      "70000000000000000000000000000001",
      "70000000000000000000000000000002",
      "80000000000000000000000000000001",
      "90000000000000000000000000000001",
      "90000000000000000000000000000002",
    ]);
    for (const update of records) {
      const names = update.fields.map((f) => f.name);
      expect(names[0]).toBe("sys_id");
      expect(names.slice(1)).toEqual([...names.slice(1)].sort());
    }
  });

  it("is stable: the same document gives the same records", () => {
    expect(flowDocumentRecords(assembleFlowDocument(flowRows()))).toEqual(records);
  });

  it("writes an unordered step's order as empty", () => {
    const base = flowRows();
    base.actions[1].order = "";
    const update = flowDocumentRecords(assembleFlowDocument(base)).find((r) => r.sys_id === "a0000000000000000000000000000001");
    expect(update?.fields.find((f) => f.name === "order")).toEqual({ name: "order", value: "" });
  });

  it("keeps an undecodable payload as its raw text", () => {
    const base = flowRows();
    base.actions[1].values = "H4sInot-really-gzip";
    const doc = assembleFlowDocument(base);
    const update = flowDocumentRecords(doc).find((r) => r.sys_id === "a0000000000000000000000000000001");
    expect(update?.fields.find((f) => f.name === "values")?.value).toBe("H4sInot-really-gzip");
  });

  it("encodes a plain-JSON payload back as plain JSON", () => {
    const base = flowRows();
    base.actions[1].values = '[{"name":"a","value":"1"}]';
    const update = flowDocumentRecords(assembleFlowDocument(base)).find((r) => r.sys_id === "a0000000000000000000000000000001");
    expect(update?.fields.find((f) => f.name === "values")?.value).toBe('[{"name":"a","value":"1"}]');
  });

  it("refuses a document with redacted secrets, naming each place", () => {
    const base = flowRows();
    base.inputs[0].internal_type = "password2";
    base.inputs[0].default_value = "s3cret";
    base.actions[1].values = gz([{ name: "token", value: "abc", parameter: { type: "password2" } }]);
    const error = encodeError(() => flowDocumentRecords(redactFlowSecrets(assembleFlowDocument(base))));
    expect(error.problems).toEqual([
      "action a0000000000000000000000000000001: values[0].value holds a redacted placeholder, not the value",
      "inputs 70000000000000000000000000000002: default_value holds a redacted placeholder, not the value",
    ]);
    expect(error.message).toContain("cannot be written back");
  });

  it("writes an older-model flow back to its own tables, with its inputs as sys_variable_value rows", () => {
    const legacy = legacyFlowRows();
    const records = flowDocumentRecords(assembleFlowDocument(legacy));
    const expected = [
      { table: "sys_hub_flow", row: legacy.flow },
      ...legacy.triggers.map((row) => ({ table: "sys_hub_trigger_instance", row })),
      ...legacy.logic.map((row) => ({ table: "sys_hub_flow_logic", row })),
      ...legacy.actions.map((row) => ({ table: "sys_hub_action_instance", row })),
      ...legacy.variableValues.map((row) => ({ table: "sys_variable_value", row })),
    ];
    expect(records.map((r) => `${r.table} ${r.sys_id}`).sort()).toEqual(
      expected.map(({ table, row }) => `${table} ${String(row.sys_id)}`).sort(),
    );
    for (const { row } of expected) {
      const update = records.find((r) => r.sys_id === row.sys_id);
      const want = Object.fromEntries(Object.entries(fromRow(row)).filter(([name]) => !name.includes(".")));
      expect(fromUpdate(update as FlowRecordUpdate)).toEqual(want);
    }
  });

  it("refuses a redacted older-model input", () => {
    const legacy = legacyFlowRows();
    legacy.variableValues[0]["variable.internal_type"] = "password2";
    const error = encodeError(() => flowDocumentRecords(redactFlowSecrets(assembleFlowDocument(legacy))));
    expect(error.problems).toEqual([
      "input c0000000000000000000000000000003: value holds a redacted placeholder, not the value",
    ]);
  });

  it("refuses a document whose steps assembly had to move", () => {
    const base = flowRows();
    base.actions[0].parent_ui_id = "99999999-9999-4999-8999-999999999999";
    const error = encodeError(() => flowDocumentRecords(assembleFlowDocument(base)));
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toMatch(/^its original parent is unknown: action a0+5 names parent/);
  });

  it("refuses a bad schema, a bad sys_id, a duplicate row and an undecoded payload that is not text", () => {
    const wrong = { ...clone(assembleFlowDocument(flowRows())), schema: "other" } as unknown as FlowDocument;
    expect(encodeError(() => flowDocumentRecords(wrong)).problems).toEqual(['schema is "other", expected "syncrona.flow/1"']);

    const doc = clone(assembleFlowDocument(flowRows()));
    doc.stages[0].sys_id = "not-an-id";
    doc.variables.push(clone(assembleFlowDocument(flowRows())).variables[0]);
    doc.triggers[0].payloads = { trigger_inputs: { format: "unknown", value: { x: 1 } } };
    doc.outputs.push({ sys_id: "c1000000000000000000000000000001", fields: {}, payloads: { values: { format: "json", value: undefined } } });
    expect(encodeError(() => flowDocumentRecords(doc)).problems).toEqual([
      "triggers b0000000000000000000000000000001: trigger_inputs is an undecoded payload but its value is not the raw text",
      "outputs c1000000000000000000000000000001: values has no value",
      "variables 80000000000000000000000000000001 appears more than once",
      'stages "not-an-id" does not have a sys_id (32 lowercase hex characters)',
    ]);
  });
});

describe("flowDocumentChanges", () => {
  const base = assembleFlowDocument(flowRows());

  it("returns nothing for an unchanged document", () => {
    expect(flowDocumentChanges(base, clone(base))).toEqual([]);
  });

  it("writes a changed step whole, and only that step", () => {
    const edited = clone(base);
    const update = findStep(edited.steps, UI.update);
    (update.payloads?.values.value as { value: string }[])[1].value = "state=7";
    const changes = flowDocumentChanges(base, edited);
    expect(changes.map((c) => [c.table, c.sys_id, c.action])).toEqual([
      ["sys_hub_action_instance_v2", "a0000000000000000000000000000001", "INSERT_OR_UPDATE"],
    ]);
    const values = detectFlowValues(changes[0].fields.find((f) => f.name === "values")?.value);
    expect((values as { value: { value: string }[] }).value[1].value).toBe("state=7");
    expect(changes[0].fields.find((f) => f.name === "flow")?.value).toBe(FLOW_ID);
  });

  it("follows a step moved to another parent and blanks a removed column", () => {
    const edited = clone(base);
    const subflow = findStep(edited.steps, UI.subflow);
    const ifBlock = findStep(edited.steps, UI.ifBlock);
    ifBlock.children.splice(ifBlock.children.indexOf(subflow), 1);
    edited.steps.push(subflow);
    delete edited.stages[0].fields.states;
    const changes = flowDocumentChanges(base, edited);
    expect(changes.map((c) => c.sys_id)).toEqual(["50000000000000000000000000000004", "90000000000000000000000000000001"]);
    expect(changes[0].fields.find((f) => f.name === "parent_ui_id")?.value).toBe("");
    expect(changes[1].fields.find((f) => f.name === "states")).toEqual({ name: "states", value: "" });
  });

  it("inserts a new row and deletes a dropped one", () => {
    const edited = clone(base);
    edited.variables.push({ sys_id: "80000000000000000000000000000002", fields: { element: "extra", internal_type: "string" } });
    edited.stages = edited.stages.filter((s) => s.sys_id !== "90000000000000000000000000000002");
    expect(flowDocumentChanges(base, edited)).toEqual([
      {
        table: "sys_hub_flow_variable",
        sys_id: "80000000000000000000000000000002",
        action: "INSERT_OR_UPDATE",
        fields: [
          { name: "sys_id", value: "80000000000000000000000000000002" },
          { name: "element", value: "extra" },
          { name: "internal_type", value: "string" },
          { name: "model", value: FLOW_ID },
        ],
      },
      {
        table: "sys_hub_flow_stage",
        sys_id: "90000000000000000000000000000002",
        action: "DELETE",
        fields: [{ name: "sys_id", value: "90000000000000000000000000000002" }],
      },
    ]);
  });

  it("allows redacted placeholders in rows it does not write, and refuses them in rows it does", () => {
    const rows = flowRows();
    rows.inputs[0].internal_type = "password2";
    rows.inputs[0].default_value = "s3cret";
    const redacted = redactFlowSecrets(assembleFlowDocument(rows));
    const edited = clone(redacted);
    edited.stages[0].fields.label = "Begun";
    expect(flowDocumentChanges(redacted, edited).map((c) => c.sys_id)).toEqual(["90000000000000000000000000000001"]);

    const input = edited.inputs.find((i) => i.sys_id === "70000000000000000000000000000002");
    if (input) input.fields.label = "Table";
    expect(encodeError(() => flowDocumentChanges(redacted, edited)).problems).toEqual([
      "inputs 70000000000000000000000000000002: default_value holds a redacted placeholder, not the value",
    ]);
  });

  it("refuses a different flow and a row that changed table", () => {
    const other = clone(base);
    other.flow.sys_id = "fedcba9876543210fedcba9876543210";
    expect(encodeError(() => flowDocumentChanges(base, other)).problems).toContain(
      `base is flow ${FLOW_ID} but the edited document is flow fedcba9876543210fedcba9876543210`
    );

    const moved = clone(base);
    findStep(moved.steps, UI.notify).kind = "logic";
    expect(encodeError(() => flowDocumentChanges(base, moved)).problems).toEqual([
      "logic a0000000000000000000000000000005 moved from sys_hub_action_instance_v2 to sys_hub_flow_logic_instance_v2",
    ]);
  });

  it("reports problems in the base document", () => {
    const broken = { ...clone(base), schema: "other" } as unknown as FlowDocument;
    expect(encodeError(() => flowDocumentChanges(broken, base)).problems).toEqual([
      'base: schema is "other", expected "syncrona.flow/1"',
    ]);
  });
});

describe("flowCompositeUpdate", () => {
  const base = assembleFlowDocument(flowRows());

  it("names the update after the flow and writes every row, the flow first", () => {
    const update = flowCompositeUpdate(base);
    expect(update.updateName).toBe(`sys_hub_flow_${FLOW_ID}`);
    expect(update.table).toBe("sys_hub_flow");
    expect(update.records).toEqual(flowDocumentRecords(base));
    expect(update.records[0]).toMatchObject({ table: "sys_hub_flow", sys_id: FLOW_ID });
    expect(update.records.every((record) => record.action === "INSERT_OR_UPDATE")).toBe(true);
  });

  it("appends a DELETE for every row the edited document dropped from its base", () => {
    const edited = clone(base);
    edited.stages = edited.stages.filter((s) => s.sys_id !== "90000000000000000000000000000002");
    const update = flowCompositeUpdate(edited, base);
    expect(update.records.slice(0, -1)).toEqual(flowDocumentRecords(edited));
    expect(update.records.at(-1)).toEqual({
      table: "sys_hub_flow_stage",
      sys_id: "90000000000000000000000000000002",
      action: "DELETE",
      fields: [{ name: "sys_id", value: "90000000000000000000000000000002" }],
    });
    expect(flowCompositeUpdate(clone(base), base).records).toEqual(flowDocumentRecords(base));
  });

  it("refuses redacted placeholders anywhere, since every row is written", () => {
    const rows = flowRows();
    rows.inputs[0].internal_type = "password2";
    rows.inputs[0].default_value = "s3cret";
    const redacted = redactFlowSecrets(assembleFlowDocument(rows));
    expect(flowDocumentChanges(redacted, clone(redacted))).toEqual([]);
    const { problems } = encodeError(() => flowCompositeUpdate(redacted));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^inputs [0-9a-f]{32}: default_value holds a redacted placeholder, not the value$/);
  });

  it("refuses a different flow, a row that changed table and a broken base", () => {
    const other = clone(base);
    other.flow.sys_id = "f".repeat(32);
    expect(encodeError(() => flowCompositeUpdate(base, other)).problems).toContain(
      `base is flow ${"f".repeat(32)} but the edited document is flow ${FLOW_ID}`,
    );
    const broken = { ...clone(base), schema: "other" } as unknown as FlowDocument;
    expect(encodeError(() => flowCompositeUpdate(base, broken)).problems).toEqual([
      'base: schema is "other", expected "syncrona.flow/1"',
    ]);
  });
});
