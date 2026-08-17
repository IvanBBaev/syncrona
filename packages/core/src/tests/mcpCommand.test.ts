// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

export {};

// mcpCommand.ts had no suite of its own: its coverage was whatever the
// commands-level suites happened to drag in, which made it both the weakest
// file in the package AND host-dependent. resolveMcpClientTargets branches on
// process.platform, so a macOS runner covered the darwin arm, a Linux runner
// covered neither arm, and the per-file floor passed locally while failing CI
// on ubuntu-latest with the same 990 green tests.
//
// Every test below pins the inputs the file reads from its environment —
// process.platform, os.homedir(), %APPDATA%, the workspace root and the MCP
// server candidates — so the file measures the same on any host. Nothing here
// may be written so that it only runs on one operating system.

const mockGetRootDir = jest.fn();
const mockGetActiveInstance = jest.fn();
const mockResolveCredentials = jest.fn();
const mockSetLogLevel = jest.fn();
const mockRouteAllToStderr = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockSpawn = jest.fn();
const mockHomedir = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getRootDir: (...a: unknown[]) => mockGetRootDir(...a),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    routeAllToStderr: (...a: unknown[]) => mockRouteAllToStderr(...a),
    setLogLevel: jest.fn(),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../commandHelpers.js", () => ({
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
}));

jest.unstable_mockModule("../auth.js", () => ({
  getActiveInstance: (...a: unknown[]) => mockGetActiveInstance(...a),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  resolveCredentials: (...a: unknown[]) => mockResolveCredentials(...a),
}));

// Never spawn the real MCP server: it would inherit this process's stdio and
// keep running after the test that started it.
jest.unstable_mockModule("child_process", () => {
  const spawn = (...a: unknown[]) => mockSpawn(...a);
  return { spawn, default: { spawn } };
});

// os.homedir() decides where the darwin client configs are looked for. Left
// real, the darwin tests would read (and write) the developer's actual home
// directory, and their outcome would depend on whether Claude Desktop happens
// to be installed on the host.
jest.unstable_mockModule("os", () => {
  const actual = jest.requireActual("os") as typeof import("os");
  const patched = { ...actual, homedir: (...a: unknown[]) => mockHomedir(...a) };
  return { ...patched, default: patched };
});

// Exactly one thing needs a seam in fs. The last MCP-server candidate resolves
// relative to mcpCommand.ts itself (packages/mcp-server/dist/index.js), which
// really exists in a built checkout — so without hiding it, the "nothing found"
// branch is unreachable here and its error message is never tested. Everything
// else in this suite runs against a real temp directory on the real filesystem.
const hiddenFromLookup = new Set<string>();
jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    stat: (target: Parameters<typeof actual.promises.stat>[0]) =>
      hiddenFromLookup.has(String(target))
        ? Promise.reject(Object.assign(new Error("not found"), { code: "ENOENT" }))
        : actual.promises.stat(target),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

// jest.unstable_mockModule does not hoist under ESM, so the subject is imported
// lazily: a static import would bind the real config/auth/snClient (and the
// real child_process) before any of the mocks above take effect.
let mcpCommand: typeof import("../mcpCommand.js").mcpCommand;
type McpArgs = Parameters<typeof mcpCommand>[0];

beforeAll(async () => {
  ({ mcpCommand } = await import("../mcpCommand.js"));
});

// The bundled-sibling candidate, derived from THIS file's location rather than
// from the subject, so hiding it stays honest if the subject's own derivation
// ever changes.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SIBLING = path.resolve(
  TEST_DIR,
  "..",
  "..",
  "..",
  "mcp-server",
  "dist",
  "index.js"
);

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_APPDATA = process.env.APPDATA;
const ORIGINAL_SERVER_PATH_ENV = process.env.SYNCRONA_MCP_SERVER_PATH;
const ORIGINAL_EXIT_CODE = process.exitCode;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Restores an env var to its pre-suite state, including "was not set at all". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

/** A child process that exits with `code` once both handlers are attached. */
function childClosingWith(code: number | null): EventEmitter {
  const child = new EventEmitter();
  setImmediate(() => child.emit("close", code));
  return child;
}

let tmpRoot = "";
let tmpHome = "";
let tmpAppData = "";

const vsCodeConfig = () => path.join(tmpRoot, ".vscode", "mcp.json");
const secretsConfig = () => path.join(tmpRoot, ".syncrona-mcp", "secrets.json");
const homeClaudeConfig = () =>
  path.join(tmpHome, "Library", "Application Support", "Claude", "claude_desktop_config.json");
const homeCursorConfig = () => path.join(tmpHome, ".cursor", "mcp.json");
const appDataClaudeConfig = () =>
  path.join(tmpAppData, "Claude", "claude_desktop_config.json");
const appDataCursorConfig = () => path.join(tmpAppData, "Cursor", "mcp.json");

const workspaceServerBuild = () =>
  path.join(tmpRoot, "packages", "mcp-server", "dist", "index.js");
const installedServerBuild = () =>
  path.join(tmpRoot, "node_modules", "@syncrona", "mcp-server", "dist", "index.js");

function seed(filePath: string, contents = "{}"): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** A client config that already carries an unrelated server entry. */
const withExistingServer = () =>
  JSON.stringify({ mcpServers: { existing: { command: "node", args: ["/other.js"] } } });

/** The server names present in a written client config, sorted. */
function serversIn(filePath: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  return Object.keys(parsed.mcpServers ?? {}).sort();
}

/** The MCP server entrypoint that landed in the VS Code config. */
function configuredServerPath(): string {
  const parsed = JSON.parse(fs.readFileSync(vsCodeConfig(), "utf8")) as {
    mcpServers?: Record<string, { args?: string[] }>;
  };
  return String(parsed.mcpServers?.["syncrona"]?.args?.[0]);
}

const runMcp = (overrides: Partial<McpArgs> = {}): Promise<void> =>
  mcpCommand({ logLevel: "info", autoConfigure: true, start: false, ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  hiddenFromLookup.clear();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-mcp-"));
  tmpRoot = path.join(base, "workspace");
  tmpHome = path.join(base, "home");
  tmpAppData = path.join(base, "appdata");
  for (const dir of [tmpRoot, tmpHome, tmpAppData]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // A clean exit-code baseline: another suite may have run first in this worker
  // and left process.exitCode set, which would make the "does not fail"
  // assertions order-dependent.
  process.exitCode = undefined;
  // Windows is the only platform that reads APPDATA, but it is set here for
  // every test so the win32 cases differ from the others in exactly one input.
  process.env.APPDATA = tmpAppData;
  delete process.env.SYNCRONA_MCP_SERVER_PATH;
  // Neutral default: no host's real platform, so a test that forgets to pin one
  // fails on every machine rather than only on Linux CI.
  setPlatform("linux");

  mockGetRootDir.mockReturnValue(tmpRoot);
  mockHomedir.mockReturnValue(tmpHome);
  mockGetActiveInstance.mockResolvedValue(null);
  mockResolveCredentials.mockReturnValue({
    instance: "dev.service-now.com",
    user: "dev-user",
    password: "dev-pass",
    profile: undefined,
  });
  mockSpawn.mockImplementation(() => childClosingWith(0));
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  restoreEnv("APPDATA", ORIGINAL_APPDATA);
  restoreEnv("SYNCRONA_MCP_SERVER_PATH", ORIGINAL_SERVER_PATH_ENV);
  process.exitCode = ORIGINAL_EXIT_CODE;
  fs.rmSync(path.dirname(tmpRoot), { recursive: true, force: true });
});

describe("resolveMcpClientTargets — every platform arm, on every host", () => {
  beforeEach(() => {
    seed(workspaceServerBuild(), "// built server");
  });

  it("configures only VS Code on a platform with no known desktop client", async () => {
    // Linux (and anything else): the desktop-client paths must be left alone
    // even when files happen to sit at them, because those layouts belong to
    // macOS and Windows installs.
    setPlatform("linux");
    seed(homeClaudeConfig(), withExistingServer());
    seed(homeCursorConfig(), withExistingServer());
    seed(appDataClaudeConfig(), withExistingServer());
    seed(appDataCursorConfig(), withExistingServer());

    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
    for (const untouched of [
      homeClaudeConfig(),
      homeCursorConfig(),
      appDataClaudeConfig(),
      appDataCursorConfig(),
    ]) {
      expect(serversIn(untouched)).toEqual(["existing"]);
    }
  });

  it("configures Claude Desktop and Cursor under the home directory on darwin", async () => {
    setPlatform("darwin");
    seed(homeClaudeConfig(), withExistingServer());
    seed(homeCursorConfig(), withExistingServer());
    seed(appDataClaudeConfig(), withExistingServer());

    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
    expect(serversIn(homeClaudeConfig())).toEqual(["existing", "syncrona"]);
    expect(serversIn(homeCursorConfig())).toEqual(["existing", "syncrona"]);
    // The Windows layout is not consulted on darwin, even with APPDATA set.
    expect(serversIn(appDataClaudeConfig())).toEqual(["existing"]);
  });

  it("configures Claude Desktop and Cursor under %APPDATA% on win32", async () => {
    setPlatform("win32");
    seed(appDataClaudeConfig(), withExistingServer());
    seed(appDataCursorConfig(), withExistingServer());
    seed(homeClaudeConfig(), withExistingServer());

    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
    expect(serversIn(appDataClaudeConfig())).toEqual(["existing", "syncrona"]);
    expect(serversIn(appDataCursorConfig())).toEqual(["existing", "syncrona"]);
    // The darwin layout is not consulted on win32.
    expect(serversIn(homeClaudeConfig())).toEqual(["existing"]);
  });

  it("configures VS Code only on win32 when APPDATA is not set", async () => {
    // The guard is `win32 && appData`: without the variable there is no roaming
    // profile to derive the client paths from, so path.join must never be
    // reached with an empty first segment (that would resolve relative to cwd).
    setPlatform("win32");
    delete process.env.APPDATA;
    seed(appDataClaudeConfig(), withExistingServer());
    seed(appDataCursorConfig(), withExistingServer());

    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
    expect(serversIn(appDataClaudeConfig())).toEqual(["existing"]);
    expect(serversIn(appDataCursorConfig())).toEqual(["existing"]);
  });

  it("says why the desktop clients were skipped on win32 without APPDATA", async () => {
    // Silently configuring only VS Code is indistinguishable from "Claude
    // Desktop and Cursor are not installed", which sends the user hunting in
    // the wrong place for why the MCP server never appears.
    setPlatform("win32");
    delete process.env.APPDATA;

    await runMcp();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "APPDATA is not set: skipping Claude Desktop and Cursor configuration on win32."
    );
  });

  it("does not mention APPDATA on a platform that never reads it", async () => {
    setPlatform("darwin");
    delete process.env.APPDATA;

    await runMcp();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("drops an onlyIfExists target that is not installed and keeps one that is", async () => {
    // Writing a Claude Desktop config for a machine with no Claude Desktop
    // would create a config directory the user never asked for; VS Code is the
    // one target created unconditionally, because it is workspace-local.
    setPlatform("darwin");
    seed(homeCursorConfig(), withExistingServer());

    await runMcp();

    expect(fs.existsSync(homeClaudeConfig())).toBe(false);
    expect(serversIn(homeCursorConfig())).toEqual(["existing", "syncrona"]);
    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
  });

  it("logs a restart hint for each client it configured", async () => {
    setPlatform("darwin");
    seed(homeClaudeConfig());
    seed(homeCursorConfig());

    await runMcp();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Restart MCP clients to pick up the updated configuration:"
    );
    for (const hint of [
      "- VS Code: run `Developer: Reload Window`.",
      "- Claude Desktop: fully quit and open again.",
      "- Cursor: run `Developer: Reload Window`.",
    ]) {
      expect(mockLoggerInfo).toHaveBeenCalledWith(hint);
    }
  });
});

describe("resolveMcpServerPath candidate order", () => {
  it("prefers --mcp-server-path over every other candidate", async () => {
    const explicit = seed(path.join(tmpRoot, "explicit", "index.js"), "// explicit");
    const fromEnv = seed(path.join(tmpRoot, "env", "index.js"), "// env");
    process.env.SYNCRONA_MCP_SERVER_PATH = fromEnv;
    seed(workspaceServerBuild(), "// workspace");
    seed(installedServerBuild(), "// installed");

    await runMcp({ mcpServerPath: explicit });

    expect(configuredServerPath()).toBe(explicit);
  });

  it("falls back to SYNCRONA_MCP_SERVER_PATH when no path is passed", async () => {
    const fromEnv = seed(path.join(tmpRoot, "env", "index.js"), "// env");
    process.env.SYNCRONA_MCP_SERVER_PATH = fromEnv;
    seed(workspaceServerBuild(), "// workspace");
    seed(installedServerBuild(), "// installed");

    await runMcp();

    expect(configuredServerPath()).toBe(fromEnv);
  });

  it("ignores a blank SYNCRONA_MCP_SERVER_PATH instead of treating it as a candidate", async () => {
    // An exported-but-empty variable is common in CI shells; untrimmed it would
    // become a candidate whose stat() resolves the current directory.
    process.env.SYNCRONA_MCP_SERVER_PATH = "   ";
    seed(workspaceServerBuild(), "// workspace");

    await runMcp();

    expect(configuredServerPath()).toBe(workspaceServerBuild());
  });

  it("fails on a --mcp-server-path that does not exist instead of starting another server", async () => {
    // Falling through to the discovery candidates would configure and start a
    // DIFFERENT server than the one that was explicitly requested, so a typo
    // would look like a successful run against the wrong build.
    const typo = path.join(tmpRoot, "typo", "index.js");
    seed(workspaceServerBuild(), "// workspace");

    await expect(runMcp({ mcpServerPath: typo })).rejects.toThrow(
      `MCP server entrypoint not found at --mcp-server-path: ${typo}`
    );

    expect(fs.existsSync(vsCodeConfig())).toBe(false);
    expect(fs.existsSync(secretsConfig())).toBe(false);
  });

  it("resolves a relative --mcp-server-path against the invoking directory", async () => {
    // The path is validated with a cwd-relative stat but consumed with
    // cwd=workspaceRoot (both the written client configs and the spawn), so a
    // relative path returned as-is would pass validation against one base and
    // then resolve against another. The absolute path is pinned at resolution
    // time so every consumer agrees with the stat.
    //
    // A real chdir, not a cwd spy: jest hands each suite a COPY of the process
    // object while path.resolve() reads the real one, so a spy on the copy
    // never reaches it. realpathSync because cwd() reports the physical path
    // (on macOS the tmpdir sits behind the /var -> /private/var symlink).
    const invokedFrom = path.join(tmpRoot, "tools");
    seed(path.join(invokedFrom, "dist", "index.js"), "// built here");
    const realInvokedFrom = fs.realpathSync(invokedFrom);
    const previousCwd = process.cwd();
    process.chdir(invokedFrom);
    try {
      await runMcp({ mcpServerPath: path.join("dist", "index.js") });
    } finally {
      process.chdir(previousCwd);
    }

    expect(configuredServerPath()).toBe(path.join(realInvokedFrom, "dist", "index.js"));
  });

  it("names the resolved location when a relative --mcp-server-path is missing", async () => {
    // The converse direction: a path that exists relative to the workspace
    // root but not to the invoking directory must still fail, and the error
    // must say where the stat actually looked — otherwise the typo hunt starts
    // from the wrong base.
    const relative = path.join("srv", "index.js");
    seed(path.join(tmpRoot, relative), "// at the workspace root, not at cwd");
    seed(workspaceServerBuild(), "// workspace");
    const invokedFrom = path.join(tmpRoot, "tools");
    fs.mkdirSync(invokedFrom, { recursive: true });
    const realInvokedFrom = fs.realpathSync(invokedFrom);
    const previousCwd = process.cwd();
    process.chdir(invokedFrom);
    try {
      await expect(runMcp({ mcpServerPath: relative })).rejects.toThrow(
        `MCP server entrypoint not found at --mcp-server-path: ${relative} ` +
          `(resolved to ${path.join(realInvokedFrom, relative)})`
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("resolves a relative SYNCRONA_MCP_SERVER_PATH against the invoking directory", async () => {
    // Same base-mismatch hazard as the explicit flag, one candidate down.
    const invokedFrom = path.join(tmpRoot, "tools");
    seed(path.join(invokedFrom, "dist", "index.js"), "// env build");
    const realInvokedFrom = fs.realpathSync(invokedFrom);
    process.env.SYNCRONA_MCP_SERVER_PATH = path.join("dist", "index.js");
    const previousCwd = process.cwd();
    process.chdir(invokedFrom);
    try {
      await runMcp();
    } finally {
      process.chdir(previousCwd);
    }

    expect(configuredServerPath()).toBe(path.join(realInvokedFrom, "dist", "index.js"));
  });

  it("ignores a blank --mcp-server-path rather than failing on it", async () => {
    // yargs hands through an empty string for `--mcp-server-path=`; that is an
    // absent value, not a request for a file whose name is "".
    seed(workspaceServerBuild(), "// workspace");

    await runMcp({ mcpServerPath: "   " });

    expect(configuredServerPath()).toBe(workspaceServerBuild());
  });

  it("prefers the workspace build over the installed package", async () => {
    seed(workspaceServerBuild(), "// workspace");
    seed(installedServerBuild(), "// installed");

    await runMcp();

    expect(configuredServerPath()).toBe(workspaceServerBuild());
  });

  it("falls back to the installed @syncrona/mcp-server package", async () => {
    seed(installedServerBuild(), "// installed");

    await runMcp();

    expect(configuredServerPath()).toBe(installedServerBuild());
  });

  it("fails with an actionable error when no candidate exists", async () => {
    hiddenFromLookup.add(BUNDLED_SIBLING);

    await expect(runMcp()).rejects.toThrow(/Unable to find MCP server entrypoint\./);

    // Resolution happens before auto-configure, so a run that cannot find the
    // server must not leave half-written client configs behind.
    expect(fs.existsSync(vsCodeConfig())).toBe(false);
    expect(fs.existsSync(secretsConfig())).toBe(false);
  });
});

describe("writeMcpClientConfig", () => {
  beforeEach(() => {
    seed(workspaceServerBuild(), "// built server");
  });

  it("merges into an existing config instead of replacing it", async () => {
    // The VS Code config is shared with every other MCP server the developer
    // uses; clobbering the map would silently unregister all of them.
    seed(
      vsCodeConfig(),
      JSON.stringify({
        inputs: [{ id: "token" }],
        mcpServers: { existing: { command: "node", args: ["/other.js"] } },
      })
    );

    await runMcp();

    const parsed = JSON.parse(fs.readFileSync(vsCodeConfig(), "utf8")) as {
      inputs?: unknown;
      mcpServers?: Record<string, { command: string; args: string[]; cwd?: string }>;
    };
    expect(parsed.inputs).toEqual([{ id: "token" }]);
    expect(parsed.mcpServers?.existing).toEqual({ command: "node", args: ["/other.js"] });
    expect(parsed.mcpServers?.["syncrona"]).toEqual({
      command: "node",
      args: [workspaceServerBuild()],
      cwd: tmpRoot,
    });
  });

  it.each([
    ["unparseable JSON", "{ half written"],
    ["a JSON null document", "null"],
    ["a JSON scalar", "42"],
    ["a JSON array", '[{"mcpServers":{"existing":{"command":"node","args":["/other.js"]}}}]'],
  ])("recovers to an empty config when the file holds %s", async (_label, raw) => {
    // A corrupt or truncated config must not abort the whole command: the entry
    // is rewritten from scratch so `syncrona mcp` stays self-healing.
    //
    // The array row is the one that used to pass the `typeof parsed ===
    // "object"` guard: mcpServers was assigned onto the array, JSON.stringify
    // dropped it as a non-index property, and the file was written back with
    // the entry gone while the command still logged success.
    seed(vsCodeConfig(), raw);

    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
  });

  it("names the config file it had to replace instead of reporting a bare success", async () => {
    seed(vsCodeConfig(), "[]");

    await runMcp();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `Replacing malformed MCP client config: ${vsCodeConfig()}`
    );
  });

  it("says nothing about malformed configs when it creates one from scratch", async () => {
    // A first run has no file to replace; a warning there would be pure noise.
    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("replaces an mcpServers value that is not a map", async () => {
    seed(vsCodeConfig(), JSON.stringify({ mcpServers: "not-a-map" }));

    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
  });

  it("replaces an mcpServers value that is an array instead of spreading it", async () => {
    // `typeof [] === "object"` passes the map guard, and spreading an array
    // registers each element as a server named by its index ("0", "1", ...) —
    // the same class the document-level array guard excludes.
    seed(
      vsCodeConfig(),
      JSON.stringify({ mcpServers: [{ command: "node", args: ["/other.js"] }] })
    );

    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
  });
});

describe("writeMcpSecretsConfig", () => {
  beforeEach(() => {
    seed(workspaceServerBuild(), "// built server");
  });

  const secrets = () =>
    JSON.parse(fs.readFileSync(secretsConfig(), "utf8")) as {
      servicenow?: { instance?: string };
    };

  it("prefers the active instance from the credential store", async () => {
    // `syncrona use` is the authority on which instance the session targets;
    // an SN_INSTANCE left over in the environment must not override it.
    mockGetActiveInstance.mockResolvedValue("store.service-now.com");
    mockResolveCredentials.mockReturnValue({ instance: "env.service-now.com" });

    await runMcp();

    expect(secrets().servicenow?.instance).toBe("store.service-now.com");
  });

  it("lets an explicit --instance-profile outrank the stored active instance", async () => {
    // The mirror image of the test above, and the reason the precedence is a
    // conditional rather than a `||` chain: `syncrona use` sets the session
    // default, but naming a profile on the command line is a deliberate
    // override for this run. With the store winning unconditionally, the
    // secrets file aims the MCP server at the environment the user did NOT ask
    // for — and nothing in the output says so.
    mockGetActiveInstance.mockResolvedValue("store.service-now.com");
    mockResolveCredentials.mockReturnValue({ instance: "qa.service-now.com" });

    await runMcp({ instanceProfile: "qa" });

    expect(mockResolveCredentials).toHaveBeenCalledWith("qa");
    expect(secrets().servicenow?.instance).toBe("qa.service-now.com");
  });

  it("falls back to resolveCredentials for the requested profile when the store is empty", async () => {
    mockGetActiveInstance.mockResolvedValue(null);

    await runMcp({ instanceProfile: "qa" });

    expect(mockResolveCredentials).toHaveBeenCalledWith("qa");
    expect(secrets().servicenow?.instance).toBe("dev.service-now.com");
  });

  it("falls back to resolveCredentials when the credential store cannot be read", async () => {
    // A locked keychain must degrade to the environment rather than fail the
    // whole auto-configure.
    mockGetActiveInstance.mockRejectedValue(new Error("keychain is locked"));

    await runMcp();

    expect(secrets().servicenow?.instance).toBe("dev.service-now.com");
  });

  it("writes the instance only — never the user or the password", async () => {
    // The file lands in the workspace, where it is easy to commit by accident.
    await runMcp();

    const raw = fs.readFileSync(secretsConfig(), "utf8");
    expect(raw).toContain("dev.service-now.com");
    expect(raw).not.toContain("dev-pass");
    expect(raw).not.toContain("dev-user");
    expect(raw).not.toContain("password");
  });

  it("fails the run and asks for a login when no instance can be resolved", async () => {
    // #13: missing credentials is a failure, not a skip — a script that runs
    // `syncrona mcp --start=false` in CI has to see a non-zero exit code.
    mockGetActiveInstance.mockResolvedValue(null);
    mockResolveCredentials.mockReturnValue({ instance: "", user: "", password: "" });

    await runMcp({ start: true });

    expect(mockLoggerError).toHaveBeenCalledWith("Run syncrona login first.");
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(secretsConfig())).toBe(false);
    // It returns before the restart hints and before starting the server.
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      "Restart MCP clients to pick up the updated configuration:"
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("mcpCommand orchestration", () => {
  beforeEach(() => {
    seed(workspaceServerBuild(), "// built server");
  });

  it("routes logging to stderr before anything else can write to stdout", async () => {
    // When a client launches `syncrona mcp`, stdout is the JSON-RPC channel.
    // setLogLevel() can emit a debug line while resolving a local profile, so
    // the routing has to be engaged before it, not merely somewhere in the run.
    await runMcp();

    expect(mockRouteAllToStderr).toHaveBeenCalledTimes(1);
    expect(mockSetLogLevel).toHaveBeenCalledTimes(1);
    expect(mockRouteAllToStderr.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetLogLevel.mock.invocationCallOrder[0]
    );
  });

  it("writes nothing when --auto-configure=false", async () => {
    await runMcp({ autoConfigure: false });

    expect(fs.existsSync(vsCodeConfig())).toBe(false);
    expect(fs.existsSync(secretsConfig())).toBe(false);
    expect(mockGetActiveInstance).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns after auto-configure without spawning when --start=false", async () => {
    await runMcp();

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "MCP auto-configure complete. Server start skipped (--start=false)."
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns the resolved server in the workspace root and returns on a clean exit", async () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await runMcp({ autoConfigure: false, start: true });

      const [command, argv, options] = mockSpawn.mock.calls[0] as [
        string,
        string[],
        { cwd: string; stdio: string },
      ];
      expect(command).toBe(process.execPath);
      expect(argv).toEqual([workspaceServerBuild()]);
      expect(options.cwd).toBe(tmpRoot);
      // stdio must be inherited: the client talks to the child over this
      // process's own stdin/stdout.
      expect(options.stdio).toBe("inherit");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("propagates a non-zero server exit code to the shell", async () => {
    // A crashed MCP server must not look like a successful run to whatever
    // supervises the CLI.
    mockSpawn.mockImplementation(() => childClosingWith(3));
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(runMcp({ autoConfigure: false, start: true })).rejects.toThrow("process.exit");

      expect(mockLoggerError).toHaveBeenCalledWith(
        "SyncroNow AI MCP server exited with code 3."
      );
      expect(exitSpy).toHaveBeenCalledWith(3);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("treats a signal-terminated server (null exit code) as a clean exit", async () => {
    // `close` reports (null, signal) when the child is killed; Number-less codes
    // must not be forwarded to process.exit, which would coerce them to 0 anyway
    // while still logging a bogus "exited with code null".
    mockSpawn.mockImplementation(() => childClosingWith(null));
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await runMcp({ autoConfigure: false, start: true });

      expect(exitSpy).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("rejects when the server process cannot be spawned at all", async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    });

    await expect(runMcp({ autoConfigure: false, start: true })).rejects.toThrow("spawn EACCES");
  });

  it("starts the server by default when neither flag is passed", async () => {
    // `syncrona mcp` with no flags is the form MCP clients launch, so both
    // defaults have to hold: auto-configure on, start on.
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await mcpCommand({ logLevel: "info" });

      expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
      expect(fs.existsSync(secretsConfig())).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        `Starting SyncroNow AI MCP server from ${workspaceServerBuild()}...`
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("getWorkspaceRoot", () => {
  it("falls back to the current working directory when no config root is loaded", async () => {
    // `syncrona mcp` is expected to work in a directory that has never been
    // initialised — ConfigManager.getRootDir() throws there, and the command
    // must still write its configs somewhere sane rather than crash.
    mockGetRootDir.mockImplementation(() => {
      throw new Error("no config loaded");
    });
    const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    try {
      seed(workspaceServerBuild(), "// built server");

      await runMcp();
    } finally {
      cwdSpy.mockRestore();
    }

    expect(serversIn(vsCodeConfig())).toEqual(["syncrona"]);
    expect(fs.existsSync(secretsConfig())).toBe(true);
    expect(configuredServerPath()).toBe(workspaceServerBuild());
  });
});
