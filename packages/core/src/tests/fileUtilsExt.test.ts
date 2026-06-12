import fs from "fs";
import os from "os";
import path from "path";

const getManifest = jest.fn();

jest.mock("../config", () => ({
  getManifest,
  getSourcePath: jest.fn(() => "/tmp/source"),
  getBuildPath: jest.fn(() => "/tmp/build"),
}));

import { getFileContextFromPath, SNFileExists } from "../FileUtils";

describe("getFileContextFromPath extension handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("derives the correct extension and targetField for dotted field names", () => {
    // ATF steps store their script under a dotted field name "inputs.script"
    getManifest.mockReturnValue({
      scope: "x_test_app",
      tables: {
        sys_atf_step: {
          records: {
            MyStep: {
              sys_id: "abc123",
              files: [{ name: "inputs.script", type: "js" }],
            },
          },
        },
      },
    });

    const filePath = path.join(
      "/proj/src/sys_atf_step/MyStep",
      "inputs.script.js"
    );
    const ctx = getFileContextFromPath(filePath);

    expect(ctx).toBeDefined();
    expect(ctx?.ext).toBe(".js");
    expect(ctx?.targetField).toBe("inputs.script");
    expect(ctx?.sys_id).toBe("abc123");
  });

  it("handles plain single-extension field names", () => {
    getManifest.mockReturnValue({
      scope: "x_test_app",
      tables: {
        sys_script_include: {
          records: {
            MyUtil: {
              sys_id: "def456",
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    });

    const filePath = path.join(
      "/proj/src/sys_script_include/MyUtil",
      "script.js"
    );
    const ctx = getFileContextFromPath(filePath);

    expect(ctx?.ext).toBe(".js");
    expect(ctx?.targetField).toBe("script");
  });
});

describe("SNFileExists regex safety", () => {
  it("matches files whose record name contains regex special characters", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-snexists-"));
    fs.writeFileSync(path.join(root, "weird.name(v1).js"), "x");

    const exists = await SNFileExists(root)({
      name: "weird.name(v1)",
      type: "js",
    } as any);

    expect(exists).toBe(true);
  });

  it("does not match a name as a substring of another file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-snexists-"));
    fs.writeFileSync(path.join(root, "prefixScript.js"), "x");

    const exists = await SNFileExists(root)({
      name: "Script",
      type: "js",
    } as any);

    expect(exists).toBe(false);
  });
});
