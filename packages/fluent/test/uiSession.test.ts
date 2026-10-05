// SPDX-License-Identifier: GPL-3.0-or-later
import { cookieHeader, FetchLike, FluentLoginError, loginUiSession, mergeSetCookies } from "../src/uiSession";

type Reply = {
  status?: number;
  statusText?: string;
  json?: unknown;
  jsonThrows?: boolean;
  setCookies?: string[];
  singleSetCookie?: string | null;
  headers?: Record<string, string>;
};

function scripted(replies: Reply[]) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error("unexpected request");
    const status = r.status ?? 200;
    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const h: { get(name: string): string | null; getSetCookie?(): string[] } = {
      get: (name) => (name === "set-cookie" ? (r.singleSetCookie ?? null) : (headers[name.toLowerCase()] ?? null)),
    };
    if (r.setCookies) h.getSetCookie = () => r.setCookies as string[];
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: r.statusText ?? "",
      headers: h,
      json: async () => {
        if (r.jsonThrows) throw new Error("not json");
        return r.json ?? {};
      },
    };
  };
  return { calls, fetchImpl };
}

describe("mergeSetCookies / cookieHeader", () => {
  it("keeps the last value per name and ignores malformed pairs", () => {
    const jar = new Map<string, string>();
    mergeSetCookies(jar, ["A=1; Path=/", "=nameless", "novalue", "B=2", "A=3; HttpOnly", " =x"]);
    expect(cookieHeader(jar)).toBe("A=3; B=2");
  });
});

describe("loginUiSession", () => {
  it("performs the two-step login and returns cookie + token", async () => {
    const { calls, fetchImpl } = scripted([
      { json: { status: "success" }, setCookies: ["JSESSIONID=J1; Path=/", "glide_user_route=R; Path=/"] },
      { status: 401, setCookies: ["JSESSIONID=J2"], headers: { "X-UserToken-Response": "TOK" } },
    ]);
    const session = await loginUiSession("https://dev.example.invalid", "admin", "s3cr3t", fetchImpl);
    expect(session).toEqual({ type: "basic", token: "TOK", cookie: "JSESSIONID=J2; glide_user_route=R" });
    expect(calls[0].url).toBe("https://dev.example.invalid/angular.do?sysparm_type=view_form.login");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(calls[0].init.body);
    expect(body.get("user_name")).toBe("admin");
    expect(body.get("user_password")).toBe("s3cr3t");
    expect(body.get("ni.nolog.user_password")).toBe("true");
    expect(calls[1].url).toBe("https://dev.example.invalid/angular.do?sysparm_type=get_user");
    expect(calls[1].init.headers.Cookie).toBe("JSESSIONID=J1; glide_user_route=R");
  });

  it("falls back to a single set-cookie header and an empty token", async () => {
    const { fetchImpl } = scripted([{ jsonThrows: true, singleSetCookie: "S=1; Path=/" }, {}]);
    const session = await loginUiSession("https://dev.example.invalid/", "u", "p", fetchImpl);
    expect(session).toEqual({ type: "basic", token: "", cookie: "S=1" });
  });

  it("uses the global fetch by default", async () => {
    const { calls, fetchImpl } = scripted([{ json: {} }, { headers: { "x-usertoken-response": "G" } }]);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      expect((await loginUiSession("https://g.invalid", "u", "p")).token).toBe("G");
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(2);
  });

  it("maps a 404 to instance-not-found", async () => {
    const { fetchImpl } = scripted([{ status: 404 }]);
    await expect(loginUiSession("https://x.invalid", "u", "p", fetchImpl)).rejects.toMatchObject({
      code: "FLUENT_INSTANCE_NOT_FOUND",
    });
  });

  it("maps other failures to the HTTP status without echoing credentials", async () => {
    const { fetchImpl } = scripted([{ status: 500, statusText: "Server Error" }]);
    const err = (await loginUiSession("https://x.invalid", "u", "pw-secret", fetchImpl).catch((e) => e)) as FluentLoginError;
    expect(err).toBeInstanceOf(FluentLoginError);
    expect(err.message).toBe("UI session login failed: 500 Server Error");
    expect(err.message).not.toContain("pw-secret");
  });

  it("refuses MFA", async () => {
    const { fetchImpl } = scripted([{ json: { status: "mfa_code_required" } }]);
    await expect(loginUiSession("https://x.invalid", "u", "p", fetchImpl)).rejects.toMatchObject({ code: "FLUENT_LOGIN_MFA" });
  });

  it("surfaces the instance's error message, or a generic one", async () => {
    const first = scripted([{ json: { status: "error", message: "User locked" } }]);
    await expect(loginUiSession("https://x.invalid", "u", "p", first.fetchImpl)).rejects.toThrow("UI session login failed: User locked");
    const second = scripted([{ json: { status: "error" } }]);
    await expect(loginUiSession("https://x.invalid", "u", "p", second.fetchImpl)).rejects.toThrow("invalid credentials");
  });
});
