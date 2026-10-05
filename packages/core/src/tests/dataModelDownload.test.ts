// SPDX-License-Identifier: GPL-3.0-or-later
//
// R4, refresh half: routing data-model records through the Table API.
//
// A table named by a composite rule (sys_dictionary is `<name>.<element>`) must
// not go to the scoped bulk endpoint: that endpoint names records by their
// display value, so its answer would land in a folder the manifest does not
// know. These tests pin the split and the merge of the two halves.
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";
import { META_FILE_NAME } from "../metaFields.js";

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
  applyIncludeTypeRulesToManifest: async (manifest: unknown) => manifest,
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


const dataModelManifest = (): SN.AppManifest => ({
  scope: "x_demo",
  tables: {
    sys_dictionary: {
      metaFields: ["element", "name"],
      records: {
        "x_demo_task.u_foo": {
          name: "x_demo_task.u_foo",
          sys_id: "d1",
          files: [{ name: META_FILE_NAME, type: "json" }],
        },
      },
    },
    sys_script_include: {
      records: {
        IncludeA: { name: "IncludeA", sys_id: "rec-1", files: [{ name: "script", type: "js" }] },
      },
    },
  },
});

const dictionaryAnswer = () => ({
  sys_dictionary: {
    records: {
      "x_demo_task.u_foo": {
        name: "x_demo_task.u_foo",
        sys_id: "d1",
        files: [{ name: META_FILE_NAME, type: "json", content: "{}" }],
      },
    },
  },
});

const scriptAnswer = () => ({
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
});

beforeEach(() => {
  writtenFiles.length = 0;
  jest.clearAllMocks();
  pathExists.mockImplementation(async () => false);
  SNFileExists.mockImplementation(() => async () => false);
  getConfig.mockImplementation(() => ({ tableOptions: {}, dataModelTables: ["sys_dictionary"] }));
  mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => dictionaryAnswer());
  getMissingFilesApi.mockImplementation(async () => scriptAnswer());
});

describe("data-model tables bypass the scoped bulk endpoint (R4)", () => {
  it("sends an opted-in composite-named table to the Table API only", async () => {
    const { processMissingFiles } = await import("../downloadPipeline.js");
    const manifest = dataModelManifest();
    delete manifest.tables.sys_script_include;

    const incomplete = await processMissingFiles(manifest);

    expect(getMissingFilesApi).not.toHaveBeenCalled();
    expect(Object.keys(mockBuildBulkDownloadFromTableAPI.mock.calls[0]?.[0] as object)).toEqual([
      "sys_dictionary",
    ]);
    // The naming rule reaches the Table API path, so it names records as the build did.
    const options = mockBuildBulkDownloadFromTableAPI.mock.calls[0]?.[2] as Record<
      string,
      { nameFields?: string[] }
    >;
    expect(options.sys_dictionary.nameFields).toEqual(["name", "element"]);
    expect(writtenFiles).toEqual([
      { table: "sys_dictionary", record: "x_demo_task.u_foo", file: META_FILE_NAME },
    ]);
    expect(incomplete).toEqual([]);
  });

  it("splits a mixed request and merges both halves", async () => {
    const { processMissingFiles } = await import("../downloadPipeline.js");

    const incomplete = await processMissingFiles(dataModelManifest());

    const scopedRequest = getMissingFilesApi.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(scopedRequest)).toEqual(["sys_script_include"]);
    expect(writtenFiles.map((w) => `${w.table}/${w.file}`).sort()).toEqual([
      `sys_dictionary/${META_FILE_NAME}`,
      "sys_script_include/script",
    ]);
    expect(incomplete).toEqual([]);
  });

  it("leaves routing unchanged when no table is opted in", async () => {
    getConfig.mockImplementation(() => ({ tableOptions: {}, dataModelTables: [] }));
    const manifest = dataModelManifest();
    delete manifest.tables.sys_dictionary;
    const { processMissingFiles } = await import("../downloadPipeline.js");

    await processMissingFiles(manifest);

    expect(getMissingFilesApi).toHaveBeenCalledTimes(1);
    expect(mockBuildBulkDownloadFromTableAPI).not.toHaveBeenCalled();
  });
});
