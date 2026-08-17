// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

const getManifest = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getManifest,
  getSourcePath: jest.fn(() => "/tmp/source"),
  getBuildPath: jest.fn(() => "/tmp/build"),
}));

// R1: defer the SUT import so it binds to the mocked ../config.js rather than the
// real module (jest.unstable_mockModule does not hoist).
let getFileContextFromPath: typeof import("../FileUtils.js").getFileContextFromPath;
let SNFileExists: typeof import("../FileUtils.js").SNFileExists;

beforeAll(async () => {
  ({ getFileContextFromPath, SNFileExists } = await import("../FileUtils.js"));
});

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

  // #19: a Windows-shaped path (backslashes + drive letter) must resolve to the
  // same table/record/field on any platform. Before the separator-agnostic
  // split this was broken on non-Windows runtimes: path.sep did not tokenize
  // "\\", so tableName/recordName came back undefined and the whole path leaked
  // into the field name. Feeding a literal Windows path makes the fix
  // Linux-testable.
  it("resolves table/record/field from a Windows-style backslash path (#19)", () => {
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

    const winPath = "C:\\proj\\src\\sys_script_include\\MyUtil\\script.js";
    const ctx = getFileContextFromPath(winPath);

    expect(ctx).toBeDefined();
    expect(ctx?.tableName).toBe("sys_script_include");
    expect(ctx?.name).toBe("MyUtil");
    expect(ctx?.targetField).toBe("script");
    expect(ctx?.sys_id).toBe("def456");
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

  it("does not treat a longer-stemmed sibling as the field's file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-snexists-"));
    // Only `foo.min.js` exists; the field `foo` (foo.js) has not been written.
    fs.writeFileSync(path.join(root, "foo.min.js"), "x");

    const exists = await SNFileExists(root)({ name: "foo", type: "js" } as any);

    expect(exists).toBe(false);
  });

  it("counts a zero-byte file as present, because an empty field is converged", async () => {
    // This used to assert the opposite: zero bytes meant "still a placeholder,
    // re-fetch it". That rule existed for the skeleton phase, which manufactured
    // zero-byte files for manifest entries — and it also caught every field whose
    // value on the instance is legitimately "", so such a field was re-downloaded
    // on every run and never converged. writeSNFileCurry no longer writes a file
    // for a request that carries no content (the placeholder is now an ABSENT
    // file, covered by the test below), so zero bytes can only mean "downloaded,
    // and the field really is empty".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-snexists-"));
    fs.writeFileSync(path.join(root, "empty.js"), "");

    const exists = await SNFileExists(root)({ name: "empty", type: "js" } as any);

    expect(exists).toBe(true);
  });

  it("reports a field whose file was never created as missing", async () => {
    // The placeholder case the zero-byte rule used to serve: nothing on disk.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-snexists-"));

    const exists = await SNFileExists(root)({ name: "absent", type: "js" } as any);

    expect(exists).toBe(false);
  });
});
