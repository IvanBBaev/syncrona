// SPDX-License-Identifier: GPL-3.0-or-later
//
// R4, refresh half: reading data-model records through the Table API.
//
// A table named by a composite rule (sys_dictionary is `<name>.<element>`) must
// be read with that rule, or its answer would land in a folder the manifest
// does not know. These tests pin the naming rule on the per-table read and the
// write of every table's answer.
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";
import { META_FILE_NAME } from "../metaFields.js";

const writtenFiles: { table: string; record: string; file: string }[] = [];

const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(
  () => async (file: SN.File, parentPath: string) => {
    const parts = parentPath.split(/[\\/]/);
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

const mockBuildBulkDownloadFromTableAPI = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();

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
  defaultClient: () => ({}),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) =>
    (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  buildManifestFromTableAPI: (...a: unknown[]) =>
    (mockBuildManifestFromTableAPI as (...x: unknown[]) => unknown)(...a),
  buildBulkDownloadFromTableAPI: (...a: unknown[]) =>
    (mockBuildBulkDownloadFromTableAPI as (...x: unknown[]) => unknown)(...a),
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
  sys_script_include: {
    records: {
      IncludeA: {
        name: "IncludeA",
        sys_id: "rec-1",
        files: [{ name: "script", type: "js", content: "gs.info('a');" }],
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
  mockBuildBulkDownloadFromTableAPI.mockImplementation(async (requested: unknown) =>
    Object.keys(requested as object)[0] === "sys_dictionary" ? dictionaryAnswer() : scriptAnswer()
  );
});

describe("data-model tables on the Table API read (R4)", () => {
  it("reads an opted-in composite-named table by its naming rule", async () => {
    const { processMissingFiles } = await import("../downloadPipeline.js");
    const manifest = dataModelManifest();
    delete manifest.tables.sys_script_include;

    const incomplete = await processMissingFiles(manifest);

    expect(mockBuildBulkDownloadFromTableAPI).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockBuildBulkDownloadFromTableAPI.mock.calls[0]?.[0] as object)).toEqual([
      "sys_dictionary",
    ]);
    // The naming rule reaches the Table API read, so it names records as the build did.
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

  it("reads a mixed manifest one table at a time and writes every answer", async () => {
    const { processMissingFiles } = await import("../downloadPipeline.js");

    const incomplete = await processMissingFiles(dataModelManifest());

    const requestedTables = mockBuildBulkDownloadFromTableAPI.mock.calls.map((call) =>
      Object.keys(call[0] as object)
    );
    expect(requestedTables.sort()).toEqual([["sys_dictionary"], ["sys_script_include"]]);
    expect(writtenFiles.map((w) => `${w.table}/${w.file}`).sort()).toEqual([
      `sys_dictionary/${META_FILE_NAME}`,
      "sys_script_include/script",
    ]);
    expect(incomplete).toEqual([]);
  });
});
