// SPDX-License-Identifier: GPL-3.0-or-later
// The edges of the git evidence `repair --apply --prune` deletes by: how a git
// failure is reported, one file git cannot read, names macOS stores decomposed
// while git stores them precomposed, an exported GIT_DIR, long path lists, line
// endings, and what the prompt and the final line tell the user.
import { jest } from "@jest/globals";
import { execFileSync } from "child_process";

jest.unstable_mockModule("../config.js", () => ({
  getManifest: jest.fn(),
  getSourcePath: jest.fn(),
  getRootDir: jest.fn(),
  getConfig: jest.fn(),
  getManifestPath: jest.fn(),
}));
jest.unstable_mockModule("../appUtils.js", () => ({
  findMissingFiles: jest.fn(),
  processMissingFiles: jest.fn(),
}));
// A prompt that reached the real inquirer would hang the run on stdin.
const mockPrompt = jest.fn(async (..._args: unknown[]) => ({ confirmed: false }));
jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { git, initRepo } from "./helpers/gitFixture.js";

let ConfigManager: typeof import("../config.js");
let AppUtils: typeof import("../appUtils.js");
let logger: typeof import("../Logger.js").logger;
let repairCommand: typeof import("../repairCommand.js").repairCommand;

beforeAll(async () => {
  ConfigManager = await import("../config.js");
  AppUtils = await import("../appUtils.js");
  ({ logger } = await import("../Logger.js"));
  ({ repairCommand } = await import("../repairCommand.js"));
});

const PRUNE = { logLevel: "info", apply: true, prune: true, ci: true } as never;
// Records the committed manifest tracked: their files are download leftovers,
// judged by the git evidence alone.
const LEFTOVERS = ["Gone", "Other", "Third"];

let tmp: string;
let sourceDir: string;
let infoSpy: jest.SpiedFunction<typeof logger.info>;
let warnSpy: jest.SpiedFunction<typeof logger.warn>;
let errorSpy: jest.SpiedFunction<typeof logger.error>;
let successSpy: jest.SpiedFunction<typeof logger.success>;

const logged = (spy: jest.SpiedFunction<typeof logger.info>): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

const write = (rel: string, content = "content"): string => {
  const file = path.join(sourceDir, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const record = (name: string) => ({
  name,
  sys_id: `id_${name}`,
  files: [{ name: "script", type: "js" }],
});

const useManifests = (leftovers: string[]): void => {
  (ConfigManager.getManifest as jest.Mock).mockReturnValue({
    scope: "x_app",
    tables: { sys_script: { records: { Kept: record("Kept") } } },
  });
  writeFileSync(
    path.join(tmp, "sync.manifest.json"),
    JSON.stringify({
      scope: "x_app",
      tables: {
        sys_script: {
          records: Object.fromEntries(["Kept", ...leftovers].map((n) => [n, record(n)])),
        },
      },
    })
  );
};

// The variables an outer git process (a hook, `git rebase -x`, a worktree
// script) exports; restored after every test.
// The env the command's git calls inherit (the fixture's own git calls do not
// see these: they run in the real process environment, not Jest's copy of it).
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES", "PATH"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  savedEnv = Object.fromEntries(GIT_ENV.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "sync-repair-edges-"));
  sourceDir = path.join(tmp, "src");
  mkdirSync(sourceDir, { recursive: true });
  (ConfigManager.getSourcePath as jest.Mock).mockReturnValue(sourceDir);
  (ConfigManager.getRootDir as jest.Mock).mockReturnValue(tmp);
  (ConfigManager.getManifestPath as jest.Mock).mockReturnValue(path.join(tmp, "sync.manifest.json"));
  (ConfigManager.getConfig as jest.Mock).mockReturnValue({});
  (AppUtils.findMissingFiles as jest.Mock<() => Promise<unknown>>).mockResolvedValue({});
  (AppUtils.processMissingFiles as jest.Mock<() => Promise<unknown>>).mockResolvedValue([]);
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
  warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
  successSpy = jest.spyOn(logger, "success").mockImplementation(() => {});
  useManifests(LEFTOVERS);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // chmod 000 directories or files must not make the cleanup fail.
  try {
    chmodSync(path.join(sourceDir, "sys_script", "Other", "script.js"), 0o644);
  } catch (_e) {
    // not created by this test
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("a git failure names git's own reason", () => {
  test("the refusal quotes git's fatal line, not the command line", async () => {
    git(tmp, "init", "-q");
    const leftover = write("sys_script/Gone/script.js");

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(process.exitCode).toBe(1);
    const error = logged(errorSpy);
    expect(error).toContain("Refusing to prune");
    expect(error).toMatch(/\(fatal: [^)]*HEAD/);
    expect(error).not.toContain("Command failed");
    expect(error).not.toContain(leftover);
  });

  test("outside any repository the reason is git's own", async () => {
    const leftover = write("sys_script/Gone/script.js");
    // A ceiling at tmp stops discovery from finding a repository above it.
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(tmp);

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(logged(errorSpy)).toMatch(/\(fatal: not a git repository/);
  });

  test("a missing git binary is named as such", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    process.env.PATH = path.join(tmp, "no-bin");

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logged(errorSpy)).toContain("(git is not installed or not on PATH)");
  });

  // A git wrapper on PATH that fails `ls-tree` the way a test asks and hands
  // every other call to the real git. Which real git failure lacks a `fatal:`
  // line differs by platform and git version, so without the wrapper the two
  // platforms measured different branches of the reason formatter.
  const failLsTree = (stderr: string, code: number): void => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = path.join(tmp, "fake-bin");
    mkdirSync(bin, { recursive: true });
    const script = path.join(bin, "git");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'if [ "$1" = "ls-tree" ]; then',
        stderr === "" ? "  :" : `  printf '%s\\n' '${stderr}' >&2`,
        `  exit ${code}`,
        "fi",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n")
    );
    chmodSync(script, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  };
  const posixOnly = process.platform === "win32" ? test.skip : test;

  posixOnly("without a fatal line the reason is git's last stderr line", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    failLsTree("error: object file is empty", 128);

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logged(errorSpy)).toContain("(error: object file is empty)");
  });

  posixOnly("a git failure with no stderr at all names the command and its exit code", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    failLsTree("", 3);

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logged(errorSpy)).toContain("(git ls-tree exited with code 3)");
  });
});

describe("one file git cannot read", () => {
  const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const unlessRoot = runsAsRoot || process.platform === "win32" ? test.skip : test;

  unlessRoot("is kept with git's reason and the rest are still pruned", async () => {
    const before = write("sys_script/Gone/script.js");
    const unreadable = write("sys_script/Other/script.js");
    const after = write("sys_script/Third/script.js");
    initRepo(tmp);
    chmodSync(unreadable, 0o000);

    await repairCommand(PRUNE);

    expect(existsSync(before)).toBe(false);
    expect(existsSync(after)).toBe(false);
    expect(existsSync(unreadable)).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 2 orphan file(s).");
    const warning = logged(warnSpy);
    expect(warning).toContain("git could not read");
    expect(warning).toContain(unreadable);
    expect(warning).toMatch(/Permission denied/i);
    expect(logged(errorSpy)).not.toContain("Refusing to prune");
    expect(process.exitCode).toBeUndefined();
  });
});

describe("Unicode normalization of file names", () => {
  test("a committed orphan stored decomposed on disk is pruned under core.precomposeunicode", async () => {
    // macOS keeps the decomposed name a tool wrote (NFD); git with
    // core.precomposeunicode (git init's default there) commits it precomposed.
    const nfd = "café.js";
    const file = write(`sys_script/Gone/${nfd}`);
    git(tmp, "init", "-q");
    git(tmp, "config", "core.precomposeunicode", "true");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(existsSync(file)).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
  });

  // git init sets core.precomposeunicode on macOS only, so without this the
  // as-is comparison ran on Linux alone and the two platforms measured
  // different branch coverage.
  test("with core.precomposeunicode disabled, names are compared as they are", async () => {
    const plain = write("sys_script/Gone/script.js");
    const nfc = write("sys_script/Other/café.js");
    git(tmp, "init", "-q");
    git(tmp, "config", "core.precomposeunicode", "false");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(existsSync(plain)).toBe(false);
    expect(existsSync(nfc)).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 2 orphan file(s).");
  });

});

describe("the repository is found from the source directory", () => {
  test("an exported GIT_DIR does not misalign the committed paths", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    process.env.GIT_DIR = path.join(tmp, ".git");

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
  });

  test("a GIT_DIR naming another repository is not used to judge this one", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    const other = mkdtempSync(path.join(os.tmpdir(), "sync-repair-other-"));
    try {
      git(other, "init", "-q");
      process.env.GIT_DIR = path.join(other, ".git");

      await repairCommand(PRUNE);

      expect(existsSync(leftover)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("many orphans", () => {
  test("hundreds of long-named orphans are hashed and pruned", async () => {
    // 600 paths of ~150 characters exceed the 32,767-character command line
    // Windows allows: the paths go to git on stdin, not as arguments.
    const names = Array.from({ length: 600 }, (_, i) => `Leftover_${"x".repeat(120)}_${i}`);
    useManifests(names);
    const files = names.map((name) => write(`sys_script/${name}/script.js`));
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(files.filter((f) => existsSync(f))).toEqual([]);
    expect(infoSpy).toHaveBeenCalledWith(`Pruned ${files.length} orphan file(s).`);
  });

  test("a top-level directory starting with a quote is not read as a C-quoted path", async () => {
    // hash-object --stdin-paths unquotes a line that starts with `"`.
    sourceDir = path.join(tmp, '"src');
    mkdirSync(sourceDir);
    (ConfigManager.getSourcePath as jest.Mock).mockReturnValue(sourceDir);
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(false);
  });
});

describe("line endings", () => {
  test("a CRLF copy of an LF blob under text=auto counts as unchanged, and checkout restores its text", async () => {
    // Decision (see restorableFromGit): the clean filter maps CRLF to the LF the
    // commit holds, so git calls the file unchanged. Deleting it loses no text:
    // a checkout writes it back with the line endings the repository's own eol
    // policy picks. Only the terminators can differ, never the content.
    writeFileSync(path.join(tmp, ".gitattributes"), "* text=auto\n");
    const leftover = write("sys_script/Gone/script.js", "a\nb\n");
    initRepo(tmp);
    writeFileSync(leftover, "a\r\nb\r\n");

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(false);
    git(sourceDir, "-c", "core.autocrlf=false", "checkout", "HEAD", "--", "sys_script/Gone/script.js");
    expect(readFileSync(leftover, "utf8").replace(/\r\n/g, "\n")).toBe("a\nb\n");
  });
});

describe("what the user is told", () => {
  test("the prompt says git restores the files and the run prints the restore command", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    mockPrompt.mockResolvedValue({ confirmed: true });

    await repairCommand({ logLevel: "info", apply: true, prune: true } as never);

    const [[questions]] = mockPrompt.mock.calls as unknown as [[{ message: string }[]]];
    expect(questions[0].message).not.toContain("cannot be undone");
    expect(questions[0].message).toContain("git");
    expect(existsSync(leftover)).toBe(false);
    const restore = logged(infoSpy)
      .split("\n")
      .find((line) => line.includes("checkout HEAD --"));
    expect(restore).toBeDefined();
    expect(restore).toContain("sys_script/Gone/script.js");
    // The printed command works.
    const command = restore!.slice(restore!.indexOf("git -C"));
    expect(command).toContain(sourceDir);
    git(sourceDir, "checkout", "HEAD", "--", "sys_script/Gone/script.js");
    expect(existsSync(leftover)).toBe(true);
  });

  test("many pruned files get a restore template, and a name that needs quoting is quoted", async () => {
    const names = Array.from({ length: 11 }, (_, i) => `Leftover ${i}`);
    useManifests(names);
    names.forEach((name) => write(`sys_script/${name}/script.js`));
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(infoSpy).toHaveBeenCalledWith("Pruned 11 orphan file(s).");
    expect(logged(infoSpy)).toContain("checkout HEAD -- <file>");

    // One file: listed, and quoted because of the space.
    rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    infoSpy.mockClear();
    write("sys_script/Leftover 0/script.js");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(logged(infoSpy)).toContain("checkout HEAD -- 'sys_script/Leftover 0/script.js'");
  });

  test("the final line is no success when orphans were kept", async () => {
    initRepo(tmp);
    write("sys_script/NewRule/script.js");

    await repairCommand(PRUNE);

    expect(successSpy).not.toHaveBeenCalledWith(expect.stringContaining("Repair complete"));
    expect(logged(warnSpy)).toMatch(/1 orphan file\(s\) left in place/);
  });

  test("the final line is no success when pruning was declined", async () => {
    write("sys_script/Gone/script.js");
    initRepo(tmp);
    mockPrompt.mockResolvedValue({ confirmed: false });

    await repairCommand({ logLevel: "info", apply: true, prune: true } as never);

    expect(successSpy).not.toHaveBeenCalled();
    expect(logged(warnSpy)).toMatch(/1 orphan file\(s\) left in place/);
  });

  test("the final line is a success when every orphan was pruned", async () => {
    write("sys_script/Gone/script.js");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(successSpy).toHaveBeenCalledWith("Repair complete. ✅");
  });
});
