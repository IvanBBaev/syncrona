// SPDX-License-Identifier: GPL-3.0-or-later
// `repair --apply --prune` deletes local files, so it may only delete what can
// be got back. A file no manifest record claims is either a download leftover
// (a record deleted on the instance) or new local work that has not been pushed
// yet — a script or a column sidecar `push --create` will create — and the
// manifest alone cannot tell the two apart. Git can: a file committed and
// unchanged since HEAD is recoverable with `git checkout`, anything else is not.
//
// The second half pins manifest lookups against names that collide with
// Object.prototype members: a directory named `constructor` or `toString` must
// resolve against the manifest's own keys, never an inherited member.
import { jest } from "@jest/globals";

jest.unstable_mockModule("../config.js", () => ({
  getManifest: jest.fn(),
  getSourcePath: jest.fn(),
  getRootDir: jest.fn(),
  getConfig: jest.fn(),
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

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, promises as fsp } from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";
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

const record = (name: string, files: SN.File[] = [{ name: "script", type: "js" } as SN.File]) => ({
  name,
  sys_id: `id_${name}`,
  files,
});

// JSON.parse, not an object literal: a literal `__proto__` key sets the
// prototype instead of creating an own property, while a manifest read from
// disk holds it as an ordinary own key.
const useManifest = (tables: Record<string, unknown>): void => {
  const manifest = JSON.parse(JSON.stringify({ scope: "x_app", tables }).replace(/"PROTO"/g, '"__proto__"'));
  (ConfigManager.getManifest as jest.Mock).mockReturnValue(manifest);
};

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  tmp = mkdtempSync(path.join(os.tmpdir(), "sync-repair-git-"));
  sourceDir = path.join(tmp, "src");
  mkdirSync(sourceDir, { recursive: true });
  (ConfigManager.getSourcePath as jest.Mock).mockReturnValue(sourceDir);
  (ConfigManager.getRootDir as jest.Mock).mockReturnValue(tmp);
  (ConfigManager.getConfig as jest.Mock).mockReturnValue({});
  (AppUtils.findMissingFiles as jest.Mock<() => Promise<unknown>>).mockResolvedValue({});
  (AppUtils.processMissingFiles as jest.Mock<() => Promise<unknown>>).mockResolvedValue([]);
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
  warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
  successSpy = jest.spyOn(logger, "success").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("repair --prune deletes only files git can restore", () => {
  beforeEach(() => {
    useManifest({
      sys_script: { records: { Kept: record("Kept") } },
      sys_dictionary: { records: { "x_t.u_kept": record("x_t.u_kept", []) } },
    });
  });

  test("deletes a committed, unchanged download leftover", async () => {
    write("sys_script/Kept/script.js");
    const leftover = write("sys_script/Gone/script.js");
    const leftoverSidecar = write("sys_dictionary/x_t.u_gone/.meta.json", "{}");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(leftoverSidecar)).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 2 orphan file(s).");
    expect(process.exitCode).toBeUndefined();
  });

  test("keeps a new script and a new column sidecar that are not committed yet", async () => {
    initRepo(tmp);
    const newScript = write("sys_script/NewRule/script.js", "work in progress");
    const newColumn = write("sys_dictionary/x_t.u_new/.meta.json", '{"element":"u_new"}');

    await repairCommand(PRUNE);

    expect(existsSync(newScript)).toBe(true);
    expect(existsSync(newColumn)).toBe(true);
    const warning = logged(warnSpy);
    expect(warning).toContain("Kept 2 orphan file(s)");
    expect(warning).toContain(newScript);
    expect(warning).toContain(newColumn);
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("Pruned"));
    expect(process.exitCode).toBeUndefined();
  });

  test("keeps a staged but uncommitted file", async () => {
    initRepo(tmp);
    const staged = write("sys_script/Staged/script.js");
    git(tmp, "add", "-A");

    await repairCommand(PRUNE);

    expect(existsSync(staged)).toBe(true);
  });

  test("keeps a committed file that was edited since HEAD, staged or not", async () => {
    const edited = write("sys_script/Edited/script.js", "v1");
    const stagedEdit = write("sys_script/StagedEdit/script.js", "v1");
    initRepo(tmp);
    writeFileSync(edited, "v2 — local edit");
    writeFileSync(stagedEdit, "v2 — staged edit");
    git(tmp, "add", path.join("src", "sys_script", "StagedEdit", "script.js"));

    await repairCommand(PRUNE);

    expect(existsSync(edited)).toBe(true);
    expect(existsSync(stagedEdit)).toBe(true);
  });

  test("keeps an ignored, never-committed file", async () => {
    writeFileSync(path.join(tmp, ".gitignore"), "src/sys_script/Ignored/\n");
    initRepo(tmp);
    const ignored = write("sys_script/Ignored/script.js");

    await repairCommand(PRUNE);

    expect(existsSync(ignored)).toBe(true);
  });

  test("prunes the clean leftovers and keeps the local work in one run", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    const newScript = write("sys_script/NewRule/script.js");

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(newScript)).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
  });

  test("works when the source directory is a git subdirectory reached through a symlink", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    const link = path.join(os.tmpdir(), `sync-repair-link-${path.basename(tmp)}`);
    await fsp.symlink(tmp, link);
    try {
      (ConfigManager.getSourcePath as jest.Mock).mockReturnValue(path.join(link, "src"));
      (ConfigManager.getRootDir as jest.Mock).mockReturnValue(link);

      await repairCommand(PRUNE);

      expect(existsSync(leftover)).toBe(false);
    } finally {
      await fsp.unlink(link);
    }
  });

  test("refuses to prune outside a git repository and deletes nothing", async () => {
    const leftover = write("sys_script/Gone/script.js");

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(process.exitCode).toBe(1);
    const error = logged(errorSpy);
    expect(error).toContain("Refusing to prune");
    expect(error).toContain("git");
    // The orphans are still listed, so the user knows what to remove by hand.
    expect(logged(infoSpy)).toContain(leftover);
  });

  test("refuses to prune in a repository with no commit yet", async () => {
    git(tmp, "init", "-q");
    const leftover = write("sys_script/Gone/script.js");

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("never prompts or prunes when no orphan is restorable", async () => {
    initRepo(tmp);
    write("sys_script/NewRule/script.js");

    await repairCommand({ logLevel: "info", apply: true, prune: true } as never);

    expect(logged(infoSpy)).toContain("Nothing to prune");
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  test("keeps a committed field file of a table the manifest does not list", async () => {
    // A table the last refresh could not read, or one never pulled: its files
    // are not leftovers of this manifest, whatever git says.
    const unlisted = write("sys_ui_page/Page/html.html");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(existsSync(unlisted)).toBe(true);
    expect(logged(warnSpy)).toContain(unlisted);
    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining("Nothing to repair"));
  });

  test("reports a failed deletion of a restorable orphan", async () => {
    const leftover = write("sys_script/Gone/script.js");
    initRepo(tmp);
    jest.spyOn(fsp, "unlink").mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 0 orphan file(s).");
    expect(logged(errorSpy)).toContain("Failed to delete 1 orphan file(s)");
    expect(process.exitCode).toBe(1);
  });
});

describe("repair matches Object.prototype-named tables and records by own key", () => {
  const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

  test("files and sidecars of records named like prototype members are not orphans", async () => {
    const records: Record<string, unknown> = {};
    for (const name of NAMES) {
      records[name === "__proto__" ? "PROTO" : name] = record(name, [
        { name: "script", type: "js" } as SN.File,
        { name: ".meta", type: "json" } as SN.File,
      ]);
    }
    useManifest({ sys_script: { records } });
    const files = NAMES.flatMap((name) => [
      write(`sys_script/${name}/script.js`),
      write(`sys_script/${name}/.meta.json`, "{}"),
    ]);
    initRepo(tmp);

    await repairCommand(PRUNE);

    for (const file of files) {
      expect(existsSync(file)).toBe(true);
    }
    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining("Nothing to repair"));
  });

  test("a table named like a prototype member is matched by own key", async () => {
    useManifest({
      constructor: { records: { Rec: record("Rec") } },
      PROTO: { records: { Rec: record("Rec") } },
    });
    const kept = [write("constructor/Rec/script.js"), write("__proto__/Rec/script.js")];
    const leftover = write("constructor/Gone/script.js");
    initRepo(tmp);

    await repairCommand(PRUNE);

    for (const file of kept) {
      expect(existsSync(file)).toBe(true);
    }
    expect(existsSync(leftover)).toBe(false);
  });

  test("a table the manifest does not list is not found through Object.prototype", async () => {
    // `tables["toString"]` is Object.prototype.toString — a truthy value with no
    // records — so the sidecar read as the orphan of a listed table and was pruned.
    // An unlisted table's sidecar is reported and never pruned (sys_choice is
    // the control case); a prototype-named one must get the same verdict.
    useManifest({ sys_script: { records: {} } });
    const sidecars = [...NAMES, "sys_choice"].map((name) => write(`${name}/Rec/.meta.json`, "{}"));
    initRepo(tmp);

    await repairCommand(PRUNE);

    for (const file of sidecars) {
      expect(existsSync(file)).toBe(true);
    }
    expect(logged(warnSpy)).toContain(`Kept ${sidecars.length} metadata sidecar(s)`);
    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining("Nothing to repair"));
  });

  test("a record missing from the manifest is an orphan even when named like a prototype member", async () => {
    useManifest({ sys_script: { records: { Other: record("Other") } } });
    const leftovers = NAMES.filter((n) => n !== "__proto__").map((name) =>
      write(`sys_script/${name}/script.js`)
    );
    initRepo(tmp);

    await repairCommand(PRUNE);

    for (const file of leftovers) {
      expect(existsSync(file)).toBe(false);
    }
    expect(infoSpy).toHaveBeenCalledWith(`Pruned ${leftovers.length} orphan file(s).`);
  });
});
