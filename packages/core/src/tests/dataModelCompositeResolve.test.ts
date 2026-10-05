// SPDX-License-Identifier: GPL-3.0-or-later
//
// SDK-F2, defence in depth: a data-model document entry is pushed only to the
// record its own section and key name. parseCompositeDocument already refuses a
// key that is not one path segment; this suite stands in a path resolver that
// answers with a different record anyway, and checks that push refuses the
// entry instead of sending it to whatever the virtual path resolved to.
import { jest } from "@jest/globals";
import { promises as fsp, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { Sync } from "@syncrona/types";

let root: string;
let src: string;

const getFileContextFromPath = jest.fn<(filePath: string) => Sync.FileContext | undefined>();
const parseUnmappedPath = jest.fn<(filePath: string) => unknown>();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: () => ({
    dataModelLayout: "composite",
    dataModelTables: ["sys_db_object", "sys_dictionary", "sys_choice"],
  }),
  getSourcePath: () => src,
  getManifest: () => ({ scope: "x_demo", tables: {} }),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  writeManifestFile: jest.fn(),
  getFileContextFromPath: (filePath: string) => getFileContextFromPath(filePath),
  parseUnmappedPath: (filePath: string) => parseUnmappedPath(filePath),
  encodedPathsToFilePaths: jest.fn(),
}));

jest.unstable_mockModule("../downloadPipeline.js", () => ({
  findMissingFiles: jest.fn(async () => ({})),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), silly: jest.fn() },
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

let getAppFileListWithCandidates: typeof import("../pushPipeline.js").getAppFileListWithCandidates;

const docPath = () => path.join(src, "data-model", "x_demo_task.json");

beforeAll(async () => {
  ({ getAppFileListWithCandidates } = await import("../pushPipeline.js"));
});

beforeEach(async () => {
  jest.clearAllMocks();
  root = mkdtempSync(path.join(os.tmpdir(), "sdk-f2-resolve-"));
  src = path.join(root, "src");
  await fsp.mkdir(path.dirname(docPath()), { recursive: true });
  await fsp.writeFile(
    docPath(),
    JSON.stringify({
      format: "syncrona.data-model/1",
      table: "x_demo_task",
      sys_choice: { "x_demo_task.u_foo.1": { label: "One" } },
    })
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ctx = (tableName: string, name: string): Sync.FileContext =>
  ({
    filePath: "virtual",
    ext: ".json",
    sys_id: "s1",
    name,
    scope: "x_demo",
    tableName,
    targetField: ".meta",
  }) as Sync.FileContext;

describe("a document entry resolving to another record", () => {
  it("is pushed when it resolves to its own section and key", async () => {
    getFileContextFromPath.mockReturnValue(ctx("sys_choice", "x_demo_task.u_foo.1"));
    const { records } = await getAppFileListWithCandidates([docPath()], { create: false });
    expect(records.map((r) => `${r.table}:${r.sysId}`)).toEqual(["sys_choice:s1"]);
  });

  it.each([
    ["another table", "sys_script", "x_demo_task.u_foo.1"],
    ["another record", "sys_choice", "x_demo_task.u_foo.2"],
  ])("is refused when the manifest lookup lands on %s", async (_label, table, name) => {
    getFileContextFromPath.mockReturnValue(ctx(table, name));
    await expect(getAppFileListWithCandidates([docPath()], { create: false })).rejects.toThrow(
      new RegExp(
        "do not resolve to their own record:[\\s\\S]*x_demo_task\\.json#sys_choice/" +
          `x_demo_task\\.u_foo\\.1 resolves to ${table} "${name.replace(/\./g, "\\.")}"`
      )
    );
  });

  it("is refused as a --create candidate for another table", async () => {
    getFileContextFromPath.mockReturnValue(undefined);
    parseUnmappedPath.mockReturnValue({
      table: "sys_script",
      recordName: "x_demo_task.u_foo.1",
      field: ".meta",
      ext: ".json",
      isSidecar: true,
    });
    await expect(getAppFileListWithCandidates([docPath()], { create: true })).rejects.toThrow(
      /resolves to sys_script "x_demo_task\.u_foo\.1"/
    );
  });

  it("becomes a create candidate when the unmapped path names its own record", async () => {
    getFileContextFromPath.mockReturnValue(undefined);
    parseUnmappedPath.mockReturnValue({
      table: "sys_choice",
      recordName: "x_demo_task.u_foo.1",
      field: ".meta",
      ext: ".json",
      isSidecar: true,
    });
    const { candidates } = await getAppFileListWithCandidates([docPath()], { create: true });
    expect(candidates.map((c) => `${c.table}:${c.recordName}`)).toEqual([
      "sys_choice:x_demo_task.u_foo.1",
    ]);
  });
});
