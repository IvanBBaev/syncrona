// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// status and doctor used to demand SN_USER + SN_PASSWORD from every
// configuration, regardless of how it actually authenticates. That is only the
// Basic shape: api-key identifies the caller by a token, and the OAuth
// client-credentials / JWT-bearer grants identify it by a client id — none of
// them has an SN_PASSWORD to offer. A fully working instance of any of those
// was therefore reported "Environment Ready: no" and `doctor` exited non-zero,
// while the connectivity check that would have disproved it was skipped.
//
// The verdict now comes from sn-transport's own resolveAuthMethod — the
// function the client uses to pick a method — so the report cannot drift away
// from what the transport does. resolveAuthMethod is deliberately NOT mocked
// here: a stub would let the two drift apart again without failing this suite.

const mockSetLogLevel = jest.fn();
const mockLogScopedEndpointCapability = jest.fn();
const mockGetActiveStoreDecryptWarning = jest.fn();

const mockGetConfig = jest.fn();
const mockCheckConfigPath = jest.fn();
const mockGetSourcePath = jest.fn();
const mockGetBuildPath = jest.fn();
const mockGetManifestPath = jest.fn();
const mockGetManifest = jest.fn();
const mockGetRootDir = jest.fn();
const mockGetDefaultConfig = jest.fn();

const mockCheckConnection = jest.fn();
const mockGetCurrentScope = jest.fn();
const mockResolveCredentials = jest.fn();
const mockDescribeCredentialSource = jest.fn();
const mockDiagnoseCredentials = jest.fn();
const mockUnwrapSNResponse = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    silly: jest.fn(),
  },
}));

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  checkConfigPath: (...a: unknown[]) => mockCheckConfigPath(...a),
  getSourcePath: (...a: unknown[]) => mockGetSourcePath(...a),
  getBuildPath: (...a: unknown[]) => mockGetBuildPath(...a),
  getManifestPath: (...a: unknown[]) => mockGetManifestPath(...a),
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getRootDir: (...a: unknown[]) => mockGetRootDir(...a),
  getDefaultConfig: (...a: unknown[]) => mockGetDefaultConfig(...a),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({
    checkConnection: (...a: unknown[]) => mockCheckConnection(...a),
    getCurrentScope: (...a: unknown[]) => mockGetCurrentScope(...a),
  }),
  resolveCredentials: (...a: unknown[]) => mockResolveCredentials(...a),
  describeCredentialSource: (...a: unknown[]) => mockDescribeCredentialSource(...a),
  diagnoseCredentials: (...a: unknown[]) => mockDiagnoseCredentials(...a),
  unwrapSNResponse: (...a: unknown[]) => mockUnwrapSNResponse(...a),
}));

jest.unstable_mockModule("../auth.js", () => ({ listInstances: jest.fn() }));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  isScopedEndpointUnavailableError: () => false,
}));

jest.unstable_mockModule("../commandHelpers.js", () => ({
  setLogLevel: (...a: unknown[]) => mockSetLogLevel(...a),
  logScopedEndpointCapability: (...a: unknown[]) => mockLogScopedEndpointCapability(...a),
  activeStoreHealth: jest.fn(),
  getActiveStoreDecryptWarning: (...a: unknown[]) => mockGetActiveStoreDecryptWarning(...a),
}));

let statusCommand: typeof import("../diagnosticsCommands.js").statusCommand;
let doctorCommand: typeof import("../diagnosticsCommands.js").doctorCommand;

const ARGS = { logLevel: "info" } as never;

/** A credential set that authenticates, minus the user/password Basic needs. */
const INSTANCE = { instance: "dev.service-now.com" };

beforeEach(async () => {
  jest.clearAllMocks();
  ({ statusCommand, doctorCommand } = await import("../diagnosticsCommands.js"));
  mockGetConfig.mockReturnValue({ includes: {}, excludes: {}, rules: [] });
  mockCheckConfigPath.mockReturnValue("/proj/sync.config.js");
  mockGetSourcePath.mockReturnValue("/proj/src");
  mockGetBuildPath.mockReturnValue("/proj/build");
  mockGetManifestPath.mockReturnValue("/proj/sync.manifest.json");
  mockGetManifest.mockReturnValue({ scope: "x_scope" });
  mockGetRootDir.mockReturnValue("/proj");
  mockDescribeCredentialSource.mockReturnValue("environment (.env / shell SN_* vars)");
  mockCheckConnection.mockResolvedValue(undefined);
  mockGetCurrentScope.mockResolvedValue({ scope: "x_scope" });
  mockUnwrapSNResponse.mockImplementation((p: unknown) => p);
  mockGetActiveStoreDecryptWarning.mockResolvedValue(null);
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

const doctorCheck = (
  checks: { name: string; ok: boolean; details: string }[],
  name: string
) => {
  const found = checks.find((c) => c.name === name);
  if (!found) {
    throw new Error(`doctor reported no "${name}" check`);
  }
  return found;
};

// Each of these is a complete, working configuration for the method it names.
const COMPLETE: { label: string; credentials: Record<string, string> }[] = [
  {
    label: "api-key",
    credentials: { ...INSTANCE, authMethod: "api-key", apiKey: "k" },
  },
  {
    label: "oauth-client-credentials",
    credentials: {
      ...INSTANCE,
      authMethod: "oauth-client-credentials",
      clientId: "id",
      clientSecret: "secret",
    },
  },
  {
    label: "oauth-jwt-bearer",
    credentials: {
      ...INSTANCE,
      authMethod: "oauth-jwt-bearer",
      clientId: "id",
      clientSecret: "secret",
      jwtKey: "-----BEGIN PRIVATE KEY-----",
    },
  },
];

describe("statusCommand credential readiness per auth method", () => {
  it.each(COMPLETE)(
    "reports a complete $label configuration as ready and checks connectivity",
    async ({ credentials }) => {
      mockResolveCredentials.mockReturnValue(credentials);

      const summary = await statusCommand(ARGS);

      expect(summary.envReady).toBe(true);
      expect(summary.errors).toEqual([]);
      expect(mockCheckConnection).toHaveBeenCalled();
      expect(summary.connectivityOk).toBe(true);
      expect(summary.ok).toBe(true);
    }
  );

  it("still names the variable an incomplete api-key configuration is missing", async () => {
    mockResolveCredentials.mockReturnValue({ ...INSTANCE, authMethod: "api-key" });

    const summary = await statusCommand(ARGS);

    expect(summary.envReady).toBe(false);
    expect(summary.errors).toContainEqual(
      "Missing environment variables: SN_API_KEY"
    );
    expect(mockCheckConnection).not.toHaveBeenCalled();
  });

  it("keeps demanding SN_USER and SN_PASSWORD for basic auth", async () => {
    mockResolveCredentials.mockReturnValue({ ...INSTANCE });

    const summary = await statusCommand(ARGS);

    expect(summary.envReady).toBe(false);
    expect(summary.errors).toContainEqual(
      "Missing environment variables: SN_USER, SN_PASSWORD"
    );
  });

  it("keeps demanding SN_USER for the oauth password grant, which logs in AS a user", async () => {
    mockResolveCredentials.mockReturnValue({
      ...INSTANCE,
      authMethod: "oauth-password",
      clientId: "id",
      clientSecret: "secret",
      password: "pw",
    });

    const summary = await statusCommand(ARGS);

    expect(summary.envReady).toBe(false);
    expect(summary.errors).toContainEqual("Missing environment variables: SN_USER");
  });

  it("reports an entirely unconfigured environment as unconfigured", async () => {
    mockResolveCredentials.mockReturnValue({});

    const summary = await statusCommand(ARGS);

    expect(summary.envReady).toBe(false);
    expect(summary.errors).toContainEqual(
      "Missing environment variables: SN_INSTANCE, SN_USER, SN_PASSWORD"
    );
  });
});

describe("doctorCommand credential readiness per auth method", () => {
  it.each(COMPLETE)(
    "passes the env check and reaches connectivity for a complete $label configuration",
    async ({ credentials }) => {
      mockResolveCredentials.mockReturnValue(credentials);

      const report = await doctorCommand(ARGS);

      expect(doctorCheck(report.checks, "env").ok).toBe(true);
      expect(doctorCheck(report.checks, "connectivity").ok).toBe(true);
      expect(process.exitCode).toBe(0);
    }
  );

  it("still fails the env check when the chosen method's secret is absent", async () => {
    mockResolveCredentials.mockReturnValue({
      ...INSTANCE,
      authMethod: "oauth-jwt-bearer",
      clientId: "id",
    });

    const report = await doctorCommand(ARGS);

    const env = doctorCheck(report.checks, "env");
    expect(env.ok).toBe(false);
    expect(env.details).toBe(
      "Missing environment variables: SN_OAUTH_CLIENT_SECRET, SN_JWT_KEY"
    );
    expect(doctorCheck(report.checks, "connectivity").ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
