// SPDX-License-Identifier: GPL-3.0-or-later
// Native-Windows path semantics regression coverage (ROADMAP: Windows support).
// Runs on any platform: every case feeds literal win32-shaped strings
// (backslashes, drive-letter absolutes, UNC prefixes, mixed separators) into
// functions that are pure or take their paths as parameters, so the win32
// behavior is pinned without a Windows runner.
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  folderRelToFlat,
  flatRelToFolder,
  isFlatEncoded,
} from "../flatLayout.js";
import { isSafePathComponent } from "../genericUtils.js";

const getManifest = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getManifest,
  getSourcePath: jest.fn(() => "/tmp/source"),
  getBuildPath: jest.fn(() => "/tmp/build"),
}));

// Defer the SUT imports so they bind to the mocked ../config.js
// (jest.unstable_mockModule does not hoist). manifestBuilder is deferred for
// the same reason: importing it statically would link the REAL ../config.js
// into the registry before the mock is registered.
let isUnderPath: typeof import("../FileUtils.js").isUnderPath;
let getFileContextFromPath: typeof import("../FileUtils.js").getFileContextFromPath;
let writeSNFileCurry: typeof import("../FileUtils.js").writeSNFileCurry;
let writeFlatSNFileCurry: typeof import("../FileUtils.js").writeFlatSNFileCurry;
let buildBulkDownloadFromTableAPI: typeof import("../manifestBuilder.js").buildBulkDownloadFromTableAPI;

beforeAll(async () => {
  ({
    isUnderPath,
    getFileContextFromPath,
    writeSNFileCurry,
    writeFlatSNFileCurry,
  } = await import("../FileUtils.js"));
  ({ buildBulkDownloadFromTableAPI } = await import("../manifestBuilder.js"));
});

describe("isUnderPath: win32 drive-letter and UNC semantics", () => {
  // The defect this pins: on Windows "C:" and "c:" name the same volume, and
  // mismatched casing between cwd-derived and config-derived absolutes is
  // routine (VS Code's integrated terminal lowercases the drive). The strict
  // token compare returned false here, so getPathsInPath refused the scan and
  // push/build silently saw "no files".
  it("treats drive letters as case-insensitive (fails on the old strict compare)", () => {
    expect(
      isUnderPath("C:\\proj\\src", "c:\\proj\\src\\sys_script_include\\A\\script.js")
    ).toBe(true);
    expect(isUnderPath("c:\\proj\\src", "C:\\proj\\src\\a.js")).toBe(true);
  });

  it("folds the drive letter even when the separators are mixed", () => {
    expect(isUnderPath("C:/proj/src", "c:\\proj\\src\\a.js")).toBe(true);
  });

  it("keeps directory tokens byte-equal — only the drive designator is folded", () => {
    expect(isUnderPath("C:\\proj\\Src", "C:\\proj\\src\\a.js")).toBe(false);
    expect(isUnderPath("/proj/src", "/Proj/src/a.js")).toBe(false);
  });

  it("does not fold a colon-bearing token that is not a pure drive designator", () => {
    // "C:x" is drive-relative, not a device designator; callers resolve before
    // calling, so isUnderPath never has to interpret it — keep it strict.
    expect(isUnderPath("C:x\\src", "c:x\\src\\a.js")).toBe(false);
  });

  it("does not fold a drive-shaped token past the first position", () => {
    // A POSIX directory literally named "C:" stays case-sensitive.
    expect(isUnderPath("/mnt/C:/data", "/mnt/c:/data/a.js")).toBe(false);
  });

  it("distinguishes different drives", () => {
    expect(isUnderPath("C:\\ws\\src", "D:\\ws\\src\\a.js")).toBe(false);
  });

  it("handles UNC paths: containment within a share, divergence across shares", () => {
    expect(
      isUnderPath("\\\\server\\share\\ws\\src", "\\\\server\\share\\ws\\src\\t\\r.js")
    ).toBe(true);
    expect(
      isUnderPath("\\\\server\\share\\ws\\src", "\\\\server\\other\\ws\\src\\t\\r.js")
    ).toBe(false);
  });
});

describe("flatLayout conversions: win32-shaped inputs", () => {
  // Assertions compare SEGMENTS (outputs are rejoined with the platform's
  // path.join), so the same expectations hold on POSIX and win32 runtimes.
  const segments = (p: string): string[] =>
    p.split(/[/\\]/).filter((s) => s.length > 0);

  it("folderRelToFlat tokenizes backslash-separated relative paths", () => {
    const flat = folderRelToFlat("sys_script_include\\MyUtil\\script.js");
    expect(segments(flat)).toEqual(["sys_script_include", "MyUtil~script.js"]);
  });

  it("folderRelToFlat tokenizes mixed-separator relative paths", () => {
    const flat = folderRelToFlat("sys_script_include\\MyUtil/script.js");
    expect(segments(flat)).toEqual(["sys_script_include", "MyUtil~script.js"]);
  });

  it("flatRelToFolder tokenizes backslash-separated flat paths", () => {
    const folder = flatRelToFolder("sys_script_include\\MyUtil~script.js");
    expect(segments(folder)).toEqual(["sys_script_include", "MyUtil", "script.js"]);
  });

  it("round-trips a backslash-separated record-folder path", () => {
    const folder = flatRelToFolder(
      folderRelToFlat("sys_script_include\\My.Util\\inputs.script.js")
    );
    expect(segments(folder)).toEqual([
      "sys_script_include",
      "My.Util",
      "inputs.script.js",
    ]);
  });

  it("isFlatEncoded reads the stem through backslash separators", () => {
    // path.posix.basename does not strip backslashes, so this pins that the
    // stem inspection still finds the '~' when the basename carries the whole
    // win32 path on a POSIX runtime.
    expect(isFlatEncoded("sys_script_include\\MyUtil~script.js")).toBe(true);
    expect(isFlatEncoded("sys_script_include\\plain.js")).toBe(false);
  });
});

describe("isSafePathComponent: win32-shaped components", () => {
  it("rejects backslash-bearing components", () => {
    expect(isSafePathComponent("..\\evil")).toBe(false);
    expect(isSafePathComponent("sub\\dir")).toBe(false);
    expect(isSafePathComponent("C:\\evil")).toBe(false);
    expect(isSafePathComponent("\\\\server\\share")).toBe(false);
  });

  it("accepts the server-side separator replacement character", () => {
    expect(isSafePathComponent("sub〳dir")).toBe(true);
  });

  it("accepts a bare drive designator (documented contract)", () => {
    // "C:" carries no separator and is not dots-only, so the containment rule
    // passes it. path.win32.join/resolve do NOT reinterpret a colon component
    // embedded mid-path, so it cannot traverse; on native Windows the write
    // fails loudly with EINVAL instead. Pinned so a future tightening is a
    // deliberate decision, not drift.
    expect(isSafePathComponent("C:")).toBe(true);
  });
});

describe("getFileContextFromPath: flat layout with a git-on-Windows path shape", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves flat context from a forward-slash drive-letter absolute", () => {
    // git and globs on Windows emit "/" with a drive-letter prefix. The flat
    // branch keys off path.dirname/basename, which handle "/" on the win32
    // runtime too, so this shape must resolve on every platform.
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

    const ctx = getFileContextFromPath(
      "C:/proj/src/sys_script_include/MyUtil~script.js"
    );

    expect(ctx).toBeDefined();
    expect(ctx?.tableName).toBe("sys_script_include");
    expect(ctx?.name).toBe("MyUtil");
    expect(ctx?.targetField).toBe("script");
    expect(ctx?.sys_id).toBe("def456");
  });
});

describe("write seam: win32-shaped unsafe components are refused (INJ-1)", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-win32-"));

  it("rejects a backslash traversal in a file name", async () => {
    await expect(
      writeSNFileCurry(false)(
        { name: "..\\Bar\\script", type: "js", content: "x" } as any,
        tmpRoot
      )
    ).rejects.toThrow(/unsafe file name/);
  });

  it("rejects a drive-letter absolute in a file name", async () => {
    await expect(
      writeSNFileCurry(false)(
        { name: "C:\\evil", type: "js", content: "x" } as any,
        tmpRoot
      )
    ).rejects.toThrow(/unsafe file name/);
  });

  it("rejects a backslash-bearing file type", async () => {
    await expect(
      writeSNFileCurry(false)(
        { name: "script", type: "js\\..\\evil", content: "x" } as any,
        tmpRoot
      )
    ).rejects.toThrow(/unsafe file type/);
  });

  it("rejects a backslash traversal in a flat record name", async () => {
    await expect(
      writeFlatSNFileCurry(false)(
        { name: "script", type: "js", content: "x" } as any,
        tmpRoot,
        "..\\Bar"
      )
    ).rejects.toThrow(/unsafe record name/);
  });
});

describe("buildRecordName sanitization: win32-shaped display values", () => {
  type TableApiGet = jest.Mock<
    Promise<{ data: { result: Record<string, string>[] } }>,
    [string, string, string, number?]
  >;

  const createClient = (tableAPIGet: TableApiGet) =>
    ({ tableAPIGet } as unknown as import("../snClient.js").SNClient);

  const SYS_ID = "a".repeat(32);

  const download = async (row: Record<string, string>) => {
    const tableAPIGet: TableApiGet = jest.fn();
    tableAPIGet.mockResolvedValue({ data: { result: [row] } });
    return buildBulkDownloadFromTableAPI(
      { sys_script_include: { [SYS_ID]: [{ name: "script", type: "js" }] } },
      createClient(tableAPIGet),
      {}
    );
  };

  it("replaces backslashes in a display name with the server-side substitute", async () => {
    const result = await download({
      sys_id: SYS_ID,
      name: "sub\\dir",
      script: "x",
    });
    expect(Object.keys(result.sys_script_include.records)).toEqual(["sub〳dir"]);
  });

  it("neutralizes a drive-letter absolute display name into one component", async () => {
    const result = await download({
      sys_id: SYS_ID,
      name: "C:\\Temp\\evil",
      script: "x",
    });
    const [recordName] = Object.keys(result.sys_script_include.records);
    expect(recordName).toBe("C:〳Temp〳evil");
    expect(isSafePathComponent(recordName)).toBe(true);
  });

  it("keeps a backslash-only traversal name harmless after substitution", async () => {
    const result = await download({
      sys_id: SYS_ID,
      name: "..\\..",
      script: "x",
    });
    const [recordName] = Object.keys(result.sys_script_include.records);
    expect(recordName).toBe("..〳..");
    expect(isSafePathComponent(recordName)).toBe(true);
  });
});
