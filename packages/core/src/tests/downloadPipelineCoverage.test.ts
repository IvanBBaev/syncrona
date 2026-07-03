// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";

// Coverage for downloadPipeline paths the sibling suites leave untouched:
//   - syncManifest: re-throw of a non-scoped error and the non-Error catch arm
//   - findMissingFiles: the whole mark/check chain when files, records and
//     tables are absent on disk (markFileMissing / markRecordMissing /
//     markTableMissing / checkFilesForMissing / checkRecordsForMissing /
//     checkTablesForMissing)
//   - processMissingFiles: the missing-record debug count and the re-throw of a
//     non-scoped fetch error
//   - downloadAllFiles: the re-throw of a non-scoped fetch error
//
// Everything is driven through injected/mocked deps so there is no network, no
// keychain and no disk write outside the mocks.

const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(() => async () => undefined);
const writeFlatSNFileCurry = jest.fn(() => async () => undefined);
const writeFileForce = jest.fn(async () => undefined);
const writeManifestFile = jest.fn(async () => undefined);

// pathExists / SNFileExists are the seam that decides what counts as "missing".
// Each test drives them per path so the mark/check branches are exercised.
const pathExists = jest.fn(async (_p: string) => true);
const SNFileExists = jest.fn(() => async (_file: SN.File) => true);

const getSourcePath = jest.fn(() => "/src");
const getManifestPath = jest.fn(() => "/tmp/manifest.json");
const getConfig = jest.fn(() => ({}) as Record<string, unknown>);
const updateManifest = jest.fn();
const getManifest = jest.fn();

const getManifestApi = jest.fn();
const getMissingFilesApi = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockBuildBulkDownloadFromTableAPI = jest.fn();

const loggerError = jest.fn();
const loggerInfo = jest.fn();
const loggerDebug = jest.fn();

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
  buildManifestFromTableAPI: (...args: unknown[]) =>
    mockBuildManifestFromTableAPI(...args),
  buildBulkDownloadFromTableAPI: (...args: unknown[]) =>
    mockBuildBulkDownloadFromTableAPI(...args),
  // 400/403/404 are treated as "scoped endpoint unavailable"; any other error
  // (e.g. 500 or a plain Error) is not, so callers re-throw it.
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
    debug: (...a: unknown[]) => loggerDebug(...a),
    error: (...a: unknown[]) => loggerError(...a),
    success: jest.fn(),
  },
}));

// Two-table, two-record manifest so the mark/check chain has real breadth.
function makeManifest(): SN.AppManifest {
  return {
    scope: "x_test",
    tables: {
      sys_script: {
        records: {
          recA: {
            name: "recA",
            sys_id: "sysA",
            files: [
              { name: "script", type: "js" },
              { name: "doc", type: "html" },
            ],
          },
          recB: {
            name: "recB",
            sys_id: "sysB",
            files: [{ name: "script", type: "js" }],
          },
        },
      },
      sys_ui_page: {
        records: {
          page1: {
            name: "page1",
            sys_id: "sysP",
            files: [{ name: "html", type: "xml" }],
          },
        },
      },
    },
  } as unknown as SN.AppManifest;
}

beforeEach(() => {
  jest.clearAllMocks();
  getConfig.mockReturnValue({});
  pathExists.mockImplementation(async () => true);
  SNFileExists.mockImplementation(() => async () => true);
});

describe("syncManifest error handling", () => {
  it("re-throws a non-scoped manifest error and returns false", async () => {
    getManifest.mockResolvedValue({ scope: "x_test", tables: {} });
    getConfig.mockReturnValue({});
    // 500 is not a scoped-unavailable error, so line 138 re-throws it; the outer
    // catch turns that into a false return.
    getManifestApi.mockRejectedValue({ response: { status: 500 } });

    const { syncManifest } = await import("../appUtils.js");
    const result = await syncManifest();

    expect(result).toBe(false);
    expect(mockBuildManifestFromTableAPI).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalled();
  });

  it("stringifies a non-Error rejection in the catch arm", async () => {
    // A missing manifest makes getManifest resolve null -> throw new Error, but
    // to hit the String(e) arm (line 152) we reject with a plain string, which
    // is not an instanceof Error.
    getManifest.mockRejectedValue("plain string failure");

    const { syncManifest } = await import("../appUtils.js");
    const result = await syncManifest();

    expect(result).toBe(false);
    // The stringified message is logged verbatim.
    expect(loggerError).toHaveBeenCalledWith("plain string failure");
  });
});

describe("findMissingFiles discovery chain", () => {
  it("marks every file missing when whole tables are absent on disk", async () => {
    // Every table path is absent -> markTableMissing -> markRecordMissing ->
    // markFileMissing for all files (lines 189-190, 179-180, 161-169, 248-253).
    pathExists.mockImplementation(async () => false);

    const { findMissingFiles } = await import("../appUtils.js");
    const missing = await findMissingFiles(makeManifest());

    // Both tables, every record and every file are reported missing.
    expect(Object.keys(missing).sort()).toEqual(["sys_script", "sys_ui_page"]);
    expect(missing.sys_script.sysA).toEqual([
      { name: "script", type: "js" },
      { name: "doc", type: "html" },
    ]);
    expect(missing.sys_script.sysB).toEqual([{ name: "script", type: "js" }]);
    expect(missing.sys_ui_page.sysP).toEqual([{ name: "html", type: "xml" }]);
  });

  it("marks a record's files missing when only its folder is absent", async () => {
    // Table folders exist; recA's folder is absent (markRecordMissing, 222-224),
    // recB's folder exists so we descend into checkFilesForMissing (226-230).
    pathExists.mockImplementation(async (p: string) => !p.endsWith("/recA"));
    // Inside recB every file is present, so nothing is marked there.
    SNFileExists.mockImplementation(() => async () => true);

    const { findMissingFiles } = await import("../appUtils.js");
    const missing = await findMissingFiles(makeManifest());

    // Only recA (folder gone) contributes; recB and page1 are fully present.
    expect(missing.sys_script.sysA).toEqual([
      { name: "script", type: "js" },
      { name: "doc", type: "html" },
    ]);
    expect(missing.sys_script?.sysB).toBeUndefined();
    expect(missing.sys_ui_page).toBeUndefined();
  });

  it("marks only the individual files that are absent inside an existing record", async () => {
    // Everything exists on disk EXCEPT the "doc.html" file inside recA, so only
    // the checkFilesForMissing branch fires (lines 199-206, 201-203).
    pathExists.mockImplementation(async () => true);
    SNFileExists.mockImplementation(
      () => async (file: SN.File) => file.name !== "doc"
    );

    const { findMissingFiles } = await import("../appUtils.js");
    const missing = await findMissingFiles(makeManifest());

    // Only recA's "doc" file is missing; its "script" sibling is present.
    expect(missing.sys_script.sysA).toEqual([{ name: "doc", type: "html" }]);
    expect(missing.sys_script?.sysB).toBeUndefined();
    expect(missing.sys_ui_page).toBeUndefined();
  });

  it("returns an empty map when nothing is missing", async () => {
    pathExists.mockImplementation(async () => true);
    SNFileExists.mockImplementation(() => async () => true);

    const { findMissingFiles } = await import("../appUtils.js");
    const missing = await findMissingFiles(makeManifest());

    expect(missing).toEqual({});
  });
});

describe("processMissingFiles", () => {
  it("counts missing records for the debug log and fetches them", async () => {
    // Whole tables absent -> a non-empty missing map so the reduce on line 283
    // computes a real count (>0) and getMissingFiles is called with it.
    pathExists.mockImplementation(async () => false);
    getConfig.mockReturnValue({ tableOptions: {} });
    // The unwrapped result is a TableMap consumed by processTablesInManifest;
    // an empty map keeps the write step a no-op.
    getMissingFilesApi.mockResolvedValue({ data: { result: {} } });

    const { processMissingFiles } = await import("../appUtils.js");
    await processMissingFiles(makeManifest());

    expect(getMissingFilesApi).toHaveBeenCalledTimes(1);
    // Debug line reports 3 missing records across 2 tables.
    const debugMsg = loggerDebug.mock.calls.map((c) => String(c[0])).join("\n");
    expect(debugMsg).toContain("3 missing record(s)");
    expect(debugMsg).toContain("2 table(s)");
  });

  it("re-throws a non-scoped fetch error", async () => {
    pathExists.mockImplementation(async () => false);
    getConfig.mockReturnValue({ tableOptions: {} });
    // 500 is not scoped-unavailable, so line 302 re-throws instead of falling
    // back to the Table API.
    getMissingFilesApi.mockRejectedValue({ response: { status: 500 } });

    const { processMissingFiles } = await import("../appUtils.js");
    await expect(processMissingFiles(makeManifest())).rejects.toEqual({
      response: { status: 500 },
    });
    expect(mockBuildBulkDownloadFromTableAPI).not.toHaveBeenCalled();
  });
});

describe("downloadAllFiles fetchTable error handling", () => {
  it("re-throws a non-scoped fetch error from the scoped endpoint", async () => {
    getConfig.mockReturnValue({ tableOptions: {} });
    // The very first table fetch fails with a non-scoped error, so the inner
    // fetchTable re-throws (line 418) and the run rejects.
    getMissingFilesApi.mockRejectedValue({ response: { status: 500 } });

    const { downloadAllFiles } = await import("../appUtils.js");
    await expect(downloadAllFiles(makeManifest())).rejects.toEqual({
      response: { status: 500 },
    });
    expect(mockBuildBulkDownloadFromTableAPI).not.toHaveBeenCalled();
  });
});
