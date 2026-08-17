// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";

export {};

// ROADMAP "Second look: profile fallback to the base instance": when the user
// NAMES a profile and that profile defines no instance, credential resolution
// falls back to the base SN_INSTANCE by design (a credentials-only profile that
// inherits the base target is legitimate, so a hard error is off the table).
// This suite pins the loud warning that replaces the former silence: it fires
// exactly in the fallback case, names the profile, the fallback target and the
// env var that silences it — and stays quiet for every configuration in which
// nothing surprising happens.

const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn(),
  },
}));

jest.unstable_mockModule("../auth.js", () => ({
  resolveCredentialsFromStore: jest.fn(),
}));

let snClient: typeof import("../snClient.js");

beforeAll(async () => {
  snClient = await import("../snClient.js");
});

// Every SN_* variable is cleared, not just the ones each test sets: an ambient
// SN_AUTH_METHOD (or a leftover profile var) would add unrelated warn calls and
// break the exact-count assertions below.
const savedSnEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) {
      savedSnEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  snClient.setActiveInstanceProfile(undefined);
  snClient.clearStoredCredentialsCache();
  snClient.resetAuthIssueWarnings();
  snClient.resetProfileFallbackWarnings();
});

afterEach(() => {
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
});

function setBaseEnv(): void {
  process.env.SN_USER = "admin";
  process.env.SN_PASSWORD = "pw";
  process.env.SN_INSTANCE = "base.service-now.com";
}

describe("profile instance fallback warning", () => {
  it("warns loudly when an explicitly selected profile defines no instance", () => {
    setBaseEnv();
    process.env.SN_USER_QA = "qa-admin";
    process.env.SN_PASSWORD_QA = "qa-pw";

    const creds = snClient.resolveCredentials("qa");

    expect(creds.instance).toBe("base.service-now.com");
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const line = String(mockLoggerWarn.mock.calls[0]?.[0]);
    expect(line).toContain('Instance profile "QA" defines no instance');
    expect(line).toContain("SN_INSTANCE_QA is not set");
    expect(line).toContain('falling back to the base SN_INSTANCE "base.service-now.com"');
    expect(line).toContain("set SN_INSTANCE_QA");
  });

  it("fires for a profile selected via setActiveInstanceProfile (--instance-profile)", () => {
    setBaseEnv();
    snClient.setActiveInstanceProfile("qa");

    const creds = snClient.resolveCredentials();

    expect(creds.instance).toBe("base.service-now.com");
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerWarn.mock.calls[0]?.[0])).toContain('Instance profile "QA"');
  });

  it("warns only once even though credentials resolve on every command", () => {
    setBaseEnv();

    snClient.resolveCredentials("qa");
    snClient.resolveCredentials("qa");
    snClient.describeCredentialSource("qa");

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the profile defines its own instance", () => {
    setBaseEnv();
    process.env.SN_INSTANCE_QA = "qa.service-now.com";

    const creds = snClient.resolveCredentials("qa");

    expect(creds.instance).toBe("qa.service-now.com");
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("stays silent when no profile is selected", () => {
    setBaseEnv();

    const creds = snClient.resolveCredentials();

    expect(creds.instance).toBe("base.service-now.com");
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("stays silent when there is no base instance to fall back to", () => {
    // A profile with no instance anywhere resolves to an empty instance, which
    // announces itself on the first request — nothing silent to warn about.
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "pw";

    const creds = snClient.resolveCredentials("qa");

    expect(creds.instance).toBe("");
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});
