// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { createTokenManager, OAuthTokenResponse, TokenPoster } from "../oauth.js";

export {};

// G1: token manager — password grant, caching, expiry refresh, 401 forceRefresh,
// and refresh-token fallback to a fresh password grant.
describe("createTokenManager (OAuth)", () => {
  const creds = { username: "u", password: "p" };
  const oauth = { clientId: "cid", clientSecret: "secret" };

  // A token is now cached for its own lifetime minus a skew capped at half the
  // TTL, so even a 1-second token is reused until it expires — move the clock
  // past it instead of relying on it being stale on arrival.
  let clock = 1_000_000;
  beforeEach(() => {
    clock = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

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
      // A non-positive expires_in is not a valid expiry trick — it falls back to
      // the default TTL so a malformed server value can't force a refresh storm.
      { access_token: "A", refresh_token: "R", expires_in: 1 },
      { access_token: "B", refresh_token: "R2", expires_in: 3600 },
    ]);
    const tm = createTokenManager(creds, oauth, post);

    expect(await tm.getToken()).toBe("A"); // first acquire
    clock += 1_000;
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
      if (call === 1) return { access_token: "A", refresh_token: "R", expires_in: 1 };
      if (body.includes("grant_type=refresh_token")) throw new Error("invalid_grant");
      return { access_token: "C", refresh_token: "R3", expires_in: 3600 };
    };
    const tm = createTokenManager(creds, oauth, post);

    expect(await tm.getToken()).toBe("A");
    clock += 1_000;
    expect(await tm.getToken()).toBe("C"); // expired → refresh throws → re-acquire with password
  });
});
