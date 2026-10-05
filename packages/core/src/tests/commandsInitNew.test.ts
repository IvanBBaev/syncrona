// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// initCommand routes every `init --new` flag to appCreator.initNewApp before the
// wizard/.env paths, and runs the MCP auto-configure only after a real create.

const mockInitNewApp = jest.fn();
const mockMcpCommand = jest.fn();
const mockStartWizard = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../appCreator.js", () => ({
  initNewApp: (...a: unknown[]) => mockInitNewApp(...a),
  wantsInitNew: (args: { new?: boolean; name?: string }) => args.new === true || args.name !== undefined,
}));

jest.unstable_mockModule("../mcpCommand.js", () => ({
  mcpCommand: (...a: unknown[]) => mockMcpCommand(...a),
}));

jest.unstable_mockModule("../wizard.js", () => ({
  startWizard: (...a: unknown[]) => mockStartWizard(...a),
}));

const { initCommand } = await import("../commands.js");

describe("initCommand --new", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMcpCommand.mockResolvedValue(undefined);
  });

  it("creates the app, then auto-configures MCP", async () => {
    mockInitNewApp.mockResolvedValueOnce(true);
    const args = { logLevel: "info", new: true, name: "Asset Tracker" };
    await initCommand(args);
    expect(mockInitNewApp).toHaveBeenCalledWith(args);
    expect(mockMcpCommand).toHaveBeenCalledWith({ ...args, autoConfigure: true, start: false });
    expect(mockStartWizard).not.toHaveBeenCalled();
  });

  it("a dry run creates nothing and leaves MCP config alone", async () => {
    mockInitNewApp.mockResolvedValueOnce(false);
    await initCommand({ logLevel: "info", new: true, name: "Asset Tracker", dryRun: true });
    expect(mockMcpCommand).not.toHaveBeenCalled();
    expect(mockStartWizard).not.toHaveBeenCalled();
  });

  it("a refusal propagates to the CLI error handler", async () => {
    mockInitNewApp.mockRejectedValueOnce(new Error("no vendor prefix"));
    await expect(initCommand({ logLevel: "info", name: "X" })).rejects.toThrow("no vendor prefix");
    expect(mockMcpCommand).not.toHaveBeenCalled();
  });
});
