// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncro-now-ai/types";

// DX17: exercise the flat-layout wiring end to end with mocked config but a real
// filesystem, so the pull write path (processManifest) and the push/build read
// path (getFileContextFromPath) are proven to round-trip the
// <table>/<record>~<field>.<ext> encoding without a live instance.

const getManifest = jest.fn();
const getConfig = jest.fn();
const getSourcePath = jest.fn();
const getBuildPath = jest.fn(() => "/tmp/build");
const getManifestPath = jest.fn();

jest.mock("../config", () => ({
  getManifest,
  getConfig,
  getSourcePath,
  getBuildPath,
  getManifestPath,
}));

jest.mock("../Logger", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    silly: jest.fn(),
    getLogLevel: jest.fn(() => "warn"),
  },
}));

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-flat-"));

const manifestFixture = (): SN.AppManifest => ({
  scope: "x_test",
  tables: {
    sys_script_include: {
      records: {
        "Include A": {
          name: "Include A",
          sys_id: "sysA",
          files: [{ name: "script", type: "js", content: "var a = 1;\n" }],
        },
        // A record name containing a dot proves the LAST '~' rule keeps the
        // mapping reversible even when the record name has separators.
        "v1.2 helper": {
          name: "v1.2 helper",
          sys_id: "sysB",
          files: [{ name: "script", type: "js", content: "var b = 2;\n" }],
        },
      },
    },
    sys_atf_step: {
      records: {
        "Step One": {
          name: "Step One",
          sys_id: "sysS",
          files: [{ name: "inputs.script", type: "js", content: "atf();\n" }],
        },
      },
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  getConfig.mockReturnValue({});
  getSourcePath.mockReturnValue(path.join(TMP_ROOT, "src"));
  getManifestPath.mockReturnValue(path.join(TMP_ROOT, "manifest.json"));
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("getFileContextFromPath — flat layout", () => {
  it("parses table, record and field from a flat path", async () => {
    getManifest.mockReturnValue(manifestFixture());
    const { getFileContextFromPath } = await import("../FileUtils");
    const filePath = path.join(
      "/proj/src/sys_script_include",
      "Include A~script.js"
    );
    const ctx = getFileContextFromPath(filePath);
    expect(ctx).toBeDefined();
    expect(ctx?.tableName).toBe("sys_script_include");
    expect(ctx?.name).toBe("Include A");
    expect(ctx?.targetField).toBe("script");
    expect(ctx?.sys_id).toBe("sysA");
    expect(ctx?.ext).toBe(".js");
  });

  it("uses the LAST separator so dotted record names round-trip", async () => {
    getManifest.mockReturnValue(manifestFixture());
    const { getFileContextFromPath } = await import("../FileUtils");
    const filePath = path.join(
      "/proj/src/sys_script_include",
      "v1.2 helper~script.js"
    );
    const ctx = getFileContextFromPath(filePath);
    expect(ctx?.name).toBe("v1.2 helper");
    expect(ctx?.targetField).toBe("script");
    expect(ctx?.sys_id).toBe("sysB");
  });

  it("forces inputs.script as the target field for sys_atf_step", async () => {
    getManifest.mockReturnValue(manifestFixture());
    const { getFileContextFromPath } = await import("../FileUtils");
    const filePath = path.join(
      "/proj/src/sys_atf_step",
      "Step One~inputs.script.js"
    );
    const ctx = getFileContextFromPath(filePath);
    expect(ctx?.tableName).toBe("sys_atf_step");
    expect(ctx?.name).toBe("Step One");
    expect(ctx?.targetField).toBe("inputs.script");
    expect(ctx?.sys_id).toBe("sysS");
  });

  it("still parses a classic folder-layout path (no regression)", async () => {
    getManifest.mockReturnValue(manifestFixture());
    const { getFileContextFromPath } = await import("../FileUtils");
    const filePath = path.join(
      "/proj/src/sys_script_include/Include A",
      "script.js"
    );
    const ctx = getFileContextFromPath(filePath);
    expect(ctx?.tableName).toBe("sys_script_include");
    expect(ctx?.name).toBe("Include A");
    expect(ctx?.targetField).toBe("script");
  });

  it("returns undefined for a flat path that no manifest record claims", async () => {
    getManifest.mockReturnValue(manifestFixture());
    const { getFileContextFromPath } = await import("../FileUtils");
    const ctx = getFileContextFromPath(
      path.join("/proj/src/sys_script_include", "Ghost~script.js")
    );
    expect(ctx).toBeUndefined();
  });
});

describe("writeFlatSNFileCurry", () => {
  it("writes a single <record>~<field>.<ext> file under the table dir", async () => {
    const { writeFlatSNFileCurry } = await import("../FileUtils");
    const tableDir = path.join(TMP_ROOT, "writecurry", "sys_script_include");
    fs.mkdirSync(tableDir, { recursive: true });
    await writeFlatSNFileCurry(false)(
      { name: "script", type: "js", content: "var x = 1;\n" },
      tableDir,
      "Include A"
    );
    const written = path.join(tableDir, "Include A~script.js");
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, "utf8")).toBe("var x = 1;\n");
    // No per-record folder is created in flat mode.
    expect(fs.existsSync(path.join(tableDir, "Include A"))).toBe(false);
  });
});

describe("processManifest — flat pull round-trip", () => {
  it("writes flat files that getFileContextFromPath reads straight back", async () => {
    getConfig.mockReturnValue({ flat: true });
    const readManifest = manifestFixture();
    getManifest.mockReturnValue(readManifest);
    const srcPath = getSourcePath();

    const { processManifest } = await import("../appUtils");
    const { getFileContextFromPath } = await import("../FileUtils");

    // processManifest mutates file.content, so feed it a deep clone.
    await processManifest(
      JSON.parse(JSON.stringify(readManifest)) as SN.AppManifest,
      true
    );

    const includePath = path.join(
      srcPath,
      "sys_script_include",
      "Include A~script.js"
    );
    const dottedPath = path.join(
      srcPath,
      "sys_script_include",
      "v1.2 helper~script.js"
    );
    const atfPath = path.join(
      srcPath,
      "sys_atf_step",
      "Step One~inputs.script.js"
    );

    // Files landed flat, with no per-record folders.
    expect(fs.existsSync(includePath)).toBe(true);
    expect(fs.existsSync(dottedPath)).toBe(true);
    expect(fs.existsSync(atfPath)).toBe(true);
    expect(
      fs.existsSync(path.join(srcPath, "sys_script_include", "Include A"))
    ).toBe(false);
    expect(fs.readFileSync(includePath, "utf8")).toBe("var a = 1;\n");

    // The manifest file was written.
    expect(fs.existsSync(getManifestPath())).toBe(true);

    // Read each file back through the push/build boundary.
    const includeCtx = getFileContextFromPath(includePath);
    expect(includeCtx).toMatchObject({
      tableName: "sys_script_include",
      name: "Include A",
      targetField: "script",
      sys_id: "sysA",
    });
    const atfCtx = getFileContextFromPath(atfPath);
    expect(atfCtx).toMatchObject({
      tableName: "sys_atf_step",
      name: "Step One",
      targetField: "inputs.script",
      sys_id: "sysS",
    });
  });

  it("writes per-record folders when flat mode is off", async () => {
    getConfig.mockReturnValue({ flat: false });
    const folderRoot = path.join(TMP_ROOT, "folder-src");
    getSourcePath.mockReturnValue(folderRoot);
    getManifestPath.mockReturnValue(path.join(TMP_ROOT, "folder-manifest.json"));

    const { processManifest } = await import("../appUtils");
    await processManifest(manifestFixture(), true);

    const folderFile = path.join(
      folderRoot,
      "sys_script_include",
      "Include A",
      "script.js"
    );
    expect(fs.existsSync(folderFile)).toBe(true);
    // The flat file name must NOT be produced in folder mode.
    expect(
      fs.existsSync(
        path.join(folderRoot, "sys_script_include", "Include A~script.js")
      )
    ).toBe(false);
  });
});
