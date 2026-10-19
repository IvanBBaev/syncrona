// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { FlowReadClient } from "../flow/flowReader.js";
import {
  WORKFLOW_TABLES,
  WORKFLOW_VALUE_CHUNK,
  WORKFLOW_VALUE_FIELDS,
  listScopeWorkflows,
  readWorkflowDocument,
  readWorkflowRows,
} from "../flow/workflowReader.js";
import { NonApiResponseError } from "../snClient.js";

// An in-memory Table API: honours `<column>=<value>` and `<column>IN<a,b>`
// conditions joined by `^`, limit and offset, and records every call. Dot-walked
// columns are stored flat on the row (`activity.workflow_version`).

type Row = Record<string, unknown>;
type Call = {
  table: string;
  query: string;
  fields: string;
  limit: number;
  offset: number;
};

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
    return {
      data: { result: rows.slice(offset, offset + limit) },
      headers: {},
    };
  });
  return { client: { tableAPIGet } as unknown as FlowReadClient, calls };
}

const WF = "e0000000000000000000000000000001";
const OTHER_WF = "e0000000000000000000000000000002";
const VER = "b0000000000000000000000000000001";
const OLD = "b0000000000000000000000000000002";
const ACT = "ac000000000000000000000000000001";
const END = "ac000000000000000000000000000002";
const COND = "c0000000000000000000000000000001";

const valueRow = (key: string, element: string, v: string): Row => ({
  sys_id: `v-${key}-${element}`,
  document: "wf_activity",
  document_key: key,
  order: "100",
  value: v,
  variable: `${element}-dict`,
  "variable.element": element,
  "variable.internal_type": "string",
  "variable.name": "var__m_d0000000000000000000000000000001",
});

function instance(): Record<string, Row[]> {
  return {
    wf_workflow: [
      { sys_id: WF, name: "Approval", table: "x_demo_request" },
      { sys_id: OTHER_WF, name: "Other" },
    ],
    wf_workflow_version: [
      {
        sys_id: VER,
        workflow: WF,
        published: "true",
        name: "Approval",
        start: ACT,
        activity_stages: '{"stages":{}}',
        sys_updated_on: "2020-07-28 22:59:38",
      },
      {
        sys_id: OLD,
        workflow: WF,
        published: "false",
        sys_updated_on: "2021-01-01 00:00:00",
      },
    ],
    wf_stage: [
      {
        sys_id: "5a000000000000000000000000000001",
        workflow_version: VER,
        name: "Approved",
        order: "100",
      },
    ],
    wf_activity: [
      { sys_id: ACT, workflow_version: VER, name: "Begin", input: "{}" },
      { sys_id: END, workflow_version: VER, name: "End" },
      {
        sys_id: "ac000000000000000000000000000009",
        workflow_version: OLD,
        name: "old",
      },
    ],
    wf_condition: [
      {
        sys_id: COND,
        activity: ACT,
        "activity.workflow_version": VER,
        name: "Always",
        order: "1",
      },
    ],
    wf_transition: [
      {
        sys_id: "7a000000000000000000000000000001",
        from: ACT,
        to: END,
        condition: COND,
        "from.workflow_version": VER,
      },
    ],
    sys_variable_value: [
      valueRow(ACT, "values", "status=300^EQ"),
      valueRow("ac000000000000000000000000000009", "values", "not ours"),
    ],
  };
}

describe("readWorkflowRows", () => {
  it("reads the workflow, its published version, every part by its link and the activities' values", async () => {
    const { client, calls } = fakeClient(instance());
    const rows = await readWorkflowRows(client, WF);
    expect(rows.workflow.sys_id).toBe(WF);
    expect(rows.version.sys_id).toBe(VER);
    expect(rows.skippedVersions).toBeUndefined();
    expect(rows.activities.map((r) => r.sys_id)).toEqual([ACT, END]);
    expect(rows.conditions.map((r) => r.sys_id)).toEqual([COND]);
    expect(rows.transitions).toHaveLength(1);
    expect(rows.stages).toHaveLength(1);
    expect(rows.values.map((r) => r.value)).toEqual(["status=300^EQ"]);

    expect(calls[0]).toMatchObject({
      table: "wf_workflow",
      query: `sys_id=${WF}^ORDERBYsys_id`,
      limit: 1,
    });
    expect(calls.find((c) => c.table === "wf_workflow_version")).toMatchObject({
      query: `workflow=${WF}^published=true^ORDERBYsys_id`,
    });
    for (const { table, link } of Object.values(WORKFLOW_TABLES)) {
      expect(calls).toContainEqual(
        expect.objectContaining({
          table,
          query: `${link}=${VER}^ORDERBYsys_id`,
        })
      );
    }
    const valueCalls = calls.filter((c) => c.table === "sys_variable_value" && c.offset === 0);
    expect(valueCalls.map((c) => c.query)).toEqual([`document=wf_activity^document_keyIN${ACT},${END}^ORDERBYsys_id`]);
    expect(valueCalls.every((c) => c.fields === WORKFLOW_VALUE_FIELDS)).toBe(true);
    // Runtime tables are never read.
    expect(calls.some((c) => /^wf_(context|executing|history|log|transition_history)/.test(c.table))).toBe(false);
  });

  it("picks the newest published version and names the ones it passed over", async () => {
    const tables = instance();
    tables.wf_workflow_version[1].published = "true";
    tables.wf_workflow_version.push({
      sys_id: "b0000000000000000000000000000000",
      workflow: WF,
      published: "true",
      sys_updated_on: "2021-01-01 00:00:00",
    });
    const { client } = fakeClient(tables);
    const rows = await readWorkflowRows(client, WF);
    // Same timestamp: the lower sys_id wins, so the pick does not depend on read order.
    expect(rows.version.sys_id).toBe("b0000000000000000000000000000000");
    expect(rows.skippedVersions).toEqual([OLD, VER]);
  });

  it("splits the variable value reads into chunks and reads none for a version without activities", async () => {
    const tables = instance();
    const many = Array.from({ length: WORKFLOW_VALUE_CHUNK + 1 }, (_, i) => ({
      sys_id: `ac${i.toString(16).padStart(30, "0")}`,
      workflow_version: VER,
    }));
    tables.wf_activity = [...many, { sys_id: "not-a-sys-id", workflow_version: VER }];
    const { client, calls } = fakeClient(tables);
    await readWorkflowRows(client, WF);
    const queries = calls.filter((c) => c.table === "sys_variable_value" && c.offset === 0).map((c) => c.query);
    expect(queries).toHaveLength(2);
    expect(queries[0].split("IN")[1].replace("^ORDERBYsys_id", "").split(",")).toHaveLength(WORKFLOW_VALUE_CHUNK);
    expect(queries[1]).toBe(`document=wf_activity^document_keyIN${many[WORKFLOW_VALUE_CHUNK].sys_id}^ORDERBYsys_id`);

    tables.wf_activity = [];
    const empty = fakeClient(tables);
    expect((await readWorkflowRows(empty.client, WF)).values).toEqual([]);
    expect(empty.calls.some((c) => c.table === "sys_variable_value")).toBe(false);
  });

  it("refuses a value that is not a sys_id before reading anything", async () => {
    const { client, calls } = fakeClient(instance());
    await expect(readWorkflowRows(client, `${WF}^ORsys_id!=x`)).rejects.toThrow("is not a sys_id");
    expect(calls).toEqual([]);
  });

  it("throws when the workflow does not exist", async () => {
    const { client, calls } = fakeClient(instance());
    await expect(readWorkflowRows(client, "f".repeat(32))).rejects.toThrow(
      "Workflow ffffffffffffffffffffffffffffffff was not found in wf_workflow."
    );
    expect(calls).toHaveLength(1);
  });

  it("throws when the workflow has no published version", async () => {
    const { client, calls } = fakeClient(instance());
    await expect(readWorkflowRows(client, OTHER_WF)).rejects.toThrow(
      `Workflow ${OTHER_WF} has no published version in wf_workflow_version.`
    );
    expect(calls.map((c) => c.table)).toEqual(["wf_workflow", "wf_workflow", "wf_workflow_version"]);
  });

  it("surfaces a non-API response", async () => {
    const tableAPIGet = jest.fn(async () => ({
      data: "<html>login</html>",
      headers: { "content-type": "text/html" },
    }));
    await expect(readWorkflowRows({ tableAPIGet } as unknown as FlowReadClient, WF)).rejects.toBeInstanceOf(
      NonApiResponseError
    );
  });
});

describe("readWorkflowDocument", () => {
  it("assembles what it read", async () => {
    const { client } = fakeClient(instance());
    const doc = await readWorkflowDocument(client, WF);
    expect(doc.schema).toBe("syncrona.workflow/1");
    expect(doc.version.payloads?.activity_stages).toEqual({
      format: "json",
      value: { stages: {} },
    });
    expect(doc.activities.map((a) => a.fields.name)).toEqual(["Begin", "End"]);
    expect(doc.activities[0].variables?.map((v) => v.value)).toEqual(["status=300^EQ"]);
    expect(doc.activities[0].conditions.map((c) => c.sys_id)).toEqual([COND]);
    expect(doc.warnings).toEqual([]);
  });
});

describe("listScopeWorkflows", () => {
  it("lists the workflows of a scope by sys_id and name, dropping rows without a sys_id", async () => {
    const { client, calls } = fakeClient({
      wf_workflow: [
        { sys_id: WF, name: "Approval", "sys_scope.scope": "x_demo" },
        { sys_id: OTHER_WF, name: 7, "sys_scope.scope": "x_demo" },
        { sys_id: "bad", name: "broken", "sys_scope.scope": "x_demo" },
        {
          sys_id: "e0000000000000000000000000000003",
          name: "elsewhere",
          "sys_scope.scope": "x_other",
        },
      ],
    });
    expect(await listScopeWorkflows(client, "x_demo")).toEqual([
      { sys_id: WF, name: "Approval" },
      { sys_id: OTHER_WF, name: "" },
    ]);
    expect(calls[0]).toMatchObject({
      table: "wf_workflow",
      query: "sys_scope.scope=x_demo^ORDERBYsys_id",
      fields: "sys_id,name",
    });
  });

  it("refuses a scope that would add query conditions", async () => {
    const { client, calls } = fakeClient({});
    await expect(listScopeWorkflows(client, "x_demo^ORactive=true")).rejects.toThrow("is not a scope name");
    expect(calls).toEqual([]);
  });
});
