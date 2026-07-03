// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import path from "path";

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

describe("gitUtils", () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ gitDiffToEncodedPaths, writeDiff } = await import("../gitUtils.js"));
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
