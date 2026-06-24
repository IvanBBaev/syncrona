// SPDX-License-Identifier: GPL-3.0-or-later
import type { SN, Sync } from "@syncro-now-ai/types";

// Mocked snClient surface. The unwrap helpers are mocked so each test can drive
// the return values directly without constructing real Table-API envelopes.
const mockClient = {
  getScopeId: jest.fn(async () => ({})),
  getCurrentScope: jest.fn(async () => ({})),
  getUserSysId: jest.fn(async () => ({})),
  getCurrentAppUserPrefSysId: jest.fn(async () => ({})),
  updateCurrentAppUserPref: jest.fn(async () => ({})),
  createCurrentAppUserPref: jest.fn(async () => ({})),
  createUpdateSet: jest.fn(async () => ({})),
  getCurrentUpdateSetUserPref: jest.fn(async () => ({})),
  updateCurrentUpdateSetUserPref: jest.fn(async () => ({})),
  createCurrentUpdateSetUserPref: jest.fn(async () => ({})),
  getMissingFiles: jest.fn(async () => ({})),
  updateRecord: jest.fn(async () => ({})),
};

const mockUnwrapSNResponse = jest.fn();
const mockUnwrapFirst = jest.fn();
const mockUnwrapFirstOrEmpty = jest.fn();
const mockProcessPush = jest.fn();
const mockBuildBulk = jest.fn();

const getConfig = jest.fn(() => ({}) as Record<string, unknown>);
const getManifest = jest.fn();
const getSourcePath = jest.fn(() => "/src");
const getBuildPath = jest.fn(() => "/build");

const getFinalFileContents = jest.fn(async () => "built-content");
const createDirRecursively = jest.fn(async () => undefined);
const writeFileForce = jest.fn(async () => undefined);
const getFileContextFromPath = jest.fn((..._a: unknown[]) => undefined as unknown);
const encodedPathsToFilePaths = jest.fn(async (..._a: unknown[]) => [] as string[]);

const loggerError = jest.fn();

jest.mock("../snClient", () => ({
  defaultClient: jest.fn(() => mockClient),
  unwrapSNResponse: (...a: unknown[]) => mockUnwrapSNResponse(...a),
  unwrapTableAPIFirstItem: (...a: unknown[]) => mockUnwrapFirst(...a),
  unwrapTableAPIFirstItemOrEmpty: (...a: unknown[]) => mockUnwrapFirstOrEmpty(...a),
  getErrorResponseStatus: (e: { response?: { status?: number } } | null) =>
    e && e.response ? e.response.status : undefined,
  isRetryableRequestError: () => false,
  retryOnErr: (fn: () => Promise<unknown>) => fn(),
  processPushResponse: (...a: unknown[]) => mockProcessPush(...a),
  SNClient: class {},
}));

jest.mock("../config", () => ({
  getConfig,
  getManifest,
  getSourcePath,
  getBuildPath,
}));

jest.mock("../PluginManager", () => ({
  __esModule: true,
  default: { getFinalFileContents },
}));

jest.mock("../FileUtils", () => ({
  createDirRecursively,
  writeFileForce,
  getFileContextFromPath: (...a: unknown[]) => getFileContextFromPath(...a),
  encodedPathsToFilePaths: (...a: unknown[]) => encodedPathsToFilePaths(...a),
  getBuildExt: () => "js",
  writeSNFileCurry: () => async () => undefined,
  appendToPath: (prefix: string) => (suffix: string) => `${prefix}/${suffix}`,
  pathExists: async () => true,
  SNFileExists: () => async () => true,
}));

jest.mock("../manifestBuilder", () => ({
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: (...a: unknown[]) => mockBuildBulk(...a),
  isScopedEndpointUnavailableError: (e: { response?: { status?: number } } | null) =>
    Boolean(e && [400, 403, 404].includes(e.response?.status as number)),
}));

jest.mock("../Logger", () => ({
  logger: {
    info: jest.fn(),
    error: (...a: unknown[]) => loggerError(...a),
    debug: jest.fn(),
    // "error" log level keeps getProgTick a no-op (no ProgressBar on stderr).
    getLogLevel: jest.fn(() => "error"),
  },
}));

jest.mock("../downloadCheckpoint", () => ({
  readDownloadCheckpoint: jest.fn(async () => null),
  writeDownloadCheckpoint: jest.fn(async () => undefined),
  deleteDownloadCheckpoint: jest.fn(async () => undefined),
}));

beforeEach(() => {
  jest.clearAllMocks();
  getConfig.mockReturnValue({});
  mockProcessPush.mockReturnValue({ success: true, message: "ok" });
  mockBuildBulk.mockResolvedValue({});
});

const buildableRecord = (sysId: string): Sync.BuildableRecord =>
  ({
    table: "sys_script",
    sysId,
    fields: {
      script: {
        name: `record_${sysId}`,
        tableName: "sys_script",
        targetField: "script",
        filePath: `/src/sys_script/record_${sysId}/script.js`,
        ext: ".js",
        sys_id: sysId,
        scope: "x_test",
      },
    },
  }) as unknown as Sync.BuildableRecord;

describe("swapScope / swapServerScope", () => {
  it("updates the existing user pref when one already exists", async () => {
    mockUnwrapFirst
      .mockResolvedValueOnce("scopeId123") // getScopeId
      .mockResolvedValueOnce("userId"); // getUserSysId
    mockUnwrapFirstOrEmpty.mockResolvedValueOnce("prefId"); // existing pref
    mockUnwrapSNResponse.mockResolvedValueOnce({ scope: "x_app" }); // getCurrentScope

    const { swapScope } = await import("../appUtils");
    const res = await swapScope("x_app");

    expect(res).toEqual({ scope: "x_app" });
    expect(mockClient.updateCurrentAppUserPref).toHaveBeenCalledWith("scopeId123", "prefId");
    expect(mockClient.createCurrentAppUserPref).not.toHaveBeenCalled();
  });

  it("creates a new user pref when none exists yet", async () => {
    mockUnwrapFirst
      .mockResolvedValueOnce("scopeId123")
      .mockResolvedValueOnce("userId");
    mockUnwrapFirstOrEmpty.mockResolvedValueOnce(""); // no existing pref
    mockUnwrapSNResponse.mockResolvedValueOnce({ scope: "x_app" });

    const { swapScope } = await import("../appUtils");
    await swapScope("x_app");

    expect(mockClient.createCurrentAppUserPref).toHaveBeenCalledWith("scopeId123", "userId");
    expect(mockClient.updateCurrentAppUserPref).not.toHaveBeenCalled();
  });

  it("logs and rethrows when the scope swap fails", async () => {
    mockUnwrapFirst
      .mockResolvedValueOnce("scopeId123") // getScopeId
      .mockRejectedValueOnce(new Error("no user")); // getUserSysId fails

    const { swapScope } = await import("../appUtils");
    await expect(swapScope("x_app")).rejects.toThrow("no user");
    expect(loggerError).toHaveBeenCalledWith("no user");
  });
});

describe("checkScope", () => {
  it("returns the first-time result when there is no manifest", async () => {
    getManifest.mockReturnValue(undefined);
    const { checkScope } = await import("../appUtils");
    const res = await checkScope(false);
    expect(res).toEqual({ match: true, sessionScope: "", manifestScope: "" });
  });

  it("matches when the session scope equals the manifest scope", async () => {
    getManifest.mockReturnValue({ scope: "x_app" });
    mockUnwrapSNResponse.mockResolvedValueOnce({ scope: "x_app" });
    const { checkScope } = await import("../appUtils");
    const res = await checkScope(false);
    expect(res).toEqual({ match: true, sessionScope: "x_app", manifestScope: "x_app" });
  });

  it("reports a mismatch without swapping when swap=false", async () => {
    getManifest.mockReturnValue({ scope: "x_app" });
    mockUnwrapSNResponse.mockResolvedValueOnce({ scope: "other" });
    const { checkScope } = await import("../appUtils");
    const res = await checkScope(false);
    expect(res).toEqual({ match: false, sessionScope: "other", manifestScope: "x_app" });
  });

  it("swaps and re-checks when swap=true and the scope differs", async () => {
    getManifest.mockReturnValue({ scope: "x_app" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce({ scope: "other" }) // initial getCurrentScope
      .mockResolvedValueOnce({ scope: "x_app" }); // getCurrentScope after swap
    mockUnwrapFirst
      .mockResolvedValueOnce("scopeId123") // getScopeId
      .mockResolvedValueOnce("userId"); // getUserSysId
    mockUnwrapFirstOrEmpty.mockResolvedValueOnce("prefId");

    const { checkScope } = await import("../appUtils");
    const res = await checkScope(true);
    expect(res).toEqual({ match: true, sessionScope: "x_app", manifestScope: "x_app" });
  });

  it("treats a missing scoped endpoint as a match", async () => {
    getManifest.mockReturnValue({ scope: "x_app" });
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 404 } });
    const { checkScope } = await import("../appUtils");
    const res = await checkScope(false);
    expect(res).toEqual({ match: true, sessionScope: "x_app", manifestScope: "x_app" });
  });

  it("rethrows a non-scoped error from getCurrentScope", async () => {
    getManifest.mockReturnValue({ scope: "x_app" });
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 500 } });
    const { checkScope } = await import("../appUtils");
    await expect(checkScope(false)).rejects.toEqual({ response: { status: 500 } });
  });
});

describe("createAndAssignUpdateSet", () => {
  it("updates the existing update-set pref when present", async () => {
    mockUnwrapSNResponse.mockResolvedValueOnce({ sys_id: "us123" }); // createUpdateSet
    mockUnwrapFirst.mockResolvedValueOnce("userId"); // getUserSysId
    mockUnwrapFirstOrEmpty.mockResolvedValueOnce("pref1"); // existing pref

    const { createAndAssignUpdateSet } = await import("../appUtils");
    const res = await createAndAssignUpdateSet("My Set");

    expect(res).toEqual({ name: "My Set", id: "us123" });
    expect(mockClient.updateCurrentUpdateSetUserPref).toHaveBeenCalledWith("us123", "pref1");
    expect(mockClient.createCurrentUpdateSetUserPref).not.toHaveBeenCalled();
  });

  it("creates a new update-set pref when none exists", async () => {
    mockUnwrapSNResponse.mockResolvedValueOnce({ sys_id: "us123" });
    mockUnwrapFirst.mockResolvedValueOnce("userId");
    mockUnwrapFirstOrEmpty.mockResolvedValueOnce("");

    const { createAndAssignUpdateSet } = await import("../appUtils");
    await createAndAssignUpdateSet("My Set");

    expect(mockClient.createCurrentUpdateSetUserPref).toHaveBeenCalledWith("us123", "userId");
    expect(mockClient.updateCurrentUpdateSetUserPref).not.toHaveBeenCalled();
  });
});

describe("pushFiles error paths", () => {
  it("reports a 404 as 'could not find' on the server", async () => {
    getConfig.mockReturnValue({ pushConcurrency: 1 });
    mockClient.updateRecord.mockRejectedValueOnce({ response: { status: 404 } });

    const { pushFiles } = await import("../appUtils");
    const [res] = await pushFiles([buildableRecord("s1")]);

    expect(res.success).toBe(false);
    expect(res.message).toContain("Could not find");
    expect(mockProcessPush).not.toHaveBeenCalled();
  });

  it("surfaces a non-404 push error message", async () => {
    getConfig.mockReturnValue({ pushConcurrency: 1 });
    mockClient.updateRecord.mockRejectedValueOnce(new Error("boom"));

    const { pushFiles } = await import("../appUtils");
    const [res] = await pushFiles([buildableRecord("s1")]);

    expect(res.success).toBe(false);
    expect(res.message).toContain("boom");
  });

  it("returns a build failure without attempting the push", async () => {
    getConfig.mockReturnValue({ pushConcurrency: 1 });
    getFinalFileContents.mockRejectedValueOnce(new Error("plugin blew up"));

    const { pushFiles } = await import("../appUtils");
    const [res] = await pushFiles([buildableRecord("s1")]);

    expect(res.success).toBe(false);
    expect(res.message).toContain("plugin blew up");
    expect(mockClient.updateRecord).not.toHaveBeenCalled();
  });
});

describe("buildFiles", () => {
  it("writes built field contents to the build path on success", async () => {
    const { buildFiles } = await import("../appUtils");
    const [res] = await buildFiles([buildableRecord("s1")]);

    expect(res.success).toBe(true);
    expect(writeFileForce).toHaveBeenCalledTimes(1);
    expect(createDirRecursively).toHaveBeenCalled();
  });

  it("returns a build failure when a plugin rejects", async () => {
    getFinalFileContents.mockRejectedValueOnce(new Error("plugin blew up"));
    const { buildFiles } = await import("../appUtils");
    const [res] = await buildFiles([buildableRecord("s1")]);

    expect(res.success).toBe(false);
    expect(writeFileForce).not.toHaveBeenCalled();
  });

  it("returns a write failure when the build file cannot be written", async () => {
    writeFileForce.mockRejectedValueOnce(new Error("disk full"));
    const { buildFiles } = await import("../appUtils");
    const [res] = await buildFiles([buildableRecord("s1")]);

    expect(res.success).toBe(false);
    expect(res.message).toContain("disk full");
  });
});

describe("downloadAllFiles scoped-endpoint probe", () => {
  const manifest = {
    scope: "x_app",
    tables: {
      sys_script_include: { records: { a: { sys_id: "sa", files: [{ name: "script", type: "js" }] } } },
      sys_script: { records: { b: { sys_id: "sb", files: [{ name: "script", type: "js" }] } } },
    },
  } as unknown as SN.AppManifest;

  it("uses the scoped bulk endpoint when it is available", async () => {
    getConfig.mockReturnValue({ tableOptions: {} });
    mockUnwrapSNResponse.mockResolvedValue({});

    const { downloadAllFiles } = await import("../appUtils");
    await downloadAllFiles(manifest);

    expect(mockUnwrapSNResponse).toHaveBeenCalledTimes(2);
    expect(mockBuildBulk).not.toHaveBeenCalled();
  });

  it("falls back to the Table API for the rest once the scoped endpoint is unavailable", async () => {
    getConfig.mockReturnValue({ tableOptions: {} });
    // First table's scoped call fails as unavailable; the probe latches so the
    // second table goes straight to the Table API without re-probing.
    mockUnwrapSNResponse.mockRejectedValueOnce({ response: { status: 404 } });

    const { downloadAllFiles } = await import("../appUtils");
    await downloadAllFiles(manifest);

    expect(mockUnwrapSNResponse).toHaveBeenCalledTimes(1);
    expect(mockBuildBulk).toHaveBeenCalledTimes(2);
  });
});

describe("getAppFileList", () => {
  it("decodes a string of encoded paths before building file contexts", async () => {
    encodedPathsToFilePaths.mockResolvedValueOnce(["/src/sys_script/r/script.js"]);
    getFileContextFromPath.mockReturnValueOnce({
      tableName: "sys_script",
      sys_id: "s1",
      targetField: "script",
    });

    const { getAppFileList } = await import("../appUtils");
    const out = await getAppFileList("encoded-paths");

    expect(encodedPathsToFilePaths).toHaveBeenCalledWith("encoded-paths");
    expect(out).toHaveLength(1);
    expect(out[0].table).toBe("sys_script");
  });

  it("uses an array of paths directly and drops unparseable entries", async () => {
    getFileContextFromPath
      .mockReturnValueOnce({ tableName: "sys_script", sys_id: "s1", targetField: "script" })
      .mockReturnValueOnce(null);

    const { getAppFileList } = await import("../appUtils");
    const out = await getAppFileList(["/a.js", "/bad"]);

    expect(encodedPathsToFilePaths).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });
});
