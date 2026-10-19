// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP2c: playbook documents on disk — where they go, what they are named, and
// how a sync writes them.
import { jest } from "@jest/globals";
import { promises as fsp, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { FlowReadClient } from "../flow/flowReader.js";
import { PLAYBOOK_DOCUMENT_SCHEMA, type PlaybookDocument } from "../flow/playbookDocument.js";
import type { PlaybookListing } from "../flow/playbookReader.js";

const listScopePlaybooks = jest.fn<(client: FlowReadClient, scope: string) => Promise<PlaybookListing[]>>();
const readPlaybookDocument = jest.fn<(client: FlowReadClient, sysId: string) => Promise<PlaybookDocument>>();

jest.unstable_mockModule("../flow/playbookReader.js", () => ({ listScopePlaybooks, readPlaybookDocument }));

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), silly: jest.fn() };
jest.unstable_mockModule("../Logger.js", () => ({ logger }));

const { playbookFileNames, isPlaybookDocumentPath, syncPlaybookDocuments, writePlaybookDocuments, PLAYBOOK_DOCUMENT_DIR } =
  await import("../flow/playbookFiles.js");

const client = {} as FlowReadClient;
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

const listing = (sys_id: string, name: string, label = ""): PlaybookListing => ({ sys_id, name, label });

const documentOf = (sysId: string): PlaybookDocument => ({
  schema: PLAYBOOK_DOCUMENT_SCHEMA,
  process: { sys_id: sysId, fields: { label: `Playbook ${sysId.slice(0, 1)}` } },
  triggers: [],
  inputs: [],
  outputs: [],
  variants: [],
  timers: [],
  lanes: [],
  unassigned: [],
  warnings: [],
});

let root: string;
const dir = () => path.join(root, PLAYBOOK_DOCUMENT_DIR);
const read = (name: string) => fsp.readFile(path.join(dir(), name), "utf8");

beforeEach(() => {
  jest.clearAllMocks();
  root = mkdtempSync(path.join(os.tmpdir(), "wp2c-playbook-files-"));
  readPlaybookDocument.mockImplementation(async (_client, sysId) => documentOf(sysId));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isPlaybookDocumentPath", () => {
  it("matches a .playbook.json directly under the sys_pd_process_definition folder, with either separator", () => {
    expect(isPlaybookDocumentPath("src/sys_pd_process_definition/remediate.playbook.json")).toBe(true);
    expect(isPlaybookDocumentPath("C:\\repo\\src\\sys_pd_process_definition\\remediate.playbook.json")).toBe(true);
    expect(isPlaybookDocumentPath("sys_pd_process_definition/remediate.playbook.json")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isPlaybookDocumentPath("remediate.playbook.json")).toBe(false);
    expect(isPlaybookDocumentPath("src/sys_pd_process_definition/.playbook.json")).toBe(false);
    expect(isPlaybookDocumentPath("src/sys_pd_process_definition/remediate/script.js")).toBe(false);
    expect(isPlaybookDocumentPath("src/sys_pd_process_definition/remediate.json")).toBe(false);
    expect(isPlaybookDocumentPath("src/sys_hub_flow/remediate.playbook.json")).toBe(false);
  });
});

describe("playbookFileNames", () => {
  it("names a playbook after its name, then its label, then its sys_id", () => {
    const names = playbookFileNames([listing(A, "remediate", "Remediate"), listing(B, "", "Onboard"), listing(C, "")]);
    expect([...names.entries()]).toEqual([
      [A, "remediate.playbook.json"],
      [B, "Onboard.playbook.json"],
      [C, `${C}.playbook.json`],
    ]);
  });

  it("replaces path separators, reserved characters and the flat-layout ~", () => {
    const names = playbookFileNames([listing(A, "a/b\\c:d~e*f")]);
    expect(names.get(A)).toBe("a_b_c_d_e_f.playbook.json");
    expect(isPlaybookDocumentPath(path.join("src", PLAYBOOK_DOCUMENT_DIR, names.get(A) as string))).toBe(true);
  });

  it("appends the sys_id to every playbook sharing a name, ignoring case", () => {
    const names = playbookFileNames([listing(A, "Remediate"), listing(B, "remediate"), listing(C, "Other")]);
    expect(names.get(A)).toBe(`Remediate_${A}.playbook.json`);
    expect(names.get(B)).toBe(`remediate_${B}.playbook.json`);
    expect(names.get(C)).toBe("Other.playbook.json");
  });
});

describe("writePlaybookDocuments", () => {
  it("writes one document per playbook and skips unchanged bytes", async () => {
    listScopePlaybooks.mockResolvedValue([listing(A, "first"), listing(B, "second")]);
    const first = await writePlaybookDocuments(client, "x_demo", root);
    expect(listScopePlaybooks).toHaveBeenCalledWith(client, "x_demo");
    expect(first).toEqual({
      written: ["first.playbook.json", "second.playbook.json"],
      unchanged: [],
      failed: [],
      stale: [],
    });
    const text = await read("first.playbook.json");
    expect(JSON.parse(text).process.sys_id).toBe(A);
    expect(text.endsWith("}\n")).toBe(true);

    const second = await writePlaybookDocuments(client, "x_demo", root);
    expect(second).toEqual({
      written: [],
      unchanged: ["first.playbook.json", "second.playbook.json"],
      failed: [],
      stale: [],
    });
    expect((await fsp.readdir(dir())).sort()).toEqual(["first.playbook.json", "second.playbook.json"]);
  });

  it("rewrites a document whose bytes changed", async () => {
    listScopePlaybooks.mockResolvedValue([listing(A, "first")]);
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "first.playbook.json"), "{}\n");
    expect((await writePlaybookDocuments(client, "x_demo", root)).written).toEqual(["first.playbook.json"]);
    expect(JSON.parse(await read("first.playbook.json")).schema).toBe(PLAYBOOK_DOCUMENT_SCHEMA);
  });

  it("keeps writing the other playbooks when one cannot be read, and reports leftovers", async () => {
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "gone.playbook.json"), "{}");
    await fsp.writeFile(path.join(dir(), "notes.md"), "kept");
    listScopePlaybooks.mockResolvedValue([listing(A, "Broken"), listing(B, "Fine")]);
    readPlaybookDocument.mockImplementation(async (_client, sysId) => {
      if (sysId === A) throw new Error("HTTP 403");
      return documentOf(sysId);
    });
    const result = await writePlaybookDocuments(client, "x_demo", root);
    expect(result).toEqual({
      written: ["Fine.playbook.json"],
      unchanged: [],
      failed: [{ sys_id: A, reason: "HTTP 403" }],
      stale: ["gone.playbook.json"],
    });
    expect(await read("gone.playbook.json")).toBe("{}");
  });

  it("reports a listing failure and writes nothing", async () => {
    listScopePlaybooks.mockRejectedValue("offline");
    expect(await writePlaybookDocuments(client, "x_demo", root)).toEqual({
      written: [],
      unchanged: [],
      failed: [],
      stale: [],
      listError: "offline",
    });
    await expect(fsp.stat(dir())).rejects.toThrow();
  });

  it("reports every playbook as failed when the folder cannot be made, without throwing", async () => {
    await fsp.writeFile(dir(), "a file where the folder belongs");
    listScopePlaybooks.mockResolvedValue([listing(A, "first"), listing(B, "second")]);
    const result = await writePlaybookDocuments(client, "x_demo", root);
    expect(result.failed.map((f) => f.sys_id)).toEqual([A, B]);
    expect(result.written).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("creates no folder for a scope without playbooks", async () => {
    listScopePlaybooks.mockResolvedValue([]);
    expect(await writePlaybookDocuments(client, "x_demo", root)).toEqual({
      written: [],
      unchanged: [],
      failed: [],
      stale: [],
    });
    await expect(fsp.stat(dir())).rejects.toThrow();
  });
});

describe("syncPlaybookDocuments", () => {
  it("returns true and logs a summary when every playbook was written", async () => {
    listScopePlaybooks.mockResolvedValue([listing(A, "First")]);
    expect(await syncPlaybookDocuments(client, "x_demo", root)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Playbook documents: 1 written, 0 unchanged (1 in scope).");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns about stale documents without failing", async () => {
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.writeFile(path.join(dir(), "gone.playbook.json"), "{}");
    listScopePlaybooks.mockResolvedValue([]);
    expect(await syncPlaybookDocuments(client, "x_demo", root)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(path.join(PLAYBOOK_DOCUMENT_DIR, "gone.playbook.json"))
    );
  });

  it("returns false when a playbook could not be read", async () => {
    listScopePlaybooks.mockResolvedValue([listing(A, "Broken")]);
    readPlaybookDocument.mockRejectedValue(new Error("HTTP 500"));
    expect(await syncPlaybookDocuments(client, "x_demo", root)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`${A}: HTTP 500`));
  });

  it("returns false when the playbooks could not be listed", async () => {
    listScopePlaybooks.mockRejectedValue(new Error("HTTP 401"));
    expect(await syncPlaybookDocuments(client, "x_demo", root)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not list the playbooks of scope "x_demo" (HTTP 401)')
    );
  });
});
