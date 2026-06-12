export {};

const mockSetLogLevel = jest.fn();
const mockProcessManifest = jest.fn();
const mockGetConfig = jest.fn();
const mockDefaultConfigFile = jest.fn();
const mockStartWizard = jest.fn();
const mockStat = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockGetAppListApi = jest.fn();
const mockGetManifestApi = jest.fn();

jest.mock("../Watcher", () => ({
  startWatching: jest.fn(),
}));

jest.mock("../Logger", () => ({
  logger: {
    setLogLevel: (...args: unknown[]) => mockSetLogLevel(...args),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../appUtils", () => ({
  processManifest: (...args: unknown[]) => mockProcessManifest(...args),
}));

jest.mock("../config", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getDefaultConfigFile: (...args: unknown[]) => mockDefaultConfigFile(...args),
}));

jest.mock("../wizard", () => ({
  startWizard: (...args: unknown[]) => mockStartWizard(...args),
}));

jest.mock("../manifestBuilder", () => ({
  isScopedEndpointUnavailableError: () => false,
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(),
  listAppsFromTableAPI: jest.fn(),
}));

jest.mock("../snClient", () => ({
  defaultClient: () => ({
    getAppList: (...args: unknown[]) => mockGetAppListApi(...args),
    getManifest: (...args: unknown[]) => mockGetManifestApi(...args),
  }),
  getScopedEndpointPrefix: jest.fn(),
  resolveCredentials: () => ({ instance: "", user: "", password: "", profile: undefined }),
  setActiveInstanceProfile: jest.fn(),
  preloadStoredCredentials: jest.fn(),
  clearStoredCredentialsCache: jest.fn(),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
}));

jest.mock("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

jest.mock("fs", () => ({
  promises: {
    stat: (...args: unknown[]) => mockStat(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

describe("initCommand auto scope flow", () => {
  const oldCwd = process.cwd;
  const oldChdir = process.chdir;

  beforeEach(() => {
    jest.clearAllMocks();
    process.cwd = jest.fn(() => "/tmp/project");
    process.chdir = jest.fn();

    mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, tableOptions: {} });
    mockDefaultConfigFile.mockReturnValue("module.exports={sourceDirectory:'src'};\n");

    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    mockStat.mockImplementation(async (targetPath: string) => {
      if (targetPath === "/tmp/project/.env") {
        return { isFile: () => true };
      }
      throw enoent;
    });

    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    mockGetAppListApi.mockResolvedValue({
      data: {
        result: [
          { sys_id: "1", scope: "x_alpha", displayName: "Alpha" },
          { sys_id: "2", scope: "x_beta", displayName: "Beta" },
          { sys_id: "3", scope: "global", displayName: "Global" },
        ],
      },
    });

    mockGetManifestApi.mockImplementation(async (scope: string) => ({
      data: {
        result: {
          scope,
          tables: {
            sys_script_include: {
              records: {
                [`Rec-${scope}`]: {
                  sys_id: `id-${scope}`,
                  name: `Rec-${scope}`,
                  files: [{ name: "script", type: "js", content: "gs.info('ok');" }],
                },
              },
            },
          },
        },
      },
    }));
  });

  afterEach(() => {
    process.cwd = oldCwd;
    process.chdir = oldChdir;
  });

  it("initializes all x_* scopes when .env exists", async () => {
    const { initCommand } = await import("../commands");

    await initCommand({ logLevel: "info", ci: true });

    expect(mockSetLogLevel).toHaveBeenCalledWith("info");
    expect(mockStartWizard).not.toHaveBeenCalled();
    expect(mockGetManifestApi).toHaveBeenCalledTimes(2);
    expect(mockGetManifestApi).toHaveBeenNthCalledWith(
      1,
      "x_alpha",
      { includes: {}, excludes: {}, tableOptions: {} },
      true
    );
    expect(mockGetManifestApi).toHaveBeenNthCalledWith(
      2,
      "x_beta",
      { includes: {}, excludes: {}, tableOptions: {} },
      true
    );
    expect(mockProcessManifest).toHaveBeenCalledTimes(2);
  });
});
