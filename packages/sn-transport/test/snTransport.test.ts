// SPDX-License-Identifier: GPL-3.0-or-later
import {
  sanitizeScopedPrefix,
  parseConfiguredScopedApiPrefixes,
  orderScopedApiPrefixes,
  shouldRetryStatus,
  isEndpointNotFoundStatus,
  resolveTlsPolicy,
  escapeQueryValue,
  DEFAULT_SCOPED_API_PREFIXES,
  oauthFormBody,
  createTokenManager,
  OAUTH_TOKEN_PATH,
  type OAuthTokenResponse,
} from "../src/index";

describe("sanitizeScopedPrefix", () => {
  it("strips non [a-zA-Z0-9_] characters and trims", () => {
    expect(sanitizeScopedPrefix("  x_my-scope!@# ")).toBe("x_myscope");
  });
});

describe("parseConfiguredScopedApiPrefixes", () => {
  it("splits, sanitizes, filters empties and de-dupes preserving order", () => {
    expect(parseConfiguredScopedApiPrefixes("x_a, x_b ,,x_a")).toEqual(["x_a", "x_b"]);
  });

  it("falls back to defaults on an empty/invalid value", () => {
    expect(parseConfiguredScopedApiPrefixes("")).toEqual([...DEFAULT_SCOPED_API_PREFIXES]);
    expect(parseConfiguredScopedApiPrefixes("!!!,@@@")).toEqual([...DEFAULT_SCOPED_API_PREFIXES]);
  });
});

describe("orderScopedApiPrefixes", () => {
  it("puts preferred prefixes first and de-dupes against configured", () => {
    expect(orderScopedApiPrefixes(["x_a", "x_b"], ["x_b"])).toEqual(["x_b", "x_a"]);
  });

  it("returns configured unchanged when there are no preferred", () => {
    expect(orderScopedApiPrefixes(["x_a", "x_b"])).toEqual(["x_a", "x_b"]);
  });
});

describe("shouldRetryStatus", () => {
  it("retries transient statuses", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(shouldRetryStatus(s)).toBe(true);
    }
  });
  it("does not retry client errors that won't change", () => {
    for (const s of [400, 401, 403, 404, 200]) {
      expect(shouldRetryStatus(s)).toBe(false);
    }
  });
});

describe("escapeQueryValue", () => {
  // `^` is the condition separator in a ServiceNow encoded query. A
  // user-controlled value carrying a caret could otherwise smuggle extra
  // conditions (e.g. flip a scoped lookup into an instance-wide one).
  it("replaces caret condition separators with spaces", () => {
    expect(escapeQueryValue("x_app^sys_id=ADMIN")).toBe("x_app sys_id=ADMIN");
  });

  it("neutralizes every caret, including ^OR / ^NQ", () => {
    expect(escapeQueryValue("a^ORb^NQc")).toBe("a ORb NQc");
  });

  it("leaves a benign value untouched", () => {
    expect(escapeQueryValue("x_my_scope")).toBe("x_my_scope");
  });

  it("handles an empty string", () => {
    expect(escapeQueryValue("")).toBe("");
  });
});

describe("isEndpointNotFoundStatus", () => {
  it("flags 400/403/404 as scoped-endpoint-unavailable", () => {
    expect(isEndpointNotFoundStatus(400)).toBe(true);
    expect(isEndpointNotFoundStatus(403)).toBe(true);
    expect(isEndpointNotFoundStatus(404)).toBe(true);
  });
  it("does not flag other statuses", () => {
    expect(isEndpointNotFoundStatus(500)).toBe(false);
    expect(isEndpointNotFoundStatus(200)).toBe(false);
  });
});

describe("resolveTlsPolicy", () => {
  it("keeps verification ON by default (unset env)", () => {
    const p = resolveTlsPolicy(undefined, undefined);
    expect(p.rejectUnauthorized).toBe(true);
    expect(p.custom).toBe(false);
    expect(p.caBundlePath).toBeUndefined();
  });

  it("turns verification OFF only on explicit falsey tokens", () => {
    for (const v of ["0", "false", "NO", " No "]) {
      expect(resolveTlsPolicy(undefined, v).rejectUnauthorized).toBe(false);
    }
    expect(resolveTlsPolicy(undefined, "1").rejectUnauthorized).toBe(true);
  });

  it("marks the policy custom when a CA bundle is configured", () => {
    const p = resolveTlsPolicy("/etc/ca.pem", undefined);
    expect(p.caBundlePath).toBe("/etc/ca.pem");
    expect(p.custom).toBe(true);
  });
});

describe("oauthFormBody", () => {
  it("url-encodes keys and values and joins with &", () => {
    expect(oauthFormBody({ grant_type: "password", "a b": "c&d" })).toBe(
      "grant_type=password&a%20b=c%26d"
    );
  });
});

describe("createTokenManager", () => {
  const creds = { username: "u", password: "p" };
  const oauth = { clientId: "cid", clientSecret: "csec" };

  it("acquires with a password grant on first getToken", async () => {
    const posts: Array<{ path: string; body: string }> = [];
    const post = async (path: string, body: string): Promise<OAuthTokenResponse> => {
      posts.push({ path, body });
      return { access_token: "tok1", refresh_token: "ref1", expires_in: 3600 };
    };
    const mgr = createTokenManager(creds, oauth, post);
    expect(await mgr.getToken()).toBe("tok1");
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(OAUTH_TOKEN_PATH);
    expect(posts[0].body).toContain("grant_type=password");
  });

  it("reuses a cached, unexpired token without a second call", async () => {
    let calls = 0;
    const post = async (): Promise<OAuthTokenResponse> => {
      calls += 1;
      return { access_token: `tok${calls}`, refresh_token: "ref", expires_in: 3600 };
    };
    const mgr = createTokenManager(creds, oauth, post);
    await mgr.getToken();
    expect(await mgr.getToken()).toBe("tok1");
    expect(calls).toBe(1);
  });

  it("forceRefresh uses the refresh_token grant when one is cached", async () => {
    const bodies: string[] = [];
    const post = async (_path: string, body: string): Promise<OAuthTokenResponse> => {
      bodies.push(body);
      return { access_token: `tok${bodies.length}`, refresh_token: "ref", expires_in: 3600 };
    };
    const mgr = createTokenManager(creds, oauth, post);
    await mgr.getToken(); // password grant
    await mgr.forceRefresh(); // refresh grant
    expect(bodies[1]).toContain("grant_type=refresh_token");
  });

  it("forceRefresh re-runs a password grant when no refresh_token was cached (#68)", async () => {
    // Some instances (or a misconfigured OAuth app) return an access_token with
    // NO refresh_token. A later forceRefresh() — e.g. the snClient 401 re-auth
    // interceptor — then has nothing to refresh with and must fall back to a
    // fresh password grant instead of sending an empty refresh_token. This pins
    // the `!cached?.refreshToken` branch inside refresh().
    const bodies: string[] = [];
    let n = 0;
    const post = async (_path: string, body: string): Promise<OAuthTokenResponse> => {
      bodies.push(body);
      n += 1;
      // Never hand out a refresh_token, so the cache has none to reuse.
      return { access_token: `tok${n}`, expires_in: 3600 };
    };
    const mgr = createTokenManager(creds, oauth, post);
    expect(await mgr.getToken()).toBe("tok1"); // password grant, no refresh_token
    const refreshed = await mgr.forceRefresh(); // must re-acquire via password
    expect(refreshed).toBe("tok2");
    // Both calls were password grants; no refresh_token grant was ever attempted.
    expect(bodies.every((b) => b.includes("grant_type=password"))).toBe(true);
    expect(bodies.some((b) => b.includes("grant_type=refresh_token"))).toBe(false);
    expect(n).toBe(2);
  });

  it("falls back to a password grant when the refresh call fails", async () => {
    const bodies: string[] = [];
    let n = 0;
    const post = async (_path: string, body: string): Promise<OAuthTokenResponse> => {
      bodies.push(body);
      n += 1;
      if (body.includes("grant_type=refresh_token")) {
        throw new Error("refresh revoked");
      }
      return { access_token: `tok${n}`, refresh_token: "ref", expires_in: 3600 };
    };
    const mgr = createTokenManager(creds, oauth, post);
    await mgr.getToken(); // password
    const tok = await mgr.forceRefresh(); // refresh fails -> password fallback
    expect(tok).toMatch(/^tok/);
    expect(bodies.some((b) => b.includes("grant_type=refresh_token"))).toBe(true);
    expect(bodies.filter((b) => b.includes("grant_type=password"))).toHaveLength(2);
  });

  it("rejects a token response that carries no access_token", async () => {
    const post = async (): Promise<OAuthTokenResponse> =>
      ({ expires_in: 3600 } as unknown as OAuthTokenResponse);
    const mgr = createTokenManager(creds, oauth, post);
    await expect(mgr.getToken()).rejects.toThrow(/access_token/);
  });

  it("treats a non-positive expires_in as the default TTL, not an already-expired token", async () => {
    for (const badTtl of [0, -100, Number.NaN]) {
      let calls = 0;
      const post = async (): Promise<OAuthTokenResponse> => {
        calls += 1;
        return { access_token: `tok${calls}`, expires_in: badTtl } as OAuthTokenResponse;
      };
      const mgr = createTokenManager(creds, oauth, post);
      await mgr.getToken();
      // A second call must reuse the cache: a 0/negative/NaN expires_in must NOT
      // mint an instantly-expired token that re-acquires on every request.
      expect(await mgr.getToken()).toBe("tok1");
      expect(calls).toBe(1);
    }
  });

  it("refreshes when a short-lived token falls inside the expiry skew window", async () => {
    // A token whose lifetime (1s) is shorter than the 30s expiry skew must be
    // treated as already needing refresh on the very next getToken. This pins the
    // two halves of the boundary: a valid positive expires_in is honored as the
    // real TTL (NOT silently routed to the 30-min default), and getToken subtracts
    // the skew from expiry rather than adding it.
    const bodies: string[] = [];
    let n = 0;
    const post = async (_path: string, body: string): Promise<OAuthTokenResponse> => {
      bodies.push(body);
      n += 1;
      return n === 1
        ? { access_token: "short", refresh_token: "R", expires_in: 1 }
        : { access_token: "fresh", refresh_token: "R2", expires_in: 3600 };
    };
    const mgr = createTokenManager(creds, oauth, post);
    expect(await mgr.getToken()).toBe("short");
    expect(await mgr.getToken()).toBe("fresh"); // expired within skew -> refresh
    expect(bodies[1]).toContain("grant_type=refresh_token");
    expect(n).toBe(2);
  });

  it("de-duplicates concurrent acquisitions into a single token call", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const post = async (): Promise<OAuthTokenResponse> => {
      calls += 1;
      await gate;
      return { access_token: "tok", refresh_token: "ref", expires_in: 3600 };
    };
    const mgr = createTokenManager(creds, oauth, post);
    const p1 = mgr.getToken();
    const p2 = mgr.getToken();
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("tok");
    expect(b).toBe("tok");
    expect(calls).toBe(1);
  });
});
