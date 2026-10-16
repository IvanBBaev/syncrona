// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP2: the `flow` preset's read-only documents — where they go, what they are
// named, and how a refresh writes them.
import { jest } from "@jest/globals";
import { promises as fsp, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FLOW_DOCUMENT_SCHEMA, type FlowDocument } from "../flow/flowDocument.js";
import type { FlowListing, FlowReadClient } from "../flow/flowReader.js";

const listScopeFlows = jest.fn<(client: FlowReadClient, scope: string) => Promise<FlowListing[]>>();
const readFlowDocument = jest.fn<(client: FlowReadClient, sysId: string) => Promise<FlowDocument>>();

jest.unstable_mockModule("../flow/flowReader.js", () => ({ listScopeFlows, readFlowDocument }));

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), silly: jest.fn() };
jest.unstable_mockModule("../Logger.js", () => ({ logger }));

const { flowFileNames, isFlowDocumentPath, syncFlowDocuments, writeFlowDocuments, FLOW_DOCUMENT_DIR } = await import(
  "../flow/flowFiles.js"
);
const { isFlowPresetEnabled } = await import("../tablePresets.js");

const client = {} as FlowReadClient;
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

const listing = (sys_id: string, name: string, internal_name = ""): FlowListing => ({ sys_id, name, internal_name });

const documentOf = (sysId: string, extra: Partial<FlowDocument> = {}): FlowDocument => ({
  schema: FLOW_DOCUMENT_SCHEMA,
  flow: { sys_id: sysId, fields: { name: `Flow ${sysId.slice(0, 1)}` } },
  triggers: [],
  inputs: [],
  outputs: [],
  variables: [],
  stages: [],
  steps: [],
  warnings: [],
  ...extra,
});

let root: string;
const dir = () => path.join(root, FLOW_DOCUMENT_DIR);
const read = (name: string) => fsp.readFile(path.join(dir(), name), "utf8");

beforeEach(() => {
  jest.clearAllMocks();
  root = mkdtempSync(path.join(os.tmpdir(), "wp2-flow-files-"));
  readFlowDocument.mockImplementation(async (_client, sysId) => documentOf(sysId));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isFlowPresetEnabled", () => {
  it("is on only when tablePresets lists flow", () => {
    expect(isFlowPresetEnabled({ tablePresets: ["uib", "flow"] })).toBe(true);
    expect(isFlowPresetEnabled({ tablePresets: ["uib"] })).toBe(false);
    expect(isFlowPresetEnabled({})).toBe(false);
    expect(isFlowPresetEnabled(undefined)).toBe(false);
  });
});

describe("isFlowDocumentPath", () => {
  it("matches a .flow.json directly under the sys_hub_flow folder, with either separator", () => {
    expect(isFlowDocumentPath("src/sys_hub_flow/approve.flow.json")).toBe(true);
    expect(isFlowDocumentPath("C:\\repo\\src\\sys_hub_flow\\approve.flow.json")).toBe(true);
    expect(isFlowDocumentPath("sys_hub_flow/approve.flow.json")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isFlowDocumentPath("approve.flow.json")).toBe(false);
    expect(isFlowDocumentPath("src/sys_hub_flow/.flow.json")).toBe(false);
    expect(isFlowDocumentPath("src/sys_hub_flow/approve/script.js")).toBe(false);
    expect(isFlowDocumentPath("src/sys_hub_flow/approve.json")).toBe(false);
    expect(isFlowDocumentPath("src/sys_script/approve.flow.json")).toBe(false);
  });
});

describe("flowFileNames", () => {
  it("names a flow after its internal name, then its name, then its sys_id", () => {
    const names = flowFileNames([listing(A, "Approve Order", "approve_order"), listing(B, "Notify"), listing(C, "")]);
    expect([...names.entries()]).toEqual([
      [A, "approve_order.flow.json"],
      [B, "Notify.flow.json"],
      [C, `${C}.flow.json`],
    ]);
  });

  it("replaces path separators, reserved characters and the flat-layout ~", () => {
    const names = flowFileNames([listing(A, "a/b\\c:d~e*f")]);
    expect(names.get(A)).toBe("a_b_c_d_e_f.flow.json");
    expect(isFlowDocumentPath(path.join("src", FLOW_DOCUMENT_DIR, names.get(A) as string))).toBe(true);
  });

  it("appends the sys_id to every flow sharing a name, ignoring case", () => {
    const names = flowFileNames([listing(A, "Approve"), listing(B, "approve"), listing(C, "Other")]);
    expect(names.get(A)).toBe(`Approve_${A}.flow.json`);
    expect(names.get(B)).toBe(`approve_${B}.flow.json`);
    expect(names.get(C)).toBe("Other.flow.json");
  });
});

describe("writeFlowDocuments", () => {
  it("writes one redacted document per flow and skips unchanged bytes", async () => {
    listScopeFlows.mockResolvedValue([listing(A, "First", "first"), listing(B, "Second", "second")]);
    readFlowDocument.mockImplementation(async (_client, sysId) =>
      documentOf(sysId, {
        inputs: [{ sys_id: C, fields: { name: "key", internal_type: "password2", default_value: "placeholder" } }],
      })
    );
    const first = await writeFlowDocuments(client, "x_demo", root);
    expect(listScopeFlows).toHaveBeenCalledWith(client, "x_demo");
    expect(first).toEqual({ written: ["first.flow.json", "second.flow.json"], unchanged: [], failed: [], stale: [] });
    const text = await read("first.flow.json");
    expect(text).toContain("<redacted:password2>");
    expect(text).not.toContain('"placeholder"');
    expect(JSON.parse(text).flow.sys_id).toBe(A);

    const second = await writeFlowDocuments(client, "x_demo", root);
    expect(second).toEqual({ written: [], unchanged: ["first.flow.json", "second.flow.json"], failed: [], stale: [] });
    expect((await fsp.readdir(dir())).sort()).toEqual(["first.flow.json", "second.flow.json"]);
  });

  it("keeps writing the other flows when one cannot be read, and reports leftovers", async () => {
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "gone.flow.json"), "{}");
    await fsp.writeFile(path.join(dir(), "notes.md"), "kept");
    listScopeFlows.mockResolvedValue([listing(A, "Broken"), listing(B, "Fine")]);
    readFlowDocument.mockImplementation(async (_client, sysId) => {
      if (sysId === A) throw new Error("HTTP 403");
      return documentOf(sysId);
    });
    const result = await writeFlowDocuments(client, "x_demo", root);
    expect(result).toEqual({
      written: ["Fine.flow.json"],
      unchanged: [],
      failed: [{ sys_id: A, reason: "HTTP 403" }],
      stale: ["gone.flow.json"],
    });
    expect(await read("gone.flow.json")).toBe("{}");
  });

  it("reports a listing failure and writes nothing", async () => {
    listScopeFlows.mockRejectedValue("offline");
    expect(await writeFlowDocuments(client, "x_demo", root)).toEqual({
      written: [],
      unchanged: [],
      failed: [],
      stale: [],
      listError: "offline",
    });
    await expect(fsp.stat(dir())).rejects.toThrow();
  });

  it("creates no folder for a scope without flows", async () => {
    listScopeFlows.mockResolvedValue([]);
    expect(await writeFlowDocuments(client, "x_demo", root)).toEqual({ written: [], unchanged: [], failed: [], stale: [] });
    await expect(fsp.stat(dir())).rejects.toThrow();
  });
});

describe("syncFlowDocuments", () => {
  it("returns true and logs a summary when every flow was written", async () => {
    listScopeFlows.mockResolvedValue([listing(A, "First")]);
    expect(await syncFlowDocuments(client, "x_demo", root)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Flow documents: 1 written, 0 unchanged (1 in scope).");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("warns about stale documents without failing", async () => {
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "gone.flow.json"), "{}");
    listScopeFlows.mockResolvedValue([]);
    expect(await syncFlowDocuments(client, "x_demo", root)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(path.join(FLOW_DOCUMENT_DIR, "gone.flow.json")));
  });

  it("returns false when a flow could not be read", async () => {
    listScopeFlows.mockResolvedValue([listing(A, "Broken")]);
    readFlowDocument.mockRejectedValue(new Error("HTTP 500"));
    expect(await syncFlowDocuments(client, "x_demo", root)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`${A}: HTTP 500`));
  });

  it("returns false when the flows could not be listed", async () => {
    listScopeFlows.mockRejectedValue(new Error("HTTP 401"));
    expect(await syncFlowDocuments(client, "x_demo", root)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Could not list the flows of scope "x_demo" (HTTP 401)'));
  });
});
