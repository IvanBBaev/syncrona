// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

const mockSetLogLevel = jest.fn();
const mockPrompt = jest.fn();
const mockGetConfig = jest.fn();
const mockProcessManifest = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
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

const mockGetManifest = jest.fn();
const mockGetSourcePath = jest.fn(() => "/nonexistent-source");

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
  getSourcePath: () => mockGetSourcePath(),
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
  buildClientAuth: () => ({}),
  credentialsFromStore: (stored: unknown) => stored,
  preloadStoredCredentials: jest.fn(),
  getErrorResponseStatus: jest.fn(),
  describeCredentialSource: jest.fn(),
  diagnoseCredentials: jest.fn(),
  defaultClient: () => ({}),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
  setActiveInstanceProfile: jest.fn(),
  resolveCredentials: () => ({
    instance: process.env.SN_INSTANCE || "",
    user: process.env.SN_USER || "",
    password: process.env.SN_PASSWORD || "",
    profile: undefined,
  }),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  buildManifestFromTableAPI: (...args: unknown[]) => mockBuildManifestFromTableAPI(...args),
  listAppsFromTableAPI: jest.fn(),
  withStableOrder: (query: string) => query,
}));

// WP2: the `flow` preset's documents, loaded lazily by downloadCommand.
const mockSyncFlowDocuments = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule("../flow/flowFiles.js", () => ({
  syncFlowDocuments: (...args: unknown[]) => mockSyncFlowDocuments(...args),
}));

// WP2c: the `playbook` preset's documents, loaded the same way.
const mockSyncPlaybookDocuments = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule("../flow/playbookFiles.js", () => ({
  syncPlaybookDocuments: (...args: unknown[]) => mockSyncPlaybookDocuments(...args),
}));

// WP2f: the `workflow` preset's documents, loaded the same way.
const mockSyncWorkflowDocuments = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule("../flow/workflowFiles.js", () => ({
  syncWorkflowDocuments: (...args: unknown[]) => mockSyncWorkflowDocuments(...args),
}));

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

// A Table API manifest build with one table (an empty scope is refused by the
// builder, see downloadEmptyScope.test.ts).
const BUILT_MANIFEST = {
  scope: "x_test",
  tables: {
    sys_script_include: {
      records: { Demo: { name: "Demo", sys_id: "1", files: [{ name: "script", type: "js" }] } },
    },
  },
};

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
    const manifest = BUILT_MANIFEST;
    mockBuildManifestFromTableAPI.mockResolvedValue(manifest);

    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test" });

    expect(mockSetLogLevel).toHaveBeenCalledWith("info");
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledWith("x_test", expect.anything(), {
      includes: {},
      excludes: {},
      tableOptions: {},
    });
    // forceWrite MUST be false: the skeleton phase preserves already-downloaded,
    // non-empty files so a resumed download doesn't truncate the tables it then
    // skips via the checkpoint. downloadAllFiles still force-writes pending tables.
    expect(mockProcessManifest).toHaveBeenCalledWith(manifest, false);
  });

  it("17c warns about a value file the previous manifest listed and this one drops", async () => {
    const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("fs/promises");
    const os = await import("os");
    const path = await import("path");
    const root = await mkdtemp(path.join(os.tmpdir(), "download-withdrawn-"));
    try {
      const stale = path.join(root, "sys_script_include", "Demo", "u_token.txt");
      await mkdir(path.dirname(stale), { recursive: true });
      await writeFile(stale, "s3cr3t");
      mockGetSourcePath.mockReturnValue(root);
      mockGetManifest.mockReturnValue({
        scope: "x_test",
        tables: {
          sys_script_include: {
            records: {
              Demo: {
                name: "Demo",
                sys_id: "1",
                files: [
                  { name: "script", type: "js" },
                  { name: "u_token", type: "txt" },
                ],
              },
            },
          },
        },
      });
      mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);

      const { downloadCommand } = await import("../commands.js");
      await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

      const warned = mockWarn.mock.calls.map((call) => String(call[0]));
      expect(warned.filter((m) => m.includes(stale))).toHaveLength(1);
      expect(await readFile(stale, "utf8")).toBe("s3cr3t");
    } finally {
      mockGetManifest.mockReturnValue(undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips confirmation prompt in ci mode", async () => {
    const manifest = BUILT_MANIFEST;
    mockBuildManifestFromTableAPI.mockResolvedValue(manifest);

    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockProcessManifest).toHaveBeenCalledWith(manifest, false);
  });

  it("REV-206 announces a clean completion when nothing flagged a failed table", async () => {
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);

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
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);

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

  it("WP2 writes the flow documents when the flow preset is on", async () => {
    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {}, tablePresets: ["flow"] });
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);
    mockSyncFlowDocuments.mockResolvedValue(true);
    mockGetSourcePath.mockReturnValue("/nonexistent-source");
    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockSyncFlowDocuments).toHaveBeenCalledWith(expect.anything(), "x_test", "/nonexistent-source");
    expect(process.exitCode).toBeUndefined();
  });

  it("WP2 fails the download when a flow could not be read", async () => {
    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {}, tablePresets: ["flow"] });
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);
    mockSyncFlowDocuments.mockResolvedValue(false);
    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(process.exitCode).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("Download finished with errors"));
  });

  it("WP2 leaves the flow reader unloaded without the preset", async () => {
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);
    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockSyncFlowDocuments).not.toHaveBeenCalled();
    expect(mockSyncPlaybookDocuments).not.toHaveBeenCalled();
    expect(mockSyncWorkflowDocuments).not.toHaveBeenCalled();
  });

  it("WP2c writes the playbook documents when only the playbook preset is on", async () => {
    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {}, tablePresets: ["playbook"] });
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);
    mockSyncPlaybookDocuments.mockResolvedValue(true);
    mockGetSourcePath.mockReturnValue("/nonexistent-source");
    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockSyncPlaybookDocuments).toHaveBeenCalledWith(expect.anything(), "x_test", "/nonexistent-source");
    expect(mockSyncFlowDocuments).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("WP2c fails the download when a playbook could not be read, after writing the flows", async () => {
    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {}, tablePresets: ["flow", "playbook"] });
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);
    mockSyncFlowDocuments.mockResolvedValue(true);
    mockSyncPlaybookDocuments.mockResolvedValue(false);
    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockSyncFlowDocuments).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("Download finished with errors"));
  });

  it("WP2f writes the workflow documents when only the workflow preset is on", async () => {
    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {}, tablePresets: ["workflow"] });
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);
    mockSyncWorkflowDocuments.mockResolvedValue(true);
    mockGetSourcePath.mockReturnValue("/nonexistent-source");
    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockSyncWorkflowDocuments).toHaveBeenCalledWith(expect.anything(), "x_test", "/nonexistent-source");
    expect(mockSyncFlowDocuments).not.toHaveBeenCalled();
    expect(mockSyncPlaybookDocuments).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("WP2f fails the download when a workflow could not be read, after writing the playbooks", async () => {
    mockGetConfig.mockReturnValue({
      includes: {},
      excludes: {},
      tableOptions: {},
      tablePresets: ["playbook", "workflow"],
    });
    mockBuildManifestFromTableAPI.mockResolvedValue(BUILT_MANIFEST);
    mockSyncPlaybookDocuments.mockResolvedValue(true);
    mockSyncWorkflowDocuments.mockResolvedValue(false);
    const { downloadCommand } = await import("../commands.js");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockSyncPlaybookDocuments).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("Download finished with errors"));
  });
});
