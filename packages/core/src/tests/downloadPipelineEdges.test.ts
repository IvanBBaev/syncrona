// SPDX-License-Identifier: GPL-3.0-or-later
import path from "node:path";
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";

// Edge cases of downloadPipeline the sibling suites leave out:
//   - adoptRecordFolderNames: a failed folder move is a warning, never a failed
//     pull, whether the failure is an Error or not
//   - processManifest on a directory with no previous manifest
//   - applyRecordSecretRulesToContent on manifests and Table-API answers with
//     missing tables, records or file lists
//   - syncManifest without a manifest, and the empty `init --new` scope
//   - record names that are empty, where the manifest key stands in
//   - the fetcher's merge of malformed halves and its "scoped endpoint gone" latch
//   - computeMissingFingerprint and downloadTablesWithResume on records without
//     a file list
//
// Everything is driven through mocked modules: no network, no keychain and no
// disk write outside the mocks.

const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(() => async () => undefined);
const writeFlatSNFileCurry = jest.fn(() => async () => undefined);
const writeFileForce = jest.fn(async (_path: string, _content: string) => undefined);
const writeManifestFile = jest.fn(async () => undefined);
const pathExists = jest.fn(async (_p: string) => true);
const SNFileExists = jest.fn(() => async (_file: SN.File) => true);

const getSourcePath = jest.fn((): string => "/src");
const getManifestPath = jest.fn(() => "/tmp/manifest.json");
const getConfig = jest.fn(() => ({}) as Record<string, unknown>);
const updateManifest = jest.fn();
const getManifest = jest.fn<() => Promise<unknown>>();

const getManifestApi = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const getMissingFilesApi = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBuildManifestFromTableAPI = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBuildBulkDownloadFromTableAPI = jest.fn<(...a: unknown[]) => Promise<unknown>>();

const loggerError = jest.fn();
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();

jest.unstable_mockModule("../FileUtils.js", () => ({
  createDirRecursively,
  writeSNFileCurry,
  writeFlatSNFileCurry,
  writeFileForce,
  writeManifestFile,
  pathExists: (...a: unknown[]) => (pathExists as (...x: unknown[]) => unknown)(...a),
  SNFileExists: (...a: unknown[]) => (SNFileExists as (...x: unknown[]) => unknown)(...a),
  appendToPath: (prefix: string) => (suffix: string) => `${prefix}/${suffix}`,
}));

jest.unstable_mockModule("../config.js", () => ({
  getSourcePath,
  getManifestPath,
  getConfig,
  updateManifest,
  getManifest,
}));

jest.unstable_mockModule("../snClient.js", () => ({
  getErrorResponseStatus: jest.fn(),
  isRetryableRequestError: jest.fn(),
  processPushResponse: jest.fn(),
  retryOnErr: jest.fn(),
  SNClient: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
  defaultClient: () => ({
    getManifest: getManifestApi,
    getMissingFiles: getMissingFilesApi,
  }),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) =>
    (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  applyIncludeTypeRulesToManifest: async (manifest: unknown) => manifest,
  attachMetaFieldsToManifest: jest.fn(async (manifest: unknown) => manifest),
  buildManifestFromTableAPI: (...args: unknown[]) => mockBuildManifestFromTableAPI(...args),
  buildBulkDownloadFromTableAPI: (...args: unknown[]) =>
    mockBuildBulkDownloadFromTableAPI(...args),
  isScopedEndpointUnavailableError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return Boolean(err && [400, 403, 404].includes(err.response?.status as number));
  },
}));

jest.unstable_mockModule("../downloadCheckpoint.js", () => ({
  DownloadCheckpoint: jest.fn(),
  readDownloadCheckpoint: jest.fn(async () => null),
  writeDownloadCheckpoint: jest.fn(async () => undefined),
  deleteDownloadCheckpoint: jest.fn(async () => undefined),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    debug: jest.fn(),
    error: (...a: unknown[]) => loggerError(...a),
    success: jest.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
  },
}));

const {
  adoptRecordFolderNames,
  processManifest,
  applyRecordSecretRulesToContent,
  syncManifest,
  findMissingFiles,
  buildManifestRecordNames,
  processMissingFiles,
  computeMissingFingerprint,
  downloadTablesWithResume,
} = await import("../downloadPipeline.js");

type Client = Parameters<typeof applyRecordSecretRulesToContent>[1];
const client = {} as Client;

const warnings = () => loggerWarn.mock.calls.map((call) => String(call[0]));
const infos = () => loggerInfo.mock.calls.map((call) => String(call[0]));
const errors = () => loggerError.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  jest.clearAllMocks();
  getConfig.mockReturnValue({});
  getSourcePath.mockReturnValue("/src");
  pathExists.mockImplementation(async () => true);
  SNFileExists.mockImplementation(() => async () => true);
});

describe("adoptRecordFolderNames", () => {
  const empty = (): SN.AppManifest => ({ scope: "x", tables: {} }) as SN.AppManifest;

  it("turns a thrown Error into a warning and still names the new manifest", async () => {
    getSourcePath.mockImplementation(() => {
      throw new Error("no source dir");
    });
    const next = {
      scope: "x",
      tables: { t: { records: { Foo: { name: "Foo", sys_id: "s1", files: [] }, foo: { name: "foo", sys_id: "s2", files: [] } } } },
    } as unknown as SN.AppManifest;
    await expect(adoptRecordFolderNames(empty(), next)).resolves.toBeUndefined();
    expect(warnings()).toEqual(
      expect.arrayContaining(["Could not move renamed record folders: no source dir"])
    );
    expect(Object.keys(next.tables.t.records).sort()).toEqual(["Foo_s1", "foo_s2"]);
  });

  it("turns a thrown non-Error into a warning by its string form", async () => {
    getSourcePath.mockImplementation(() => {
      throw "source path unset";
    });
    await expect(adoptRecordFolderNames(empty(), empty())).resolves.toBeUndefined();
    expect(warnings()).toEqual(["Could not move renamed record folders: source path unset"]);
  });
});

describe("processManifest without a previous manifest", () => {
  it("names the records, writes them and the manifest, and moves nothing", async () => {
    getManifest.mockResolvedValue(null);
    const manifest = {
      scope: "x",
      tables: {
        t: {
          records: {
            Foo: { name: "Foo", sys_id: "s1", files: [{ name: "script", type: "js", content: "a" }] },
            foo: { name: "foo", sys_id: "s2", files: [{ name: "script", type: "js", content: "b" }] },
          },
        },
      },
    } as unknown as SN.AppManifest;

    await processManifest(manifest);

    expect(warnings().some((m) => m.includes("Could not move"))).toBe(false);
    expect(createDirRecursively.mock.calls.map((call) => String((call as unknown[])[0])).sort()).toEqual([
      path.join("/src", "t", "Foo_s1"),
      path.join("/src", "t", "foo_s2"),
    ]);
    expect(writeFileForce).toHaveBeenCalledTimes(1);
    const [manifestPath, written] = writeFileForce.mock.calls[0];
    expect(manifestPath).toBe("/tmp/manifest.json");
    const persisted = JSON.parse(written) as SN.AppManifest;
    expect(Object.keys(persisted.tables.t.records).sort()).toEqual(["Foo_s1", "foo_s2"]);
    // File bodies never reach the manifest.
    expect(persisted.tables.t.records.Foo_s1.files).toEqual([{ name: "script", type: "js" }]);
  });
});

describe("applyRecordSecretRulesToContent with sparse shapes", () => {
  it("costs no request for a manifest without tables, records or file lists", async () => {
    await applyRecordSecretRulesToContent({ scope: "x" } as SN.AppManifest, client, {});
    await applyRecordSecretRulesToContent(
      {
        scope: "x",
        tables: {
          sys_properties: {},
          sys_script: { records: { r: { name: "r", sys_id: "s1" } } },
        },
      } as unknown as SN.AppManifest,
      client,
      {}
    );
    expect(mockBuildBulkDownloadFromTableAPI).not.toHaveBeenCalled();
  });

  it("keeps the value withheld when the re-read row comes back without files", async () => {
    const manifest = {
      scope: "x",
      tables: {
        sys_properties: {
          records: {
            secret_prop: {
              name: "secret_prop",
              sys_id: "p1",
              files: [{ name: "value", type: "txt", content: "from the scoped endpoint" }],
            },
            plain_prop: {
              name: "plain_prop",
              sys_id: "p2",
              files: [{ name: "value", type: "txt", content: "endpoint value" }],
            },
            listed_only: { name: "listed_only", sys_id: "p3" },
          },
        },
      },
    } as unknown as SN.AppManifest;
    mockBuildBulkDownloadFromTableAPI.mockResolvedValue({
      sys_properties: {
        records: {
          // The classifier withheld the value: the row carries no file list.
          secret_prop: { name: "secret_prop", sys_id: "p1" },
          plain_prop: {
            name: "plain_prop",
            sys_id: "p2",
            files: [{ name: "value", type: "txt", content: "table api value" }],
          },
          // A row for a record whose manifest entry lists no files.
          listed_only: { name: "listed_only", sys_id: "p3", files: [] },
        },
      },
    });

    await applyRecordSecretRulesToContent(manifest, client, {});

    const records = manifest.tables.sys_properties.records;
    expect(records.secret_prop.files).toEqual([{ name: "value", type: "txt" }]);
    expect(records.plain_prop.files).toEqual([
      { name: "value", type: "txt", content: "table api value" },
    ]);
    expect(records.listed_only.files).toBeUndefined();
    // Every requested record was answered, so nothing is reported unread.
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(mockBuildBulkDownloadFromTableAPI).toHaveBeenCalledWith(
      {
        sys_properties: {
          p1: [{ name: "value", type: "txt" }],
          p2: [{ name: "value", type: "txt" }],
        },
      },
      client,
      {},
      expect.anything()
    );
  });
});

describe("syncManifest edge cases", () => {
  it("fails without a manifest and touches nothing", async () => {
    getManifest.mockResolvedValue(null);
    await expect(syncManifest()).resolves.toBe(false);
    expect(errors()).toContain("No manifest file loaded!");
    expect(getManifestApi).not.toHaveBeenCalled();
    expect(writeManifestFile).not.toHaveBeenCalled();
  });

  it("lifts the empty-manifest refusal for a bound scope whose manifest has no tables key", async () => {
    // `init --new` binds the scope by sys_id; a manifest without `tables` lists
    // no table, exactly like one with `tables: {}`.
    getManifest.mockResolvedValue({ scope: "x_new", scopeId: "abc" });
    getManifestApi.mockRejectedValue({ response: { status: 404 } });
    mockBuildManifestFromTableAPI.mockResolvedValue({ scope: "x_new", tables: {} });

    await expect(syncManifest()).resolves.toBe(true);

    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith(
      "x_new",
      expect.anything(),
      {},
      { allowEmpty: true }
    );
    expect(infos()).toContain('Scope "x_new" owns no records yet — keeping the empty manifest.');
    // The scope's sys_id survives the rebuild.
    expect(updateManifest).toHaveBeenCalledWith({ scope: "x_new", tables: {}, scopeId: "abc" });
  });
});

describe("records whose manifest name is empty", () => {
  const manifest = (): SN.AppManifest =>
    ({
      scope: "x",
      tables: {
        sys_script: {
          records: { by_key: { name: "", sys_id: "s1", files: [{ name: "script", type: "js" }] } },
        },
      },
    }) as unknown as SN.AppManifest;

  it("probes the folder at the manifest key", async () => {
    const probed: string[] = [];
    pathExists.mockImplementation(async (p: string) => {
      probed.push(p);
      return p !== "/src/sys_script/by_key";
    });
    const missing = await findMissingFiles(manifest());
    expect(probed).toContain("/src/sys_script/by_key");
    expect(probed).not.toContain("/src/sys_script/");
    expect(missing).toEqual({ sys_script: { s1: [{ name: "script", type: "js" }] } });
  });

  it("is named by its key for the Table-API download path", () => {
    expect(buildManifestRecordNames(manifest())).toEqual({ sys_script: { s1: "by_key" } });
  });
});

describe("processMissingFiles fetcher", () => {
  const twoTables = (): SN.AppManifest =>
    ({
      scope: "x",
      tables: {
        t1: {
          records: {
            recA: {
              name: "recA",
              sys_id: "a1",
              files: [
                { name: "script", type: "js" },
                { name: ".meta", type: "json" },
              ],
            },
          },
        },
        t2: {
          records: {
            recB: {
              name: "recB",
              sys_id: "b1",
              files: [
                { name: "script", type: "js" },
                { name: ".meta", type: "json" },
              ],
            },
          },
        },
      },
    }) as unknown as SN.AppManifest;

  beforeEach(() => {
    pathExists.mockImplementation(async () => false);
    getConfig.mockReturnValue({ tableOptions: {} });
  });

  it("merges halves that come back without records or file lists", async () => {
    getMissingFilesApi.mockImplementation(async (files: unknown) => {
      const table = Object.keys(files as object)[0];
      return {
        data: {
          result:
            table === "t1"
              ? {
                  t1: {
                    records: {
                      recA: { name: "recA", sys_id: "a1", files: [{ name: "script", type: "js", content: "s" }] },
                    },
                  },
                }
              : // The record came back, but without a file list.
                { t2: { records: { recB: { name: "recB", sys_id: "b1" } } } },
        },
      };
    });
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async (requested: unknown) => {
      const table = Object.keys(requested as object)[0];
      return table === "t1"
        ? { t1: {} } // the sidecar half answered with no records at all
        : { t2: { records: { recB: { name: "recB", sys_id: "b1" } } } };
    });

    const incomplete = await processMissingFiles(twoTables());

    // t1's script survives the record-less sidecar half and is written.
    expect(writeSNFileCurry).toHaveBeenCalledTimes(1);
    // t2's record arrived with no fields at all, so its script is still missing.
    expect(incomplete).toEqual(["t2"]);
    expect(warnings().some((m) => m.includes("Table t2 is still missing field(s) script"))).toBe(
      true
    );
  });

  it("probes the scoped endpoint once per run after it reports itself unavailable", async () => {
    getMissingFilesApi.mockRejectedValue({ response: { status: 404 } });
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async (requested: unknown) => {
      const out: Record<string, unknown> = {};
      for (const [table, records] of Object.entries(requested as Record<string, Record<string, SN.File[]>>)) {
        const [sysId, files] = Object.entries(records)[0];
        out[table] = {
          records: {
            [table === "t1" ? "recA" : "recB"]: {
              name: table === "t1" ? "recA" : "recB",
              sys_id: sysId,
              files: files.map((f) => ({ ...f, content: "x" })),
            },
          },
        };
      }
      return out;
    });

    const incomplete = await processMissingFiles(twoTables());

    expect(incomplete).toEqual([]);
    expect(getMissingFilesApi).toHaveBeenCalledTimes(1);
    // t1: sidecar half + script fallback; t2: everything in one Table-API call.
    expect(mockBuildBulkDownloadFromTableAPI).toHaveBeenCalledTimes(3);
    expect(mockBuildBulkDownloadFromTableAPI.mock.calls[2][0]).toEqual({
      t2: {
        b1: [
          { name: "script", type: "js" },
          { name: ".meta", type: "json" },
        ],
      },
    });
    expect(
      infos().filter((m) => m.startsWith("Custom scope not found — fetching missing files"))
    ).toHaveLength(1);
  });
});

describe("computeMissingFingerprint", () => {
  it("treats a record without a field list like one with an empty list", () => {
    const absent = { t: { s1: undefined } } as unknown as SN.MissingFileTableMap;
    const empty = { t: { s1: [] } } as unknown as SN.MissingFileTableMap;
    const fielded = { t: { s1: [{ name: "script", type: "js" }] } } as SN.MissingFileTableMap;
    expect(computeMissingFingerprint(absent)).toBe(computeMissingFingerprint(empty));
    expect(computeMissingFingerprint(absent)).not.toBe(computeMissingFingerprint(fielded));
  });
});

describe("downloadTablesWithResume", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("keeps the checkpoint when a returned record carries no file list", async () => {
    const deps = {
      fetchTable: jest.fn(async () => ({
        t: { records: { recA: { name: "recA", sys_id: "a1" } } },
      }) as unknown as SN.TableMap),
      writeTable: jest.fn(async () => undefined),
      readCheckpoint: jest.fn(async () => null),
      writeCheckpoint: jest.fn(async () => undefined),
      deleteCheckpoint: jest.fn(async () => undefined),
    };

    await downloadTablesWithResume(
      { t: { a1: [{ name: "script", type: "js" }] } } as SN.MissingFileTableMap,
      "x",
      deps
    );

    expect(process.exitCode).toBe(1);
    expect(deps.writeCheckpoint).not.toHaveBeenCalled();
    expect(deps.deleteCheckpoint).not.toHaveBeenCalled();
    expect(warnings().some((m) => m.includes("Table t was downloaded without field(s) script"))).toBe(
      true
    );
  });
});
