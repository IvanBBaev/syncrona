// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

const mockSetLogLevel = jest.fn();
const mockPrompt = jest.fn();
const mockGetConfig = jest.fn();
const mockProcessManifest = jest.fn();
const mockGetManifestApi = jest.fn();
const mockSuccess = jest.fn();
const mockWarn = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: (...args: unknown[]) => mockSetLogLevel(...args),
    info: jest.fn(),
    success: (...args: unknown[]) => mockSuccess(...args),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  processManifest: (...args: unknown[]) => mockProcessManifest(...args),
  downloadAllFiles: jest.fn().mockResolvedValue(undefined),
}));

// downloadCommand also generates scope docs; stub it so the test does not
// write the real packages/core/docs/scopes/<scope>.md (which generateScopeDocs
// resolves from process.cwd() and would dirty the tracked tree). (G17)
jest.unstable_mockModule("../scopeDocs.js", () => ({
  generateScopeDocs: jest.fn().mockResolvedValue("/tmp/docs/scopes/x_test.md"),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  snClient: jest.fn(),
  preloadStoredCredentials: jest.fn(),
  getErrorResponseStatus: jest.fn(),
  getScopedEndpointPrefix: jest.fn(),
  describeCredentialSource: jest.fn(),
  diagnoseCredentials: jest.fn(),
  defaultClient: () => ({
    getManifest: (...args: unknown[]) => mockGetManifestApi(...args),
  }),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
  setActiveInstanceProfile: jest.fn(),
  resolveCredentials: () => ({
    instance: process.env.SN_INSTANCE || "",
    user: process.env.SN_USER || "",
    password: process.env.SN_PASSWORD || "",
    profile: undefined,
  }),
}));

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

describe("downloadCommand flow", () => {
  // REV-206. `downloadCommand` ends by branching on `process.exitCode`, which
  // `downloadAllFiles` sets when a table could not be fetched. That value is
  // per-PROCESS, not per-test: Jest runs many suites in one worker, several of them
  // set a non-zero exit code, and not all restore it — so which arm this suite took
  // was decided by whatever happened to run before it in the same worker. That is
  // the whole of why `commands.ts` measured 96.73 / 83.11 on one full run and
  // 96.19 / 81.81 on another with no source change: one statement and one branch,
  // covered by leakage instead of by a test. Pinning it here makes the clean arm
  // deterministic (and stops this suite leaking onto the next one); the failure arm
  // gets a test of its own below.
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    jest.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {} });
    mockPrompt.mockResolvedValue({ confirmed: true });
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("downloads manifest and skeletons non-destructively (processManifest forceWrite=false)", async () => {
    const manifest = { scope: "x_test", tables: {} };
    mockGetManifestApi.mockResolvedValue({ data: { result: manifest } });

    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test" });

    expect(mockSetLogLevel).toHaveBeenCalledWith("info");
    expect(mockGetManifestApi).toHaveBeenCalledWith("x_test", {
      includes: {},
      excludes: {},
      tableOptions: {},
    });
    // forceWrite MUST be false: the skeleton phase preserves already-downloaded,
    // non-empty files so a resumed download doesn't truncate the tables it then
    // skips via the checkpoint. downloadAllFiles still force-writes pending tables.
    expect(mockProcessManifest).toHaveBeenCalledWith(manifest, false);
  });

  it("skips confirmation prompt in ci mode", async () => {
    const manifest = { scope: "x_test", tables: {} };
    mockGetManifestApi.mockResolvedValue({ data: { result: manifest } });

    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockProcessManifest).toHaveBeenCalledWith(manifest, false);
  });

  it("REV-206 announces a clean completion when nothing flagged a failed table", async () => {
    mockGetManifestApi.mockResolvedValue({ data: { result: { scope: "x_test", tables: {} } } });

    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining("Download complete"));
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("Download finished with errors")
    );
    // A clean run must not hand the shell a failure it did not earn.
    expect(process.exitCode).toBeUndefined();
  });

  it("REV-206 warns instead of announcing success when a table could not be fetched", async () => {
    mockGetManifestApi.mockResolvedValue({ data: { result: { scope: "x_test", tables: {} } } });

    const { downloadCommand } = await import("../commands.js");

    // This is what downloadAllFiles does to signal a partial pull. Set here rather than
    // from the appUtils mock so the assertion pins downloadCommand's own contract and
    // not a detail of how its collaborator happens to raise the flag today.
    process.exitCode = 1;
    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("Download finished with errors")
    );
    // The point of the branch: a partial pull must never be reported as a clean one,
    // because the next command in a script reads that line and moves on.
    expect(mockSuccess).not.toHaveBeenCalledWith(expect.stringContaining("Download complete"));
    // And the flag must survive the command, or CI sees a green step over missing files.
    expect(process.exitCode).toBe(1);
  });
});
