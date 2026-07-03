// SPDX-License-Identifier: GPL-3.0-or-later
// Shared, IO-free OAuth 2.0 token manager (Resource Owner Password Credentials
// grant). Lives in @syncro-now-ai/sn-transport so both the CLI (axios) and the MCP
// server (fetch) use one implementation. The HTTP call is injected as `post`,
// so this module performs no IO itself and stays pure.
//
// OAuth is ADDITIVE everywhere — Basic auth stays the default; OAuth engages
// only when a client id + secret are configured.

export type OAuthConfig = { clientId: string; clientSecret: string };

export type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

// Posts a form-encoded body to a path (relative to the instance base URL) and
// returns the parsed token response. Injected so the manager is testable
// without a network or a specific HTTP client.
export type TokenPoster = (path: string, body: string) => Promise<OAuthTokenResponse>;

export type TokenManager = {
  /** Valid access token, acquiring or refreshing as needed. */
  getToken(): Promise<string>;
  /** Force a refresh (used after a 401) and return the new token. */
  forceRefresh(): Promise<string>;
};

export const OAUTH_TOKEN_PATH = "oauth_token.do";
// Treat a token as expired this many ms early to avoid racing its expiry.
const EXPIRY_SKEW_MS = 30_000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function oauthFormBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function createTokenManager(
  credentials: { username: string; password: string },
  oauth: OAuthConfig,
  post: TokenPoster
): TokenManager {
  let cached: { accessToken: string; refreshToken?: string; expiresAt: number } | null = null;
  // De-duplicates concurrent acquire/refresh: a burst of parallel requests that
  // all see an expired (or missing) token must trigger ONE token call, not N.
  let inFlight: Promise<string> | null = null;

  const store = (res: OAuthTokenResponse): string => {
    const token = res?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      // A malformed response (e.g. an error payload with no access_token) must
      // not poison the cache with `undefined` — that would make every later
      // request send `Authorization: Bearer undefined` until restart.
      throw new Error("OAuth token response did not include an access_token");
    }
    // Trust `expires_in` only when it is a positive, finite number of seconds.
    // A 0 / negative / NaN / non-number value (malformed server, or a string that
    // would coerce oddly) falls back to DEFAULT_TTL_MS instead of producing an
    // already-expired token that forces a refresh on the very next request.
    const ttlMs =
      typeof res.expires_in === "number" &&
      Number.isFinite(res.expires_in) &&
      res.expires_in > 0
        ? res.expires_in * 1000
        : DEFAULT_TTL_MS;
    cached = {
      accessToken: token,
      refreshToken: res.refresh_token ?? cached?.refreshToken,
      expiresAt: Date.now() + ttlMs,
    };
    return token;
  };

  // Serializes token acquisition so concurrent callers share a single network
  // round-trip. The in-flight promise is cleared once settled (success or
  // failure) so the next miss starts fresh.
  const runExclusive = (fn: () => Promise<string>): Promise<string> => {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        return await fn();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const acquireWithPassword = async (): Promise<string> => {
    const res = await post(
      OAUTH_TOKEN_PATH,
      oauthFormBody({
        grant_type: "password",
        username: credentials.username,
        password: credentials.password,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
      })
    );
    return store(res);
  };

  const refresh = async (): Promise<string> => {
    if (!cached?.refreshToken) {
      return acquireWithPassword();
    }
    try {
      const res = await post(
        OAUTH_TOKEN_PATH,
        oauthFormBody({
          grant_type: "refresh_token",
          refresh_token: cached.refreshToken,
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
        })
      );
      return store(res);
    } catch (_) {
      // Refresh token expired/revoked — fall back to a fresh password grant.
      return acquireWithPassword();
    }
  };

  return {
    async getToken(): Promise<string> {
      if (cached && Date.now() < cached.expiresAt - EXPIRY_SKEW_MS) {
        return cached.accessToken;
      }
      return runExclusive(() => (cached ? refresh() : acquireWithPassword()));
    },
    async forceRefresh(): Promise<string> {
      return runExclusive(refresh);
    },
  };
}
