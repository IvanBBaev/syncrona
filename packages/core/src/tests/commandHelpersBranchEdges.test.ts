// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// Branch edges of commandHelpers that commandHelpers.test.ts,
// storeDecryptWarning.test.ts and localProfile.test.ts leave open: the
// .syncrona-local profile reaching the client (and its debug line), the scoped
// endpoint capability line, the scope-check error sinks for blank and non-Error
// failures, non-Error decrypt failures, and the login workspace bootstrap
// (create, keep, rethrow on a non-ENOENT stat failure).

const mockGetActiveInstance = jest.fn();
const mockLoadCredentials = jest.fn();
const mockCheckScope = jest.fn();
const mockScopeCheckMessage = jest.fn();
const mockSetActiveInstanceProfile = jest.fn();
const mockGetScopedEndpointPrefix = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();
const mockSetLogLevel = jest.fn();
const mockFsStat = jest.fn();

jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    stat: (...a: unknown[]) => mockFsStat(...a),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

jest.unstable_mockModule("../auth.js", () => ({
  getActiveInstance: (...a: unknown[]) => mockGetActiveInstance(...a),
  loadCredentials: (...a: unknown[]) => mockLoadCredentials(...a),
}));
jest.unstable_mockModule("../appUtils.js", () => ({
  checkScope: (...a: unknown[]) => mockCheckScope(...a),
}));
jest.unstable_mockModule("../logMessages.js", () => ({
  scopeCheckMessage: (...a: unknown[]) => mockScopeCheckMessage(...a),
}));
jest.unstable_mockModule("../snClient.js", () => ({
  setActiveInstanceProfile: (...a: unknown[]) => mockSetActiveInstanceProfile(...a),
  getScopedEndpointPrefix: (...a: unknown[]) => mockGetScopedEndpointPrefix(...a),
}));
jest.unstable_mockModule("../config.js", () => ({
  getDefaultConfigFile: (dir: string) => `module.exports = { sourceDirectory: "${dir}" };\n`,
}));
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    warn: jest.fn(),
    success: jest.fn(),
  },
}));

const helpers = await import("../commandHelpers.js");
const { classifyError } = await import("../errorTaxonomy.js");

const realStat = (jest.requireActual("fs") as typeof import("fs")).promises.stat;
const BASE_ARGS = { logLevel: "debug", dryRun: false };
const SCOPE_FAIL_LINE =
  "Failed to check your scope! You may want to make sure your project is configured correctly or run `npx syncrona init`";

const originalCwd = process.cwd();
let dir: string;
let exitCodeSnapshot: typeof process.exitCode;

beforeEach(() => {
  jest.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-helpers-"));
  process.chdir(dir);
  exitCodeSnapshot = process.exitCode;
  process.exitCode = undefined;
  mockFsStat.mockImplementation((...a: unknown[]) => realStat(a[0] as string));
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = exitCodeSnapshot;
});

function writeLocal(content: unknown): void {
  fs.writeFileSync(
    path.join(dir, helpers.LOCAL_CONFIG_FILE),
    typeof content === "string" ? content : JSON.stringify(content)
  );
}

describe("setLogLevel / resolveInstanceProfile", () => {
  it("activates the .syncrona-local profile and says where it came from", () => {
    writeLocal({ instanceProfile: "  staging  " });

    helpers.setLogLevel(BASE_ARGS);

    expect(mockSetLogLevel).toHaveBeenCalledWith("debug");
    expect(mockSetActiveInstanceProfile).toHaveBeenCalledWith("staging");
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      'Using instance profile "staging" from .syncrona-local'
    );
  });

  it("activates an explicit --instance-profile without the local-file debug line", () => {
    writeLocal({ instanceProfile: "staging" });

    helpers.setLogLevel({ ...BASE_ARGS, instanceProfile: "prod" });

    expect(mockSetActiveInstanceProfile).toHaveBeenCalledWith("prod");
    expect(mockLoggerDebug).not.toHaveBeenCalled();
  });

  it("clears the active profile when neither a flag nor a local file sets one", () => {
    helpers.setLogLevel(BASE_ARGS);

    expect(mockSetActiveInstanceProfile).toHaveBeenCalledWith(undefined);
    expect(mockLoggerDebug).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank profile", { instanceProfile: "   " }],
    ["a non-string profile", { instanceProfile: 42 }],
    ["no profile key", { other: "x" }],
  ])("treats %s in .syncrona-local as no default", (_label, content) => {
    writeLocal(content);
    expect(helpers.resolveInstanceProfile({})).toBeUndefined();
  });

  it("falls back to .syncrona-local when the flag is an empty string", () => {
    writeLocal({ instanceProfile: "dev" });
    expect(helpers.resolveInstanceProfile({ instanceProfile: "" })).toBe("dev");
  });
});

describe("logScopedEndpointCapability", () => {
  it("names the scoped endpoint prefix when one is detected", () => {
    mockGetScopedEndpointPrefix.mockReturnValue("/api/x_acme_app");

    helpers.logScopedEndpointCapability("push");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Capability check (push): using scoped endpoint prefix /api/x_acme_app."
    );
  });

  it("reports standard Table API mode when no prefix is detected", () => {
    mockGetScopedEndpointPrefix.mockReturnValue("");

    helpers.logScopedEndpointCapability("download");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Capability check (download): scoped endpoint prefix not detected. Using standard Table API mode (no scoped app required)."
    );
  });
});

describe("logErrorHint", () => {
  it("logs the classified next step with the arrow prefix", () => {
    const err = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });

    helpers.logErrorHint(err);

    expect(mockLoggerInfo).toHaveBeenCalledWith(`→ ${classifyError(err).hint}`);
  });
});

describe("scopeCheck — error sinks", () => {
  it("prints the scope mismatch details and skips the body", async () => {
    const result = { match: false, sessionScope: "global", manifestScope: "x_app" };
    mockCheckScope.mockResolvedValue(result);
    const body = jest.fn();

    await helpers.scopeCheck(body);

    expect(mockScopeCheckMessage).toHaveBeenCalledWith(result);
    expect(body).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not print mismatch details when the scope matches", async () => {
    mockCheckScope.mockResolvedValue({ match: true });
    const body = jest.fn(async () => undefined);

    await helpers.scopeCheck(body);

    expect(mockCheckScope).toHaveBeenCalledWith(false);
    expect(mockScopeCheckMessage).not.toHaveBeenCalled();
    expect(body).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("logs the checkScope error, the init advice and a hint", async () => {
    mockCheckScope.mockRejectedValue(new Error("401 Unauthorized"));

    await helpers.scopeCheck(jest.fn());

    expect(mockLoggerError.mock.calls.map((c) => c[0])).toEqual([
      "401 Unauthorized",
      SCOPE_FAIL_LINE,
    ]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringMatching(/^→ /));
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["an Error with an empty message", new Error("")],
    ["an empty-string rejection", ""],
  ])("skips the blank message line when checkScope fails with %s", async (_l, failure) => {
    mockCheckScope.mockRejectedValue(failure);

    await helpers.scopeCheck(jest.fn());

    expect(mockLoggerError.mock.calls.map((c) => c[0])).toEqual([SCOPE_FAIL_LINE]);
    expect(process.exitCode).toBe(1);
  });

  it("stringifies a non-Error checkScope rejection", async () => {
    mockCheckScope.mockRejectedValue("manifest unreadable");

    await helpers.scopeCheck(jest.fn());

    expect(mockLoggerError.mock.calls[0][0]).toBe("manifest unreadable");
  });

  it("reports a body failure with its message, not as a scope problem", async () => {
    mockCheckScope.mockResolvedValue({ match: true });

    await helpers.scopeCheck(async () => {
      throw new Error("push failed: 3 records");
    });

    expect(mockLoggerError.mock.calls.map((c) => c[0])).toEqual(["push failed: 3 records"]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringMatching(/^→ /));
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["an Error with an empty message", new Error("")],
    ["an empty-string throw", ""],
  ])("uses the unknown-error fallback when the body throws %s", async (_l, failure) => {
    mockCheckScope.mockResolvedValue({ match: true });

    await helpers.scopeCheck(() => {
      throw failure;
    });

    expect(mockLoggerError).toHaveBeenCalledWith("Command failed with an unknown error.");
    expect(process.exitCode).toBe(1);
  });

  it("stringifies a non-Error body throw", async () => {
    mockCheckScope.mockResolvedValue({ match: true });

    await helpers.scopeCheck(() => {
      throw 42;
    });

    expect(mockLoggerError).toHaveBeenCalledWith("42");
    expect(process.exitCode).toBe(1);
  });
});

describe("activeStoreHealth / getActiveStoreDecryptWarning — non-Error failures", () => {
  it("stringifies a non-Error decrypt failure into the health and the warning", async () => {
    mockGetActiveInstance.mockResolvedValue("dev.service-now.com");
    mockLoadCredentials.mockRejectedValue("bad tag");

    expect(await helpers.activeStoreHealth()).toEqual({
      active: "dev.service-now.com",
      decrypts: false,
      error: "bad tag",
    });
    expect(await helpers.getActiveStoreDecryptWarning()).toBe(
      'Stored credentials for "dev.service-now.com" failed to decrypt (bad tag)' +
        " — likely encrypted on a different machine or user. Re-run 'syncrona login'."
    );
  });

  it("omits the parenthesised reason when the decrypt error is blank", async () => {
    mockGetActiveInstance.mockResolvedValue("dev.service-now.com");
    mockLoadCredentials.mockRejectedValue(new Error(""));

    expect(await helpers.getActiveStoreDecryptWarning()).toBe(
      'Stored credentials for "dev.service-now.com" failed to decrypt' +
        " — likely encrypted on a different machine or user. Re-run 'syncrona login'."
    );
  });

  it("does not try to decrypt when no instance is active", async () => {
    mockGetActiveInstance.mockResolvedValue("");

    expect(await helpers.activeStoreHealth()).toEqual({ active: null, decrypts: false });
    expect(mockLoadCredentials).not.toHaveBeenCalled();
  });
});

describe("bootstrapWorkspaceOnLogin", () => {
  it("creates sync.config.js and the src directory in an empty workspace", async () => {
    const result = await helpers.bootstrapWorkspaceOnLogin();

    const cwd = process.cwd();
    expect(result).toEqual({ createdConfig: true, sourcePath: path.join(cwd, "src") });
    expect(fs.readFileSync(path.join(cwd, "sync.config.js"), "utf8")).toBe(
      'module.exports = { sourceDirectory: "src" };\n'
    );
    expect(fs.statSync(path.join(cwd, "src")).isDirectory()).toBe(true);
  });

  it("keeps an existing sync.config.js untouched", async () => {
    const cwd = process.cwd();
    fs.writeFileSync(path.join(cwd, "sync.config.js"), "// mine\n");
    fs.mkdirSync(path.join(cwd, "src"));

    const result = await helpers.bootstrapWorkspaceOnLogin();

    expect(result.createdConfig).toBe(false);
    expect(fs.readFileSync(path.join(cwd, "sync.config.js"), "utf8")).toBe("// mine\n");
  });

  it("rethrows a non-ENOENT stat failure without writing anything", async () => {
    mockFsStat.mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    );

    await expect(helpers.bootstrapWorkspaceOnLogin()).rejects.toThrow("EACCES");

    const cwd = process.cwd();
    expect(fs.existsSync(path.join(cwd, "sync.config.js"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "src"))).toBe(false);
  });
});
