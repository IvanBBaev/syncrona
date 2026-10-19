// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP2f: a legacy Workflow version assembled into one deterministic document.
// Fixtures are synthetic: shaped like ven03019 rows, with no instance data.
import { gzipSync } from "zlib";
import {
  assembleWorkflowDocument,
  serializeWorkflowDocument,
  WORKFLOW_DOCUMENT_SCHEMA,
  type WorkflowRows,
} from "../flow/workflowDocument.js";

const WF = "e0000000000000000000000000000001";
const VER = "b0000000000000000000000000000001";
const BEGIN = "ac000000000000000000000000000001";
const APPROVE = "ac000000000000000000000000000002";
const END = "ac000000000000000000000000000003";
const YES = "c0000000000000000000000000000001";
const NO = "c0000000000000000000000000000002";

const audit = {
  sys_created_by: "someone",
  sys_created_on: "2020-07-25 09:07:54",
  sys_mod_count: "3",
  sys_tags: "",
  sys_updated_by: "someone",
  sys_updated_on: "2020-07-28 22:59:38",
};

const value = (key: string, element: string, v: string, type = "string", order = "100") => ({
  sys_id: `v-${key}-${element}`,
  document: "wf_activity",
  document_key: key,
  order,
  value: v,
  variable: `${element}-dict`,
  "variable.element": element,
  "variable.internal_type": type,
  "variable.name": "var__m_d0000000000000000000000000000001",
});

function rows(): WorkflowRows {
  return {
    workflow: {
      sys_id: WF,
      name: "Approval",
      table: "x_demo_request",
      access: "public",
      ...audit,
    },
    version: {
      sys_id: VER,
      workflow: { value: WF, link: "https://example.invalid" },
      name: "Approval",
      start: BEGIN,
      published: "true",
      condition_type: "",
      on_cancel: "",
      activity_stages: '{"activities":{},"ends":[],"stages":{},"subflows":[]}',
      full_sequences: `${BEGIN},${APPROVE},${END}`,
      ...audit,
    },
    stages: [
      {
        sys_id: "5a000000000000000000000000000002",
        workflow_version: VER,
        name: "Rejected",
        order: "200",
      },
      {
        sys_id: "5a000000000000000000000000000001",
        workflow_version: VER,
        name: "Approved",
        order: "100",
      },
    ],
    // Read order is not name order: the document sorts.
    activities: [
      {
        sys_id: END,
        workflow_version: VER,
        name: "End",
        x: "500",
        y: "100",
        input: "{}",
        ...audit,
      },
      {
        sys_id: BEGIN,
        workflow_version: VER,
        name: "Begin",
        x: "100",
        y: "100",
        input: "{}",
      },
      {
        sys_id: APPROVE,
        workflow_version: VER,
        name: "Approval - User",
        x: "300",
        y: "100",
        input: "{}",
      },
    ],
    conditions: [
      {
        sys_id: NO,
        activity: { value: APPROVE },
        name: "Rejected",
        order: "2",
        condition: "activity.result=='rejected'",
      },
      {
        sys_id: YES,
        activity: APPROVE,
        name: "Approved",
        order: "1",
        condition: "activity.result=='approved'",
      },
    ],
    transitions: [
      {
        sys_id: "7a000000000000000000000000000002",
        from: APPROVE,
        to: END,
        condition: YES,
      },
      {
        sys_id: "7a000000000000000000000000000001",
        from: BEGIN,
        to: APPROVE,
        condition: "",
      },
    ],
    values: [
      value(APPROVE, "approvers", "a0000000000000000000000000000001"),
      value(APPROVE, "comment", "Please approve", "string", "50"),
      value(BEGIN, "token", "s3cr3t", "password2"),
      value(BEGIN, "empty_secret", "", "password2"),
      { ...value(END, "other", "elsewhere"), document: "wf_context" },
    ],
  };
}

describe("assembleWorkflowDocument", () => {
  it("builds the workflow, its version, stages, activities with conditions and variables, and transitions", () => {
    const doc = assembleWorkflowDocument(rows());
    expect(doc.schema).toBe(WORKFLOW_DOCUMENT_SCHEMA);
    expect(doc.workflow).toEqual({
      sys_id: WF,
      fields: { name: "Approval", table: "x_demo_request", access: "public" },
    });
    expect(doc.version.fields).toEqual({
      name: "Approval",
      start: BEGIN,
      published: "true",
      full_sequences: `${BEGIN},${APPROVE},${END}`,
    });
    expect(doc.version.payloads).toEqual({
      activity_stages: {
        format: "json",
        value: { activities: {}, ends: [], stages: {}, subflows: [] },
      },
    });
    expect(doc.stages.map((s) => s.fields.name)).toEqual(["Approved", "Rejected"]);
    expect(doc.stages[0].fields.workflow_version).toBeUndefined();

    expect(doc.activities.map((a) => a.fields.name)).toEqual(["Approval - User", "Begin", "End"]);
    const [approve, begin, end] = doc.activities;
    expect(approve.payloads?.input).toEqual({ format: "json", value: {} });
    expect(approve.conditions.map((c) => c.fields.name)).toEqual(["Approved", "Rejected"]);
    expect(approve.conditions[0].fields.activity).toBeUndefined();
    expect(approve.variables?.map((v) => [v.element, v.order, v.value])).toEqual([
      ["comment", 50, "Please approve"],
      ["approvers", 100, "a0000000000000000000000000000001"],
    ]);
    expect(end.fields.sys_created_by).toBeUndefined();
    expect(end.variables).toBeUndefined();
    expect(end.conditions).toEqual([]);
    expect(begin.variables?.find((v) => v.element === "token")?.value).toBe("<redacted:password2>");
    expect(begin.variables?.find((v) => v.element === "empty_secret")?.value).toBe("");

    expect(doc.transitions.map((t) => [t.fields.from, t.fields.to])).toEqual([
      [BEGIN, APPROVE],
      [APPROVE, END],
    ]);
    expect(doc.unassigned).toEqual([]);
    expect(doc.warnings).toEqual([`activity ${BEGIN}: token withheld (password2)`]);
  });

  it("never lets a secret value into the serialized document", () => {
    expect(serializeWorkflowDocument(assembleWorkflowDocument(rows()))).not.toContain("s3cr3t");
  });

  it("withholds secret-typed values inside decoded payloads, gzip ones included", () => {
    const input = rows();
    input.activities[2].input = JSON.stringify({ vars: [{ name: "pw", type: "password2", value: "s3cr3t" }] });
    input.activities[0].note = gzipSync(
      Buffer.from(JSON.stringify([{ internal_type: "password", value: "hunter2" }]))
    ).toString("base64");
    const doc = assembleWorkflowDocument(input);
    const [approve, , end] = doc.activities;
    expect(approve.payloads?.input?.value).toEqual({
      vars: [{ name: "pw", type: "password2", value: "<redacted:password2>" }],
    });
    expect(end.payloads?.note?.value).toEqual([{ internal_type: "password", value: "<redacted:password>" }]);
    expect(doc.warnings).toEqual(
      expect.arrayContaining([
        `activity ${APPROVE}: 1 secret value(s) withheld from input`,
        `activity ${END}: 1 secret value(s) withheld from note`,
      ])
    );
    const text = serializeWorkflowDocument(doc);
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("hunter2");
  });

  it("lists conditions of unknown activities under unassigned and keeps where they pointed", () => {
    const input = rows();
    input.conditions.push(
      {
        sys_id: "c0000000000000000000000000000003",
        activity: "ac00000000000000000000000000dead",
        name: "Lost",
      },
      { sys_id: "c0000000000000000000000000000004", name: "Loose" }
    );
    const doc = assembleWorkflowDocument(input);
    expect(doc.unassigned.map((c) => [c.fields.name, c.fields.activity])).toEqual([
      ["Loose", undefined],
      ["Lost", "ac00000000000000000000000000dead"],
    ]);
    expect(doc.warnings).toEqual(
      expect.arrayContaining([
        "condition c0000000000000000000000000000004 has no activity; listed under unassigned",
        "condition c0000000000000000000000000000003 names activity ac00000000000000000000000000dead, which is not an activity of this version; listed under unassigned",
      ])
    );
  });

  it("warns about a start activity or transition end outside the version", () => {
    const input = rows();
    input.version.start = "ac00000000000000000000000000beef";
    input.transitions.push({
      sys_id: "7a000000000000000000000000000003",
      from: END,
      to: "",
    });
    const doc = assembleWorkflowDocument(input);
    expect(doc.warnings).toEqual(
      expect.arrayContaining([
        `version ${VER} starts at activity ac00000000000000000000000000beef, which is not an activity of this version`,
        "transition 7a000000000000000000000000000003: to is empty",
      ])
    );
    input.transitions[2].to = "ac00000000000000000000000000beef";
    expect(assembleWorkflowDocument(input).warnings).toContain(
      "transition 7a000000000000000000000000000003: to names activity ac00000000000000000000000000beef, which is not an activity of this version"
    );
  });

  it("notes the published versions it passed over", () => {
    const input = rows();
    input.skippedVersions = ["b0000000000000000000000000000009"];
    expect(assembleWorkflowDocument(input).warnings).toContain(
      `version b0000000000000000000000000000009 is published too; the document shows version ${VER}`
    );
  });

  it("keeps an undecodable payload as raw text with a warning, and decodes gzip in any column", () => {
    const input = rows();
    input.version.activity_stages = "{not json";
    const packed = gzipSync(Buffer.from('{"a":1}')).toString("base64");
    input.activities[0].note = packed;
    const doc = assembleWorkflowDocument(input);
    expect(doc.version.payloads?.activity_stages).toMatchObject({
      format: "unknown",
      value: "{not json",
    });
    expect(doc.warnings.some((w) => w.startsWith(`version ${VER}: activity_stages could not be decoded`))).toBe(true);
    expect(doc.activities.find((a) => a.sys_id === END)?.payloads?.note).toEqual({
      format: "base64-gzip-json",
      value: { a: 1 },
    });
  });

  it("orders records without an order after ordered ones, then by name and sys_id", () => {
    const input = rows();
    input.stages.push(
      { sys_id: "5a000000000000000000000000000004", name: "Unordered" },
      { sys_id: "5a000000000000000000000000000003", name: "Unordered" }
    );
    const doc = assembleWorkflowDocument(input);
    expect(doc.stages.map((s) => s.sys_id)).toEqual([
      "5a000000000000000000000000000001",
      "5a000000000000000000000000000002",
      "5a000000000000000000000000000003",
      "5a000000000000000000000000000004",
    ]);
  });
});

describe("serializeWorkflowDocument", () => {
  it("is byte-identical whatever order the rows were read in", () => {
    const a = rows();
    const b = rows();
    b.activities.reverse();
    b.conditions.reverse();
    b.transitions.reverse();
    b.stages.reverse();
    b.values.reverse();
    const text = serializeWorkflowDocument(assembleWorkflowDocument(a));
    expect(serializeWorkflowDocument(assembleWorkflowDocument(b))).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.indexOf('"activities"')).toBeLessThan(text.indexOf('"schema"'));
  });
});
