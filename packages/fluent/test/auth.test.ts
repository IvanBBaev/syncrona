// SPDX-License-Identifier: GPL-3.0-or-later
import { createFluentAuthResolver, SESSION_ONLY_ENDPOINTS } from "../src/auth";
import type { FetchLike } from "../src/uiSession";

describe("createFluentAuthResolver", () => {
  it("logs in afresh on every call for a Basic profile (no memoization)", async () => {
    let logins = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("view_form.login")) logins++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: (n) => (n === "x-usertoken-response" ? `T${logins}` : null), getSetCookie: () => [`S=${logins}`] },
        json: async () => ({ status: "success" }),
      };
    };
    const resolve = createFluentAuthResolver("https://x.invalid", { kind: "basic", username: "u", password: "p" }, { fetch: fetchImpl });
    expect(await resolve()).toEqual({ type: "basic", token: "T1", cookie: "S=1" });
    expect(await resolve()).toEqual({ type: "basic", token: "T2", cookie: "S=2" });
    expect(logins).toBe(2);
  });

  it("asks the token manager on every call for an OAuth profile", async () => {
    let n = 0;
    const resolve = createFluentAuthResolver("https://x.invalid", { kind: "oauth", getToken: async () => `B${++n}` });
    expect(await resolve()).toEqual({ type: "oauth", token: "B1" });
    expect(await resolve()).toEqual({ type: "oauth", token: "B2" });
  });

  it("refuses unsupported methods lazily, naming the session-only endpoints", async () => {
    const resolve = createFluentAuthResolver("https://x.invalid", { kind: "unsupported", method: "api-key" });
    const err = await resolve().catch((e: Error) => e);
    expect((err as { code?: string }).code).toBe("FLUENT_AUTH_UNSUPPORTED");
    expect((err as Error).message).toContain("api-key");
    for (const endpoint of SESSION_ONLY_ENDPOINTS) expect((err as Error).message).toContain(endpoint);
  });

  it("treats an unknown input kind as unsupported", async () => {
    const resolve = createFluentAuthResolver("https://x.invalid", { kind: "bogus" } as never);
    await expect(resolve()).rejects.toThrow("The unknown authentication method");
  });
});
