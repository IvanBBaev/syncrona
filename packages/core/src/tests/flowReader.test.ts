// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import {
  FLOW_MAX_PAGES,
  FLOW_TABLES,
  LEGACY_FLOW_TABLES,
  listScopeFlows,
  readFlowDocument,
  readFlowRows,
  VARIABLE_VALUE_FIELDS,
  VARIABLE_VALUE_KEYS_PER_QUERY,
  type FlowReadClient,
} from "../flow/flowReader.js";
import { NonApiResponseError } from "../snClient.js";
import { FLOW_ID, LEGACY_FLOW_ID, LEGACY_UI, legacyFlowRows, flowRows, UI } from "./fixtures/flowRows.js";

// An in-memory Table API: answers each read from fixture rows, honours
// `<column>=<value>` and `<column>IN<a,b>` conditions joined by `^`, limit and
// offset, and records every call.

type Call = { table: string; query: string; fields: string; limit: number; offset: number; extra: unknown };
type Resp = { data: unknown; headers?: Record<string, unknown> };

function fakeClient(tables: Record<string, Record<string, unknown>[]>, opts: { totalHeader?: boolean } = {}) {
  const calls: Call[] = [];
  const tableAPIGet = jest.fn(
    async (table: string, query: string, fields: string, limit = 500, offset = 0, extra?: unknown): Promise<Resp> => {
      calls.push({ table, query, fields, limit, offset, extra });
      const conditions = query
        .replace(/\^ORDERBYsys_id$/, "")
        .split("^")
        .map((condition) => {
          const match = /^([\w.]+?)(=|IN)(.*)$/.exec(condition) as RegExpExecArray;
          return { column: match[1], values: match[2] === "IN" ? match[3].split(",") : [match[3]] };
        });
      const matching = (tables[table] ?? []).filter((row) =>
        conditions.every(({ column, values }) => {
          const cell = row[column];
          return values.includes(String(typeof cell === "object" && cell !== null ? (cell as { value: unknown }).value : cell));
        })
      );
      return {
        data: { result: matching.slice(offset, offset + limit) },
        headers: opts.totalHeader ? { "x-total-count": String(matching.length) } : {},
      };
    }
  );
  return { client: { tableAPIGet } as unknown as FlowReadClient, calls };
}

function instanceTables(): Record<string, Record<string, unknown>[]> {
  const rows = flowRows();
  const tables: Record<string, Record<string, unknown>[]> = { sys_hub_flow: [rows.flow] };
  for (const [key, { table }] of Object.entries(FLOW_TABLES)) {
    tables[table] = rows[key as keyof typeof FLOW_TABLES];
  }
  // A row of another flow must not leak in.
  tables.sys_hub_action_instance_v2 = [...tables.sys_hub_action_instance_v2, { sys_id: "x", flow: "f".repeat(32) }];
  return tables;
}

describe("readFlowRows", () => {
  it("reads the flow and every part of it by its link column", async () => {
    const { client, calls } = fakeClient(instanceTables(), { totalHeader: true });
    const rows = await readFlowRows(client, FLOW_ID);
    expect(rows.flow.sys_id).toBe(FLOW_ID);
    expect(rows.actions.map((r) => r.sys_id).sort()).toEqual([
      "a0000000000000000000000000000001",
      "a0000000000000000000000000000005",
    ]);
    expect(rows.inputs).toHaveLength(3);
    expect(rows.outputs).toEqual([]);
    expect(calls.map((c) => [c.table, c.query])).toEqual([
      ["sys_hub_flow", `sys_id=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_trigger_instance_v2", `flow=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_action_instance_v2", `flow=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_flow_logic_instance_v2", `flow=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_sub_flow_instance_v2", `flow=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_flow_input", `model=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_flow_output", `model=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_flow_variable", `model=${FLOW_ID}^ORDERBYsys_id`],
      ["sys_hub_flow_stage", `flow=${FLOW_ID}^ORDERBYsys_id`],
    ]);
    expect(rows.variableValues).toEqual([]);
    for (const call of calls) {
      expect(call.fields).toBe("");
      expect(call.extra).toEqual({ params: { sysparm_exclude_reference_link: "true" } });
    }
  });

  it("pages until an empty page when the instance sends no total", async () => {
    const { client, calls } = fakeClient(instanceTables());
    const rows = await readFlowRows(client, FLOW_ID, 2);
    expect(rows.inputs).toHaveLength(3);
    expect(calls.filter((c) => c.table === "sys_hub_flow_input").map((c) => [c.limit, c.offset])).toEqual([
      [2, 0],
      [2, 2],
      [2, 3],
    ]);
  });

  it("stops at the total the instance reports", async () => {
    const { client, calls } = fakeClient(instanceTables(), { totalHeader: true });
    await readFlowRows(client, FLOW_ID, 2);
    expect(calls.filter((c) => c.table === "sys_hub_flow_input").map((c) => c.offset)).toEqual([0, 2]);
  });

  it("refuses an argument that is not a sys_id without calling the instance", async () => {
    const { client, calls } = fakeClient(instanceTables());
    await expect(readFlowRows(client, "name=x^ORsys_id!=")).rejects.toThrow(
      '"name=x^ORsys_id!=" is not a sys_id (32 lowercase hex characters).'
    );
    expect(calls).toEqual([]);
  });

  it("says when the flow does not exist", async () => {
    const { client } = fakeClient({});
    await expect(readFlowRows(client, "f".repeat(32))).rejects.toThrow(`Flow ${"f".repeat(32)} was not found in sys_hub_flow.`);
  });

  it("reports an HTML page instead of JSON as a non-API response", async () => {
    const tableAPIGet = jest.fn(async () => ({
      data: "<html>\n  <body>Instance hibernating</body></html>",
      headers: { "content-type": "text/html" },
    }));
    const failing = readFlowRows({ tableAPIGet } as unknown as FlowReadClient, FLOW_ID);
    await expect(failing).rejects.toBeInstanceOf(NonApiResponseError);
    await expect(failing).rejects.toThrow(/content-type: text\/html.*Response starts with: <html> <body>Instance hibernating/);
  });

  it("reports a non-API response with neither content type nor body", async () => {
    const tableAPIGet = jest.fn(async () => ({ data: null }));
    const failing = readFlowRows({ tableAPIGet } as unknown as FlowReadClient, FLOW_ID);
    await expect(failing).rejects.toBeInstanceOf(NonApiResponseError);
    await expect(failing).rejects.not.toThrow(/content-type|Response starts with/);
  });

  it("gives up on an instance that ignores the offset", async () => {
    const tableAPIGet = jest.fn(async () => ({ data: { result: [{ sys_id: FLOW_ID }] }, headers: { "x-total-count": "n/a" } }));
    await expect(readFlowRows({ tableAPIGet } as unknown as FlowReadClient, FLOW_ID)).rejects.toThrow(
      `Reading sys_hub_flow did not finish within ${FLOW_MAX_PAGES} pages of 1 rows; the instance may be ignoring sysparm_offset.`
    );
    expect(tableAPIGet).toHaveBeenCalledTimes(FLOW_MAX_PAGES);
  });
});

describe("readFlowRows on the older step model", () => {
  function legacyTables(): Record<string, Record<string, unknown>[]> {
    const rows = legacyFlowRows();
    const tables: Record<string, Record<string, unknown>[]> = {
      sys_hub_flow: [rows.flow],
      sys_variable_value: [
        ...rows.variableValues,
        // A value of a step of another flow must not leak in.
        { sys_id: "v0", document: "sys_hub_action_instance", document_key: "f".repeat(32), value: "other" },
      ],
    };
    for (const [key, table] of Object.entries(LEGACY_FLOW_TABLES)) {
      tables[table] = rows[key as keyof typeof LEGACY_FLOW_TABLES];
    }
    return tables;
  }

  it("reads the older step tables and the inputs of their rows", async () => {
    const { client, calls } = fakeClient(legacyTables(), { totalHeader: true });
    const rows = await readFlowRows(client, LEGACY_FLOW_ID);
    expect(rows.actions.map((r) => r.sys_id)).toEqual(["a1000000000000000000000000000002"]);
    expect(rows.logic.map((r) => r.sys_id)).toEqual(["e1000000000000000000000000000001"]);
    expect(rows.triggers.map((r) => r.sys_id)).toEqual(["b1000000000000000000000000000001"]);
    expect(rows.variableValues?.map((r) => r.sys_id).sort()).toEqual([
      "c0000000000000000000000000000001",
      "c0000000000000000000000000000002",
      "c0000000000000000000000000000003",
    ]);
    const valueCalls = calls.filter((c) => c.table === "sys_variable_value");
    expect(valueCalls.map((c) => [c.query, c.fields])).toEqual([
      [`document=sys_hub_trigger_instance^document_keyINb1000000000000000000000000000001^ORDERBYsys_id`, VARIABLE_VALUE_FIELDS],
      [`document=sys_hub_action_instance^document_keyINa1000000000000000000000000000002^ORDERBYsys_id`, VARIABLE_VALUE_FIELDS],
      [`document=sys_hub_flow_logic^document_keyINe1000000000000000000000000000001^ORDERBYsys_id`, VARIABLE_VALUE_FIELDS],
    ]);
  });

  it("splits the owners of the values over several queries", async () => {
    const actions = Array.from({ length: VARIABLE_VALUE_KEYS_PER_QUERY + 1 }, (_, n) => ({
      sys_id: `a${String(n).padStart(31, "0")}`,
      flow: LEGACY_FLOW_ID,
    }));
    const { client, calls } = fakeClient({ ...legacyTables(), sys_hub_action_instance: actions });
    await readFlowRows(client, LEGACY_FLOW_ID);
    const keyCounts = calls
      .filter((c) => c.query.startsWith("document=sys_hub_action_instance^"))
      .map((c) => (/document_keyIN([^^]*)/.exec(c.query) as RegExpExecArray)[1].split(",").length);
    expect(keyCounts).toEqual([VARIABLE_VALUE_KEYS_PER_QUERY, 1]);
  });

  it("never puts a malformed owner id into a query", async () => {
    const { client, calls } = fakeClient({
      ...legacyTables(),
      sys_hub_flow_logic: [],
      sys_hub_trigger_instance: [],
      sys_hub_action_instance: [{ sys_id: "x^ORdocument_key!=", flow: LEGACY_FLOW_ID }],
    });
    await readFlowRows(client, LEGACY_FLOW_ID);
    expect(calls.filter((c) => c.table === "sys_variable_value")).toEqual([]);
  });

  it("leaves out the pre-migration copies of a migrated flow", async () => {
    // A migrated flow keeps its older rows beside the v2 ones, with the same ui_ids.
    const tables = instanceTables();
    for (const [key, table] of Object.entries(LEGACY_FLOW_TABLES)) {
      tables[table] = flowRows()[key as keyof typeof LEGACY_FLOW_TABLES].map((row) => ({ ...row, sys_id: `9${String(row.sys_id).slice(1)}` }));
    }
    tables.sys_variable_value = [{ sys_id: "v1", document: "sys_hub_action_instance", document_key: "9".repeat(32), value: "stale" }];
    const { client, calls } = fakeClient(tables, { totalHeader: true });
    const rows = await readFlowRows(client, FLOW_ID);
    expect(rows.actions.map((r) => r.sys_id).sort()).toEqual([
      "a0000000000000000000000000000001",
      "a0000000000000000000000000000005",
    ]);
    expect(rows.variableValues).toEqual([]);
    expect(calls.filter((c) => Object.values(LEGACY_FLOW_TABLES).includes(c.table as never) || c.table === "sys_variable_value")).toEqual([]);
  });

  it("decides the trigger apart from the steps", async () => {
    const legacy = legacyFlowRows();
    const tables = instanceTables();
    tables.sys_hub_trigger_instance_v2 = [];
    tables.sys_hub_trigger_instance = legacy.triggers.map((row) => ({ ...row, flow: FLOW_ID }));
    tables.sys_hub_action_instance = legacy.actions.map((row) => ({ ...row, flow: FLOW_ID }));
    tables.sys_variable_value = legacy.variableValues;
    const { client, calls } = fakeClient(tables, { totalHeader: true });
    const rows = await readFlowRows(client, FLOW_ID);
    expect(rows.triggers.map((r) => r.sys_id)).toEqual(["b1000000000000000000000000000001"]);
    expect(rows.actions.map((r) => r.sys_id)).not.toContain("a1000000000000000000000000000002");
    expect(rows.variableValues?.map((r) => r.document)).toEqual(["sys_hub_trigger_instance"]);
    expect(calls.map((c) => c.table).filter((t) => Object.values(LEGACY_FLOW_TABLES).includes(t as never))).toEqual([
      "sys_hub_trigger_instance",
    ]);
  });

  it("assembles an older-model flow into a non-empty document", async () => {
    const { client } = fakeClient(legacyTables(), { totalHeader: true });
    const doc = await readFlowDocument(client, LEGACY_FLOW_ID);
    expect(doc.steps.map((s) => s.ui_id)).toEqual([LEGACY_UI.root]);
    expect(doc.steps[0].children[0].variableValues).toHaveLength(2);
    expect(doc.warnings).toEqual([]);
  });
});

describe("readFlowDocument", () => {
  it("reads and assembles one flow", async () => {
    const { client } = fakeClient(instanceTables(), { totalHeader: true });
    const doc = await readFlowDocument(client, FLOW_ID);
    expect(doc.flow.fields.name).toBe("Example Flow");
    expect(doc.steps.map((s) => s.ui_id)).toEqual([UI.update, UI.ifBlock, UI.elseBlock]);
    expect(doc.warnings).toEqual([]);
  });
});

describe("listScopeFlows", () => {
  const flowRow = (sys_id: string, name: string, internal_name: string) => ({
    sys_id,
    name,
    internal_name,
    "sys_scope.scope": "x_demo",
  });

  it("lists the scope's flows by sys_id, name and internal name", async () => {
    const { client, calls } = fakeClient({
      sys_hub_flow: [
        flowRow("b".repeat(32), "Second", "second"),
        flowRow("a".repeat(32), "First", "first"),
        flowRow("not-a-sys-id", "Broken", "broken"),
        { sys_id: "c".repeat(32), name: "Elsewhere", internal_name: "elsewhere", "sys_scope.scope": "x_other" },
      ],
    });
    expect(await listScopeFlows(client, "x_demo", 1)).toEqual([
      { sys_id: "b".repeat(32), name: "Second", internal_name: "second" },
      { sys_id: "a".repeat(32), name: "First", internal_name: "first" },
    ]);
    expect(calls[0]).toMatchObject({
      table: "sys_hub_flow",
      query: "sys_scope.scope=x_demo^ORDERBYsys_id",
      fields: "sys_id,name,internal_name",
      limit: 1,
    });
  });

  it("reads a missing name column as empty", async () => {
    const { client } = fakeClient({ sys_hub_flow: [{ sys_id: "a".repeat(32), "sys_scope.scope": "x_demo" }] });
    expect(await listScopeFlows(client, "x_demo")).toEqual([{ sys_id: "a".repeat(32), name: "", internal_name: "" }]);
  });

  it("refuses a scope that would add query conditions", async () => {
    const { client, calls } = fakeClient({});
    await expect(listScopeFlows(client, "x_demo^active=true")).rejects.toThrow(/not a scope name/);
    expect(calls).toEqual([]);
  });
});
