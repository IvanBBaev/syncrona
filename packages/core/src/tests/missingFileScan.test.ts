// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

// Pins the shape of findMissingFiles' answer against a real source tree:
// whole-table and whole-record recording when a directory is absent, per-field
// probing when it is present, the flat layout's `<record>~<field>` probe, the
// record-name-over-key folder rule, name/type-only entries, and own-slot
// handling of prototype-shaped keys. Also pins the small FileUtils helpers whose
// exact contract nothing else asserts.

const getManifest = jest.fn();
const getConfig = jest.fn();
const getSourcePath = jest.fn();
const getManifestPath = jest.fn();
const getBuildPath = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getManifest,
  getConfig,
  getSourcePath,
  getManifestPath,
  getBuildPath,
  updateManifest: jest.fn(),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    silly: jest.fn(),
    getLogLevel: jest.fn(() => "warn"),
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({}),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  applyIncludeTypeRulesToManifest: async (manifest: unknown) => manifest,
  attachMetaFieldsToManifest: jest.fn(async (manifest: unknown) => manifest),
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(),
  isScopedEndpointUnavailableError: () => false,
  ManifestRecordNames: jest.fn(),
}));

jest.unstable_mockModule("../downloadCheckpoint.js", () => ({
  DownloadCheckpoint: jest.fn(),
  readDownloadCheckpoint: jest.fn(async () => null),
  writeDownloadCheckpoint: jest.fn(async () => undefined),
  deleteDownloadCheckpoint: jest.fn(async () => undefined),
}));

const { findMissingFiles } = await import("../downloadPipeline.js");
const fUtils = await import("../FileUtils.js");

let root: string;
let src: string;

const record = (name: string, sys_id: string, files: SN.File[]): SN.MetaRecord =>
  ({ name, sys_id, files }) as SN.MetaRecord;

const manifestOf = (tables: Record<string, Record<string, SN.MetaRecord>>): SN.AppManifest =>
  ({
    scope: "x_test",
    tables: Object.fromEntries(
      Object.entries(tables).map(([table, records]) => [table, { records }]),
    ),
  }) as unknown as SN.AppManifest;

const touch = (...segments: string[]): void => {
  const target = path.join(src, ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x");
};

beforeEach(() => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-missing-scan-"));
  src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  getSourcePath.mockReturnValue(src);
  getBuildPath.mockReturnValue(path.join(root, "build"));
  getConfig.mockReturnValue({ writeConcurrency: 2 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("findMissingFiles", () => {
  it("records a whole table, a whole record and single fields, name and type only", async () => {
    const script = {
      name: "script",
      type: "js",
      content: "never recorded",
    } as SN.File;
    const condition = { name: "condition", type: "js" } as SN.File;
    touch("sys_script_include", "Present", "script.js");
    fs.mkdirSync(path.join(src, "sys_script_include", "Half"), {
      recursive: true,
    });
    touch("sys_script_include", "Half", "condition.js");

    const missing = await findMissingFiles(
      manifestOf({
        sys_script_include: {
          Present: record("Present", "a1", [script]),
          Half: record("Half", "a2", [script, condition]),
          Absent: record("Absent", "a3", [script, condition]),
        },
        sys_ui_page: {
          Page: record("Page", "b1", [{ name: "html", type: "html" } as SN.File]),
        },
      }),
    );

    expect(JSON.parse(JSON.stringify(missing))).toEqual({
      sys_script_include: {
        a2: [{ name: "script", type: "js" }],
        a3: [
          { name: "script", type: "js" },
          { name: "condition", type: "js" },
        ],
      },
      sys_ui_page: { b1: [{ name: "html", type: "html" }] },
    });
    expect(Object.getPrototypeOf(missing)).toBeNull();
    expect(Object.getPrototypeOf(missing.sys_script_include)).toBeNull();
  });

  it("probes the folder named by record.name, falling back to the manifest key", async () => {
    touch("sys_script", "Real Name", "script.js");
    touch("sys_script", "KeyOnly", "script.js");
    const nameless = {
      sys_id: "c2",
      files: [{ name: "script", type: "js" }],
    } as unknown as SN.MetaRecord;

    const missing = await findMissingFiles(
      manifestOf({
        sys_script: {
          "stale-key": record("Real Name", "c1", [{ name: "script", type: "js" } as SN.File]),
          KeyOnly: nameless,
        },
      }),
    );

    expect(Object.keys(missing)).toEqual([]);
  });

  it("probes flat `<record>~<field>` files under the table directory", async () => {
    getConfig.mockReturnValue({ flat: true, writeConcurrency: 1 });
    touch("sys_script_include", "Utils~script.js");

    const missing = await findMissingFiles(
      manifestOf({
        sys_script_include: {
          Utils: record("Utils", "d1", [
            { name: "script", type: "js" } as SN.File,
            { name: "description", type: "txt" } as SN.File,
          ]),
          Other: record("Other", "d2", [{ name: "script", type: "js" } as SN.File]),
        },
      }),
    );

    expect(JSON.parse(JSON.stringify(missing))).toEqual({
      sys_script_include: {
        d1: [{ name: "description", type: "txt" }],
        d2: [{ name: "script", type: "js" }],
      },
    });
  });

  it("keeps a `__proto__` table key and sys_id as own slots", async () => {
    const tables = Object.create(null);
    const records = Object.create(null);
    records.__proto__ = record("Evil", "__proto__", [{ name: "script", type: "js" } as SN.File]);
    tables.__proto__ = { records };

    const missing = await findMissingFiles({
      scope: "x_test",
      tables,
    } as SN.AppManifest);

    expect(Object.prototype.hasOwnProperty.call(missing, "__proto__")).toBe(true);
    expect(missing["__proto__"]["__proto__"]).toEqual([{ name: "script", type: "js" }]);
    expect(({} as Record<string, unknown>).script).toBeUndefined();
  });
});

describe("FileUtils helpers", () => {
  it("withRetry makes retries + 1 attempts and rethrows the last failure", async () => {
    let attempts = 0;
    const failing = async () => {
      attempts += 1;
      throw new Error(`attempt ${attempts}`);
    };
    await expect(fUtils.withRetry(failing, 3, 0)).rejects.toThrow("attempt 4");
    expect(attempts).toBe(4);

    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 2) throw new Error("transient");
      return "done";
    };
    await expect(fUtils.withRetry(flaky, 2, 0)).resolves.toBe("done");
    expect(calls).toBe(2);
  });

  it("encodedPathsToFilePaths drops empty and absent entries and de-duplicates in first-seen order", async () => {
    touch("t", "r", "b.js");
    touch("t", "r", "a.js");
    const fileA = path.join(src, "t", "r", "a.js");
    const fileB = path.join(src, "t", "r", "b.js");
    const { PATH_DELIMITER } = await import("../constants.js");
    const encoded = ["", fileA, path.join(src, "nope.js"), path.join(src, "t"), fileA, ""].join(
      PATH_DELIMITER,
    );

    const found = await fUtils.encodedPathsToFilePaths(encoded);

    expect(found[0]).toBe(fileA);
    expect([...found].sort()).toEqual([fileA, fileB].sort());
    expect(found).toHaveLength(2);
  });

  it("summarizeFile labels a context as table/record/sys_id", () => {
    expect(
      fUtils.summarizeFile({
        tableName: "sys_script",
        name: "Rule",
        sys_id: "e1",
      } as never),
    ).toBe("sys_script/Rule/e1");
  });

  it("writeBuildFile creates the missing folder before writing", async () => {
    const folder = path.join(root, "build", "deep", "er");
    const target = path.join(folder, "out.js");

    await fUtils.writeBuildFile(folder, target, "built");

    expect(fs.readFileSync(target, "utf8")).toBe("built");
  });

  it("isDirectory answers for directories and files and rejects for nothing", async () => {
    touch("only.txt");
    await expect(fUtils.isDirectory(src)).resolves.toBe(true);
    await expect(fUtils.isDirectory(path.join(src, "only.txt"))).resolves.toBe(false);
    await expect(fUtils.isDirectory(path.join(src, "none"))).rejects.toThrow();
  });

  it("toAbsolutePath anchors a relative path at the working directory", () => {
    expect(fUtils.toAbsolutePath("a/b")).toBe(path.join(process.cwd(), "a/b"));
    expect(fUtils.toAbsolutePath(src)).toBe(src);
  });
});
