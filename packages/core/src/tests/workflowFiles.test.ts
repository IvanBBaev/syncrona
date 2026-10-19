// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP2f: legacy workflow documents on disk — where they go, what they are named, and
// how a sync writes them.
import { jest } from "@jest/globals";
import { promises as fsp, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { FlowReadClient } from "../flow/flowReader.js";
import { WORKFLOW_DOCUMENT_SCHEMA, type WorkflowDocument } from "../flow/workflowDocument.js";
import type { WorkflowListing } from "../flow/workflowReader.js";

const listScopeWorkflows = jest.fn<(client: FlowReadClient, scope: string) => Promise<WorkflowListing[]>>();
const readWorkflowDocument = jest.fn<(client: FlowReadClient, sysId: string) => Promise<WorkflowDocument>>();

jest.unstable_mockModule("../flow/workflowReader.js", () => ({
  listScopeWorkflows,
  readWorkflowDocument,
}));

const logger = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  silly: jest.fn(),
};
jest.unstable_mockModule("../Logger.js", () => ({ logger }));

const {
  workflowFileNames,
  isWorkflowDocumentPath,
  syncWorkflowDocuments,
  writeWorkflowDocuments,
  WORKFLOW_DOCUMENT_DIR,
} = await import("../flow/workflowFiles.js");

const client = {} as FlowReadClient;
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

const listing = (sys_id: string, name: string): WorkflowListing => ({
  sys_id,
  name,
});

const documentOf = (sysId: string): WorkflowDocument => ({
  schema: WORKFLOW_DOCUMENT_SCHEMA,
  workflow: {
    sys_id: sysId,
    fields: { name: `Workflow ${sysId.slice(0, 1)}` },
  },
  version: { sys_id: "f".repeat(32), fields: {} },
  stages: [],
  activities: [],
  transitions: [],
  unassigned: [],
  warnings: [],
});

let root: string;
const dir = () => path.join(root, WORKFLOW_DOCUMENT_DIR);
const read = (name: string) => fsp.readFile(path.join(dir(), name), "utf8");

beforeEach(() => {
  jest.clearAllMocks();
  root = mkdtempSync(path.join(os.tmpdir(), "wp2f-workflow-files-"));
  readWorkflowDocument.mockImplementation(async (_client, sysId) => documentOf(sysId));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isWorkflowDocumentPath", () => {
  it("matches a .workflow.json directly under the wf_workflow folder, with either separator", () => {
    expect(isWorkflowDocumentPath("src/wf_workflow/remediate.workflow.json")).toBe(true);
    expect(isWorkflowDocumentPath("C:\\repo\\src\\wf_workflow\\remediate.workflow.json")).toBe(true);
    expect(isWorkflowDocumentPath("wf_workflow/remediate.workflow.json")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isWorkflowDocumentPath("remediate.workflow.json")).toBe(false);
    expect(isWorkflowDocumentPath("src/wf_workflow/.workflow.json")).toBe(false);
    expect(isWorkflowDocumentPath("src/wf_workflow/remediate/script.js")).toBe(false);
    expect(isWorkflowDocumentPath("src/wf_workflow/remediate.json")).toBe(false);
    expect(isWorkflowDocumentPath("src/sys_pd_process_definition/remediate.workflow.json")).toBe(false);
  });
});

describe("workflowFileNames", () => {
  it("names a workflow after its name, then its sys_id", () => {
    const names = workflowFileNames([listing(A, "Approval"), listing(C, "")]);
    expect([...names.entries()]).toEqual([
      [A, "Approval.workflow.json"],
      [C, `${C}.workflow.json`],
    ]);
  });

  it("replaces path separators, reserved characters and the flat-layout ~", () => {
    const names = workflowFileNames([listing(A, "a/b\\c:d~e*f")]);
    expect(names.get(A)).toBe("a_b_c_d_e_f.workflow.json");
    expect(isWorkflowDocumentPath(path.join("src", WORKFLOW_DOCUMENT_DIR, names.get(A) as string))).toBe(true);
  });

  it("appends the sys_id to every workflow sharing a name, ignoring case", () => {
    const names = workflowFileNames([listing(A, "Remediate"), listing(B, "remediate"), listing(C, "Other")]);
    expect(names.get(A)).toBe(`Remediate_${A}.workflow.json`);
    expect(names.get(B)).toBe(`remediate_${B}.workflow.json`);
    expect(names.get(C)).toBe("Other.workflow.json");
  });

  it("falls back to the sys_id when a generated name is another workflow's real name", () => {
    const names = workflowFileNames([listing(A, "Dup"), listing(B, "dup"), listing(C, `Dup_${A}`)]);
    expect(names.get(A)).toBe(`${A}.workflow.json`);
    expect(names.get(C)).toBe(`${C}.workflow.json`);
    expect(names.get(B)).toBe(`dup_${B}.workflow.json`);
  });
});

describe("writeWorkflowDocuments", () => {
  it("writes one document per workflow and skips unchanged bytes", async () => {
    listScopeWorkflows.mockResolvedValue([listing(A, "first"), listing(B, "second")]);
    const first = await writeWorkflowDocuments(client, "x_demo", root);
    expect(listScopeWorkflows).toHaveBeenCalledWith(client, "x_demo");
    expect(first).toEqual({
      written: ["first.workflow.json", "second.workflow.json"],
      unchanged: [],
      failed: [],
      stale: [],
    });
    const text = await read("first.workflow.json");
    expect(JSON.parse(text).workflow.sys_id).toBe(A);
    expect(text.endsWith("}\n")).toBe(true);

    const second = await writeWorkflowDocuments(client, "x_demo", root);
    expect(second).toEqual({
      written: [],
      unchanged: ["first.workflow.json", "second.workflow.json"],
      failed: [],
      stale: [],
    });
    expect((await fsp.readdir(dir())).sort()).toEqual(["first.workflow.json", "second.workflow.json"]);
  });

  it("rewrites a document whose bytes changed", async () => {
    listScopeWorkflows.mockResolvedValue([listing(A, "first")]);
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "first.workflow.json"), "{}\n");
    expect((await writeWorkflowDocuments(client, "x_demo", root)).written).toEqual(["first.workflow.json"]);
    expect(JSON.parse(await read("first.workflow.json")).schema).toBe(WORKFLOW_DOCUMENT_SCHEMA);
  });

  it("keeps writing the other workflows when one cannot be read, and reports leftovers", async () => {
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "gone.workflow.json"), "{}");
    await fsp.writeFile(path.join(dir(), "notes.md"), "kept");
    listScopeWorkflows.mockResolvedValue([listing(A, "Broken"), listing(B, "Fine")]);
    readWorkflowDocument.mockImplementation(async (_client, sysId) => {
      if (sysId === A) throw new Error("HTTP 403");
      return documentOf(sysId);
    });
    const result = await writeWorkflowDocuments(client, "x_demo", root);
    expect(result).toEqual({
      written: ["Fine.workflow.json"],
      unchanged: [],
      failed: [{ sys_id: A, reason: "HTTP 403" }],
      stale: ["gone.workflow.json"],
    });
    expect(await read("gone.workflow.json")).toBe("{}");
  });

  it("reports a listing failure and writes nothing", async () => {
    listScopeWorkflows.mockRejectedValue("offline");
    expect(await writeWorkflowDocuments(client, "x_demo", root)).toEqual({
      written: [],
      unchanged: [],
      failed: [],
      stale: [],
      listError: "offline",
    });
    await expect(fsp.stat(dir())).rejects.toThrow();
  });

  it("reports every workflow as failed when the folder cannot be made, without throwing", async () => {
    await fsp.writeFile(dir(), "a file where the folder belongs");
    listScopeWorkflows.mockResolvedValue([listing(A, "first"), listing(B, "second")]);
    const result = await writeWorkflowDocuments(client, "x_demo", root);
    expect(result.failed.map((f) => f.sys_id)).toEqual([A, B]);
    expect(result.written).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("creates no folder for a scope without workflows", async () => {
    listScopeWorkflows.mockResolvedValue([]);
    expect(await writeWorkflowDocuments(client, "x_demo", root)).toEqual({
      written: [],
      unchanged: [],
      failed: [],
      stale: [],
    });
    await expect(fsp.stat(dir())).rejects.toThrow();
  });
});

describe("syncWorkflowDocuments", () => {
  it("returns true and logs a summary when every workflow was written", async () => {
    listScopeWorkflows.mockResolvedValue([listing(A, "First")]);
    expect(await syncWorkflowDocuments(client, "x_demo", root)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Workflow documents: 1 written, 0 unchanged (1 in scope).");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns about stale documents without failing", async () => {
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "gone.workflow.json"), "{}");
    listScopeWorkflows.mockResolvedValue([]);
    expect(await syncWorkflowDocuments(client, "x_demo", root)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(path.join(WORKFLOW_DOCUMENT_DIR, "gone.workflow.json"))
    );
  });

  it("returns false when a workflow could not be read", async () => {
    listScopeWorkflows.mockResolvedValue([listing(A, "Broken")]);
    readWorkflowDocument.mockRejectedValue(new Error("HTTP 500"));
    expect(await syncWorkflowDocuments(client, "x_demo", root)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`${A}: HTTP 500`));
  });

  it("returns false when the workflows could not be listed", async () => {
    listScopeWorkflows.mockRejectedValue(new Error("HTTP 401"));
    expect(await syncWorkflowDocuments(client, "x_demo", root)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not list the workflows of scope "x_demo" (HTTP 401)')
    );
  });
});
