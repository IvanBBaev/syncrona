// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "@jest/globals";

// Pre-issued bearer token (SN_AUTH_METHOD=bearer + SN_BEARER_TOKEN): env-only,
// inferred ahead of every other method, sent as a static Authorization header.
const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH_METHOD",
  "SN_API_KEY",
  "SN_OAUTH_CLIENT_ID",
  "SN_OAUTH_CLIENT_SECRET",
  "SN_BEARER_TOKEN",
  "SN_INSTANCE_QA",
  "SN_BEARER_TOKEN_QA",
  "SN_USER_QA",
  "SN_PASSWORD_QA",
] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]])
);

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("bearer-token auth", () => {
  it("infers bearer from SN_BEARER_TOKEN ahead of a username and password", async () => {
    const { resolveCredentials, buildClientAuth } = await import("../snClient.js");
    clearEnv();
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "pw";
    process.env.SN_BEARER_TOKEN = "tok-1";

    const creds = resolveCredentials();
    expect(creds.authMethod).toBe("bearer");
    expect(creds.bearerToken).toBe("tok-1");
    expect(buildClientAuth(creds)).toEqual({
      apiKey: { header: "Authorization", value: "Bearer tok-1" },
    });
  });

  it("authenticates with the token alone, without a username", async () => {
    const { resolveCredentials, buildClientAuth } = await import("../snClient.js");
    clearEnv();
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "bearer";
    process.env.SN_BEARER_TOKEN = "tok-2";

    const creds = resolveCredentials();
    expect(creds.authMethod).toBe("bearer");
    expect(buildClientAuth(creds).apiKey).toEqual({
      header: "Authorization",
      value: "Bearer tok-2",
    });
  });

  it("an explicit selector wins over an inferred bearer token", async () => {
    const { resolveCredentials, buildClientAuth } = await import("../snClient.js");
    clearEnv();
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "basic";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "pw";
    process.env.SN_BEARER_TOKEN = "tok-3";

    const creds = resolveCredentials();
    expect(creds.authMethod).toBe("basic");
    expect(buildClientAuth(creds).apiKey).toBeUndefined();
  });

  it("reads the profile-suffixed token", async () => {
    const { resolveCredentials } = await import("../snClient.js");
    clearEnv();
    process.env.SN_INSTANCE_QA = "qa.service-now.com";
    process.env.SN_BEARER_TOKEN_QA = "tok-qa";

    const creds = resolveCredentials("qa");
    expect(creds.instance).toBe("qa.service-now.com");
    expect(creds.authMethod).toBe("bearer");
    expect(creds.bearerToken).toBe("tok-qa");
  });

  it("never sends the unprofiled token to a profile's own instance", async () => {
    const { resolveCredentials, buildClientAuth } = await import("../snClient.js");
    clearEnv();
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_BEARER_TOKEN = "tok-dev1";
    process.env.SN_INSTANCE_QA = "qa.service-now.com";
    process.env.SN_USER_QA = "qa-admin";
    process.env.SN_PASSWORD_QA = "qa-pw";

    const creds = resolveCredentials("qa");
    expect(creds.instance).toBe("qa.service-now.com");
    expect(creds.authMethod).toBe("basic");
    expect(creds.bearerToken).toBeUndefined();
    expect(buildClientAuth(creds).apiKey).toBeUndefined();
  });

  it("lends the unprofiled token to a profile that reuses SN_INSTANCE", async () => {
    const { resolveCredentials } = await import("../snClient.js");
    clearEnv();
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_BEARER_TOKEN = "tok-dev1";
    process.env.SN_USER_QA = "qa-admin";

    const creds = resolveCredentials("qa");
    expect(creds.instance).toBe("dev1.service-now.com");
    expect(creds.bearerToken).toBe("tok-dev1");
  });

  it("names the missing token when bearer is selected without one", async () => {
    const { buildClientAuth } = await import("../snClient.js");
    clearEnv();
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "bearer";

    expect(() =>
      buildClientAuth({ instance: "dev1.service-now.com", user: "", password: "", authMethod: "bearer" })
    ).toThrow("missing bearer token (SN_BEARER_TOKEN)");
  });
});
