// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";

// REV-91 (PERF-3): the refresh path (processMissingFiles) must stream the
// fetch/write one table at a time instead of materializing every missing file
// body for the whole scope in memory at once. Before the fix it made a single
// getMissingFiles call for the entire missing map, then wrote everything. These
// tests assert the fetch is issued once PER TABLE (call count == table count),
// each with a single-table missing map, and that a write for one table happens
// before the next table is fetched (proving interleaving, not batch-then-write).

const createDirRecursively = jest.fn(async () => undefined);

const events: string[] = [];
const writeImpl = async () => {
  events.push("write");
};
const writeSNFileCurry = jest.fn(() => writeImpl);
const writeFlatSNFileCurry = jest.fn(() => async () => undefined);
const writeFileForce = jest.fn(async () => undefined);
const writeManifestFile = jest.fn(async () => undefined);
const pathExists = jest.fn(async (_p: string) => false); // whole tables missing
const SNFileExists = jest.fn(() => async (_file: SN.File) => true);

const getSourcePath = jest.fn(() => "/src");
const getManifestPath = jest.fn(() => "/tmp/manifest.json");
const getConfig = jest.fn(() => ({ tableOptions: {} }) as Record<string, unknown>);
const updateManifest = jest.fn();
const getManifest = jest.fn();

const getManifestApi = jest.fn();
const getMissingFilesApi = jest.fn();
const mockBuildBulkDownloadFromTableAPI = jest.fn();

jest.unstable_mockModule("../FileUtils.js", () => ({
  createDirRecursively,
  writeSNFileCurry,
  writeFlatSNFileCurry,
  writeFileForce,
  writeManifestFile,
  pathExists: (...a: unknown[]) =>
    (pathExists as (...x: unknown[]) => unknown)(...a),
  SNFileExists: (...a: unknown[]) =>
    (SNFileExists as (...x: unknown[]) => unknown)(...a),
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
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: (...args: unknown[]) =>
    mockBuildBulkDownloadFromTableAPI(...args),
  isScopedEndpointUnavailableError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return Boolean(
      err && [400, 403, 404].includes(err.response?.status as number)
    );
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
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
  },
}));

// Three tables, one record + one file each, all absent on disk so every table
// contributes a single-table missing map to the streamed fetch.
function threeTableManifest(): SN.AppManifest {
  const table = (name: string) => ({
    records: {
      [`${name}Rec`]: {
        name: `${name}Rec`,
        sys_id: `${name}Sys`,
        files: [{ name: "script", type: "js" }],
      },
    },
  });
  return {
    scope: "x_test",
    tables: {
      sys_script: table("a"),
      sys_ui_page: table("b"),
      sys_script_include: table("c"),
    },
  } as unknown as SN.AppManifest;
}

// getMissingFiles echoes the requested single-table missing map back as a proper
// TableMap so processTablesInManifest has real records/files to write.
function missingToTableMap(missing: Record<string, Record<string, { name: string; type: string }[]>>) {
  const result: Record<string, unknown> = {};
  for (const [table, recs] of Object.entries(missing)) {
    const records: Record<string, unknown> = {};
    for (const [sysId, files] of Object.entries(recs)) {
      records[sysId] = {
        sys_id: sysId,
        name: sysId,
        files: files.map((f) => ({ ...f, content: "body" })),
      };
    }
    result[table] = { records };
  }
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
  getConfig.mockReturnValue({ tableOptions: {} });
  pathExists.mockImplementation(async () => false);
  SNFileExists.mockImplementation(() => async () => true);
  writeSNFileCurry.mockImplementation(() => writeImpl);
  getMissingFilesApi.mockImplementation(async (missing: unknown) => {
    events.push(`fetch:${Object.keys(missing as object).join(",")}`);
    return { data: { result: missingToTableMap(missing as never) } };
  });
});

describe("refresh streams table-by-table (REV-91)", () => {
  it("issues one getMissingFiles fetch per table, each with a single-table map", async () => {
    const { processMissingFiles } = await import("../appUtils.js");
    await processMissingFiles(threeTableManifest());

    // One fetch per table (3), NOT a single whole-scope fetch as before.
    expect(getMissingFilesApi).toHaveBeenCalledTimes(3);
    for (const call of getMissingFilesApi.mock.calls) {
      expect(Object.keys(call[0] as object)).toHaveLength(1);
    }
  });

  it("writes each table before fetching the next (interleaved, not batched)", async () => {
    const { processMissingFiles } = await import("../appUtils.js");
    await processMissingFiles(threeTableManifest());

    const fetches = events.filter((e) => e.startsWith("fetch:"));
    const writes = events.filter((e) => e === "write");
    expect(fetches).toHaveLength(3);
    expect(writes).toHaveLength(3);
    // A write lands before the LAST fetch — impossible under the old
    // fetch-everything-then-write model where the sole fetch precedes all writes.
    expect(events.indexOf("write")).toBeLessThan(events.lastIndexOf(fetches[2]));
  });
});
