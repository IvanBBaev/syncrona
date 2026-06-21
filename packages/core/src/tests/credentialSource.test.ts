export {};

// DX2: `syncro-now-ai status` reports where credentials were resolved from.
// describeCredentialSource must mirror resolveCredentials' precedence exactly
// (they share one internal resolver), so these cover the env-driven branches.

jest.mock("axios", () => ({
  __esModule: true,
  default: { isAxiosError: () => false, create: jest.fn(() => ({})) },
}));
jest.mock("axios-rate-limit", () => ({
  __esModule: true,
  default: (client: unknown) => client,
}));

describe("describeCredentialSource (DX2)", () => {
  const ENV_KEYS = [
    "SN_USER",
    "SN_PASSWORD",
    "SN_INSTANCE",
    "SN_USER_DEV",
    "SN_PASSWORD_DEV",
    "SN_INSTANCE_DEV",
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    jest.resetModules();
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

  async function describe_(profile?: string): Promise<string> {
    const { describeCredentialSource } = await import("../snClient");
    return describeCredentialSource(profile);
  }

  it("reports base environment vars", async () => {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_INSTANCE = "dev.service-now.com";
    expect(await describe_()).toBe("environment (.env / shell SN_* vars)");
  });

  it("reports instance profile env vars when a profile is used", async () => {
    process.env.SN_USER_DEV = "u";
    process.env.SN_PASSWORD_DEV = "p";
    process.env.SN_INSTANCE_DEV = "dev.service-now.com";
    expect(await describe_("dev")).toBe("instance profile env vars");
  });

  it("reports missing credentials when nothing is set", async () => {
    expect(await describe_()).toBe("none (credentials missing)");
  });

  // DX20: diagnoseCredentials backs `status --debug-credentials`.
  async function diagnose_(profile?: string) {
    const { diagnoseCredentials } = await import("../snClient");
    return diagnoseCredentials(profile);
  }

  it("diagnoseCredentials reports base env presence and the resolved winner", async () => {
    process.env.SN_INSTANCE = "dev.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    const d = await diagnose_();
    expect(d.baseEnvPresent).toEqual({ instance: true, user: true, password: true });
    expect(d.profileEnvPresent).toBeUndefined();
    expect(d.source).toBe("environment (.env / shell SN_* vars)");
    expect(d.resolvedInstance).toBe("dev.service-now.com");
    expect(d.resolvedUser).toBe("u");
  });

  it("diagnoseCredentials reports profile env presence when a profile is used", async () => {
    process.env.SN_USER_DEV = "u";
    process.env.SN_INSTANCE_DEV = "dev.service-now.com";
    const d = await diagnose_("dev");
    expect(d.profile).toBe("DEV");
    expect(d.profileEnvPresent).toEqual({ instance: true, user: true, password: false });
    expect(d.source).toBe("instance profile env vars");
  });

  it("diagnoseCredentials reports all-missing when nothing is set", async () => {
    const d = await diagnose_();
    expect(d.baseEnvPresent).toEqual({ instance: false, user: false, password: false });
    expect(d.source).toBe("none (credentials missing)");
  });
});
