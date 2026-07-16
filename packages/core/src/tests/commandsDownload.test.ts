// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

const mockSetLogLevel = jest.fn();
const mockPrompt = jest.fn();
const mockGetConfig = jest.fn();
const mockProcessManifest = jest.fn();
const mockGetManifestApi = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: (...args: unknown[]) => mockSetLogLevel(...args),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {} });
    mockPrompt.mockResolvedValue({ confirmed: true });
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
});
