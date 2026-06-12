export {};

const mockSetLogLevel = jest.fn();
const mockPrompt = jest.fn();
const mockGetConfig = jest.fn();
const mockProcessManifest = jest.fn();
const mockGetManifestApi = jest.fn();

jest.mock("../Logger", () => ({
  logger: {
    setLogLevel: (...args: unknown[]) => mockSetLogLevel(...args),
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../config", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

jest.mock("../appUtils", () => ({
  processManifest: (...args: unknown[]) => mockProcessManifest(...args),
}));

jest.mock("../snClient", () => ({
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

jest.mock("inquirer", () => ({
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

  it("downloads manifest and calls processManifest with forceWrite=true", async () => {
    const manifest = { scope: "x_test", tables: {} };
    mockGetManifestApi.mockResolvedValue({ data: { result: manifest } });

    const { downloadCommand } = await import("../commands");

    await downloadCommand({ logLevel: "info", scope: "x_test" });

    expect(mockSetLogLevel).toHaveBeenCalledWith("info");
    expect(mockGetManifestApi).toHaveBeenCalledWith("x_test", {
      includes: {},
      excludes: {},
      tableOptions: {},
    }, true);
    expect(mockProcessManifest).toHaveBeenCalledWith(manifest, true);
  });

  it("skips confirmation prompt in ci mode", async () => {
    const manifest = { scope: "x_test", tables: {} };
    mockGetManifestApi.mockResolvedValue({ data: { result: manifest } });

    const { downloadCommand } = await import("../commands");

    await downloadCommand({ logLevel: "info", scope: "x_test", ci: true });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockProcessManifest).toHaveBeenCalledWith(manifest, true);
  });
});
