// SPDX-License-Identifier: GPL-3.0-or-later
import { gzipSync } from "node:zlib";
import {
  assemblePlaybookDocument,
  PLAYBOOK_DOCUMENT_SCHEMA,
  serializePlaybookDocument,
  type PlaybookRows,
} from "../flow/playbookDocument.js";

// Synthetic rows only: the shapes follow sys_pd_* and sys_variable_value as the
// Table API returns them with sysparm_exclude_reference_link=true.

const PD = "d0000000000000000000000000000001";
const LANE_A = "1a000000000000000000000000000001";
const LANE_B = "1b000000000000000000000000000002";
const ACT_1 = "ac000000000000000000000000000001";
const ACT_2 = "ac000000000000000000000000000002";
const ACT_3 = "ac000000000000000000000000000003";
const TRIGGER = "70000000000000000000000000000001";

const audit = { sys_created_by: "admin", sys_created_on: "2026-01-01 00:00:00", sys_mod_count: "3" };

function value(document: string, key: string, element: string, type: string, v: string, order = "100") {
  return {
    sys_id: `${key.slice(0, 24)}${element.length.toString().padStart(8, "0")}`,
    document,
    document_key: key,
    order,
    value: v,
    variable: `${element}-dict`,
    "variable.element": element,
    "variable.internal_type": type,
    "variable.name": `var__m_${document}_${key}`,
  };
}

function rows(): PlaybookRows {
  return {
    process: {
      sys_id: PD,
      label: "Remediate server",
      name: "remediate_server",
      status: "published",
      active: "true",
      launcher_inputs: "",
      designer_state: JSON.stringify({ zoom: 1, lanes: [LANE_A] }),
      permission: "",
      ...audit,
    },
    lanes: [
      { sys_id: LANE_B, process_definition: PD, label: "Remediate", name: "remediate", order: "2", ...audit },
      { sys_id: LANE_A, process_definition: PD, label: "Change", name: "change", order: "1", ...audit },
    ],
    activities: [
      { sys_id: ACT_3, process_definition: PD, lane: LANE_B, label: "Remediate", order: "1", inputs: "" },
      { sys_id: ACT_2, process_definition: PD, lane: LANE_A, label: "Schedule", order: "2" },
      { sys_id: ACT_1, process_definition: PD, lane: LANE_A, label: "Create change", order: "1", ...audit },
    ],
    triggers: [{ sys_id: TRIGGER, process_definition: PD, name: "Record created", trigger_inputs: "" }],
    inputs: [
      { sys_id: "10000000000000000000000000000002", model: PD, element: "token", internal_type: "password2", default_value: "s3cret", order: "2" },
      { sys_id: "10000000000000000000000000000001", model: PD, element: "server", internal_type: "reference", order: "1" },
    ],
    outputs: [],
    variants: [],
    timers: [],
    values: [
      value("sys_pd_activity", ACT_1, "title", "string", "Create change request", "200"),
      value("sys_pd_activity", ACT_1, "button_label", "string", "Go", "100"),
      value("sys_pd_activity", ACT_1, "api_key", "password", "hunter2"),
      value("sys_pd_trigger_instance", TRIGGER, "table", "table_name", "cmdb_ci_server"),
      // A value of a row of another table must not attach to the same sys_id here.
      value("sys_pd_lane", ACT_1, "stray", "string", "nope"),
    ],
  };
}

describe("assemblePlaybookDocument", () => {
  it("orders lanes and activities, drops audit and link columns", () => {
    const doc = assemblePlaybookDocument(rows());
    expect(doc.schema).toBe(PLAYBOOK_DOCUMENT_SCHEMA);
    expect(doc.lanes.map((lane) => lane.sys_id)).toEqual([LANE_A, LANE_B]);
    expect(doc.lanes[0].activities.map((a) => a.sys_id)).toEqual([ACT_1, ACT_2]);
    expect(doc.lanes[1].activities.map((a) => a.sys_id)).toEqual([ACT_3]);
    expect(doc.lanes[0]).toMatchObject({ order: 1, fields: { label: "Change", name: "change" } });
    expect(doc.lanes[0].fields).not.toHaveProperty("order");
    expect(doc.lanes[0].fields).not.toHaveProperty("process_definition");
    expect(doc.lanes[0].activities[0].fields).toEqual({ label: "Create change", order: "1" });
    expect(doc.process.fields).not.toHaveProperty("sys_created_by");
    expect(doc.process.fields).not.toHaveProperty("launcher_inputs");
    expect(doc.unassigned).toEqual([]);
    expect(doc.inputs.map((i) => i.fields.element)).toEqual(["server", "token"]);
  });

  it("decodes JSON payload columns", () => {
    const doc = assemblePlaybookDocument(rows());
    expect(doc.process.payloads).toEqual({ designer_state: { format: "json", value: { zoom: 1, lanes: [LANE_A] } } });
    expect(doc.process.fields).not.toHaveProperty("designer_state");
  });

  it("decodes a gzip payload in any column and keeps an undecodable known payload with a warning", () => {
    const input = rows();
    const packed = gzipSync(Buffer.from(JSON.stringify({ a: 1 }))).toString("base64");
    input.process.extra_state = packed;
    input.process.permission = "{not json";
    input.process.note = "H4sI is just text here";
    const doc = assemblePlaybookDocument(input);
    expect(doc.process.payloads?.extra_state).toEqual({ format: "base64-gzip-json", value: { a: 1 } });
    expect(doc.process.payloads?.permission).toMatchObject({ format: "unknown", value: "{not json" });
    expect(doc.process.fields.note).toBe("H4sI is just text here");
    expect(doc.warnings).toContainEqual(expect.stringMatching(/^process .*: permission could not be decoded/));
  });

  it("attaches sys_variable_value rows to their own row only, sorted", () => {
    const doc = assemblePlaybookDocument(rows());
    const act = doc.lanes[0].activities[0];
    expect(act.variables?.map((v) => v.element)).toEqual(["api_key", "button_label", "title"]);
    expect(act.variables?.[1]).toEqual({
      element: "button_label",
      model: `var__m_sys_pd_activity_${ACT_1}`,
      variable: "button_label-dict",
      type: "string",
      order: 100,
      value: "Go",
    });
    expect(doc.triggers[0].variables?.map((v) => v.value)).toEqual(["cmdb_ci_server"]);
    expect(doc.lanes[0].activities[1]).not.toHaveProperty("variables");
    expect(JSON.stringify(doc)).not.toContain("nope");
  });

  it("withholds secret variable values and secret input defaults", () => {
    const doc = assemblePlaybookDocument(rows());
    expect(doc.lanes[0].activities[0].variables?.[0].value).toBe("<redacted:password>");
    expect(doc.inputs[1].fields.default_value).toBe("<redacted:password2>");
    const text = serializePlaybookDocument(doc);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("s3cret");
    expect(doc.warnings).toEqual([
      `activity ${ACT_1}: api_key withheld (password)`,
      `input 10000000000000000000000000000002: default_value withheld (password2)`,
    ]);
  });

  it("withholds secret-typed values inside decoded payloads, plain and gzip", () => {
    const input = rows();
    input.activities[2].designer_state = JSON.stringify({ inputs: [{ name: "pw", type: "password2", value: "pl41n" }] });
    input.process.extra_state = gzipSync(
      Buffer.from(JSON.stringify([{ parameter: { type: "password" }, displayValue: "z1pped" }]))
    ).toString("base64");
    const doc = assemblePlaybookDocument(input);
    expect(doc.lanes[0].activities[0].payloads?.designer_state.value).toEqual({
      inputs: [{ name: "pw", type: "password2", value: "<redacted:password2>" }],
    });
    const text = serializePlaybookDocument(doc);
    expect(text).not.toContain("pl41n");
    expect(text).not.toContain("z1pped");
    expect(doc.warnings).toContainEqual(`activity ${ACT_1}: 1 secret value(s) withheld from designer_state`);
    expect(doc.warnings).toContainEqual(`process ${PD}: 1 secret value(s) withheld from extra_state`);
  });

  it("withholds a secret input default that was decoded as a gzip payload", () => {
    const input = rows();
    input.inputs[0].default_value = gzipSync(Buffer.from(JSON.stringify({ k: "hunter5" }))).toString("base64");
    const doc = assemblePlaybookDocument(input);
    expect(doc.inputs[1].fields.default_value).toBe("<redacted:password2>");
    expect(doc.inputs[1]).not.toHaveProperty("payloads");
    expect(serializePlaybookDocument(doc)).not.toContain("hunter5");
  });

  it("keeps an empty secret value as it is", () => {
    const input = rows();
    input.values = [value("sys_pd_activity", ACT_1, "api_key", "password", "")];
    const doc = assemblePlaybookDocument(input);
    expect(doc.lanes[0].activities[0].variables?.[0].value).toBe("");
    expect(doc.warnings).toEqual([`input 10000000000000000000000000000002: default_value withheld (password2)`]);
  });

  it("lists activities without a known lane under unassigned, with a warning", () => {
    const input = rows();
    input.activities.push(
      { sys_id: "ac000000000000000000000000000009", process_definition: PD, lane: "e".repeat(32), order: "1" },
      { sys_id: "ac000000000000000000000000000008", process_definition: PD, lane: "", order: "1" }
    );
    const doc = assemblePlaybookDocument(input);
    expect(doc.unassigned.map((a) => a.sys_id)).toEqual([
      "ac000000000000000000000000000008",
      "ac000000000000000000000000000009",
    ]);
    expect(doc.unassigned[1].fields.lane).toBe("e".repeat(32));
    expect(doc.unassigned[0].fields).not.toHaveProperty("lane");
    expect(doc.warnings).toEqual(
      expect.arrayContaining([
        "activity ac000000000000000000000000000009 names lane eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee, which is not a lane of this playbook; listed under unassigned",
        "activity ac000000000000000000000000000008 has no lane; listed under unassigned",
      ])
    );
  });

  it("puts rows without an order last and breaks ties by name then sys_id", () => {
    const input = rows();
    input.lanes = [
      { sys_id: "1c000000000000000000000000000003", process_definition: PD, name: "b", order: "" },
      { sys_id: "1c000000000000000000000000000002", process_definition: PD, name: "a", order: "x" },
      { sys_id: "1c000000000000000000000000000001", process_definition: PD, name: "a", order: "5" },
      { sys_id: "1c000000000000000000000000000004", process_definition: PD, name: "a", order: "5" },
    ];
    const doc = assemblePlaybookDocument(input);
    expect(doc.lanes.map((lane) => [lane.sys_id.slice(-1), lane.order])).toEqual([
      ["1", 5],
      ["4", 5],
      ["2", null],
      ["3", null],
    ]);
  });

  it("reads reference-link objects as their value", () => {
    const input = rows();
    input.activities = [{ sys_id: ACT_1, lane: { value: LANE_A, link: "https://x" }, label: { value: null } }];
    const doc = assemblePlaybookDocument(input);
    expect(doc.lanes[0].activities.map((a) => a.sys_id)).toEqual([ACT_1]);
    expect(doc.lanes[0].activities[0].fields).toEqual({});
  });
});

describe("serializePlaybookDocument", () => {
  it("is deterministic regardless of input row and key order", () => {
    const a = rows();
    const b = rows();
    b.lanes.reverse();
    b.activities.reverse();
    b.values.reverse();
    b.process = Object.fromEntries(Object.entries(b.process).reverse());
    const text = serializePlaybookDocument(assemblePlaybookDocument(a));
    expect(serializePlaybookDocument(assemblePlaybookDocument(b))).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.indexOf('"lanes"')).toBeLessThan(text.indexOf('"process"'));
  });
});
