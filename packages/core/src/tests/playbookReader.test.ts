// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { FlowReadClient } from "../flow/flowReader.js";
import {
  PLAYBOOK_TABLES,
  PLAYBOOK_VALUE_CHUNK,
  PLAYBOOK_VALUE_FIELDS,
  listScopePlaybooks,
  readPlaybookDocument,
  readPlaybookRows,
} from "../flow/playbookReader.js";
import { NonApiResponseError } from "../snClient.js";

// An in-memory Table API: honours `<column>=<value>` and `<column>IN<a,b>`
// conditions joined by `^`, limit and offset, and records every call.

type Row = Record<string, unknown>;
type Call = { table: string; query: string; fields: string; limit: number; offset: number };

function matches(row: Row, condition: string): boolean {
  const inMatch = /^([\w.]+)IN(.*)$/.exec(condition);
  if (inMatch) return inMatch[2].split(",").includes(String(row[inMatch[1]]));
  const [column, value] = condition.split("=");
  return String(row[column]) === value;
}

function fakeClient(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const tableAPIGet = jest.fn(async (table: string, query: string, fields: string, limit = 500, offset = 0) => {
    calls.push({ table, query, fields, limit, offset });
    const conditions = query.replace(/\^ORDERBYsys_id$/, "").split("^");
    const rows = (tables[table] ?? []).filter((row) => conditions.every((c) => matches(row, c)));
    return { data: { result: rows.slice(offset, offset + limit) }, headers: {} };
  });
  return { client: { tableAPIGet } as unknown as FlowReadClient, calls };
}

const PD = "d0000000000000000000000000000001";
const OTHER = "d0000000000000000000000000000002";
const LANE = "1a000000000000000000000000000001";
const ACT = "ac000000000000000000000000000001";
const TRIGGER = "70000000000000000000000000000001";

const valueRow = (document: string, key: string, element: string, v: string): Row => ({
  sys_id: `v-${document}-${key}-${element}`,
  document,
  document_key: key,
  order: "100",
  value: v,
  variable: `${element}-dict`,
  "variable.element": element,
  "variable.internal_type": "string",
  "variable.name": `var__m_${element}`,
});

function instance(): Record<string, Row[]> {
  return {
    sys_pd_process_definition: [
      { sys_id: PD, label: "Remediate server", designer_state: "{}" },
      { sys_id: OTHER, label: "Other" },
    ],
    sys_pd_lane: [
      { sys_id: LANE, process_definition: PD, name: "change", order: "1" },
      { sys_id: "1a000000000000000000000000000009", process_definition: OTHER, name: "elsewhere" },
    ],
    sys_pd_activity: [{ sys_id: ACT, process_definition: PD, lane: LANE, label: "Create", order: "1" }],
    sys_pd_trigger_instance: [{ sys_id: TRIGGER, process_definition: PD, name: "On create" }],
    sys_pd_process_input: [{ sys_id: "10000000000000000000000000000001", model: PD, element: "server" }],
    sys_pd_process_output: [],
    sys_pd_process_variant: [],
    sys_pd_timer_attributes: [],
    sys_variable_value: [
      valueRow("sys_pd_process_definition", PD, "launch", "now"),
      valueRow("sys_pd_lane", LANE, "rule", "always"),
      valueRow("sys_pd_activity", ACT, "title", "Create change"),
      valueRow("sys_pd_trigger_instance", TRIGGER, "table", "incident"),
      valueRow("sys_pd_activity", "ac000000000000000000000000000099", "title", "not ours"),
    ],
  };
}

describe("readPlaybookRows", () => {
  it("reads the playbook, every part by its link column, and the variable values of each owner", async () => {
    const { client, calls } = fakeClient(instance());
    const rows = await readPlaybookRows(client, PD);
    expect(rows.process.sys_id).toBe(PD);
    expect(rows.lanes.map((r) => r.sys_id)).toEqual([LANE]);
    expect(rows.activities.map((r) => r.sys_id)).toEqual([ACT]);
    expect(rows.inputs).toHaveLength(1);
    expect(rows.values.map((r) => r.value)).toEqual(["now", "always", "Create change", "incident"]);

    expect(calls[0]).toMatchObject({ table: "sys_pd_process_definition", query: `sys_id=${PD}^ORDERBYsys_id`, limit: 1 });
    for (const [key, { table, link }] of Object.entries(PLAYBOOK_TABLES)) {
      expect(calls).toContainEqual(expect.objectContaining({ table, query: `${link}=${PD}^ORDERBYsys_id` }));
      expect(key).toBeTruthy();
    }
    const valueCalls = calls.filter((c) => c.table === "sys_variable_value" && c.offset === 0);
    expect(valueCalls.map((c) => c.query)).toEqual([
      `document=sys_pd_process_definition^document_keyIN${PD}^ORDERBYsys_id`,
      `document=sys_pd_lane^document_keyIN${LANE}^ORDERBYsys_id`,
      `document=sys_pd_activity^document_keyIN${ACT}^ORDERBYsys_id`,
      `document=sys_pd_trigger_instance^document_keyIN${TRIGGER}^ORDERBYsys_id`,
    ]);
    expect(valueCalls.every((c) => c.fields === PLAYBOOK_VALUE_FIELDS)).toBe(true);
    expect(PLAYBOOK_VALUE_FIELDS).toContain("variable.internal_type");
  });

  it("splits the variable value reads into chunks and skips owners without rows", async () => {
    const tables = instance();
    const many = Array.from({ length: PLAYBOOK_VALUE_CHUNK + 1 }, (_, i) => ({
      sys_id: `ac${i.toString(16).padStart(30, "0")}`,
      process_definition: PD,
      lane: LANE,
    }));
    tables.sys_pd_activity = many;
    tables.sys_pd_lane = [];
    tables.sys_pd_trigger_instance = [{ sys_id: "not-a-sys-id", process_definition: PD }];
    const { client, calls } = fakeClient(tables);
    await readPlaybookRows(client, PD);
    const queries = calls.filter((c) => c.table === "sys_variable_value" && c.offset === 0).map((c) => c.query);
    expect(queries).toHaveLength(3);
    expect(queries[1].split("IN")[1].split(",")).toHaveLength(PLAYBOOK_VALUE_CHUNK);
    expect(queries[2]).toBe(`document=sys_pd_activity^document_keyIN${many[PLAYBOOK_VALUE_CHUNK].sys_id}^ORDERBYsys_id`);
  });

  it("refuses a value that is not a sys_id before reading anything", async () => {
    const { client, calls } = fakeClient(instance());
    await expect(readPlaybookRows(client, `${PD}^ORsys_id!=x`)).rejects.toThrow("is not a sys_id");
    expect(calls).toEqual([]);
  });

  it("throws when the playbook does not exist", async () => {
    const { client, calls } = fakeClient(instance());
    await expect(readPlaybookRows(client, "f".repeat(32))).rejects.toThrow(
      "Playbook ffffffffffffffffffffffffffffffff was not found in sys_pd_process_definition."
    );
    expect(calls).toHaveLength(1);
  });

  it("surfaces a non-API response", async () => {
    const tableAPIGet = jest.fn(async () => ({ data: "<html>login</html>", headers: { "content-type": "text/html" } }));
    await expect(readPlaybookRows({ tableAPIGet } as unknown as FlowReadClient, PD)).rejects.toBeInstanceOf(
      NonApiResponseError
    );
  });
});

describe("readPlaybookDocument", () => {
  it("assembles what it read", async () => {
    const { client } = fakeClient(instance());
    const doc = await readPlaybookDocument(client, PD);
    expect(doc.schema).toBe("syncrona.playbook/1");
    expect(doc.process.payloads?.designer_state).toEqual({ format: "json", value: {} });
    expect(doc.process.variables?.map((v) => v.value)).toEqual(["now"]);
    expect(doc.lanes[0].variables?.map((v) => v.value)).toEqual(["always"]);
    expect(doc.lanes[0].activities[0].variables?.map((v) => v.value)).toEqual(["Create change"]);
    expect(doc.triggers[0].variables?.map((v) => v.value)).toEqual(["incident"]);
    expect(doc.warnings).toEqual([]);
  });
});

describe("listScopePlaybooks", () => {
  it("lists the playbooks of a scope by sys_id, name and label, dropping rows without a sys_id", async () => {
    const { client, calls } = fakeClient({
      sys_pd_process_definition: [
        { sys_id: PD, name: "remediate", label: "Remediate", "sys_scope.scope": "x_demo" },
        { sys_id: OTHER, name: 7, "sys_scope.scope": "x_demo" },
        { sys_id: "bad", name: "broken", "sys_scope.scope": "x_demo" },
        { sys_id: "d0000000000000000000000000000003", name: "elsewhere", "sys_scope.scope": "x_other" },
      ],
    });
    expect(await listScopePlaybooks(client, "x_demo")).toEqual([
      { sys_id: PD, name: "remediate", label: "Remediate" },
      { sys_id: OTHER, name: "", label: "" },
    ]);
    expect(calls[0]).toMatchObject({
      table: "sys_pd_process_definition",
      query: "sys_scope.scope=x_demo^ORDERBYsys_id",
      fields: "sys_id,name,label",
    });
  });

  it("refuses a scope that would add query conditions", async () => {
    const { client, calls } = fakeClient({});
    await expect(listScopePlaybooks(client, "x_demo^ORactive=true")).rejects.toThrow("is not a scope name");
    expect(calls).toEqual([]);
  });
});
