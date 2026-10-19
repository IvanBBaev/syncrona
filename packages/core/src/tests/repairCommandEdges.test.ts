// SPDX-License-Identifier: GPL-3.0-or-later
// Further edges of `repair` against real files and real git (only under
// os.tmpdir()): committed file modes the git evidence must tell apart (an
// executable leftover is restorable, a committed symlink never vouches for a
// regular file), a HEAD manifest that parses to something other than an
// object, a git that fails without naming a path or prints no prefix line,
// sidecars of a manifest with no `tables` or a table with no `records`, the
// plural data-model warning, and a non-Error failure.
import { jest } from "@jest/globals";

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

import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
const REPORT = { logLevel: "info" } as never;
const posix = process.platform === "win32" ? test.skip : test;

let tmp: string;
let sourceDir: string;
let manifestPath: string;
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

// The current manifest holds Kept only; the committed one also tracked Gone, so
// Gone's files are download leftovers judged by the git evidence alone.
const useManifests = (): void => {
  (ConfigManager.getManifest as jest.Mock).mockReturnValue({
    scope: "x_app",
    tables: { sys_script: { records: { Kept: record("Kept") } } },
  });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      scope: "x_app",
      tables: { sys_script: { records: { Kept: record("Kept"), Gone: record("Gone") } } },
    })
  );
};

const GIT_ENV = ["PATH"];
let savedEnv: Record<string, string | undefined>;

// A stand-in git on PATH: `body` runs first and may answer the call itself;
// every other call goes to the real git.
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const wrapGit = (body: string): void => {
  const bin = path.join(tmp, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${body}\nexec "${realGit}" "$@"\n`, {
    mode: 0o755,
  });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  savedEnv = Object.fromEntries(GIT_ENV.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "sync-repair-more-edges-"));
  sourceDir = path.join(tmp, "src");
  manifestPath = path.join(tmp, "sync.manifest.json");
  mkdirSync(sourceDir, { recursive: true });
  (ConfigManager.getSourcePath as jest.Mock).mockReturnValue(sourceDir);
  (ConfigManager.getRootDir as jest.Mock).mockReturnValue(tmp);
  (ConfigManager.getManifestPath as jest.Mock).mockImplementation(() => manifestPath);
  (ConfigManager.getConfig as jest.Mock).mockReturnValue({});
  (AppUtils.findMissingFiles as jest.Mock<() => Promise<unknown>>).mockResolvedValue({});
  (AppUtils.processMissingFiles as jest.Mock<() => Promise<unknown>>).mockResolvedValue([]);
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
  warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
  successSpy = jest.spyOn(logger, "success").mockImplementation(() => {});
  useManifests();
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
  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("committed file modes", () => {
  posix("an executable leftover committed as 100755 is pruned and restorable with its mode", async () => {
    const leftover = write("sys_script/Gone/script.js", "#!/bin/sh\necho hi\n");
    chmodSync(leftover, 0o755);
    initRepo(tmp);
    expect(git(tmp, "ls-tree", "HEAD", "src/sys_script/Gone/script.js")).toMatch(/^100755 blob /);

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
    expect(process.exitCode).toBeUndefined();
    // The printed restore command gives back the exact bytes and the exec bit.
    git(sourceDir, "--literal-pathspecs", "checkout", "HEAD", "--", "sys_script/Gone/script.js");
    expect(readFileSync(leftover, "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(statSync(leftover).mode & 0o111).not.toBe(0);
  });

  posix("a regular file whose bytes equal a committed symlink's target is never vouched for", async () => {
    // HEAD holds Gone/script.js as a symlink: its blob is the link text. A
    // regular file with those exact bytes hashes to the same blob, but a
    // checkout would write a symlink back, not this file.
    write("sys_script/Kept/script.js", "kept");
    const link = path.join(sourceDir, "sys_script", "Gone", "script.js");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync("../Kept/script.js", link);
    initRepo(tmp);
    expect(git(tmp, "ls-tree", "HEAD", "src/sys_script/Gone/script.js")).toMatch(/^120000 blob /);
    rmSync(link);
    writeFileSync(link, "../Kept/script.js");

    await repairCommand(PRUNE);

    expect(existsSync(link)).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("../Kept/script.js");
    expect(logged(infoSpy)).not.toContain("Pruned");
    expect(logged(warnSpy)).toContain("git cannot restore");
    expect(logged(warnSpy)).toContain(link);
  });
});

describe("the manifest HEAD committed", () => {
  test("one that parses to a non-object tracks no record, so the orphan awaits push --create", async () => {
    const leftover = write("sys_script/Gone/script.js");
    writeFileSync(manifestPath, "null");
    initRepo(tmp);

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    const warning = logged(warnSpy);
    expect(warning).toContain("awaiting `push --create`");
    expect(warning).toContain(leftover);
    expect(logged(infoSpy)).toContain("Nothing to prune");
    expect(logged(infoSpy)).not.toContain("Pruned");
  });
});

describe("a git that answers unexpectedly", () => {
  posix("a hash-object failure that names no orphan refuses the whole prune", async () => {
    const first = write("sys_script/Gone/script.js");
    initRepo(tmp);
    wrapGit(
      'if [ "$1" = "hash-object" ]; then cat >/dev/null; echo "fatal: object store unavailable" >&2; exit 128; fi'
    );

    await repairCommand(PRUNE);

    expect(existsSync(first)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logged(errorSpy)).toContain("Refusing to prune");
    expect(logged(errorSpy)).toContain("(fatal: object store unavailable)");
    expect(logged(infoSpy)).not.toContain("Pruned");
  });

  posix("a rev-parse that prints no prefix line is read as the top of the repository", async () => {
    // The repository is the source directory itself, so the prefix is empty.
    manifestPath = path.join(sourceDir, "sync.manifest.json");
    useManifests();
    const leftover = write("sys_script/Gone/script.js");
    initRepo(sourceDir);
    wrapGit('if [ "$1" = "rev-parse" ]; then exec "' + realGit + '" rev-parse --show-toplevel; fi');

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Pruned 1 orphan file(s).");
  });
});

describe("sidecars against a partial manifest", () => {
  test("a manifest with no tables section keeps every sidecar as one of an unlisted table", async () => {
    (ConfigManager.getManifest as jest.Mock).mockReturnValue({ scope: "x_app" });
    const sidecar = write("sys_script/New~.meta.json", "{}");

    await repairCommand(REPORT);

    expect(existsSync(sidecar)).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      'Repair report for scope "x_app": 0 missing file(s), 0 orphan file(s).'
    );
    const warning = logged(warnSpy);
    expect(warning).toContain("Kept 1 metadata sidecar(s) of table(s) the manifest does not list");
    expect(warning).toContain(sidecar);
  });

  test("a listed table with no records section makes its sidecars orphans", async () => {
    (ConfigManager.getManifest as jest.Mock).mockReturnValue({
      scope: "x_app",
      tables: { sys_script: {} },
    });
    const sidecar = write("sys_script/Gone/.meta.json", "{}");

    await repairCommand(REPORT);

    expect(existsSync(sidecar)).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      'Repair report for scope "x_app": 0 missing file(s), 1 orphan file(s).'
    );
    expect(logged(infoSpy)).toContain(`Orphans (on disk, not in manifest):\n  ${sidecar}`);
  });
});

describe("data-model documents", () => {
  test("two unclaimed document entries are reported in the plural", async () => {
    (ConfigManager.getConfig as jest.Mock).mockReturnValue({
      dataModelLayout: "composite",
      dataModelTables: ["sys_dictionary"],
    });
    (ConfigManager.getManifest as jest.Mock).mockReturnValue({
      scope: "x_t",
      tables: { sys_dictionary: { records: {} } },
    });
    write(
      "data-model/x_t.json",
      JSON.stringify({
        format: "syncrona.data-model/1",
        table: "x_t",
        sys_dictionary: {
          "x_t.u_a": { element: "u_a", name: "x_t" },
          "x_t.u_b": { element: "u_b", name: "x_t" },
        },
      })
    );

    await repairCommand(REPORT);

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    const warning = logged(warnSpy);
    expect(warning).toMatch(/^2 data-model document entries no manifest record claims/m);
    expect(warning).toContain('"x_t.u_a"');
    expect(warning).toContain('"x_t.u_b"');
  });
});

describe("failure reporting", () => {
  test("a manifest that cannot be loaded reads as no manifest and nothing is scanned", async () => {
    const leftover = write("sys_script/Gone/script.js");
    (ConfigManager.getManifest as jest.Mock).mockImplementation(() => {
      throw new Error("Unexpected token } in JSON");
    });

    await repairCommand(PRUNE);

    expect(existsSync(leftover)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      "No manifest found. Run `syncrona refresh` or `syncrona download <scope>` first."
    );
    expect(process.exitCode).toBe(1);
    expect(AppUtils.findMissingFiles).not.toHaveBeenCalled();
  });

  test("a non-Error failure is reported as its string and fails the run", async () => {
    (AppUtils.findMissingFiles as jest.Mock<() => Promise<unknown>>).mockRejectedValue(
      "table API offline"
    );

    await repairCommand(REPORT);

    expect(errorSpy).toHaveBeenCalledWith("table API offline");
    expect(process.exitCode).toBe(1);
    expect(successSpy).not.toHaveBeenCalled();
  });
});
