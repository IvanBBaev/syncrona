// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import os from "os";
import path from "path";

// Mirrors @syncro-now-ai/sn-transport's CA_BUNDLE_ENV / TLS_REJECT_UNAUTHORIZED_ENV
// (kept inline so the test file stays a leaf with no workspace-package imports).
const CA_BUNDLE_ENV = "SYNCRONA_CA_BUNDLE";
const TLS_REJECT_UNAUTHORIZED_ENV = "SYNCRONA_TLS_REJECT_UNAUTHORIZED";

// Exercises the snClient request wrappers (endpoint + params), the scoped-
// endpoint rethrow, the OAuth 401 refresh interceptor, the response unwrap
// helpers, and the credential-cache / active-profile accessors — all offline
// against a mocked axios instance.

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockPatch = jest.fn();
const mockRequest = jest.fn();

type InterceptorRefs = {
  request?: (cfg: unknown) => unknown;
  responseError?: (err: unknown) => unknown;
};
const mockInterceptors: InterceptorRefs = {};

const mockGetToken = jest.fn();
const mockForceRefresh = jest.fn();
const mockResolveStore = jest.fn();

const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    isAxiosError: (value: unknown) => {
      const candidate = value as { response?: unknown } | null;
      return Boolean(candidate && typeof candidate === "object" && "response" in candidate);
    },
    create: jest.fn(() => ({
      get: mockGet,
      post: mockPost,
      put: mockPut,
      patch: mockPatch,
      request: mockRequest,
      interceptors: {
        request: { use: (fn: (cfg: unknown) => unknown) => { mockInterceptors.request = fn; } },
        response: {
          use: (_ok: unknown, errFn: (err: unknown) => unknown) => {
            mockInterceptors.responseError = errFn;
          },
        },
      },
    })),
  },
}));

jest.mock("axios-rate-limit", () => ({
  __esModule: true,
  default: (client: unknown) => client,
}));

jest.mock("../oauth", () => ({
  createTokenManager: () => ({ getToken: mockGetToken, forceRefresh: mockForceRefresh }),
}));

jest.mock("../auth", () => ({
  resolveCredentialsFromStore: (...a: unknown[]) => mockResolveStore(...a),
}));

jest.mock("../Logger", () => ({
  logger: {
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    info: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn(),
  },
}));

const okResult = (result: unknown) => ({ status: 200, data: { result } });

const ENV_KEYS = [
  "SN_USER",
  "SN_PASSWORD",
  "SN_INSTANCE",
  "SN_OAUTH_CLIENT_ID",
  "SN_OAUTH_CLIENT_SECRET",
] as const;

describe("snClient request wrappers", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    mockGet.mockResolvedValue(okResult([]));
    mockPost.mockResolvedValue(okResult({}));
    mockPut.mockResolvedValue({ status: 200, data: {} });
    mockPatch.mockResolvedValue({ status: 200, data: {} });
    mockRequest.mockResolvedValue({ status: 200, data: {} });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    }
  });

  const makeClient = async () => {
    const { snClient, resetClient } = await import("../snClient");
    resetClient();
    return snClient("https://example.service-now.com/", "u", "p");
  };

  it("getAppList hits the scoped getAppList endpoint", async () => {
    const client = await makeClient();
    await client.getAppList();
    expect(mockGet).toHaveBeenCalledWith("api/x_nuvo_sinc/sinc/getAppList", undefined);
  });

  it("getScopeId queries sys_scope by scope name", async () => {
    const client = await makeClient();
    await client.getScopeId("x_acme_app");
    expect(mockGet).toHaveBeenCalledWith("api/now/table/sys_scope", {
      params: { sysparm_query: "scope=x_acme_app", sysparm_fields: "sys_id" },
    });
  });

  it("getUserSysId queries sys_user by user name", async () => {
    const client = await makeClient();
    await client.getUserSysId("admin");
    expect(mockGet).toHaveBeenCalledWith("api/now/table/sys_user", {
      params: { sysparm_query: "user_name=admin", sysparm_fields: "sys_id" },
    });
  });

  it("getCurrentAppUserPrefSysId queries the apps.current_app preference", async () => {
    const client = await makeClient();
    await client.getCurrentAppUserPrefSysId("user-1");
    expect(mockGet).toHaveBeenCalledWith("api/now/table/sys_user_preference", {
      params: { sysparm_query: "user=user-1^name=apps.current_app", sysparm_fields: "sys_id" },
    });
  });

  it("updateCurrentAppUserPref PUTs the new app value", async () => {
    const client = await makeClient();
    await client.updateCurrentAppUserPref("app-9", "pref-3");
    expect(mockPut).toHaveBeenCalledWith("api/now/table/sys_user_preference/pref-3", {
      value: "app-9",
    });
  });

  it("createCurrentAppUserPref POSTs a new preference row", async () => {
    const client = await makeClient();
    await client.createCurrentAppUserPref("app-9", "user-1");
    expect(mockPost).toHaveBeenCalledWith("api/now/table/sys_user_preference", {
      value: "app-9",
      name: "apps.current_app",
      type: "string",
      user: "user-1",
    });
  });

  it("getCurrentScope hits the scoped getCurrentScope endpoint", async () => {
    const client = await makeClient();
    await client.getCurrentScope();
    expect(mockGet).toHaveBeenCalledWith("api/x_nuvo_sinc/sinc/getCurrentScope", undefined);
  });

  it("createUpdateSet POSTs a named update set", async () => {
    const client = await makeClient();
    await client.createUpdateSet("My Set");
    expect(mockPost).toHaveBeenCalledWith("api/now/table/sys_update_set", { name: "My Set" });
  });

  it("getCurrentUpdateSetUserPref queries the sys_update_set preference", async () => {
    const client = await makeClient();
    await client.getCurrentUpdateSetUserPref("user-1");
    expect(mockGet).toHaveBeenCalledWith("api/now/table/sys_user_preference", {
      params: { sysparm_query: "user=user-1^name=sys_update_set", sysparm_fields: "sys_id" },
    });
  });

  it("updateCurrentUpdateSetUserPref PUTs the new update set value", async () => {
    const client = await makeClient();
    await client.updateCurrentUpdateSetUserPref("set-2", "pref-7");
    expect(mockPut).toHaveBeenCalledWith("api/now/table/sys_user_preference/pref-7", {
      value: "set-2",
    });
  });

  it("getMissingFiles POSTs the scoped bulkDownload endpoint", async () => {
    const client = await makeClient();
    await client.getMissingFiles({} as never, {} as never);
    expect(mockPost).toHaveBeenCalledWith("api/x_nuvo_sinc/sinc/bulkDownload", {
      missingFiles: {},
      tableOptions: {},
    });
  });

  it("getManifest POSTs the scoped getManifest endpoint with config payload", async () => {
    const client = await makeClient();
    await client.getManifest("x_acme_app", { includes: { a: 1 } } as never, true);
    expect(mockPost).toHaveBeenCalledWith("api/x_nuvo_sinc/sinc/getManifest/x_acme_app", {
      includes: { a: 1 },
      excludes: {},
      tableOptions: {},
      withFiles: true,
    });
  });

  it("tableAPIGet includes a sysparm_offset only when offset > 0", async () => {
    const client = await makeClient();
    await client.tableAPIGet("sys_script", "active=true", "sys_id", 100, 50);
    expect(mockGet).toHaveBeenCalledWith("api/now/table/sys_script", {
      params: {
        sysparm_query: "active=true",
        sysparm_fields: "sys_id",
        sysparm_limit: "100",
        sysparm_offset: "50",
      },
    });
  });

  it("updateRecord PATCHes the record for non-ATF tables", async () => {
    const client = await makeClient();
    await client.updateRecord("sys_script", "rec-1", { script: "x" });
    expect(mockPatch).toHaveBeenCalledWith("api/now/table/sys_script/rec-1", { script: "x" });
  });

  it("requestScopedEndpoint rethrows immediately on a non-404 error", async () => {
    const client = await makeClient();
    mockGet.mockReset();
    mockGet.mockRejectedValue({ response: { status: 500 } });
    await expect(client.getAppList()).rejects.toEqual({ response: { status: 500 } });
    expect(mockGet).toHaveBeenCalledTimes(1); // did not try further prefixes
  });

  it("checkConnection rethrows a non-404 scoped error instead of falling back", async () => {
    const client = await makeClient();
    mockGet.mockReset();
    mockGet.mockRejectedValue({ response: { status: 500 } });
    await expect(client.checkConnection(1000)).rejects.toEqual({ response: { status: 500 } });
  });
});

describe("isRetryableRequestError", () => {
  it("retries when there is no HTTP response (network error)", async () => {
    const { isRetryableRequestError } = await import("../snClient");
    expect(isRetryableRequestError(new Error("ECONNRESET"))).toBe(true);
  });

  it("delegates to the shared retry-status policy for HTTP errors", async () => {
    const { isRetryableRequestError } = await import("../snClient");
    expect(isRetryableRequestError({ response: { status: 503 } })).toBe(true);
    expect(isRetryableRequestError({ response: { status: 404 } })).toBe(false);
  });
});

describe("snClient OAuth refresh interceptor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetToken.mockResolvedValue("access-token");
    mockForceRefresh.mockResolvedValue("refreshed-token");
    mockRequest.mockResolvedValue({ status: 200, data: { result: {} } });
  });

  it("attaches a Bearer token on request and refreshes once on a 401", async () => {
    const { snClient, resetClient } = await import("../snClient");
    resetClient();
    snClient("https://example.service-now.com/", "u", "p", {
      clientId: "cid",
      clientSecret: "secret",
    });

    const cfg = await mockInterceptors.request?.({ headers: {} as Record<string, string> });
    expect((cfg as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer access-token"
    );

    const retryCfg = { headers: {} as Record<string, string> };
    await mockInterceptors.responseError?.({ response: { status: 401 }, config: retryCfg });
    expect(mockForceRefresh).toHaveBeenCalledTimes(1);
    expect(retryCfg.headers.Authorization).toBe("Bearer refreshed-token");
    expect(mockRequest).toHaveBeenCalledWith(retryCfg);
  });

  it("rejects a non-401 response without refreshing", async () => {
    const { snClient, resetClient } = await import("../snClient");
    resetClient();
    snClient("https://example.service-now.com/", "u", "p", {
      clientId: "cid",
      clientSecret: "secret",
    });

    const err = { response: { status: 500 }, config: { headers: {} } };
    await expect(mockInterceptors.responseError?.(err)).rejects.toBe(err);
    expect(mockForceRefresh).not.toHaveBeenCalled();
  });
});

describe("snClient response unwrap helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("unwrapSNResponse returns the result payload", async () => {
    const { unwrapSNResponse } = await import("../snClient");
    const out = await unwrapSNResponse(
      Promise.resolve({ data: { result: { scope: "x_app" } } }) as never
    );
    expect(out).toEqual({ scope: "x_app" });
  });

  it("unwrapSNResponse logs and rethrows on an unexpected (non-404) error", async () => {
    const { unwrapSNResponse } = await import("../snClient");
    const err = { response: { status: 500 }, message: "boom" };
    await expect(
      unwrapSNResponse(Promise.reject(err) as never)
    ).rejects.toBe(err);
    expect(mockLoggerError).toHaveBeenCalledWith("Error processing server response");
  });

  it("unwrapSNResponse stays quiet on an expected 404 fallback", async () => {
    const { unwrapSNResponse } = await import("../snClient");
    const err = { response: { status: 404 } };
    await expect(unwrapSNResponse(Promise.reject(err) as never)).rejects.toBe(err);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("unwrapTableAPIFirstItem returns the first row or an extracted field", async () => {
    const { unwrapTableAPIFirstItem } = await import("../snClient");
    const rows = [{ sys_id: "1", name: "A" }];
    await expect(
      unwrapTableAPIFirstItem(Promise.resolve({ data: { result: rows } }) as never)
    ).resolves.toEqual({ sys_id: "1", name: "A" });
    await expect(
      unwrapTableAPIFirstItem(Promise.resolve({ data: { result: rows } }) as never, "sys_id")
    ).resolves.toBe("1");
  });

  it("unwrapTableAPIFirstItem throws on an empty result", async () => {
    const { unwrapTableAPIFirstItem } = await import("../snClient");
    await expect(
      unwrapTableAPIFirstItem(Promise.resolve({ data: { result: [] } }) as never)
    ).rejects.toThrow("Response was not a populated array!");
  });

  it("unwrapTableAPIFirstItemOrEmpty returns '' on empty and the field otherwise", async () => {
    const { unwrapTableAPIFirstItemOrEmpty } = await import("../snClient");
    await expect(
      unwrapTableAPIFirstItemOrEmpty(Promise.resolve({ data: { result: [] } }) as never, "sys_id")
    ).resolves.toBe("");
    await expect(
      unwrapTableAPIFirstItemOrEmpty(
        Promise.resolve({ data: { result: [{ sys_id: "42" }] } }) as never,
        "sys_id"
      )
    ).resolves.toBe("42");
  });
});

describe("snClient credential cache and active profile", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    }
  });

  it("preloadStoredCredentials feeds resolveCredentials and clear empties it again", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    mockResolveStore.mockResolvedValue({
      user: "store.user",
      password: "store.pass",
      instance: "store.service-now.com",
    });
    const {
      preloadStoredCredentials,
      clearStoredCredentialsCache,
      resolveCredentials,
      describeCredentialSource,
      setActiveInstanceProfile,
    } = await import("../snClient");
    setActiveInstanceProfile(undefined);

    await preloadStoredCredentials();
    expect(resolveCredentials().user).toBe("store.user");
    expect(describeCredentialSource()).toBe("credential store (syncro-now-ai login)");

    clearStoredCredentialsCache();
    expect(resolveCredentials().user).toBe("");
  });

  it("setActiveInstanceProfile normalizes and getActiveInstanceProfile reads it back", async () => {
    const { setActiveInstanceProfile, getActiveInstanceProfile } = await import("../snClient");
    setActiveInstanceProfile("dev-instance");
    expect(getActiveInstanceProfile()).toBe("DEV_INSTANCE");
    setActiveInstanceProfile(undefined);
    expect(getActiveInstanceProfile()).toBeUndefined();
  });

  it("diagnoseCredentials reports base and profile env presence", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.SN_USER = "base.user";
    process.env.SN_INSTANCE = "base.service-now.com";
    process.env.SN_USER_DEV = "dev.user";
    process.env.SN_INSTANCE_DEV = "dev.service-now.com";
    const { diagnoseCredentials } = await import("../snClient");

    const diag = diagnoseCredentials("dev");
    expect(diag.profile).toBe("DEV");
    expect(diag.baseEnvPresent.user).toBe(true);
    expect(diag.baseEnvPresent.password).toBe(false);
    expect(diag.profileEnvPresent?.user).toBe(true);
    expect(diag.resolvedUser).toBe("dev.user");
    expect(diag.source).toBe("instance profile env vars");

    delete process.env.SN_USER_DEV;
    delete process.env.SN_INSTANCE_DEV;
  });
});

describe("buildHttpsAgent", () => {
  const savedCa = process.env[CA_BUNDLE_ENV];
  const savedReject = process.env[TLS_REJECT_UNAUTHORIZED_ENV];
  let caFile: string;

  beforeEach(() => {
    jest.clearAllMocks();
    caFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-ca-")), "ca.pem");
    fs.writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  });

  afterEach(() => {
    if (savedCa === undefined) delete process.env[CA_BUNDLE_ENV];
    else process.env[CA_BUNDLE_ENV] = savedCa;
    if (savedReject === undefined) delete process.env[TLS_REJECT_UNAUTHORIZED_ENV];
    else process.env[TLS_REJECT_UNAUTHORIZED_ENV] = savedReject;
    fs.rmSync(path.dirname(caFile), { recursive: true, force: true });
  });

  it("returns undefined when no custom TLS policy is configured", async () => {
    delete process.env[CA_BUNDLE_ENV];
    delete process.env[TLS_REJECT_UNAUTHORIZED_ENV];
    const { buildHttpsAgent } = await import("../snClient");
    expect(buildHttpsAgent()).toBeUndefined();
  });

  it("builds an agent loaded with the configured CA bundle", async () => {
    process.env[CA_BUNDLE_ENV] = caFile;
    delete process.env[TLS_REJECT_UNAUTHORIZED_ENV];
    const { buildHttpsAgent } = await import("../snClient");
    const agent = buildHttpsAgent();
    expect(agent).toBeDefined();
    expect(agent?.options.ca).toBeInstanceOf(Buffer);
  });

  it("warns when the CA bundle cannot be read", async () => {
    process.env[CA_BUNDLE_ENV] = path.join(path.dirname(caFile), "missing.pem");
    const { buildHttpsAgent } = await import("../snClient");
    expect(buildHttpsAgent()).toBeDefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read CA bundle")
    );
  });

  it("warns and disables verification when TLS rejection is turned off", async () => {
    delete process.env[CA_BUNDLE_ENV];
    process.env[TLS_REJECT_UNAUTHORIZED_ENV] = "0";
    const { buildHttpsAgent } = await import("../snClient");
    const agent = buildHttpsAgent();
    expect(agent?.options.rejectUnauthorized).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("TLS certificate verification is DISABLED")
    );
  });
});
