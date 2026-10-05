// SPDX-License-Identifier: GPL-3.0-or-later
//
// Download-pipeline half of the field-file secret rule, and refresh of a scope
// that owns nothing yet.
//
//  - `sys_properties.value` is withheld per record by the Table API path, which
//    reads the property's `type` with the row. The scoped bulk endpoint cannot
//    judge a row, so a request for that column must never be sent there; and a
//    value withheld on purpose is not a read gap that marks the table
//    incomplete.
//  - `init --new` on an application with no records writes a manifest that binds
//    the scope by sys_id and lists no table. Refreshing it must keep that empty
//    manifest and succeed, not fail with "No tables discovered" on every run.
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";

const writtenFiles: { table: string; record: string; file: string }[] = [];

const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(
  () => async (file: SN.File, parentPath: string) => {
    const parts = parentPath.split("/");
    writtenFiles.push({
      table: parts[parts.length - 2] ?? "",
      record: parts[parts.length - 1] ?? "",
      file: file.name,
    });
  }
);
const writeFlatSNFileCurry = jest.fn(() => async () => undefined);
const writeFileForce = jest.fn(async () => undefined);
const writeManifestFile = jest.fn(async () => undefined);
const pathExists = jest.fn(async (_p: string) => false);
const SNFileExists = jest.fn(() => async (_file: SN.File) => false);

const getSourcePath = jest.fn(() => "/src");
const getManifestPath = jest.fn(() => "/tmp/manifest.json");
const getConfig = jest.fn(() => ({ tableOptions: {} }) as Record<string, unknown>);
const updateManifest = jest.fn();
const getManifest = jest.fn();

const getManifestApi = jest.fn();
const getMissingFilesApi = jest.fn();
const mockBuildBulkDownloadFromTableAPI = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockAttachMetaFieldsToManifest = jest.fn(async (manifest: unknown) => manifest);

jest.unstable_mockModule("../FileUtils.js", () => ({
  createDirRecursively,
  writeSNFileCurry: (...a: unknown[]) =>
    (writeSNFileCurry as (...x: unknown[]) => unknown)(...a),
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
  attachMetaFieldsToManifest: (...a: unknown[]) =>
    (mockAttachMetaFieldsToManifest as (...x: unknown[]) => unknown)(...a),
  buildManifestFromTableAPI: (...a: unknown[]) =>
    (mockBuildManifestFromTableAPI as (...x: unknown[]) => unknown)(...a),
  buildBulkDownloadFromTableAPI: (...a: unknown[]) =>
    (mockBuildBulkDownloadFromTableAPI as (...x: unknown[]) => unknown)(...a),
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
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
  },
}));


type MissingMap = Record<string, Record<string, SN.File[]>>;

const valueFile: SN.File = { name: "value", type: "txt" };

const propertiesManifest = (): SN.AppManifest => ({
  scope: "x_demo",
  tables: {
    sys_properties: {
      records: {
        "x_demo.endpoint": { name: "x_demo.endpoint", sys_id: "p1", files: [valueFile] },
        "x_demo.api_key": { name: "x_demo.api_key", sys_id: "p2", files: [valueFile] },
      },
    },
    sys_script_include: {
      records: {
        IncludeA: { name: "IncludeA", sys_id: "rec-1", files: [{ name: "script", type: "js" }] },
      },
    },
  },
});

beforeEach(() => {
  writtenFiles.length = 0;
  jest.clearAllMocks();
  pathExists.mockImplementation(async () => false);
  SNFileExists.mockImplementation(() => async () => false);
  mockAttachMetaFieldsToManifest.mockImplementation(async (m: unknown) => m);
});

describe("a secret-rule column never reaches the scoped bulk endpoint", () => {
  it("routes sys_properties.value to the Table API and keeps the rest scoped", async () => {
    getMissingFilesApi.mockImplementation(async () => ({
      data: {
        result: {
          sys_script_include: {
            records: {
              IncludeA: {
                name: "IncludeA",
                sys_id: "rec-1",
                files: [{ name: "script", type: "js", content: "gs.info('a');" }],
              },
            },
          },
        },
      },
    }));
    // The Table API path withheld the password property's value.
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => ({
      sys_properties: {
        records: {
          "x_demo.endpoint": {
            name: "x_demo.endpoint",
            sys_id: "p1",
            files: [{ ...valueFile, content: "https://example.test" }],
          },
          "x_demo.api_key": { name: "x_demo.api_key", sys_id: "p2", files: [] },
        },
      },
    }));

    const { processMissingFiles } = await import("../downloadPipeline.js");
    const incomplete = await processMissingFiles(propertiesManifest());

    const scopedRequest = getMissingFilesApi.mock.calls[0]?.[0] as MissingMap;
    expect(Object.keys(scopedRequest)).toEqual(["sys_script_include"]);
    const tableApiRequest = mockBuildBulkDownloadFromTableAPI.mock.calls[0]?.[0] as MissingMap;
    expect(Object.keys(tableApiRequest)).toEqual(["sys_properties"]);

    expect(
      writtenFiles.filter((w) => w.table === "sys_properties").map((w) => w.record)
    ).toEqual(["x_demo.endpoint"]);
    // Withheld on purpose, so not a read gap: the refresh is complete.
    expect(incomplete).toEqual([]);
  });

  it("still reports a real read gap on an ordinary column", async () => {
    getMissingFilesApi.mockImplementation(async () => ({
      data: {
        result: {
          sys_script_include: {
            records: { IncludeA: { name: "IncludeA", sys_id: "rec-1", files: [] } },
          },
        },
      },
    }));
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => ({}));
    const manifest = propertiesManifest();
    delete (manifest.tables as Record<string, unknown>).sys_properties;

    const { processMissingFiles } = await import("../downloadPipeline.js");
    await expect(processMissingFiles(manifest)).resolves.toEqual(["sys_script_include"]);
  });
});

describe("refreshing a scope that owns no records yet", () => {
  const scopedEndpointMissing = () =>
    getManifestApi.mockImplementation(async () => {
      throw { response: { status: 404 } };
    });

  it("keeps the empty manifest, says so at info level, and succeeds", async () => {
    getManifest.mockImplementation(async () => ({
      scope: "x_demo",
      scopeId: "scope-1",
      tables: {},
    }));
    scopedEndpointMissing();
    mockBuildManifestFromTableAPI.mockImplementation(async () => ({ scope: "x_demo", tables: {} }));

    const { syncManifest } = await import("../downloadPipeline.js");
    const { logger } = await import("../Logger.js");
    await expect(syncManifest()).resolves.toBe(true);

    expect(mockBuildManifestFromTableAPI.mock.calls[0]?.[3]).toEqual({ allowEmpty: true });
    expect(writeManifestFile).toHaveBeenCalledWith({
      scope: "x_demo",
      scopeId: "scope-1",
      tables: {},
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Scope "x_demo" owns no records yet — keeping the empty manifest.'
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ["has no scopeId", { scope: "x_demo", tables: {} }],
    [
      "already lists tables",
      {
        scope: "x_demo",
        scopeId: "scope-1",
        tables: { sys_script_include: { records: {} } },
      },
    ],
  ])("keeps the empty-manifest refusal when the current manifest %s", async (_label, current) => {
    getManifest.mockImplementation(async () => current);
    scopedEndpointMissing();
    mockBuildManifestFromTableAPI.mockImplementation(async () => {
      throw new Error('No tables discovered for scope "x_demo".');
    });

    const { syncManifest } = await import("../downloadPipeline.js");
    await expect(syncManifest()).resolves.toBe(false);

    expect(mockBuildManifestFromTableAPI.mock.calls[0]?.[3]).toEqual({ allowEmpty: false });
    expect(writeManifestFile).not.toHaveBeenCalled();
  });
});
