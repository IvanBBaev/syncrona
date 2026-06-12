import { SN } from "@syncrona/types";

const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(() => async () => undefined);
const writeFileForce = jest.fn(async () => undefined);
const writeManifestFile = jest.fn(async () => undefined);
const pathExists = jest.fn(async () => true);
const SNFileExists = jest.fn(() => async () => true);

const getSourcePath = jest.fn(() => "/tmp/source");
const getManifestPath = jest.fn(() => "/tmp/manifest.json");
const getConfig = jest.fn(() => ({}));
const updateManifest = jest.fn();
const getManifest = jest.fn();

const getManifestApi = jest.fn();
const getMissingFilesApi = jest.fn();
const updateRecordApi = jest.fn();
const retryOnErrApi = jest.fn(async (fn: () => Promise<unknown>) => fn());
const processPushResponseApi = jest.fn(() => ({ success: true, message: "ok" }));
const mockBuildManifestFromTableAPI = jest.fn();
const mockBuildBulkDownloadFromTableAPI = jest.fn();

jest.mock("../FileUtils", () => ({
  createDirRecursively,
  writeSNFileCurry,
  writeFileForce,
  writeManifestFile,
  pathExists,
  SNFileExists,
  appendToPath: (prefix: string) => (suffix: string) => `${prefix}/${suffix}`,
  getFileContextFromPath: jest.fn(),
  encodedPathsToFilePaths: jest.fn(async () => []),
  summarizeFile: jest.fn(() => ""),
}));

jest.mock("../config", () => ({
  getSourcePath,
  getManifestPath,
  getConfig,
  updateManifest,
  getManifest,
}));

jest.mock("../snClient", () => ({
  defaultClient: () => ({
    getManifest: getManifestApi,
    getMissingFiles: getMissingFilesApi,
    updateRecord: updateRecordApi,
  }),
  processPushResponse: (...args: any[]) => (processPushResponseApi as any)(...args),
  retryOnErr: (...args: any[]) => (retryOnErrApi as any)(...args),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
  unwrapTableAPIFirstItem: jest.fn(),
}));

jest.mock("../PluginManager", () => ({
  __esModule: true,
  default: {
    getFinalFileContents: jest.fn(async () => "built-content"),
  },
}));

jest.mock("../manifestBuilder", () => ({
  buildManifestFromTableAPI: (...args: unknown[]) => mockBuildManifestFromTableAPI(...args),
  buildBulkDownloadFromTableAPI: (...args: unknown[]) => mockBuildBulkDownloadFromTableAPI(...args),
  isScopedEndpointUnavailableError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return Boolean(err && [400, 403, 404].includes(err.response?.status as number));
  },
  isNotFoundError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return Boolean(err && [400, 403, 404].includes(err.response?.status as number));
  },
}));

describe("appUtils critical bugfixes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildManifestFromTableAPI.mockResolvedValue({ scope: "x_test", tables: {} });
    mockBuildBulkDownloadFromTableAPI.mockResolvedValue({});
  });

  it("processManifest uses overwrite mode when forceWrite=true", async () => {
    const { processManifest } = await import("../appUtils");

    const manifest = {
      scope: "x_test",
      tables: {
        sys_script: {
          records: {
            rec1: {
              name: "rec1",
              sys_id: "abc",
              files: [{ name: "script", type: "js", content: "gs.info('x');" }],
            },
          },
        },
      },
    } as unknown as SN.AppManifest;

    await processManifest(manifest, true);

    expect(writeSNFileCurry).toHaveBeenCalledWith(false);
  });

  it("processManifest uses non-overwrite mode when forceWrite=false", async () => {
    const { processManifest } = await import("../appUtils");

    const manifest = {
      scope: "x_test",
      tables: {
        sys_script: {
          records: {
            rec1: {
              name: "rec1",
              sys_id: "abc",
              files: [{ name: "script", type: "js", content: "gs.info('x');" }],
            },
          },
        },
      },
    } as unknown as SN.AppManifest;

    await processManifest(manifest, false);

    expect(writeSNFileCurry).toHaveBeenCalledWith(true);
  });

  it("syncManifest waits for manifest write before processing missing files", async () => {
    let manifestWritten = false;
    writeManifestFile.mockImplementation(async () => {
      manifestWritten = true;
      return undefined;
    });

    getManifest.mockResolvedValue({ scope: "x_test", tables: {} });
    getManifestApi.mockResolvedValue({ data: { result: { scope: "x_test", tables: {} } } });
    getMissingFilesApi.mockImplementation(async () => {
      expect(manifestWritten).toBe(true);
      return { data: { result: { tables: {} } } };
    });

    const { syncManifest } = await import("../appUtils");

    await syncManifest();

    expect(writeManifestFile).toHaveBeenCalledTimes(1);
    expect(getMissingFilesApi).toHaveBeenCalledTimes(1);
  });

  it("syncManifest uses Table API fallback when getManifest returns 404", async () => {
    getManifest.mockResolvedValue({ scope: "x_test", tables: {} });
    getConfig.mockReturnValue({});
    getManifestApi.mockRejectedValue({ response: { status: 404 } });
    getMissingFilesApi.mockResolvedValue({ data: { result: {} } });

    const { syncManifest } = await import("../appUtils");
    await syncManifest();

    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith(
      "x_test",
      expect.anything(),
      {}
    );
    expect(writeManifestFile).toHaveBeenCalledWith({ scope: "x_test", tables: {} });
  });

  it("syncManifest uses Table API fallback when getManifest returns 400", async () => {
    getManifest.mockResolvedValue({ scope: "x_test", tables: {} });
    getConfig.mockReturnValue({});
    getManifestApi.mockRejectedValue({ response: { status: 400 } });
    getMissingFilesApi.mockResolvedValue({ data: { result: {} } });

    const { syncManifest } = await import("../appUtils");
    await syncManifest();

    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith(
      "x_test",
      expect.anything(),
      {}
    );
    expect(writeManifestFile).toHaveBeenCalledWith({ scope: "x_test", tables: {} });
  });

  it("processMissingFiles uses Table API fallback when getMissingFiles returns 404", async () => {
    getConfig.mockReturnValue({ tableOptions: {} });
    getMissingFilesApi.mockRejectedValue({ response: { status: 404 } });
    mockBuildBulkDownloadFromTableAPI.mockResolvedValue({});

    const { processMissingFiles } = await import("../appUtils");
    await processMissingFiles({ scope: "x_test", tables: {} } as unknown as SN.AppManifest);

    expect(mockBuildBulkDownloadFromTableAPI).toHaveBeenCalledWith(
      {},
      expect.anything(),
      {}
    );
  });

  it("pushFiles limits parallel pushes based on pushConcurrency", async () => {
    getConfig.mockReturnValue({ pushConcurrency: 2 });

    let inFlight = 0;
    let maxInFlight = 0;
    updateRecordApi.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { status: 200, data: { result: {} } };
    });

    const { pushFiles } = await import("../appUtils");
    const records = Array.from({ length: 6 }, (_, index) => ({
      table: "sys_script",
      sysId: `id_${index}`,
      fields: {
        script: {
          name: `record_${index}`,
          tableName: "sys_script",
          targetField: "script",
          filePath: `/tmp/record_${index}.js`,
          ext: ".js",
          sys_id: `id_${index}`,
          scope: "x_test",
        },
      },
    }));

    const results = await pushFiles(records as any);

    expect(results).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(updateRecordApi).toHaveBeenCalledTimes(6);
  });
});
