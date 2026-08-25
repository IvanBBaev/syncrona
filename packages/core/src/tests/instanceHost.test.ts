// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// #20: every request URL is built as `https://${credentials.instance}/`, so the
// instance MUST be a bare host. A `.env` written by hand almost always holds
// what the browser address bar shows — `https://ven01800.service-now.com/…` —
// and that produced `https://https://ven01800.service-now.com//`, whose only
// symptom is `getaddrinfo ENOTFOUND https`. That message names a hostname the
// user never typed and points at DNS, so the actual mistake (a scheme in the
// value) is invisible; `syncrona doctor` reported the same thing.
//
// `login` already stripped a scheme and a trailing slash, which is why the
// credential store was mostly safe and the env path was not — and even `login`
// kept the PATH of a URL pasted whole out of the address bar.

jest.unstable_mockModule("axios", () => ({
  __esModule: true,
  default: { isAxiosError: () => false, create: jest.fn(() => ({})) },
}));
jest.unstable_mockModule("axios-rate-limit", () => ({
  __esModule: true,
  default: (client: unknown) => client,
}));

const loggerWarn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: jest.fn(),
    success: jest.fn(),
  },
  setLogLevel: jest.fn(),
}));

const ENV_KEYS = ["SN_USER", "SN_PASSWORD", "SN_INSTANCE"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  jest.resetModules();
  loggerWarn.mockClear();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("normalizeInstanceHost (#20)", () => {
  it.each([
    ["a bare host is unchanged", "dev12345.service-now.com", "dev12345.service-now.com"],
    ["strips https://", "https://dev12345.service-now.com", "dev12345.service-now.com"],
    ["strips http://", "http://dev12345.service-now.com", "dev12345.service-now.com"],
    ["strips a mixed-case scheme", "HtTpS://dev12345.service-now.com", "dev12345.service-now.com"],
    ["strips a trailing slash", "dev12345.service-now.com/", "dev12345.service-now.com"],
    [
      "strips the path of a URL pasted from the address bar",
      "https://dev12345.service-now.com/now/nav/ui/classic/params/target/sys_script.do",
      "dev12345.service-now.com",
    ],
    [
      "strips a query string",
      "https://dev12345.service-now.com/nav_to.do?uri=sys_script_include.do",
      "dev12345.service-now.com",
    ],
    ["trims surrounding whitespace", "  dev12345.service-now.com  ", "dev12345.service-now.com"],
    ["keeps an explicit port", "https://localhost:8080/", "localhost:8080"],
    ["leaves an empty value empty", "", ""],
  ])("%s", async (_label, input, expected) => {
    const { normalizeInstanceHost } = await import("../snClient.js");
    expect(normalizeInstanceHost(input)).toBe(expected);
  });
});

describe("resolveCredentials normalizes the instance (#20)", () => {
  it("accepts a full URL in SN_INSTANCE and reports the correction once", async () => {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_INSTANCE = "https://ven01800.service-now.com/";

    const { resolveCredentials } = await import("../snClient.js");

    expect(resolveCredentials().instance).toBe("ven01800.service-now.com");
    // Corrected, not silently accepted: the value in the user's .env is still
    // wrong, and the next tool to read it directly would fail the same way.
    const warnings = loggerWarn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("SN_INSTANCE"))).toBe(true);
    expect(warnings.some((w) => w.includes("ven01800.service-now.com"))).toBe(true);

    // Resolution runs several times per command (eight call sites, no
    // memoization) — the same dedupe rule the other credential warnings follow.
    loggerWarn.mockClear();
    resolveCredentials();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("says nothing when the instance is already a bare host", async () => {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_INSTANCE = "ven01800.service-now.com";

    const { resolveCredentials } = await import("../snClient.js");

    expect(resolveCredentials().instance).toBe("ven01800.service-now.com");
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("normalizes an instance that came from the credential store", async () => {
    // A store record can predate the normalization in `login`, or be
    // hand-edited — the URL is just as fatal from there.
    const { preloadStoredCredentials, resolveCredentials, resetAuthIssueWarnings } =
      await import("../snClient.js");
    resetAuthIssueWarnings();

    jest.resetModules();
    jest.unstable_mockModule("../auth.js", () => ({
      resolveCredentialsFromStore: async () => ({
        instance: "https://stored.service-now.com/",
        user: "u",
        password: "p",
      }),
    }));
    const snClient = await import("../snClient.js");
    await snClient.preloadStoredCredentials("https://stored.service-now.com/");

    expect(snClient.resolveCredentials().instance).toBe("stored.service-now.com");

    // Keep the direct references used so the import above is not dead weight.
    expect(typeof preloadStoredCredentials).toBe("function");
    expect(typeof resolveCredentials).toBe("function");
  });
});
