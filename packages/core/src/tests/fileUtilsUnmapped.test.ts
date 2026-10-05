// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import path from "path";

// R1 (`push --create`): parseUnmappedPath decomposes a source-tree path that no
// manifest record claims into the record it would describe. Pure path logic, so
// only the config accessors it reads are mocked.
jest.unstable_mockModule("../config.js", () => ({
  getSourcePath: jest.fn(),
  getBuildPath: jest.fn(),
  getManifest: jest.fn(),
}));

let parseUnmappedPath: typeof import("../FileUtils.js").parseUnmappedPath;
let ConfigManager: typeof import("../config.js");

const SRC = path.resolve("/work/app/src");
const src = (...parts: string[]) => path.join(SRC, ...parts);

beforeAll(async () => {
  ({ parseUnmappedPath } = await import("../FileUtils.js"));
  ConfigManager = await import("../config.js");
});

beforeEach(() => {
  (ConfigManager.getSourcePath as unknown as jest.Mock).mockReturnValue(SRC);
  (ConfigManager.getManifest as unknown as jest.Mock).mockReturnValue({
    tables: { sys_script_include: { records: { Existing: { files: [] } } } },
  });
});

describe("parseUnmappedPath", () => {
  it("parses the folder layout <table>/<record>/<field>.<ext>", () => {
    expect(parseUnmappedPath(src("sys_script_include", "NewUtil", "script.js"))).toEqual({
      table: "sys_script_include",
      recordName: "NewUtil",
      field: "script",
      ext: ".js",
      isSidecar: false,
    });
  });

  it("parses the flat layout <table>/<record>~<field>.<ext>, splitting at the last ~", () => {
    expect(parseUnmappedPath(src("sys_script", "My~Rule~script.ts"))).toEqual({
      table: "sys_script",
      recordName: "My~Rule",
      field: "script",
      ext: ".ts",
      isSidecar: false,
    });
  });

  it("maps a sidecar to the .meta pseudo-field in both layouts", () => {
    expect(parseUnmappedPath(src("sys_script", "Rule", ".meta.json"))).toMatchObject({
      recordName: "Rule",
      field: ".meta",
      isSidecar: true,
    });
    expect(parseUnmappedPath(src("sys_script", "Rule~.meta.json"))).toMatchObject({
      recordName: "Rule",
      field: ".meta",
      isSidecar: true,
    });
  });

  it("maps an ATF step file to inputs.script", () => {
    expect(parseUnmappedPath(src("sys_atf_step", "Step 1", "script.js"))).toMatchObject({
      table: "sys_atf_step",
      field: "inputs.script",
    });
  });

  it("returns undefined for a record the manifest already has", () => {
    expect(parseUnmappedPath(src("sys_script_include", "Existing", "script.js"))).toBeUndefined();
  });

  it("treats a missing manifest as empty", () => {
    (ConfigManager.getManifest as unknown as jest.Mock).mockReturnValue(undefined);
    expect(parseUnmappedPath(src("sys_script_include", "Existing", "script.js"))).toMatchObject({
      recordName: "Existing",
    });
  });

  it.each([
    ["outside the source tree", path.resolve("/elsewhere/sys_script/R/script.js")],
    ["the source root itself", SRC],
    ["a file directly under the root", src("script.js")],
    ["a path deeper than the folder layout", src("sys_script", "R", "sub", "script.js")],
    ["an extensionless file", src("sys_script", "R", "script")],
    ["a flat-depth file without a field separator", src("sys_script", "Rule.js")],
    ["an invalid table name", src("Sys-Script", "R", "script.js")],
    ["a prototype-key table", src("constructor", "R", "script.js")],
    ["a prototype-key record", src("sys_script", "__proto__", "script.js")],
    ["a dot-only record name", src("sys_script", "..~script.js")],
  ])("returns undefined for %s", (_label, filePath) => {
    expect(parseUnmappedPath(filePath)).toBeUndefined();
  });

  it("returns undefined when the source path cannot be resolved", () => {
    (ConfigManager.getSourcePath as unknown as jest.Mock).mockImplementation(() => {
      throw new Error("no config");
    });
    expect(parseUnmappedPath(src("sys_script", "R", "script.js"))).toBeUndefined();
  });
});
