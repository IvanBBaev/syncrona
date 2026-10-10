// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// Branch edges of login / logout / instances / use that authCommands.test.ts
// leaves open: the interactive instance and per-method field prompts (and their
// validators), every optional flag reaching the .env and the encrypted store,
// stale-method env clearing, a declined active-instance switch, and the warning
// paths when the .env or the workspace bootstrap cannot be written.

const mockSaveCredentials = jest.fn();
const mockListInstances = jest.fn();
const mockRemoveCredentials = jest.fn();
const mockRemoveAllCredentials = jest.fn();
const mockSetActiveInstance = jest.fn();
const mockGetActiveInstance = jest.fn();
const mockPreloadStoredCredentials = jest.fn();
const mockClearStoredCredentialsCache = jest.fn();
const mockCheckConnection = jest.fn();
const mockResetClient = jest.fn();
const mockPrompt = jest.fn();
const mockWriteDotEnv = jest.fn();
const mockEnsureGitignored = jest.fn();
const mockBootstrap = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../auth.js", () => ({
  saveCredentials: (...a: unknown[]) => mockSaveCredentials(...a),
  listInstances: (...a: unknown[]) => mockListInstances(...a),
  removeCredentials: (...a: unknown[]) => mockRemoveCredentials(...a),
  removeAllCredentials: (...a: unknown[]) => mockRemoveAllCredentials(...a),
  setActiveInstance: (...a: unknown[]) => mockSetActiveInstance(...a),
  getActiveInstance: (...a: unknown[]) => mockGetActiveInstance(...a),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({ checkConnection: mockCheckConnection }),
  resetClient: (...a: unknown[]) => mockResetClient(...a),
  preloadStoredCredentials: (...a: unknown[]) => mockPreloadStoredCredentials(...a),
  clearStoredCredentialsCache: (...a: unknown[]) => mockClearStoredCredentialsCache(...a),
}));

jest.unstable_mockModule("../envFile.js", () => ({
  writeDotEnv: (...a: unknown[]) => mockWriteDotEnv(...a),
  ensureGitignored: (...a: unknown[]) => mockEnsureGitignored(...a),
}));

jest.unstable_mockModule("../commandHelpers.js", () => ({
  setLogLevel: jest.fn(),
  bootstrapWorkspaceOnLogin: (...a: unknown[]) => mockBootstrap(...a),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: jest.fn(),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    success: (...a: unknown[]) => mockLoggerSuccess(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...a: unknown[]) => mockPrompt(...a) },
}));

const { loginCommand, logoutCommand, instancesCommand, useCommand } = await import(
  "../authCommands.js"
);

type Question = {
  type: string;
  name: string;
  message: string;
  mask?: string;
  validate?: (v: string) => true | string;
};

const BASE_ARGS = { logLevel: "info", dryRun: false };
const HOST = "dev123.service-now.com";

// Every question the command asked, across all prompt calls, in order.
let asked: Question[] = [];

// Answer each prompted question by name from `answers`.
function answerPrompts(answers: Record<string, unknown>): void {
  mockPrompt.mockImplementation(async (...a: unknown[]) => {
    const questions = a[0] as Question[];
    asked.push(...questions);
    const out: Record<string, unknown> = {};
    for (const q of questions) {
      if (q.name in answers) out[q.name] = answers[q.name];
    }
    return out;
  });
}

function askedNames(): string[] {
  return asked.map((q) => q.name);
}

function question(name: string): Question {
  const q = asked.find((x) => x.name === name);
  if (!q) throw new Error(`question ${name} was not asked`);
  return q;
}

function writtenEnv(): Record<string, string> {
  return mockWriteDotEnv.mock.calls[0][1] as Record<string, string>;
}

let envSnapshot: NodeJS.ProcessEnv;
let exitCodeSnapshot: typeof process.exitCode;
let exitSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  asked = [];
  envSnapshot = { ...process.env };
  exitCodeSnapshot = process.exitCode;
  exitSpy = jest.spyOn(process, "exit").mockImplementation((code?: unknown) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  mockPreloadStoredCredentials.mockResolvedValue(undefined);
  mockSetActiveInstance.mockResolvedValue(undefined);
  mockGetActiveInstance.mockResolvedValue(null);
  mockSaveCredentials.mockResolvedValue(undefined);
  mockRemoveCredentials.mockResolvedValue(true);
  mockRemoveAllCredentials.mockResolvedValue(0);
  mockListInstances.mockResolvedValue([]);
  mockCheckConnection.mockResolvedValue(undefined);
  mockWriteDotEnv.mockResolvedValue(undefined);
  mockEnsureGitignored.mockResolvedValue(undefined);
  mockBootstrap.mockResolvedValue({ createdConfig: false, sourcePath: "/ws/src" });
  answerPrompts({});
});

afterEach(() => {
  exitSpy.mockRestore();
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
  process.exitCode = exitCodeSnapshot;
});

describe("loginCommand — interactive instance prompt", () => {
  it("prompts for the instance when none is given and normalizes the answer", async () => {
    answerPrompts({ instance: `https://${HOST}/now/nav/ui`, user: "admin", password: "pw" });

    await loginCommand({ ...BASE_ARGS, authMethod: "basic" });

    expect(askedNames()).toEqual(["instance", "user", "password"]);
    expect(mockSaveCredentials).toHaveBeenCalledWith(HOST, "admin", "pw");
    expect(writtenEnv().SN_INSTANCE).toBe(HOST);
  });

  it("rejects an empty or scheme-only instance answer in the prompt validator", async () => {
    answerPrompts({ instance: HOST, user: "admin", password: "pw" });

    await loginCommand({ ...BASE_ARGS, authMethod: "basic" });

    const validate = question("instance").validate!;
    expect(validate("")).toMatch(/Instance host is required/);
    expect(validate("https://")).toMatch(/Instance host is required/);
    expect(validate(HOST)).toBe(true);
  });
});

describe("loginCommand — auth-method selection and field prompts", () => {
  it("accepts --auth-method case-insensitively with surrounding whitespace", async () => {
    await loginCommand({
      ...BASE_ARGS,
      instance: HOST,
      authMethod: "  API-KEY ",
      apiKey: "K",
    });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSaveCredentials).toHaveBeenCalledWith(
      HOST,
      "",
      "",
      expect.objectContaining({ authMethod: "api-key", apiKey: "K" })
    );
  });

  it("names every valid method and exits 1 on an unknown --auth-method before prompting", async () => {
    await expect(
      loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "kerberos" })
    ).rejects.toThrow("process.exit(1)");

    expect(mockLoggerError).toHaveBeenCalledWith(
      'Unknown auth method "kerberos". Valid values: basic, oauth-password, ' +
        "oauth-client-credentials, oauth-jwt-bearer, api-key."
    );
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockCheckConnection).not.toHaveBeenCalled();
  });

  it("offers the method picker with basic as the default", async () => {
    answerPrompts({ method: "api-key", apiKey: "K" });

    await loginCommand({ ...BASE_ARGS, instance: HOST });

    const picker = mockPrompt.mock.calls[0][0] as Array<{
      name: string;
      default: string;
      choices: { value: string }[];
    }>;
    expect(picker[0].name).toBe("method");
    expect(picker[0].default).toBe("basic");
    expect(picker[0].choices.map((c) => c.value)).toEqual([
      "basic",
      "oauth-password",
      "oauth-client-credentials",
      "oauth-jwt-bearer",
      "api-key",
    ]);
  });

  it("prompts for user, password, client id and secret for the OAuth password grant", async () => {
    answerPrompts({
      user: "  admin  ",
      password: "  pw with spaces ",
      clientId: "  cid  ",
      clientSecret: " secret ",
    });

    await loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "oauth-password" });

    expect(askedNames()).toEqual(["user", "password", "clientId", "clientSecret"]);
    expect(question("password").mask).toBe("*");
    expect(question("clientSecret").mask).toBe("*");
    // Identifiers are trimmed; secrets stay verbatim.
    expect(mockSaveCredentials).toHaveBeenCalledWith(
      HOST,
      "admin",
      "  pw with spaces ",
      expect.objectContaining({
        authMethod: "oauth-password",
        clientId: "cid",
        clientSecret: " secret ",
      })
    );
    expect(writtenEnv()).toEqual(
      expect.objectContaining({
        SN_AUTH_METHOD: "oauth-password",
        SN_USER: "admin",
        SN_PASSWORD: "  pw with spaces ",
      })
    );
  });

  it("uses flags where given and prompts only for the missing jwt-bearer fields", async () => {
    answerPrompts({ clientSecret: "s3", jwtKey: "  /keys/sn.pem  " });

    await loginCommand({
      ...BASE_ARGS,
      instance: HOST,
      authMethod: "oauth-jwt-bearer",
      clientId: "cid",
    });

    expect(askedNames()).toEqual(["clientSecret", "jwtKey"]);
    expect(mockSaveCredentials).toHaveBeenCalledWith(
      HOST,
      "",
      "",
      expect.objectContaining({ clientId: "cid", clientSecret: "s3", jwtKeyPath: "/keys/sn.pem" })
    );
  });

  it("prompts for a masked API key when --api-key is absent", async () => {
    answerPrompts({ apiKey: " KEY " });

    await loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "api-key" });

    expect(askedNames()).toEqual(["apiKey"]);
    expect(question("apiKey").mask).toBe("*");
    expect(process.env.SN_API_KEY).toBe(" KEY ");
  });

  it("validators reject blank answers with a field-specific message", async () => {
    answerPrompts({ user: "u", password: "p", clientId: "c", clientSecret: "s" });

    await loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "oauth-password" });

    expect(question("user").validate!("   ")).toBe("Username is required.");
    expect(question("password").validate!("")).toBe("Password is required.");
    expect(question("clientId").validate!(" ")).toBe("Client id is required.");
    expect(question("clientSecret").validate!("")).toBe("Client secret is required.");
    expect(question("user").validate!("admin")).toBe(true);
  });

  it("validates the jwt key path and API key prompts too", async () => {
    answerPrompts({ clientId: "c", clientSecret: "s", jwtKey: "/k.pem" });
    await loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "oauth-jwt-bearer" });
    expect(question("jwtKey").validate!(" ")).toBe("JWT key path is required.");

    asked = [];
    answerPrompts({ apiKey: "K" });
    await loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "api-key" });
    expect(question("apiKey").validate!("")).toBe("API key is required.");
  });

  it("leaves a field unset when the prompt returns no answer for it", async () => {
    // A prompt that resolves without a value (answers.x == null) must not
    // store the string "undefined".
    answerPrompts({});

    await loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "basic" });

    expect(mockSaveCredentials).toHaveBeenCalledWith(HOST, "", "");
    expect(writtenEnv()).toEqual({ SN_INSTANCE: HOST });
  });
});

describe("loginCommand — optional flags reach the .env and the store", () => {
  it("persists every jwt-bearer advanced flag and uses --user as the JWT subject", async () => {
    await loginCommand({
      ...BASE_ARGS,
      instance: HOST,
      authMethod: "oauth-jwt-bearer",
      user: "  svc.user ",
      clientId: "cid",
      clientSecret: "sec",
      jwtKey: "/keys/sn.pem",
      jwtKid: " kid1 ",
      jwtIss: " iss1 ",
      jwtSub: " sub1 ",
      jwtAud: " aud1 ",
      clientCert: " /c.pem ",
      clientKey: " /c.key ",
      clientKeyPassphrase: " pass ",
      apiKeyHeader: " x-hdr ",
    });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSaveCredentials).toHaveBeenCalledWith(HOST, "svc.user", "", {
      authMethod: "oauth-jwt-bearer",
      clientId: "cid",
      clientSecret: "sec",
      apiKeyHeader: "x-hdr",
      jwtKeyPath: "/keys/sn.pem",
      jwtKid: "kid1",
      jwtIss: "iss1",
      jwtSub: "sub1",
      jwtAud: "aud1",
      clientCertPath: "/c.pem",
      clientKeyPath: "/c.key",
      clientKeyPassphrase: " pass ",
    });
    expect(writtenEnv()).toEqual({
      SN_INSTANCE: HOST,
      SN_AUTH_METHOD: "oauth-jwt-bearer",
      SN_USER: "svc.user",
      SN_OAUTH_CLIENT_ID: "cid",
      SN_OAUTH_CLIENT_SECRET: "sec",
      SN_API_KEY_HEADER: "x-hdr",
      SN_JWT_KEY: "/keys/sn.pem",
      SN_JWT_KID: "kid1",
      SN_JWT_ISS: "iss1",
      SN_JWT_SUB: "sub1",
      SN_JWT_AUD: "aud1",
      SN_CLIENT_CERT: "/c.pem",
      SN_CLIENT_KEY: "/c.key",
      SN_CLIENT_KEY_PASSPHRASE: " pass ",
    });
  });

  it("ignores --user for the client-credentials grant", async () => {
    await loginCommand({
      ...BASE_ARGS,
      instance: HOST,
      authMethod: "oauth-client-credentials",
      user: "someone",
      clientId: "cid",
      clientSecret: "sec",
    });

    expect(mockSaveCredentials).toHaveBeenCalledWith(HOST, "", "", expect.any(Object));
    expect(writtenEnv().SN_USER).toBeUndefined();
  });

  it("stores a passphrase-only basic login with the richer record", async () => {
    await loginCommand({
      ...BASE_ARGS,
      instance: HOST,
      authMethod: "basic",
      user: "admin",
      password: "pw",
      clientKeyPassphrase: "pp",
    });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSaveCredentials).toHaveBeenCalledWith(HOST, "admin", "pw", {
      authMethod: "basic",
      clientKeyPassphrase: "pp",
    });
  });

  it("writes a plain basic login to .env without SN_AUTH_METHOD and gitignores it", async () => {
    await loginCommand({
      ...BASE_ARGS,
      instance: HOST,
      authMethod: "basic",
      user: "admin",
      password: "pw",
    });

    expect(mockSaveCredentials).toHaveBeenCalledWith(HOST, "admin", "pw");
    expect(mockWriteDotEnv).toHaveBeenCalledWith(expect.stringMatching(/\.env$/), {
      SN_INSTANCE: HOST,
      SN_USER: "admin",
      SN_PASSWORD: "pw",
    });
    expect(mockEnsureGitignored).toHaveBeenCalledWith(process.cwd(), ".env");
  });

  it("clears managed env keys of a previous method before verifying the new one", async () => {
    process.env.SN_USER = "old-user";
    process.env.SN_PASSWORD = "old-pw";
    process.env.SN_AUTH_METHOD = "basic";
    process.env.SN_CLIENT_CERT = "/old/cert.pem";
    let envAtCheck: Record<string, string | undefined> = {};
    mockCheckConnection.mockImplementation(async () => {
      envAtCheck = {
        SN_USER: process.env.SN_USER,
        SN_PASSWORD: process.env.SN_PASSWORD,
        SN_CLIENT_CERT: process.env.SN_CLIENT_CERT,
        SN_API_KEY: process.env.SN_API_KEY,
        SN_AUTH_METHOD: process.env.SN_AUTH_METHOD,
      };
    });

    await loginCommand({ ...BASE_ARGS, instance: HOST, authMethod: "api-key", apiKey: "K" });

    expect(mockResetClient).toHaveBeenCalled();
    expect(mockCheckConnection).toHaveBeenCalledWith(8000);
    expect(envAtCheck).toEqual({
      SN_USER: undefined,
      SN_PASSWORD: undefined,
      SN_CLIENT_CERT: undefined,
      SN_API_KEY: "K",
      SN_AUTH_METHOD: "api-key",
    });
  });
});

describe("loginCommand — post-verification paths", () => {
  const apiKeyLogin = { ...BASE_ARGS, instance: HOST, authMethod: "api-key", apiKey: "K" };

  it("still saves credentials and warns when the .env cannot be written", async () => {
    mockWriteDotEnv.mockRejectedValue(new Error("EACCES: .env"));

    await loginCommand(apiKeyLogin);

    expect(mockSaveCredentials).toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith("Logged in, but failed to write .env: EACCES: .env");
    expect(mockEnsureGitignored).not.toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith(
      `Logged in to ${HOST} and set as active instance.`
    );
  });

  it("stringifies a non-Error .env failure in the warning", async () => {
    mockEnsureGitignored.mockRejectedValue("gitignore locked");

    await loginCommand(apiKeyLogin);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Logged in, but failed to write .env: gitignore locked"
    );
  });

  // The switch prompt is asked only on an interactive terminal.
  describe("on an interactive terminal", () => {
    let isTTYDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true, writable: true });
    });

    afterEach(() => {
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    });

    it("keeps the current active instance when the switch is declined", async () => {
      mockGetActiveInstance.mockResolvedValue("prod.service-now.com");
      answerPrompts({ switchActive: false });

      await loginCommand(apiKeyLogin);

      expect(question("switchActive").message).toContain("(current: prod.service-now.com)");
      expect(mockSetActiveInstance).not.toHaveBeenCalled();
      expect(mockLoggerSuccess).toHaveBeenCalledWith(`Logged in to ${HOST}.`);
      expect(mockLoggerSuccess).not.toHaveBeenCalledWith(
        expect.stringContaining("Active instance switched")
      );
    });

    it("announces the switch and preloads the new instance when accepted", async () => {
      mockGetActiveInstance.mockResolvedValue("prod.service-now.com");
      answerPrompts({ switchActive: true });

      await loginCommand(apiKeyLogin);

      expect(mockSetActiveInstance).toHaveBeenCalledWith(HOST);
      expect(mockLoggerSuccess).toHaveBeenCalledWith(`Active instance switched to ${HOST}.`);
      expect(mockPreloadStoredCredentials).toHaveBeenCalledTimes(2);
    });
  });

  it("reports the created sync.config.js and the source directory", async () => {
    mockBootstrap.mockResolvedValue({ createdConfig: true, sourcePath: "/ws/src" });

    await loginCommand(apiKeyLogin);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      `Created default sync.config.js in ${process.cwd()}.`
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Workspace structure ready. Source directory: /ws/src"
    );
    expect(mockLoggerInfo).toHaveBeenLastCalledWith(
      "Run `syncrona init` to discover scope and generate sync.manifest.json."
    );
  });

  it("does not claim a created config when sync.config.js already existed", async () => {
    await loginCommand(apiKeyLogin);

    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("Created default sync.config.js")
    );
  });

  it("warns with the error message when the workspace bootstrap fails", async () => {
    mockBootstrap.mockRejectedValue(new Error("EROFS: read-only file system"));

    await loginCommand(apiKeyLogin);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Logged in, but failed to prepare workspace structure: EROFS: read-only file system"
    );
    expect(mockLoggerInfo).toHaveBeenLastCalledWith(
      "Run `syncrona init` to discover scope and generate sync.manifest.json."
    );
    expect(process.exitCode).toBe(exitCodeSnapshot);
  });

  it.each([
    ["an Error with a blank message", new Error("   ")],
    ["a non-Error rejection", "boom"],
  ])("falls back to 'Unknown error' for %s", async (_label, failure) => {
    mockBootstrap.mockRejectedValue(failure);

    await loginCommand(apiKeyLogin);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Logged in, but failed to prepare workspace structure: Unknown error"
    );
  });
});

describe("logoutCommand — branch edges", () => {
  it("clears the active marker when the active instance was the last one", async () => {
    mockGetActiveInstance.mockResolvedValue(HOST);
    mockListInstances.mockResolvedValue([]);

    await logoutCommand({ ...BASE_ARGS, instance: HOST });

    expect(mockSetActiveInstance).toHaveBeenCalledWith("");
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("Active instance reset")
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith(`Logged out from ${HOST}.`);
  });

  it("leaves the active marker alone when logging out a non-active instance", async () => {
    mockGetActiveInstance.mockResolvedValue("prod.service-now.com");

    await logoutCommand({ ...BASE_ARGS, instance: `  https://${HOST}/ ` });

    expect(mockRemoveCredentials).toHaveBeenCalledWith(HOST);
    expect(mockListInstances).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error removal failure and exits 1", async () => {
    mockRemoveCredentials.mockRejectedValue("locked");

    await logoutCommand({ ...BASE_ARGS, instance: HOST });

    expect(mockLoggerError).toHaveBeenCalledWith(
      `Could not remove credentials for ${HOST}: locked`
    );
    expect(mockClearStoredCredentialsCache).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("clears the cache and reports a non-Error --all failure", async () => {
    mockRemoveAllCredentials.mockRejectedValue("disk gone");

    await logoutCommand({ ...BASE_ARGS, all: true });

    expect(mockClearStoredCredentialsCache).toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith("disk gone");
    expect(process.exitCode).toBe(1);
  });

  it("clears the active marker after a successful --all", async () => {
    mockRemoveAllCredentials.mockResolvedValue(0);

    await logoutCommand({ ...BASE_ARGS, all: true, instance: HOST });

    // --all wins over a positional instance.
    expect(mockRemoveCredentials).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).toHaveBeenCalledWith("");
    expect(mockLoggerSuccess).toHaveBeenCalledWith("Removed credentials for 0 instance(s).");
  });

  it("exits 1 with a usage example when neither an instance nor --all is given", async () => {
    await expect(logoutCommand({ ...BASE_ARGS })).rejects.toThrow("process.exit(1)");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Example: syncrona logout dev12345.service-now.com"
    );
    expect(mockRemoveCredentials).not.toHaveBeenCalled();
  });
});

describe("instancesCommand / useCommand — branch edges", () => {
  it("marks only the active instance", async () => {
    mockListInstances.mockResolvedValue(["a.service-now.com", "b.service-now.com"]);
    mockGetActiveInstance.mockResolvedValue("b.service-now.com");

    await instancesCommand(BASE_ARGS);

    expect(mockLoggerInfo.mock.calls.map((c) => c[0])).toEqual([
      "Saved instances:",
      "  a.service-now.com",
      "  b.service-now.com (active)",
    ]);
  });

  it("refuses an unknown instance with a login hint and does not change the marker", async () => {
    mockListInstances.mockResolvedValue(["a.service-now.com"]);

    await expect(
      useCommand({ ...BASE_ARGS, instance: ` https://${HOST}/ ` })
    ).rejects.toThrow("process.exit(1)");

    expect(mockLoggerError).toHaveBeenCalledWith(
      `No saved credentials for "${HOST}". Run: syncrona login ${HOST}`
    );
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });
});
