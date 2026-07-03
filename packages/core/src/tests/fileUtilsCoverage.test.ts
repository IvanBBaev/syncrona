// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// The config module is mocked so the path-derivation helpers (manifest,
// source/build roots) are driven from the tests rather than a real project on
// disk. FileUtils accesses config only through a namespace import and touches
// exactly these four helpers, so stubbing just them is sufficient; any other
// config name a graph neighbour hard-links is stubbed below as needed.
jest.unstable_mockModule("../config.js", () => ({
  getManifest: jest.fn(),
  getManifestPath: jest.fn(),
  getSourcePath: jest.fn(),
  getBuildPath: jest.fn(),
}));

import { PATH_DELIMITER } from "../constants.js";

// Under ESM, jest.unstable_mockModule does not hoist: a static import of the SUT
// or of a mocked module is evaluated (and bound to the real module) before the
// mock registers. So the SUT, the mocked config namespace, and the logger
// singleton the tests spy on are all imported dynamically in beforeAll, after
// the mock is in place. PATH_DELIMITER is a plain constant and can stay static.
let writeManifestFile: typeof import("../FileUtils.js").writeManifestFile;
let writeSNFileCurry: typeof import("../FileUtils.js").writeSNFileCurry;
let writeFlatSNFileCurry: typeof import("../FileUtils.js").writeFlatSNFileCurry;
let pathExists: typeof import("../FileUtils.js").pathExists;
let getBuildExt: typeof import("../FileUtils.js").getBuildExt;
let getFileContextFromPath: typeof import("../FileUtils.js").getFileContextFromPath;
let isDirectory: typeof import("../FileUtils.js").isDirectory;
let getPathsInPath: typeof import("../FileUtils.js").getPathsInPath;
let isValidPath: typeof import("../FileUtils.js").isValidPath;
let encodedPathsToFilePaths: typeof import("../FileUtils.js").encodedPathsToFilePaths;
let writeBuildFile: typeof import("../FileUtils.js").writeBuildFile;
let ConfigManager: typeof import("../config.js");
let logger: typeof import("../Logger.js").logger;

beforeAll(async () => {
  ({
    writeManifestFile,
    writeSNFileCurry,
    writeFlatSNFileCurry,
    pathExists,
    getBuildExt,
    getFileContextFromPath,
    isDirectory,
    getPathsInPath,
    isValidPath,
    encodedPathsToFilePaths,
    writeBuildFile,
  } = await import("../FileUtils.js"));
  ConfigManager = await import("../config.js");
  ({ logger } = await import("../Logger.js"));
});

const asMock = (fn: unknown): jest.Mock => fn as unknown as jest.Mock;

// Track every temp directory so cleanup is exhaustive and no bytes leak outside
// the OS temp dir between runs.
const tmpDirs: string[] = [];
const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-fucov-"));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeManifestFile", () => {
  it("atomically writes the manifest JSON to the configured path", async () => {
    const root = makeTmpDir();
    const manifestPath = path.join(root, "manifest.json");
    asMock(ConfigManager.getManifestPath).mockReturnValue(manifestPath);

    const manifest = { scope: "x_app", tables: {} } as any;
    await writeManifestFile(manifest);

    // The final file exists with the serialized content and the sibling temp
    // file has been renamed away (no leftover *.tmp).
    const written = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(written).toEqual(manifest);
    const leftovers = fs.readdirSync(root).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("writeSNFileCurry content coercion", () => {
  it("writes an empty file when content is null", async () => {
    const root = makeTmpDir();
    await writeSNFileCurry(false)(
      { name: "empty", type: "js", content: null } as any,
      root
    );
    expect(fs.readFileSync(path.join(root, "empty.js"), "utf8")).toBe("");
  });

  it("serializes non-string content to pretty JSON", async () => {
    const root = makeTmpDir();
    await writeSNFileCurry(false)(
      { name: "obj", type: "json", content: { a: 1, b: [2, 3] } } as any,
      root
    );
    const raw = fs.readFileSync(path.join(root, "obj.json"), "utf8");
    expect(raw).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
    expect(JSON.parse(raw)).toEqual({ a: 1, b: [2, 3] });
  });

  it("falls back to String() when content is not JSON-serializable", async () => {
    const root = makeTmpDir();
    // A circular object throws in JSON.stringify, exercising the catch fallback.
    const circular: any = { name: "loop" };
    circular.self = circular;
    await writeSNFileCurry(false)(
      { name: "circular", type: "txt", content: circular } as any,
      root
    );
    const raw = fs.readFileSync(path.join(root, "circular.txt"), "utf8");
    expect(raw).toBe(String(circular));
    expect(raw).toBe("[object Object]");
  });

  it("refuses to write a name that escapes the target directory", async () => {
    const root = makeTmpDir();
    const escaping: any = {
      name: path.join("..", "escape"),
      type: "js",
      content: "x",
    };
    await expect(
      writeSNFileCurry(false)(escaping, root)
    ).rejects.toThrow(/Refusing to write .* outside its table directory/);
    // Nothing must have been written above the target directory.
    const parent = path.dirname(root);
    expect(fs.existsSync(path.join(parent, "escape.js"))).toBe(false);
  });

  it("skips the write when checkExists=true and the file already exists", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "keep.js");
    fs.writeFileSync(filePath, "original");
    await writeSNFileCurry(true)(
      { name: "keep", type: "js", content: "new" } as any,
      root
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
  });

  it("performs the write when checkExists=true and the file is missing", async () => {
    const root = makeTmpDir();
    await writeSNFileCurry(true)(
      { name: "fresh", type: "js", content: "created" } as any,
      root
    );
    expect(fs.readFileSync(path.join(root, "fresh.js"), "utf8")).toBe("created");
  });
});

describe("writeFlatSNFileCurry", () => {
  it("writes a single flat-encoded file directly under the table directory", async () => {
    const root = makeTmpDir();
    await writeFlatSNFileCurry(false)(
      { name: "script", type: "js", content: "flat" } as any,
      root,
      "MyRecord"
    );
    // Flat layout collapses <record>/<field> into <record>~<field>.<ext>.
    const flatPath = path.join(root, "MyRecord~script.js");
    expect(fs.readFileSync(flatPath, "utf8")).toBe("flat");
  });
});

describe("pathExists", () => {
  it("returns true for an existing path", async () => {
    const root = makeTmpDir();
    expect(await pathExists(root)).toBe(true);
  });

  it("returns false for a missing path", async () => {
    const root = makeTmpDir();
    expect(await pathExists(path.join(root, "does-not-exist"))).toBe(false);
  });
});

describe("getBuildExt", () => {
  const manifestWith = (files: Array<{ name: string; type: string }>) => ({
    scope: "x_app",
    tables: {
      sys_script_include: {
        records: {
          MyUtil: { sys_id: "sid", files },
        },
      },
    },
  });

  it("returns the file type for the matching field", () => {
    asMock(ConfigManager.getManifest).mockReturnValue(
      manifestWith([{ name: "script", type: "js" }])
    );
    expect(getBuildExt("sys_script_include", "MyUtil", "script")).toBe("js");
  });

  it("throws when no manifest is loaded", () => {
    asMock(ConfigManager.getManifest).mockReturnValue(undefined);
    expect(() => getBuildExt("sys_script_include", "MyUtil", "script")).toThrow(
      "Failed to retrieve manifest"
    );
  });

  it("throws when the field is not present in the record", () => {
    asMock(ConfigManager.getManifest).mockReturnValue(
      manifestWith([{ name: "script", type: "js" }])
    );
    expect(() =>
      getBuildExt("sys_script_include", "MyUtil", "missing")
    ).toThrow("Unable to find file");
  });
});

describe("getFileContextFromPath flat-encoded paths", () => {
  it("resolves a flat-encoded path off the file stem", () => {
    asMock(ConfigManager.getManifest).mockReturnValue({
      scope: "x_app",
      tables: {
        sys_script_include: {
          records: {
            MyUtil: { sys_id: "sid789", files: [{ name: "script", type: "js" }] },
          },
        },
      },
    });
    // <table>/<record>~<field>.<ext>
    const filePath = path.join("/proj/src/sys_script_include", "MyUtil~script.js");
    const ctx = getFileContextFromPath(filePath);
    expect(ctx).toBeDefined();
    expect(ctx?.tableName).toBe("sys_script_include");
    expect(ctx?.name).toBe("MyUtil");
    expect(ctx?.targetField).toBe("script");
    expect(ctx?.sys_id).toBe("sid789");
  });

  it("maps a flat ATF step path to the inputs.script field", () => {
    asMock(ConfigManager.getManifest).mockReturnValue({
      scope: "x_app",
      tables: {
        sys_atf_step: {
          records: {
            Step1: { sys_id: "atf1", files: [{ name: "inputs.script", type: "js" }] },
          },
        },
      },
    });
    const filePath = path.join("/proj/src/sys_atf_step", "Step1~inputs.script.js");
    const ctx = getFileContextFromPath(filePath);
    expect(ctx).toBeDefined();
    expect(ctx?.targetField).toBe("inputs.script");
    expect(ctx?.sys_id).toBe("atf1");
  });

  it("returns undefined when the field is not in the record's files", () => {
    asMock(ConfigManager.getManifest).mockReturnValue({
      scope: "x_app",
      tables: {
        sys_script_include: {
          records: {
            MyUtil: { sys_id: "sid", files: [{ name: "other", type: "js" }] },
          },
        },
      },
    });
    const filePath = path.join("/proj/src/sys_script_include/MyUtil", "script.js");
    expect(getFileContextFromPath(filePath)).toBeUndefined();
  });

  it("throws when no manifest is loaded", () => {
    asMock(ConfigManager.getManifest).mockReturnValue(undefined);
    const filePath = path.join("/proj/src/sys_script_include/MyUtil", "script.js");
    expect(() => getFileContextFromPath(filePath)).toThrow(
      "No manifest has been loaded!"
    );
  });

  it("returns undefined when the table/record is absent from the manifest", () => {
    asMock(ConfigManager.getManifest).mockReturnValue({
      scope: "x_app",
      tables: {},
    });
    const filePath = path.join("/proj/src/sys_script_include/MyUtil", "script.js");
    expect(getFileContextFromPath(filePath)).toBeUndefined();
  });
});

describe("isDirectory", () => {
  it("returns true for a directory", async () => {
    const root = makeTmpDir();
    expect(await isDirectory(root)).toBe(true);
  });

  it("returns false for a regular file", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "file.txt");
    fs.writeFileSync(filePath, "x");
    expect(await isDirectory(filePath)).toBe(false);
  });
});

describe("getPathsInPath", () => {
  it("returns an empty array when the path is outside source and build roots", async () => {
    asMock(ConfigManager.getSourcePath).mockReturnValue("/nowhere/source");
    asMock(ConfigManager.getBuildPath).mockReturnValue("/nowhere/build");
    const outside = makeTmpDir();
    expect(await getPathsInPath(outside)).toEqual([]);
  });

  it("collects files recursively while skipping symlinks", async () => {
    const root = makeTmpDir();
    asMock(ConfigManager.getSourcePath).mockReturnValue(root);
    asMock(ConfigManager.getBuildPath).mockReturnValue(root);

    const fileA = path.join(root, "a.txt");
    fs.writeFileSync(fileA, "a");
    const subDir = path.join(root, "sub");
    fs.mkdirSync(subDir);
    const fileB = path.join(subDir, "b.txt");
    fs.writeFileSync(fileB, "b");

    // A symlink to fileA must be skipped so its bytes are not collected twice.
    const link = path.join(root, "link.txt");
    fs.symlinkSync(fileA, link);

    const found = await getPathsInPath(root);
    expect(found).toContain(path.resolve(fileA));
    expect(found).toContain(path.resolve(fileB));
    expect(found).not.toContain(path.resolve(link));
  });

  it("ignores a directory entry that cannot be read", async () => {
    const root = makeTmpDir();
    asMock(ConfigManager.getSourcePath).mockReturnValue(root);
    asMock(ConfigManager.getBuildPath).mockReturnValue(root);

    const good = path.join(root, "good.txt");
    fs.writeFileSync(good, "ok");
    const badDir = path.join(root, "bad");
    fs.mkdirSync(badDir);

    // Force readdir to fail for the bad directory so the catch/continue branch
    // is taken; every other path is read normally.
    const realReaddir = fs.promises.readdir;
    const spy = jest
      .spyOn(fs.promises, "readdir")
      .mockImplementation(async (p: any, ...rest: any[]) => {
        if (String(p) === badDir) {
          throw new Error("EACCES");
        }
        return (realReaddir as any).call(fs.promises, p, ...rest);
      });

    const found = await getPathsInPath(root);
    expect(found).toContain(path.resolve(good));
    spy.mockRestore();
  });

  it("warns and stops descending at the max depth instead of truncating silently", async () => {
    const root = makeTmpDir();
    asMock(ConfigManager.getSourcePath).mockReturnValue(root);
    asMock(ConfigManager.getBuildPath).mockReturnValue(root);

    // Shallow file is collected; anything beyond 20 levels is not descended
    // into, and the max-depth boundary emits a warning.
    const shallow = path.join(root, "shallow.txt");
    fs.writeFileSync(shallow, "ok");

    let current = root;
    for (let i = 1; i <= 22; i += 1) {
      current = path.join(current, `d${i}`);
      fs.mkdirSync(current, { recursive: true });
    }
    const deep = path.join(current, "too-deep.txt");
    fs.writeFileSync(deep, "skip");

    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});

    const found = await getPathsInPath(root);
    expect(found).toContain(path.resolve(shallow));
    expect(found).not.toContain(path.resolve(deep));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("deeper than 20 levels")
    );
    warnSpy.mockRestore();
  });

  it("ignores an entry whose lstat fails", async () => {
    const root = makeTmpDir();
    asMock(ConfigManager.getSourcePath).mockReturnValue(root);
    asMock(ConfigManager.getBuildPath).mockReturnValue(root);

    const good = path.join(root, "present.txt");
    fs.writeFileSync(good, "ok");
    const ghost = path.join(root, "ghost.txt");

    const realLstat = fs.promises.lstat;
    const spy = jest
      .spyOn(fs.promises, "lstat")
      .mockImplementation(async (p: any, ...rest: any[]) => {
        if (String(p) === path.resolve(ghost)) {
          throw new Error("ENOENT");
        }
        return (realLstat as any).call(fs.promises, p, ...rest);
      });

    // Seed the stack with a child that lstat rejects by placing an entry the
    // readdir returns but lstat cannot resolve.
    const realReaddir = fs.promises.readdir;
    const readdirSpy = jest
      .spyOn(fs.promises, "readdir")
      .mockImplementation(async (p: any, ...rest: any[]) => {
        if (String(p) === path.resolve(root)) {
          return ["present.txt", "ghost.txt"] as any;
        }
        return (realReaddir as any).call(fs.promises, p, ...rest);
      });

    const found = await getPathsInPath(root);
    expect(found).toContain(path.resolve(good));
    expect(found).not.toContain(path.resolve(ghost));
    spy.mockRestore();
    readdirSpy.mockRestore();
  });
});

describe("isValidPath", () => {
  it("returns true for an existing path", async () => {
    const root = makeTmpDir();
    expect(await isValidPath(root)).toBe(true);
  });

  it("returns false for a missing path", async () => {
    const root = makeTmpDir();
    expect(await isValidPath(path.join(root, "nope"))).toBe(false);
  });
});

describe("encodedPathsToFilePaths", () => {
  it("filters out invalid paths and returns de-duplicated files under the roots", async () => {
    const root = makeTmpDir();
    asMock(ConfigManager.getSourcePath).mockReturnValue(root);
    asMock(ConfigManager.getBuildPath).mockReturnValue(root);

    const fileA = path.join(root, "a.txt");
    fs.writeFileSync(fileA, "a");
    const missing = path.join(root, "missing.txt");

    // Encode a valid path (twice, to prove de-duplication) plus one that does
    // not exist (dropped by the isValidPath filter).
    const encoded = [root, root, missing].join(PATH_DELIMITER);
    const result = await encodedPathsToFilePaths(encoded);

    expect(result).toContain(path.resolve(fileA));
    // The same file discovered via two identical roots collapses to one entry.
    expect(result.filter((p) => p === path.resolve(fileA))).toHaveLength(1);
    expect(result).not.toContain(path.resolve(missing));
  });
});

describe("writeBuildFile", () => {
  it("creates a missing folder then writes the file", async () => {
    const root = makeTmpDir();
    const folder = path.join(root, "build", "nested");
    const target = path.join(folder, "out.js");

    await writeBuildFile(folder, target, "built");

    expect(fs.existsSync(folder)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("built");
  });

  it("writes into an already-existing folder", async () => {
    const root = makeTmpDir();
    const folder = path.join(root, "existing");
    fs.mkdirSync(folder);
    const target = path.join(folder, "out.js");

    await writeBuildFile(folder, target, "second");

    expect(fs.readFileSync(target, "utf8")).toBe("second");
  });
});
