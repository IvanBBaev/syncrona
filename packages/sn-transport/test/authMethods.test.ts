// SPDX-License-Identifier: GPL-3.0-or-later
import { createVerify, generateKeyPairSync } from "crypto";
import {
  createTokenManager,
  JWT_BEARER_GRANT_TYPE,
  type OAuthTokenResponse,
  createJwtAssertion,
  buildJwtClaims,
  resolveAuthMethod,
  normalizeAuthMethod,
  apiKeyHeaderName,
  AUTH_METHODS,
  DEFAULT_API_KEY_HEADER,
  resolveTlsPolicy,
} from "../src/index";

// A record of the bodies posted to the token endpoint, for grant-body asserts.
function recordingPoster(
  responses: OAuthTokenResponse[]
): { post: (p: string, b: string) => Promise<OAuthTokenResponse>; bodies: string[] } {
  const bodies: string[] = [];
  let i = 0;
  const post = async (_path: string, body: string): Promise<OAuthTokenResponse> => {
    bodies.push(body);
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { post, bodies };
}

// Decode a base64url segment to a UTF-8 string (JWT header/payload).
function decodeSegment(segment: string): unknown {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
}

describe("createTokenManager — client_credentials grant", () => {
  const oauth = { clientId: "cid", clientSecret: "csec", grantType: "client_credentials" as const };

  it("acquires with grant_type=client_credentials and no username/password", async () => {
    const { post, bodies } = recordingPoster([{ access_token: "cc1", expires_in: 3600 }]);
    const mgr = createTokenManager({}, oauth, post);
    expect(await mgr.getToken()).toBe("cc1");
    expect(bodies[0]).toContain("grant_type=client_credentials");
    expect(bodies[0]).toContain("client_id=cid");
    expect(bodies[0]).toContain("client_secret=csec");
    expect(bodies[0]).not.toContain("username=");
    expect(bodies[0]).not.toContain("password=");
  });

  it("re-acquires (not refresh_token) after a forced refresh when no refresh_token was issued", async () => {
    const { post, bodies } = recordingPoster([
      { access_token: "cc1", expires_in: 3600 },
      { access_token: "cc2", expires_in: 3600 },
    ]);
    const mgr = createTokenManager({}, oauth, post);
    await mgr.getToken();
    expect(await mgr.forceRefresh()).toBe("cc2");
    expect(bodies.every((b) => b.includes("grant_type=client_credentials"))).toBe(true);
    expect(bodies.some((b) => b.includes("grant_type=refresh_token"))).toBe(false);
  });
});

describe("createTokenManager — jwt-bearer grant", () => {
  it("posts grant_type=<jwt-bearer URN> with a freshly built assertion", async () => {
    const { post, bodies } = recordingPoster([{ access_token: "jwt1", expires_in: 3600 }]);
    let builds = 0;
    const mgr = createTokenManager(
      {},
      {
        clientId: "cid",
        clientSecret: "csec",
        grantType: "jwt-bearer",
        buildAssertion: () => {
          builds += 1;
          return `ASSERTION_${builds}`;
        },
      },
      post
    );
    expect(await mgr.getToken()).toBe("jwt1");
    expect(bodies[0]).toContain(`grant_type=${encodeURIComponent(JWT_BEARER_GRANT_TYPE)}`);
    expect(bodies[0]).toContain("assertion=ASSERTION_1");
    expect(bodies[0]).toContain("client_id=cid");
  });

  it("mints a NEW assertion on re-acquisition (async builder)", async () => {
    const { post, bodies } = recordingPoster([
      { access_token: "jwt1", expires_in: 3600 },
      { access_token: "jwt2", expires_in: 3600 },
    ]);
    let builds = 0;
    const mgr = createTokenManager(
      {},
      {
        clientId: "cid",
        clientSecret: "csec",
        grantType: "jwt-bearer",
        buildAssertion: async () => {
          builds += 1;
          return `A${builds}`;
        },
      },
      post
    );
    await mgr.getToken();
    await mgr.forceRefresh();
    expect(bodies[0]).toContain("assertion=A1");
    expect(bodies[1]).toContain("assertion=A2");
    expect(builds).toBe(2);
  });

  it("throws when the jwt-bearer grant has no assertion builder", async () => {
    const { post } = recordingPoster([{ access_token: "x", expires_in: 3600 }]);
    const mgr = createTokenManager(
      {},
      { clientId: "cid", clientSecret: "csec", grantType: "jwt-bearer" },
      post
    );
    await expect(mgr.getToken()).rejects.toThrow(/assertion builder/);
  });
});

describe("createJwtAssertion", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  it("produces a three-part token whose RS256 signature verifies with the public key", () => {
    const token = createJwtAssertion(
      privateKey,
      { iss: "cid", sub: "admin", aud: "https://dev.example.com/", iat: 1000, exp: 1300 },
      { kid: "key-1" }
    );
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    expect(signatureB64).toBeTruthy();

    const header = decodeSegment(headerB64) as Record<string, string>;
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });

    const payload = decodeSegment(payloadB64) as Record<string, unknown>;
    expect(payload.iss).toBe("cid");
    expect(payload.exp).toBe(1300);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const signature = Buffer.from(signatureB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });

  it("omits the kid header when none is supplied and honors RS384/RS512", () => {
    const token = createJwtAssertion(
      privateKey,
      { iss: "cid", aud: "aud", exp: 1 },
      { algorithm: "RS512" }
    );
    const header = decodeSegment(token.split(".")[0]) as Record<string, string>;
    expect(header).toEqual({ alg: "RS512", typ: "JWT" });

    const verifier = createVerify("RSA-SHA512");
    verifier.update(token.split(".").slice(0, 2).join("."));
    verifier.end();
    const sig = Buffer.from(token.split(".")[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });

  it("rejects an unsupported signing algorithm", () => {
    expect(() =>
      createJwtAssertion(privateKey, { iss: "a", aud: "b", exp: 1 }, {
        // Force an invalid value past the type to exercise the guard.
        algorithm: "HS256" as unknown as "RS256",
      })
    ).toThrow(/Unsupported JWT signing algorithm/);
  });

  it("signs with a passphrase-protected private key", () => {
    const enc = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "topsecret",
      },
    });
    const token = createJwtAssertion(
      enc.privateKey,
      { iss: "cid", aud: "aud", exp: 1 },
      { passphrase: "topsecret" }
    );
    const [h, p, s] = token.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    verifier.end();
    expect(
      verifier.verify(enc.publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"))
    ).toBe(true);
  });
});

describe("buildJwtClaims", () => {
  it("fills iss/sub/aud defaults from the connection identity", () => {
    const claims = buildJwtClaims({
      clientId: "cid",
      user: "admin",
      instanceBaseUrl: "https://dev.example.com/",
      nowSeconds: 1000,
    });
    expect(claims).toEqual({
      iss: "cid",
      sub: "admin",
      aud: "https://dev.example.com/",
      iat: 1000,
      exp: 1300, // default 300s TTL
    });
  });

  it("honors explicit overrides and a custom ttl, and falls back sub→clientId", () => {
    const claims = buildJwtClaims({
      iss: "issuer",
      aud: "https://token.example.com/oauth_token.do",
      clientId: "cid",
      instanceBaseUrl: "https://dev.example.com/",
      ttlSeconds: 120,
      nowSeconds: 2000,
    });
    expect(claims.iss).toBe("issuer");
    expect(claims.sub).toBe("cid"); // no user, no sub override → clientId
    expect(claims.aud).toBe("https://token.example.com/oauth_token.do");
    expect(claims.exp).toBe(2120);
  });

  it("ignores a non-positive ttl and uses the 300s default", () => {
    expect(
      buildJwtClaims({ clientId: "c", instanceBaseUrl: "u", nowSeconds: 0, ttlSeconds: 0 }).exp
    ).toBe(300);
    expect(
      buildJwtClaims({ clientId: "c", instanceBaseUrl: "u", nowSeconds: 0, ttlSeconds: -5 }).exp
    ).toBe(300);
  });
});

describe("normalizeAuthMethod", () => {
  it("maps aliases (case/underscore-insensitive) to canonical methods", () => {
    expect(normalizeAuthMethod("BASIC")).toBe("basic");
    expect(normalizeAuthMethod("oauth")).toBe("oauth-password");
    expect(normalizeAuthMethod("password")).toBe("oauth-password");
    expect(normalizeAuthMethod("client_credentials")).toBe("oauth-client-credentials");
    expect(normalizeAuthMethod("oauth-client-credentials")).toBe("oauth-client-credentials");
    expect(normalizeAuthMethod("jwt")).toBe("oauth-jwt-bearer");
    expect(normalizeAuthMethod("jwt-bearer")).toBe("oauth-jwt-bearer");
    expect(normalizeAuthMethod("APIKEY")).toBe("api-key");
    expect(normalizeAuthMethod("api-key")).toBe("api-key");
  });

  it("returns undefined for empty or unknown values", () => {
    expect(normalizeAuthMethod(undefined)).toBeUndefined();
    expect(normalizeAuthMethod("   ")).toBeUndefined();
    expect(normalizeAuthMethod("kerberos")).toBeUndefined();
  });
});

describe("apiKeyHeaderName", () => {
  it("defaults to x-sn-apikey and trims an override", () => {
    expect(apiKeyHeaderName()).toBe(DEFAULT_API_KEY_HEADER);
    expect(apiKeyHeaderName("")).toBe("x-sn-apikey");
    expect(apiKeyHeaderName("  ")).toBe("x-sn-apikey");
    expect(apiKeyHeaderName("  X-My-Key ")).toBe("X-My-Key");
  });
});

describe("resolveAuthMethod", () => {
  it("infers oauth-password from client id+secret+password (backward compatible)", () => {
    const r = resolveAuthMethod({ hasClientId: true, hasClientSecret: true, hasPassword: true });
    expect(r.method).toBe("oauth-password");
    expect(r.explicit).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it("infers basic when the OAuth pair is incomplete", () => {
    expect(resolveAuthMethod({ hasPassword: true }).method).toBe("basic");
    expect(
      resolveAuthMethod({ hasClientId: true, hasPassword: true }).method
    ).toBe("basic");
  });

  it("honors an explicit selector over inference", () => {
    const r = resolveAuthMethod({
      explicit: "api-key",
      hasApiKey: true,
      hasClientId: true,
      hasClientSecret: true,
      hasPassword: true,
    });
    expect(r.method).toBe("api-key");
    expect(r.explicit).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("reports missing fields per method", () => {
    expect(resolveAuthMethod({ explicit: "api-key" }).issues).toEqual([
      "api-key requires SN_API_KEY.",
    ]);
    expect(resolveAuthMethod({ explicit: "oauth-client-credentials" }).issues).toEqual([
      "oauth-client-credentials requires SN_OAUTH_CLIENT_ID.",
      "oauth-client-credentials requires SN_OAUTH_CLIENT_SECRET.",
    ]);
    expect(
      resolveAuthMethod({ explicit: "oauth-jwt-bearer", hasClientId: true, hasClientSecret: true })
        .issues
    ).toEqual(["oauth-jwt-bearer requires SN_JWT_KEY."]);
    expect(resolveAuthMethod({ explicit: "basic" }).issues).toEqual([
      "basic requires SN_PASSWORD.",
    ]);
    expect(
      resolveAuthMethod({ explicit: "oauth-password", hasClientId: true, hasClientSecret: true })
        .issues
    ).toEqual(["oauth-password requires SN_PASSWORD."]);
  });

  it("flags an unrecognized explicit value and falls back to inference", () => {
    const r = resolveAuthMethod({ explicit: "kerberos", hasPassword: true });
    expect(r.method).toBe("basic");
    expect(r.explicit).toBe(false);
    expect(r.unknownExplicit).toBe(true);
  });

  it("exposes the full method list", () => {
    expect(AUTH_METHODS).toEqual([
      "basic",
      "oauth-password",
      "oauth-client-credentials",
      "oauth-jwt-bearer",
      "api-key",
    ]);
  });
});

describe("resolveTlsPolicy — mutual TLS fields", () => {
  it("has no client cert/key by default and is not custom", () => {
    const p = resolveTlsPolicy(undefined, undefined);
    expect(p.clientCertPath).toBeUndefined();
    expect(p.clientKeyPath).toBeUndefined();
    expect(p.clientKeyPassphrase).toBeUndefined();
    expect(p.custom).toBe(false);
  });

  it("marks the policy custom and carries cert/key/passphrase paths for mTLS", () => {
    const p = resolveTlsPolicy(
      undefined,
      undefined,
      "/certs/client.pem",
      "/certs/client.key",
      "  keypass  "
    );
    expect(p.clientCertPath).toBe("/certs/client.pem");
    expect(p.clientKeyPath).toBe("/certs/client.key");
    expect(p.clientKeyPassphrase).toBe("keypass");
    expect(p.custom).toBe(true);
  });

  it("treats blank mTLS envs as unset", () => {
    const p = resolveTlsPolicy(undefined, undefined, "   ", "  ", "  ");
    expect(p.clientCertPath).toBeUndefined();
    expect(p.clientKeyPath).toBeUndefined();
    expect(p.custom).toBe(false);
  });
});
