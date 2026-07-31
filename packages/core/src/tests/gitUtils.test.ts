// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import path from "path";
// Not mocked (it only depends on "path"), so the suite asserts against the real
// delimiter instead of hard-coding a platform-specific one.
import { PATH_DELIMITER } from "../constants.js";

export {};

// gitUtils shells out to `git` (execFile, no shell) and writes the diff file.
// We mock the process boundary (child_process), the filesystem, config paths
// and FileUtils so the real branch logic in formatGitFiles/isValidScope runs:
// empty lines, deletions, rename/copy columns and scope filtering.
const mockExecFile = jest.fn();
const mockWriteFile = jest.fn();
const mockGetSourcePath = jest.fn();
const mockGetDiffPath = jest.fn();
const mockEncodedPathsToFilePaths = jest.fn();

jest.unstable_mockModule("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.unstable_mockModule("fs", () => ({
  __esModule: true,
  default: { promises: { writeFile: (...args: unknown[]) => mockWriteFile(...args) } },
  promises: { writeFile: (...args: unknown[]) => mockWriteFile(...args) },
}));

jest.unstable_mockModule("../config.js", () => ({
  getSourcePath: (...args: unknown[]) => mockGetSourcePath(...args),
  getDiffPath: (...args: unknown[]) => mockGetDiffPath(...args),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  encodedPathsToFilePaths: (...args: unknown[]) => mockEncodedPathsToFilePaths(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: { info: jest.fn(), silly: jest.fn() },
}));

// The SUT is imported dynamically AFTER the module mocks are registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the
// real config/FileUtils before the mocks take effect.
let gitDiffToEncodedPaths: typeof import("../gitUtils.js").gitDiffToEncodedPaths;
let writeDiff: typeof import("../gitUtils.js").writeDiff;
let getCurrentBranch: typeof import("../gitUtils.js").getCurrentBranch;

describe("gitUtils", () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ gitDiffToEncodedPaths, writeDiff, getCurrentBranch } = await import(
      "../gitUtils.js"
    ));
    // Repo root "/repo", workspace inside it -> relative scope "packages/scope".
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/repo/packages/scope");
    // rev-parse returns the repo root; any other git call returns the diff text.
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (e: unknown, out: string) => void) => {
        if (args.includes("rev-parse")) {
          cb(null, "/repo\n");
        } else {
          cb(null, DIFF_OUTPUT);
        }
      }
    );
  });

  afterEach(() => cwdSpy.mockRestore());

  const DIFF_OUTPUT = [
    "", // blank line -> skipped
    "M\tpackages/scope/src/keep.js", // in scope -> kept
    "D\tpackages/scope/src/gone.js", // deletion -> skipped
    "R100\tpackages/scope/src/old.js\tpackages/scope/src/new.js", // rename -> new path kept
    "X", // single column (no tab) -> skipped
    "M\tpackages/other/foo.js", // out of scope -> skipped
  ].join("\n");

  it("returns the source path unchanged when the diff target is empty", async () => {
    mockGetSourcePath.mockReturnValue("/repo/packages/scope/src");
    const result = await gitDiffToEncodedPaths("");
    expect(result).toBe("/repo/packages/scope/src");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("keeps in-scope additions/renames and drops deletions, junk and out-of-scope files", async () => {
    mockGetSourcePath.mockReturnValue("/repo/packages/scope/src");
    const result = await gitDiffToEncodedPaths("HEAD~1");

    // diff invoked with the "<target>..." three-dot range against the source path.
    const diffCall = mockExecFile.mock.calls.find((c) => c[1].includes("diff"));
    expect(diffCall?.[1]).toContain("HEAD~1...");
    expect(diffCall?.[1]).toContain("/repo/packages/scope/src");

    expect(result).toContain(path.resolve("/repo", "packages/scope/src/keep.js"));
    expect(result).toContain(path.resolve("/repo", "packages/scope/src/new.js"));
    expect(result).not.toContain("gone.js");
    expect(result).not.toContain("foo.js");
    expect(result).not.toContain("old.js");
  });

  it("rejects when git exits with an error", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown, out: string) => void) =>
        cb(new Error("fatal: not a git repository"), "")
    );
    await expect(gitDiffToEncodedPaths("HEAD")).rejects.toThrow(
      "fatal: not a git repository"
    );
  });

  // #19: on Windows path.relative()/path.sep yield "\\" for the scope while git
  // always emits "/", so a bare separator match dropped every in-scope file (an
  // empty `push --diff`). isValidScope now normalizes both sides, so a file
  // whose diff path uses the FOREIGN separator relative to the scope is still
  // recognized. We feed a backslash-separated diff path to prove the classifier
  // is separator-agnostic on Linux (where path.sep is "/").
  it("keeps an in-scope file even when the diff path uses the foreign separator (#19)", async () => {
    mockGetSourcePath.mockReturnValue("/repo/packages/scope/src");
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (e: unknown, out: string) => void) => {
        if (args.includes("rev-parse")) {
          cb(null, "/repo\n");
        } else {
          // A Windows-shaped diff path (backslashes) under the same scope.
          cb(null, "M\tpackages\\scope\\src\\win.js");
        }
      }
    );

    const result = await gitDiffToEncodedPaths("HEAD~1");
    // The file is recognized as in-scope and resolved to an absolute path.
    expect(result).toContain("win.js");
  });

  // #5: when the workspace (cwd) IS the repo root, path.relative(root, cwd) is
  // "", so every diff path is in scope. Previously isValidScope compared each
  // file against the empty string and rejected everything, making `push --diff`
  // silently empty for a repo whose scope lives at the repository root.
  it("keeps every changed file when the workspace is the repo root (#5)", async () => {
    mockGetSourcePath.mockReturnValue("/repo/src");
    // cwd == repo root -> relative scope is "".
    cwdSpy.mockReturnValue("/repo");
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (e: unknown, out: string) => void) => {
        if (args.includes("rev-parse")) {
          cb(null, "/repo\n");
        } else {
          cb(null, ["M\tsrc/keep.js", "M\tlib/other.js"].join("\n"));
        }
      }
    );

    const result = await gitDiffToEncodedPaths("HEAD~1");
    expect(result).toContain(path.resolve("/repo", "src/keep.js"));
    expect(result).toContain(path.resolve("/repo", "lib/other.js"));
  });

  // RT-1: git diff is invoked with core.quotePath=false so non-ASCII paths are
  // emitted as literal UTF-8. Under the default (quotePath=true) git C-quotes any
  // byte >0x80 ("src/…/\320\242…/script.js"), which never matches a real file and
  // is silently dropped by the tab-split parser -> an empty `push --diff`.
  it("invokes git diff with core.quotePath=false so non-ASCII paths are not C-quoted (RT-1)", async () => {
    mockGetSourcePath.mockReturnValue("/repo/packages/scope/src");
    await gitDiffToEncodedPaths("HEAD~1");

    const diffCall = mockExecFile.mock.calls.find((c) => c[1].includes("diff"));
    const args = diffCall?.[1] as string[];
    expect(args).toContain("-c");
    expect(args).toContain("core.quotePath=false");
    // The flag must precede the "diff" subcommand (git config args come first).
    expect(args.indexOf("core.quotePath=false")).toBeLessThan(args.indexOf("diff"));
  });

  it("keeps an in-scope file whose path contains Cyrillic characters (RT-1)", async () => {
    mockGetSourcePath.mockReturnValue("/repo/packages/scope/src");
    const cyrillicPath = "packages/scope/src/sys_script_include/Тест/script.js";
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (e: unknown, out: string) => void) => {
        if (args.includes("rev-parse")) {
          cb(null, "/repo\n");
        } else {
          // With quotePath=false git emits the literal UTF-8 path.
          cb(null, `M\t${cyrillicPath}`);
        }
      }
    );

    const result = await gitDiffToEncodedPaths("HEAD~1");
    expect(result).toContain(path.resolve("/repo", cyrillicPath));
  });

  // REV-96 (GATE-2): the DIFF_OUTPUT fixture above starts with a blank line, but
  // execGit trims stdout, so the `diffFile === ""` guard in formatGitFiles was
  // never actually reached. Only an INTERIOR blank line exercises it — and git
  // does emit one when a diff chunk is separated (e.g. `-z`-less multi-range
  // output), so the guard is live code, not dead code.
  it("skips a blank line in the middle of the diff without dropping the files around it", async () => {
    mockGetSourcePath.mockReturnValue("/repo/packages/scope/src");
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (e: unknown, out: string) => void) => {
        if (args.includes("rev-parse")) {
          cb(null, "/repo\n");
        } else {
          cb(
            null,
            [
              "M\tpackages/scope/src/before.js",
              "",
              "M\tpackages/scope/src/after.js",
            ].join("\n")
          );
        }
      }
    );

    const result = await gitDiffToEncodedPaths("HEAD~1");
    expect(result).toContain(path.resolve("/repo", "packages/scope/src/before.js"));
    expect(result).toContain(path.resolve("/repo", "packages/scope/src/after.js"));
    // Exactly two entries: the blank line must not become a third (which would
    // resolve to the repo root and get pushed as a bogus path).
    expect(result.split(PATH_DELIMITER)).toHaveLength(2);
  });

  // getCurrentBranch feeds `syncrona jira`'s branch fallback (jiraCommands.ts):
  // when no issue key is passed, the branch name is mined for one. It had no test
  // at all, so every one of its degradation paths was unverified.
  describe("getCurrentBranch", () => {
    it("returns the trimmed branch name from git rev-parse --abbrev-ref HEAD", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (e: unknown, out: string) => void) =>
          cb(null, "feature/ABC-123-add-widget\n")
      );

      await expect(getCurrentBranch()).resolves.toBe("feature/ABC-123-add-widget");
      expect(mockExecFile.mock.calls[0][1]).toEqual([
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
    });

    it("returns null on a detached HEAD instead of the literal \"HEAD\"", async () => {
      // git reports "HEAD" when detached; treating that as a branch name would
      // send "HEAD" to the Jira key parser and produce a bogus lookup.
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (e: unknown, out: string) => void) =>
          cb(null, "HEAD\n")
      );

      await expect(getCurrentBranch()).resolves.toBeNull();
    });

    it("returns null when git prints nothing", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (e: unknown, out: string) => void) =>
          cb(null, "   \n")
      );

      await expect(getCurrentBranch()).resolves.toBeNull();
    });

    it("resolves to null instead of throwing when git fails", async () => {
      // Not a repo / git not installed: the caller uses this for best-effort key
      // inference, so it must degrade to "no branch", never reject.
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (e: unknown, out: string) => void) =>
          cb(new Error("fatal: not a git repository"), "")
      );

      await expect(getCurrentBranch()).resolves.toBeNull();
    });
  });

  it("writeDiff resolves encoded paths and writes them to the diff file as JSON", async () => {
    mockEncodedPathsToFilePaths.mockResolvedValue(["/a/b.js", "/a/c.js"]);
    mockGetDiffPath.mockReturnValue("/repo/.syncrona/diff.json");

    await writeDiff("encoded::paths");

    expect(mockEncodedPathsToFilePaths).toHaveBeenCalledWith("encoded::paths");
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/repo/.syncrona/diff.json",
      JSON.stringify({ changed: ["/a/b.js", "/a/c.js"] })
    );
  });
});
