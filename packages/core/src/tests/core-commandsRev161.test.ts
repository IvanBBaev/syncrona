// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// REV-161 (wizard half): aborting a prompt inside startWizard used to `return`
// with no signal at all — the caller could not tell a cancellation from a
// completed setup and the process still exited 0. The wizard now resolves false
// and sets exit code 130 (SIGINT), matching commander.ts.

const mockPrompt = jest.fn();
const mockGetActiveInstance = jest.fn();
const mockResolveCredentialsFromStore = jest.fn();
const mockLoggerError = jest.fn();
const mockSaveCredentials = jest.fn();
const mockMkdir = jest.fn();
const mockGetAppList = jest.fn();
const mockUnwrapSNResponse = jest.fn();
const mockLoadConfigs = jest.fn();

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

// fs is a CJS core module; spread the real surface and override only the
// promises members the wizard drives, so disk writes stay mocked while default
// and named imports still link.
jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    writeFile: jest.fn(),
    access: jest.fn(),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

jest.unstable_mockModule("../config.js", () => ({
  getEnvPath: () => "/tmp/project/.env",
  getManifest: jest.fn(),
  getConfig: jest.fn(() => ({})),
  getDefaultConfigFile: jest.fn(() => "module.exports = {};"),
  checkConfigPath: jest.fn(() => ""),
  getConfigPath: jest.fn(() => "/tmp/project/sync.config.js"),
  loadConfigs: (...args: unknown[]) => mockLoadConfigs(...args),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: jest.fn(),
}));

jest.unstable_mockModule("../auth.js", () => ({
  saveCredentials: (...args: unknown[]) => mockSaveCredentials(...args),
  setActiveInstance: jest.fn(),
  getActiveInstance: (...args: unknown[]) => mockGetActiveInstance(...args),
  resolveCredentialsFromStore: (...args: unknown[]) => mockResolveCredentialsFromStore(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn(),
    setLogLevel: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  snClient: jest.fn(() => ({
    getAppList: (...args: unknown[]) => mockGetAppList(...args),
    getCurrentScope: jest.fn(),
    getManifest: jest.fn(),
  })),
  defaultClient: jest.fn(() => ({ getManifest: jest.fn() })),
  unwrapSNResponse: (...args: unknown[]) => mockUnwrapSNResponse(...args),
  preloadStoredCredentials: jest.fn(async () => undefined),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  // DX22: the scoped-manifest enrichment is a no-op for these suites — they
  // assert on the manifest they hand in, not on the metadata layer.
  attachMetaFieldsToManifest: jest.fn(async (manifest: unknown) => manifest),
  buildManifestFromTableAPI: jest.fn(),
  listAppsFromTableAPI: jest.fn(async () => []),
  isScopedEndpointUnavailableError: jest.fn(() => false),
  isNotFoundError: jest.fn(() => false),
}));

jest.unstable_mockModule("../scopeDocs.js", () => ({
  generateScopeDocs: jest.fn(async () => "/tmp/project/docs/scope.md"),
}));

jest.unstable_mockModule("../envFile.js", () => ({
  writeDotEnv: jest.fn(async () => undefined),
  ensureGitignored: jest.fn(async () => undefined),
}));

/** The rejection inquirer raises when the user hits Ctrl-C at a prompt. */
function exitPromptError(): Error {
  const e = new Error("User force closed the prompt with SIGINT");
  e.name = "ExitPromptError";
  return e;
}

const oldExitCode = process.exitCode;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  mockGetActiveInstance.mockResolvedValue("dev.service-now.com" as never);
  mockResolveCredentialsFromStore.mockResolvedValue({
    instance: "https://dev.service-now.com/",
    user: "admin",
    password: "secret",
  } as never);
  mockMkdir.mockResolvedValue(undefined as never);
  mockSaveCredentials.mockResolvedValue(undefined as never);
});

afterEach(() => {
  // Never let the deliberate 130 leak into the jest runner's own exit status.
  process.exitCode = oldExitCode;
});

describe("REV-161 startWizard reports cancellation", () => {
  it("returns false and exits 130 when the source-directory prompt is aborted", async () => {
    mockPrompt.mockRejectedValueOnce(exitPromptError() as never);

    const { startWizard } = await import("../wizard.js");
    const completed = await startWizard();

    // Old behaviour: a bare `return` — indistinguishable from success, and the
    // exit code stayed 0 so `syncrona init && ...` kept going.
    expect(completed).toBe(false);
    expect(process.exitCode).toBe(130);
    // A cancellation is not a failure: no error banner is printed.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("returns false and exits 1 when setup fails for a real reason", async () => {
    mockGetActiveInstance.mockResolvedValue(undefined as never);

    const { startWizard } = await import("../wizard.js");
    const completed = await startWizard();

    expect(completed).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it("returns false when the user declines the manual-scope prompt", async () => {
    // Source directory answered, then no apps are discoverable and the user
    // declines to enter a scope code by hand.
    mockPrompt
      .mockResolvedValueOnce({ sourceDirectory: "src" } as never)
      .mockResolvedValueOnce({ tryManual: false } as never);
    mockUnwrapSNResponse.mockResolvedValue([] as never);

    const { startWizard } = await import("../wizard.js");
    const completed = await startWizard();

    expect(completed).toBe(false);
    expect(mockLoadConfigs).not.toHaveBeenCalled();
  });
});
