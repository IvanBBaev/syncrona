// SPDX-License-Identifier: GPL-3.0-or-later
import path from "path";
import {
  isUnderPath,
  toAbsolutePath,
  splitEncodedPaths,
  summarizeFile,
  appendToPath,
} from "../FileUtils.js";
import { PATH_DELIMITER } from "../constants.js";
import type { Sync } from "@syncrona/types";

describe("isUnderPath", () => {
  it("returns true when the child sits under the parent", () => {
    const parent = path.join(path.sep, "a", "b");
    const child = path.join(path.sep, "a", "b", "c", "d");
    expect(isUnderPath(parent, child)).toBe(true);
  });

  it("returns false when the child diverges from the parent", () => {
    const parent = path.join(path.sep, "a", "b");
    const child = path.join(path.sep, "a", "x");
    expect(isUnderPath(parent, child)).toBe(false);
  });

  it("treats an identical path as under itself", () => {
    const p = path.join(path.sep, "a", "b");
    expect(isUnderPath(p, p)).toBe(true);
  });

  it("ignores a trailing separator on the parent", () => {
    const parent = path.join(path.sep, "a", "b") + path.sep;
    const child = path.join(path.sep, "a", "b", "c");
    expect(isUnderPath(parent, child)).toBe(true);
  });

  it("ignores doubled separators in either path", () => {
    const parent = `${path.sep}a${path.sep}${path.sep}b`;
    const child = path.join(path.sep, "a", "b", "c");
    expect(isUnderPath(parent, child)).toBe(true);
  });

  // #19: Windows path normalization, made Linux-testable by feeding literal
  // Windows-shaped inputs (backslashes, drive letters, mixed separators). These
  // used to hinge on path.sep, so on Linux a "\\"-separated path collapsed into
  // one token and containment silently misfired. They now split on either
  // separator, so the same logic holds on both platforms.
  describe("cross-platform separators (#19)", () => {
    it("recognizes containment for pure backslash (Windows) paths", () => {
      expect(isUnderPath("C:\\proj\\src", "C:\\proj\\src\\table\\rec.js")).toBe(true);
    });

    it("rejects a divergent branch under a backslash parent", () => {
      expect(isUnderPath("C:\\proj\\src", "C:\\proj\\other\\rec.js")).toBe(false);
    });

    it("matches a parent and child that mix separators (git '/' under Node '\\')", () => {
      // git and globs emit forward slashes even on Windows, where Node builds
      // paths with backslashes — the two must still line up.
      expect(isUnderPath("C:\\proj\\src", "C:/proj/src/table/rec.js")).toBe(true);
      expect(isUnderPath("C:/proj/src", "C:\\proj\\src\\table\\rec.js")).toBe(true);
    });

    it("ignores a trailing backslash on the parent", () => {
      expect(isUnderPath("C:\\proj\\src\\", "C:\\proj\\src\\table\\rec.js")).toBe(true);
    });
  });
});

describe("toAbsolutePath", () => {
  it("returns an absolute path unchanged", () => {
    const abs = path.join(path.sep, "already", "absolute");
    expect(toAbsolutePath(abs)).toBe(abs);
  });

  it("resolves a relative path against the cwd", () => {
    expect(toAbsolutePath("rel/dir")).toBe(path.join(process.cwd(), "rel/dir"));
  });
});

describe("splitEncodedPaths", () => {
  it("splits on the delimiter and drops empty segments", () => {
    const encoded = ["/a", "", "/b", "/c"].join(PATH_DELIMITER);
    expect(splitEncodedPaths(encoded)).toEqual(["/a", "/b", "/c"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(splitEncodedPaths("")).toEqual([]);
  });
});

describe("summarizeFile", () => {
  it("renders table/record/sys_id", () => {
    const ctx = {
      tableName: "sys_script_include",
      name: "MyUtil",
      sys_id: "abc123",
    } as unknown as Sync.FileContext;
    expect(summarizeFile(ctx)).toBe("sys_script_include/MyUtil/abc123");
  });
});

describe("appendToPath", () => {
  it("joins a suffix onto the curried prefix", () => {
    expect(appendToPath("base")("leaf")).toBe(path.join("base", "leaf"));
  });
});
