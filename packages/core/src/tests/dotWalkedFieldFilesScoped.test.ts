// SPDX-License-Identifier: GPL-3.0-or-later
//
// A field file a hand-edited manifest lists under a dot-walked name
// (`sys_created_by.user_password` is the creator's password) must never be
// requested from ANY fetch path. The Table API download refused it, but refresh
// and download sent every table that is neither data-model-named nor
// secret-governed straight to the scoped bulk endpoint, which answers whatever
// field it is asked for. These tests pin the shared refusal: the dotted name is
// stripped from the missing map before the scoped endpoint, the Table API, or
// the fallback between them sees it, and the ATF step script still flows.
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";

const WALKED = "sys_created_by.user_password";

const written: string[] = [];
const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(() => async (file: SN.File) => {
  written.push(file.name);
});
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
const warn = jest.fn();

jest.unstable_mockModule("../FileUtils.js", () => ({
  createDirRecursively,
  writeSNFileCurry: (...a: unknown[]) => (writeSNFileCurry as (...x: unknown[]) => unknown)(...a),
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
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  applyIncludeTypeRulesToManifest: async (manifest: unknown) => manifest,
  attachMetaFieldsToManifest: jest.fn(async (manifest: unknown) => manifest),
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: (...args: unknown[]) => mockBuildBulkDownloadFromTableAPI(...args),
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
  logger: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), success: jest.fn(), warn },
}));

type Missing = Record<string, Record<string, { name: string; type: string }[]>>;

// Whatever was asked for comes back with a body, under the sys_id as the record
// name — so anything requested would also be written.
const echo = (missing: Missing) => {
  const result: Record<string, unknown> = {};
  for (const [table, recs] of Object.entries(missing)) {
    const records: Record<string, unknown> = {};
    for (const [sysId, files] of Object.entries(recs)) {
      records[sysId] = {
        sys_id: sysId,
        name: sysId,
        files: files.map((f) => ({ ...f, content: f.name === WALKED ? "hunter2" : "body" })),
      };
    }
    result[table] = { records };
  }
  return result;
};

const requestedNames = (mock: jest.Mock): string[] =>
  mock.mock.calls.flatMap((call) =>
    Object.values(call[0] as Missing).flatMap((recs) =>
      Object.values(recs).flatMap((files) => files.map((f) => f.name))
    )
  );

const manifest = (): SN.AppManifest =>
  ({
    scope: "x_demo",
    tables: {
      sys_script_include: {
        records: {
          one: {
            name: "one",
            sys_id: "s1",
            files: [
              { name: "script", type: "js" },
              { name: WALKED, type: "txt" },
            ],
          },
          two: { name: "two", sys_id: "s2", files: [{ name: WALKED, type: "txt" }] },
        },
      },
      sys_atf_step: {
        records: {
          step: { name: "step", sys_id: "a1", files: [{ name: "inputs.script", type: "js" }] },
        },
      },
    },
  }) as unknown as SN.AppManifest;

const walkedWarnings = (): string[] =>
  warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("dot-walked"));

beforeEach(async () => {
  jest.clearAllMocks();
  written.length = 0;
  const { resetDotWalkedFieldFileWarnings } = await import("../dotWalkedFieldFiles.js");
  resetDotWalkedFieldFileWarnings();
  getMissingFilesApi.mockImplementation(async (missing: unknown) => ({
    data: { result: echo(missing as Missing) },
  }));
  mockBuildBulkDownloadFromTableAPI.mockImplementation(async (missing: unknown) => echo(missing as Missing));
});

const expectRefused = () => {
  expect(requestedNames(getMissingFilesApi)).not.toContain(WALKED);
  expect(requestedNames(mockBuildBulkDownloadFromTableAPI)).not.toContain(WALKED);
  expect(written).not.toContain(WALKED);
  expect(written).toContain("script");
  expect(written).toContain("inputs.script");
  expect(walkedWarnings()).toEqual([
    `Table sys_script_include: ignoring the manifest files entry for column "${WALKED}" — ` +
      "a dot-walked column reads another record's value, which this table's dictionary cannot type, " +
      "so it is never written to the working tree.",
  ]);
};

describe("a dot-walked field file never reaches any fetch path", () => {
  it("refresh: is not reported missing and never reaches the scoped endpoint", async () => {
    const { findMissingFiles, processMissingFiles } = await import("../appUtils.js");

    const missing = await findMissingFiles(manifest());
    expect(missing.sys_script_include.s1.map((f) => f.name)).toEqual(["script"]);
    // A record whose only listed file is refused has nothing left to fetch.
    expect(Object.keys(missing.sys_script_include)).toEqual(["s1"]);
    expect(missing.sys_atf_step.a1.map((f) => f.name)).toEqual(["inputs.script"]);

    const incomplete = await processMissingFiles(manifest());

    expect(getMissingFilesApi).toHaveBeenCalled();
    expect(mockBuildBulkDownloadFromTableAPI).not.toHaveBeenCalled();
    expect(incomplete).toEqual([]);
    expectRefused();
  });

  it("download: never reaches the scoped endpoint", async () => {
    const { buildFullMissingMap, downloadAllFiles } = await import("../appUtils.js");

    const full = buildFullMissingMap(manifest());
    expect(full.sys_script_include.s1.map((f) => f.name)).toEqual(["script"]);
    expect(Object.keys(full.sys_script_include)).toEqual(["s1"]);
    await downloadAllFiles(manifest());

    expect(getMissingFilesApi).toHaveBeenCalled();
    expectRefused();
  });

  it("never reaches the Table API fallback once the scoped endpoint is gone", async () => {
    getMissingFilesApi.mockImplementation(async () => {
      throw Object.assign(new Error("not found"), { response: { status: 404 } });
    });
    const { processMissingFiles } = await import("../appUtils.js");

    await processMissingFiles(manifest());

    expect(mockBuildBulkDownloadFromTableAPI).toHaveBeenCalled();
    expectRefused();
  });

  it("never reaches the Table API path a data-model naming rule forces", async () => {
    getConfig.mockReturnValue({
      tableOptions: { sys_script_include: { nameFields: ["name"] } },
    });
    const { downloadAllFiles } = await import("../appUtils.js");

    await downloadAllFiles(manifest());

    expect(requestedNames(mockBuildBulkDownloadFromTableAPI)).toContain("script");
    expectRefused();
  });

  it("leaves a manifest without a dotted name untouched and silent", async () => {
    const { findMissingFiles } = await import("../appUtils.js");
    const plain = manifest();
    plain.tables.sys_script_include.records.one.files = [{ name: "script", type: "js" } as SN.File];
    delete (plain.tables.sys_script_include.records as Record<string, unknown>).two;

    const missing = await findMissingFiles(plain);

    expect(Object.keys(missing)).toEqual(["sys_script_include", "sys_atf_step"]);
    expect(walkedWarnings()).toEqual([]);
  });
});
