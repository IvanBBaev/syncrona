const mockPatch = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockGet = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    isAxiosError: (value: unknown) => {
      const candidate = value as { response?: { status?: number } } | null;
      return Boolean(candidate && typeof candidate === "object" && candidate.response);
    },
    create: jest.fn(() => ({
      patch: mockPatch,
      post: mockPost,
      put: mockPut,
      get: mockGet,
    })),
  },
}));

jest.mock("axios-rate-limit", () => ({
  __esModule: true,
  default: (client: unknown) => client,
}));

describe("snClient critical bugfixes", () => {
  const originalEnv = {
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
    SN_INSTANCE: process.env.SN_INSTANCE,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.SN_USER = originalEnv.SN_USER;
    process.env.SN_PASSWORD = originalEnv.SN_PASSWORD;
    process.env.SN_INSTANCE = originalEnv.SN_INSTANCE;
  });

  it("checkConnection pings current scope endpoint with timeout", async () => {
    mockGet.mockResolvedValue({ status: 200, data: { result: { scope: "x_test" } } });

    const { snClient, getScopedEndpointPrefix, resetClient } = await import("../snClient");
    resetClient();
    const client = snClient("https://example.service-now.com", "u", "p");

    await client.checkConnection(5000);

    expect(mockGet).toHaveBeenCalledWith("api/x_nuvo_sinc/sinc/getCurrentScope", {
      timeout: 5000,
    });
    expect(getScopedEndpointPrefix()).toBe("x_nuvo_sinc");
  });

  it("checkConnection falls back to Table API ping on scoped endpoint 404", async () => {
    const { snClient, resetClient } = await import("../snClient");
    resetClient();

    mockGet
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ status: 200, data: { result: [{ sys_id: "scope-1" }] } });

    const client = snClient("https://example.service-now.com", "u", "p");

    await client.checkConnection(5000);

    expect(mockGet).toHaveBeenNthCalledWith(1, "api/x_nuvo_sinc/sinc/getCurrentScope", {
      timeout: 5000,
    });
    expect(mockGet).toHaveBeenNthCalledWith(2, "api/x_nuvo_sync/sinc/getCurrentScope", {
      timeout: 5000,
    });
    expect(mockGet).toHaveBeenNthCalledWith(3, "api/now/table/sys_scope", {
      params: { sysparm_limit: "1", sysparm_fields: "sys_id" },
      timeout: 5000,
    });
  });

  it("checkConnection falls back to Table API ping on scoped endpoint 400", async () => {
    const { snClient, resetClient } = await import("../snClient");
    resetClient();

    mockGet
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ status: 200, data: { result: [{ sys_id: "scope-1" }] } });

    const client = snClient("https://example.service-now.com", "u", "p");

    await client.checkConnection(5000);

    expect(mockGet).toHaveBeenNthCalledWith(3, "api/now/table/sys_scope", {
      params: { sysparm_limit: "1", sysparm_fields: "sys_id" },
      timeout: 5000,
    });
  });

  it("updateRecord waits ATF upload before patch on sys_atf_step", async () => {
    const { snClient, resetClient } = await import("../snClient");
    resetClient();

    let resolvePost!: () => void;
    mockPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = () => resolve({ status: 200 });
        })
    );
    mockPatch.mockResolvedValue({ status: 200 });

    const client = snClient("https://example.service-now.com", "u", "p");

    const pending = client.updateRecord("sys_atf_step", "sys_1", {
      "inputs.script": "gs.info('ok');",
    });

    await Promise.resolve();
    expect(mockPatch).not.toHaveBeenCalled();

    resolvePost();
    await pending;

    expect(mockPost).toHaveBeenCalledWith("api/x_nuvo_sinc/pushATFfile", {
      file: "gs.info('ok');",
      sys_id: "sys_1",
    });
    expect(mockPatch).toHaveBeenCalledWith("api/now/table/sys_atf_step/sys_1", {
      "inputs.script": "gs.info('ok');",
    });
  });

  it("createCurrentUpdateSetUserPref uses POST", async () => {
    mockPost.mockResolvedValue({ status: 201 });

    const { snClient } = await import("../snClient");
    const client = snClient("https://example.service-now.com", "u", "p");

    await client.createCurrentUpdateSetUserPref("us_1", "user_1");

    expect(mockPost).toHaveBeenCalledWith("api/now/table/sys_user_preference", {
      value: "us_1",
      name: "sys_update_set",
      type: "string",
      user: "user_1",
    });
    expect(mockPut).not.toHaveBeenCalledWith("api/now/table/sys_user_preference", expect.anything());
  });

  it("retryOnErr with allowedRetries=1 performs exactly one retry", async () => {
    const { retryOnErr } = await import("../snClient");
    const onRetry = jest.fn();
    let calls = 0;

    await expect(
      retryOnErr(
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        1,
        0,
        onRetry
      )
    ).rejects.toThrow("boom");

    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(0);
  });

  it("retryOnErr with allowedRetries=3 performs exactly three retries", async () => {
    const { retryOnErr } = await import("../snClient");
    const onRetry = jest.fn();
    let calls = 0;

    await expect(
      retryOnErr(
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        3,
        0,
        onRetry
      )
    ).rejects.toThrow("boom");

    expect(calls).toBe(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenNthCalledWith(1, 2);
    expect(onRetry).toHaveBeenNthCalledWith(2, 1);
    expect(onRetry).toHaveBeenNthCalledWith(3, 0);
  });

  it("retryOnErr returns immediately when first attempt succeeds", async () => {
    const { retryOnErr } = await import("../snClient");
    const onRetry = jest.fn();
    let calls = 0;

    const result = await retryOnErr(
      async () => {
        calls += 1;
        return "ok";
      },
      3,
      0,
      onRetry
    );

    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("processPushResponse handles 404, 200, 500 and 201 statuses", async () => {
    const { processPushResponse } = await import("../snClient");

    const recSummary = "sys_script > rec_1";

    const notFound = processPushResponse({ status: 404 } as any, recSummary);
    expect(notFound.success).toBe(false);
    expect(notFound.message).toContain("Could not find");

    const ok200 = processPushResponse({ status: 200 } as any, recSummary);
    expect(ok200.success).toBe(true);
    expect(ok200.message).toContain("pushed successfully");

    const err500 = processPushResponse({ status: 500 } as any, recSummary);
    expect(err500.success).toBe(false);
    expect(err500.message).toContain("unexpected response (500)");

    const created201 = processPushResponse({ status: 201 } as any, recSummary);
    expect(created201.success).toBe(true);
    expect(created201.message).toContain("pushed successfully");
  });

  it("defaultClient refreshes when credentials change and resetClient clears cache", async () => {
    const { defaultClient, resetClient } = await import("../snClient");

    process.env.SN_INSTANCE = "instance-a.service-now.com";
    process.env.SN_USER = "user_a";
    process.env.SN_PASSWORD = "pass_a";

    resetClient();
    const clientA = defaultClient();
    const clientASecondCall = defaultClient();
    expect(clientASecondCall).toBe(clientA);

    process.env.SN_PASSWORD = "pass_b";
    const clientB = defaultClient();
    expect(clientB).not.toBe(clientA);

    resetClient();
    const clientC = defaultClient();
    expect(clientC).not.toBe(clientB);
  });

  it("resolveCredentials uses profile-specific env vars with fallback to base vars", async () => {
    const { resolveCredentials } = await import("../snClient");

    process.env.SN_INSTANCE = "base.service-now.com";
    process.env.SN_USER = "base_user";
    process.env.SN_PASSWORD = "base_pass";
    process.env.SN_INSTANCE_QA = "qa.service-now.com";
    process.env.SN_USER_QA = "qa_user";
    delete process.env.SN_PASSWORD_QA;

    const resolved = resolveCredentials("qa");
    expect(resolved.instance).toBe("qa.service-now.com");
    expect(resolved.user).toBe("qa_user");
    expect(resolved.password).toBe("base_pass");
    expect(resolved.profile).toBe("QA");
  });

  it("defaultClient keeps separate cache entries across different profiles", async () => {
    const { defaultClient, resetClient } = await import("../snClient");

    process.env.SN_INSTANCE = "base.service-now.com";
    process.env.SN_USER = "base_user";
    process.env.SN_PASSWORD = "base_pass";
    process.env.SN_INSTANCE_DEV = "dev.service-now.com";
    process.env.SN_USER_DEV = "dev_user";
    process.env.SN_PASSWORD_DEV = "dev_pass";

    resetClient();
    const defaultProfileClient = defaultClient();
    const defaultProfileSecondCall = defaultClient();
    expect(defaultProfileSecondCall).toBe(defaultProfileClient);

    const devProfileClient = defaultClient("dev");
    expect(devProfileClient).not.toBe(defaultProfileClient);

    const devProfileSecondCall = defaultClient("dev");
    expect(devProfileSecondCall).toBe(devProfileClient);
  });
});
