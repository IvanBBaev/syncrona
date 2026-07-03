// SPDX-License-Identifier: GPL-3.0-or-later
import { createTokenManager, OAuthTokenResponse, TokenPoster } from "../oauth";

export {};

// G1: token manager — password grant, caching, expiry refresh, 401 forceRefresh,
// and refresh-token fallback to a fresh password grant.
describe("createTokenManager (OAuth)", () => {
  const creds = { username: "u", password: "p" };
  const oauth = { clientId: "cid", clientSecret: "secret" };

  function poster(responses: OAuthTokenResponse[]): { post: TokenPoster; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const post: TokenPoster = async (_path, body) => {
      calls.push(body);
      return responses[Math.min(i++, responses.length - 1)];
    };
    return { post, calls };
  }

  it("acquires with the password grant on first getToken and caches it", async () => {
    const { post, calls } = poster([{ access_token: "A", refresh_token: "R", expires_in: 3600 }]);
    const tm = createTokenManager(creds, oauth, post);

    expect(await tm.getToken()).toBe("A");
    expect(await tm.getToken()).toBe("A"); // cached — no second call
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("grant_type=password");
    expect(calls[0]).toContain("username=u");
    expect(calls[0]).toContain("client_id=cid");
  });

  it("refreshes with the refresh_token when the access token has expired", async () => {
    const { post, calls } = poster([
      // A 1-second lifetime is shorter than EXPIRY_SKEW_MS (30s), so the manager
      // treats the token as already needing refresh on the next getToken. (A
      // non-positive expires_in is no longer a valid expiry trick — it now falls
      // back to the default TTL so a malformed server value can't force a refresh
      // storm.)
      { access_token: "A", refresh_token: "R", expires_in: 1 },
      { access_token: "B", refresh_token: "R2", expires_in: 3600 },
    ]);
    const tm = createTokenManager(creds, oauth, post);

    expect(await tm.getToken()).toBe("A"); // first acquire
    expect(await tm.getToken()).toBe("B"); // expired → refresh
    expect(calls[1]).toContain("grant_type=refresh_token");
    expect(calls[1]).toContain("refresh_token=R");
  });

  it("forceRefresh uses the refresh token (used after a 401)", async () => {
    const { post, calls } = poster([
      { access_token: "A", refresh_token: "R", expires_in: 3600 },
      { access_token: "B", refresh_token: "R", expires_in: 3600 },
    ]);
    const tm = createTokenManager(creds, oauth, post);

    await tm.getToken();
    expect(await tm.forceRefresh()).toBe("B");
    expect(calls[1]).toContain("grant_type=refresh_token");
  });

  it("falls back to a password grant when refresh fails", async () => {
    let call = 0;
    const post: TokenPoster = async (_p, body) => {
      call += 1;
      // 1s lifetime < EXPIRY_SKEW_MS (30s) ⇒ treated as expired on the next call.
      if (call === 1) return { access_token: "A", refresh_token: "R", expires_in: 1 };
      if (body.includes("grant_type=refresh_token")) throw new Error("invalid_grant");
      return { access_token: "C", refresh_token: "R3", expires_in: 3600 };
    };
    const tm = createTokenManager(creds, oauth, post);

    expect(await tm.getToken()).toBe("A");
    expect(await tm.getToken()).toBe("C"); // expired → refresh throws → re-acquire with password
  });
});
