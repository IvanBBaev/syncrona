// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import path from "path";
export {};

// Edge branches of the init wizard that wizard.test.ts and wizardBranches.test.ts
// leave open: the prompt validators and blank answers, a cancelled prompt, a
// manifest with missing tables/files, an unnamed current scope, a non-Error
// scope-doc failure, and downloadApp's default client and empty-manifest path
// for a just-created scope.

type Question = {
  name: string;
  validate?: (v: unknown) => true | string;
  choices?: Array<{ name: string; value: string }>;
};

const mockPrompt = jest.fn<(questions: Question[]) => Promise<Record<string, unknown>>>();
const mockGetEnvPath = jest.fn();
const mockGetManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockCheckConfigPath = jest.fn();
const mockLoadConfigs = jest.fn();
const mockProcessManifest = jest.fn();
const mockResolveCredentialsFromStore = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockUnwrapSNResponse = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockListAppsFromTableAPI = jest.fn();
const mockGenerateScopeDocs = jest.fn();
const mockMkdir = jest.fn(async () => undefined);
const mockDefaultClientGetManifest = jest.fn();
const mockSnClientGetManifest = jest.fn();

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (q: Question[]) => mockPrompt(q) },
}));

jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    writeFile: jest.fn(async () => undefined),
    access: jest.fn(async () => undefined),
    mkdir: (...a: unknown[]) => mockMkdir(...(a as [])),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

jest.unstable_mockModule("../config.js", () => ({
  getEnvPath: (...a: unknown[]) => mockGetEnvPath(...a),
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  getDefaultConfigFile: () => "module.exports = {};",
  checkConfigPath: (...a: unknown[]) => mockCheckConfigPath(...a),
  getConfigPath: () => "/tmp/project/sync.config.js",
  loadConfigs: (...a: unknown[]) => mockLoadConfigs(...a),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: (...a: unknown[]) => mockProcessManifest(...a),
  applyRecordSecretRulesToContent: async () => undefined,
}));

jest.unstable_mockModule("../auth.js", () => ({
  saveCredentials: async () => undefined,
  setActiveInstance: async () => undefined,
  getActiveInstance: async () => "dev123.service-now.com",
  resolveCredentialsFromStore: (...a: unknown[]) => mockResolveCredentialsFromStore(...a),
}));

jest.unstable_mockModule("../envFile.js", () => ({
  writeDotEnv: async () => undefined,
  ensureGitignored: async () => undefined,
}));

jest.unstable_mockModule("../scopeDocs.js", () => ({
  generateScopeDocs: (...a: unknown[]) => mockGenerateScopeDocs(...a),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    debug: jest.fn(),
    silly: jest.fn(),
    setLogLevel: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  snClient: jest.fn(() => ({
    getAppList: () => "app-list",
    getCurrentScope: () => "current-scope",
    getManifest: (...a: unknown[]) => mockSnClientGetManifest(...a),
  })),
  defaultClient: jest.fn(() => ({
    getManifest: (...a: unknown[]) => mockDefaultClientGetManifest(...a),
  })),
  unwrapSNResponse: (...a: unknown[]) => mockUnwrapSNResponse(...a),
  preloadStoredCredentials: async () => undefined,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  applyIncludeTypeRulesToManifest: async (manifest: unknown) => manifest,
  buildManifestFromTableAPI: (...a: unknown[]) => mockBuildManifestFromTableAPI(...a),
  listAppsFromTableAPI: (...a: unknown[]) => mockListAppsFromTableAPI(...a),
  isScopedEndpointUnavailableError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return Boolean(err && [400, 403, 404].includes(err.response?.status as number));
  },
}));

const oneFileManifest = (scope: string) => ({
  scope,
  tables: {
    sys_script_include: {
      records: {
        "Include A": { sys_id: "1", name: "Include A", files: [{ name: "script", type: "js" }] },
      },
    },
  },
});

const SETUP_FAILED =
  "Failed to set up workspace. Run 'syncrona doctor' or re-run 'syncrona login'.";

function questionAt(call: number): Question {
  return (mockPrompt.mock.calls[call][0] as Question[])[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEnvPath.mockReturnValue("/tmp/project/.env");
  mockGetManifest.mockReturnValue(undefined);
  mockGetConfig.mockReturnValue({});
  mockCheckConfigPath.mockReturnValue("/tmp/project/sync.config.js");
  mockLoadConfigs.mockResolvedValue(undefined);
  mockProcessManifest.mockResolvedValue(undefined);
  mockResolveCredentialsFromStore.mockResolvedValue({
    instance: "dev123.service-now.com",
    user: "stored.user",
    password: "stored.pass",
  });
  mockGenerateScopeDocs.mockResolvedValue("/docs/scope.md");
  mockListAppsFromTableAPI.mockResolvedValue([]);
});

describe("startWizard prompts", () => {
  it("validates the source directory answer and rejects blank input", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "  lib  " });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }])
      .mockResolvedValueOnce({ scope: "x_existing" });

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    const validate = questionAt(0).validate!;
    expect(validate("lib")).toBe(true);
    expect(validate("   ")).toBe("Source directory is required.");
    expect(validate(undefined)).toBe("Source directory is required.");
    // The answer is trimmed before the directory is created.
    expect(mockMkdir).toHaveBeenCalledWith(path.resolve(process.cwd(), "lib"), { recursive: true });
  });

  it("falls back to the src directory when the prompt yields no source directory", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({});
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }])
      .mockResolvedValueOnce({ scope: "x_existing" });

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockMkdir).toHaveBeenCalledWith(path.resolve(process.cwd(), "src"), { recursive: true });
  });

  it("validates the manual scope answer and offers the trimmed scope for selection", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ tryManual: true })
      .mockResolvedValueOnce({ manualScope: "  x_manual  " })
      .mockResolvedValueOnce({ app: "x_manual" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([]) // getAppList
      .mockResolvedValueOnce(oneFileManifest("x_manual")) // downloadApp
      .mockResolvedValueOnce({ scope: "x_manual" }); // doctor

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    const validate = questionAt(2).validate!;
    expect(validate("x_acme")).toBe(true);
    expect(validate("  ")).toBe("Scope is required.");
    expect(validate(undefined)).toBe("Scope is required.");
    expect(questionAt(3).choices).toEqual([
      expect.objectContaining({ name: "x_manual - x_manual", value: "x_manual" }),
    ]);
  });

  it("does not download anything when the manual scope prompt yields no scope", async () => {
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" })
      .mockResolvedValueOnce({ tryManual: true })
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async (q) => ({ app: q[0].choices![0].value }));
    mockUnwrapSNResponse.mockResolvedValueOnce([]); // getAppList

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(false);

    expect(questionAt(3).choices![0].value).toBe("");
    expect(mockProcessManifest).not.toHaveBeenCalled();
  });

  it("treats a cancelled prompt as an abort: exit code 130 and no error banner", async () => {
    const abort = new Error("User force closed the prompt with SIGINT");
    abort.name = "ExitPromptError";
    mockPrompt.mockRejectedValueOnce(abort);

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(false);

    expect(process.exitCode).toBe(130);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

describe("startWizard reporting", () => {
  it("names the current scope <unknown> when the instance does not report one", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }])
      .mockResolvedValueOnce({});

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      "Wizard doctor: connection OK, current scope is <unknown>."
    );
  });

  it("counts zero files for a manifest without tables or record files", async () => {
    mockGetManifest.mockReturnValue({
      scope: "x_existing",
      tables: { sys_script_include: { records: { A: { sys_id: "1", name: "A" } } }, sys_ui_page: {} },
    });
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }])
      .mockResolvedValueOnce({ scope: "x_existing" });

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockLoggerSuccess).toHaveBeenCalledWith("0 files ready. Open Claude and start coding.");
  });

  it("counts zero files for a manifest that has no tables map at all", async () => {
    mockGetManifest.mockReturnValue({ scope: "x_existing" });
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }])
      .mockResolvedValueOnce({ scope: "x_existing" });

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockLoggerSuccess).toHaveBeenCalledWith("0 files ready. Open Claude and start coding.");
  });

  it("reports a non-Error scope-doc failure as text and still completes", async () => {
    mockGetManifest.mockReturnValue(oneFileManifest("x_existing"));
    mockGenerateScopeDocs.mockRejectedValueOnce("disk quota");
    mockPrompt.mockResolvedValueOnce({ sourceDirectory: "src" });
    mockUnwrapSNResponse
      .mockResolvedValueOnce([{ scope: "x_existing", displayName: "Existing" }])
      .mockResolvedValueOnce({ scope: "x_existing" });

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(true);

    expect(mockLoggerWarn).toHaveBeenCalledWith("Could not generate scope documentation: disk quota");
  });

  it("fails without an error detail line when the thrown error has a blank message", async () => {
    mockResolveCredentialsFromStore.mockRejectedValueOnce(new Error("   "));

    const { startWizard } = await import("../wizard.js");
    await expect(startWizard()).resolves.toBe(false);

    expect(mockLoggerError.mock.calls).toEqual([[SETUP_FAILED]]);
    expect(process.exitCode).toBe(1);
  });
});

describe("downloadApp edges", () => {
  it("uses the default client when none is passed", async () => {
    mockDefaultClientGetManifest.mockReturnValue("default-client-manifest");
    mockUnwrapSNResponse.mockImplementationOnce(async (p) => {
      if (p === "default-client-manifest") return oneFileManifest("x_default");
      throw new Error(`unexpected response source ${String(p)}`);
    });

    const { downloadApp } = await import("../wizard.js");
    const man = await downloadApp("x_default");

    expect(man.scope).toBe("x_default");
    expect(mockDefaultClientGetManifest).toHaveBeenCalledWith("x_default", {}, true);
  });

  it("allows an empty Table-API manifest only for a just-created scope with a sys_id", async () => {
    const empty = { scope: "x_new", tables: {} };
    mockUnwrapSNResponse.mockResolvedValueOnce(empty);
    mockBuildManifestFromTableAPI.mockResolvedValueOnce(empty);
    const client = { getManifest: jest.fn() };

    const { downloadApp } = await import("../wizard.js");
    const man = await downloadApp("x_new", client as never, { justCreated: true, scopeId: "sys-1" });

    expect(man).toEqual({ scope: "x_new", tables: {}, scopeId: "sys-1" });
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith("x_new", client, {}, { allowEmpty: true });
    // A zero-file download renders an empty bar instead of dividing by zero.
    expect(mockLoggerInfo).toHaveBeenCalledWith("[--------------------] 0%");
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("100% (0/0)"));
  });

  it.each([
    ["no scopeId", { justCreated: true }],
    ["an empty scopeId", { justCreated: true, scopeId: "" }],
    ["justCreated unset", { scopeId: "sys-1" }],
  ])("refuses the empty-manifest allowance with %s", async (_label, options) => {
    mockUnwrapSNResponse.mockResolvedValueOnce({ scope: "x_new", tables: {} });
    mockBuildManifestFromTableAPI.mockResolvedValueOnce(oneFileManifest("x_new"));
    const client = { getManifest: jest.fn() };

    const { downloadApp } = await import("../wizard.js");
    await downloadApp("x_new", client as never, options);

    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith("x_new", client, {}, { allowEmpty: false });
  });
});
