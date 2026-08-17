// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// The `mcp` auto-configure path is where the profile-instance fallback bites
// hardest: writeMcpSecretsConfig() PERSISTS the resolved instance into
// .syncrona-mcp/secrets.json, so a named profile that defines no instance would
// silently pin every later MCP session to the base SN_INSTANCE. This suite
// drives the REAL snClient resolution through mcpCommand (only the process
// boundaries — config root, credential store, logger, child_process, homedir —
// are mocked) and pins that the loud fallback warning fires on this path when
// the fallback lands on disk, and that defining the profile instance both
// silences it and changes what is persisted.

const mockGetRootDir = jest.fn();
const mockGetActiveInstance = jest.fn();
const mockLoggerWarn = jest.fn();
const mockSpawn = jest.fn();
const mockHomedir = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getRootDir: (...a: unknown[]) => mockGetRootDir(...a),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    routeAllToStderr: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn(),
  },
}));

jest.unstable_mockModule("../commandHelpers.js", () => ({
  setLogLevel: jest.fn(),
}));

// Both consumers of auth.js meet here: mcpCommand reads getActiveInstance and
// the real snClient links resolveCredentialsFromStore.
jest.unstable_mockModule("../auth.js", () => ({
  getActiveInstance: (...a: unknown[]) => mockGetActiveInstance(...a),
  resolveCredentialsFromStore: jest.fn(),
}));

// Never spawn the real MCP server; the suite runs with start: false, so the
// mock also proves nothing tries to spawn anyway.
jest.unstable_mockModule("child_process", () => {
  const spawn = (...a: unknown[]) => mockSpawn(...a);
  return { spawn, default: { spawn } };
});

// os.homedir() decides where desktop-client configs are looked for; left real,
// a darwin host would read (and write) the developer's actual home directory.
jest.unstable_mockModule("os", () => {
  const actual = jest.requireActual("os") as typeof import("os");
  const patched = { ...actual, homedir: (...a: unknown[]) => mockHomedir(...a) };
  return { ...patched, default: patched };
});

let mcpCommand: typeof import("../mcpCommand.js").mcpCommand;
let snClient: typeof import("../snClient.js");

beforeAll(async () => {
  ({ mcpCommand } = await import("../mcpCommand.js"));
  snClient = await import("../snClient.js");
});

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_SERVER_PATH_ENV = process.env.SYNCRONA_MCP_SERVER_PATH;
const ORIGINAL_EXIT_CODE = process.exitCode;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

let tmpRoot = "";
let tmpHome = "";
let serverPath = "";

const secretsConfig = () => path.join(tmpRoot, ".syncrona-mcp", "secrets.json");

const savedSnEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-mcp-fallback-"));
  tmpRoot = path.join(base, "workspace");
  tmpHome = path.join(base, "home");
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.mkdirSync(tmpHome, { recursive: true });
  serverPath = path.join(tmpRoot, "fake-mcp-server.js");
  fs.writeFileSync(serverPath, "// stand-in MCP server entrypoint\n", "utf8");

  // Pinned platform: only the VS Code target (inside tmpRoot) is resolved, so
  // the test measures the same on every host.
  setPlatform("linux");
  delete process.env.SYNCRONA_MCP_SERVER_PATH;
  process.exitCode = undefined;

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) {
      savedSnEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.SN_USER = "admin";
  process.env.SN_PASSWORD = "pw";
  process.env.SN_INSTANCE = "base.service-now.com";

  mockGetRootDir.mockReturnValue(tmpRoot);
  mockHomedir.mockReturnValue(tmpHome);
  mockGetActiveInstance.mockResolvedValue(null);

  snClient.setActiveInstanceProfile(undefined);
  snClient.clearStoredCredentialsCache();
  snClient.resetAuthIssueWarnings();
  snClient.resetProfileFallbackWarnings();
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  if (ORIGINAL_SERVER_PATH_ENV === undefined) {
    delete process.env.SYNCRONA_MCP_SERVER_PATH;
  } else {
    process.env.SYNCRONA_MCP_SERVER_PATH = ORIGINAL_SERVER_PATH_ENV;
  }
  process.exitCode = ORIGINAL_EXIT_CODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(savedSnEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
    delete savedSnEnv[key];
  }
  snClient.setActiveInstanceProfile(undefined);
  fs.rmSync(path.dirname(tmpRoot), { recursive: true, force: true });
});

const runMcp = (): Promise<void> =>
  mcpCommand({
    logLevel: "info",
    autoConfigure: true,
    start: false,
    mcpServerPath: serverPath,
    instanceProfile: "qa",
  });

const fallbackWarnings = (): string[] =>
  mockLoggerWarn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("defines no instance"));

describe("mcp auto-configure and the profile instance fallback", () => {
  it("warns loudly when the fallback instance is persisted into secrets.json", async () => {
    await runMcp();

    const secrets = JSON.parse(fs.readFileSync(secretsConfig(), "utf8")) as {
      servicenow: { instance: string };
    };
    expect(secrets.servicenow.instance).toBe("base.service-now.com");

    const lines = fallbackWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Instance profile "QA"');
    expect(lines[0]).toContain('falling back to the base SN_INSTANCE "base.service-now.com"');
    expect(lines[0]).toContain("SN_INSTANCE_QA");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("stays silent and persists the profile instance when the profile defines one", async () => {
    process.env.SN_INSTANCE_QA = "qa.service-now.com";

    await runMcp();

    const secrets = JSON.parse(fs.readFileSync(secretsConfig(), "utf8")) as {
      servicenow: { instance: string };
    };
    expect(secrets.servicenow.instance).toBe("qa.service-now.com");
    expect(fallbackWarnings()).toHaveLength(0);
  });
});
