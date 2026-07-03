// SPDX-License-Identifier: GPL-3.0-or-later
// Shared JWT bearer-assertion builder for ServiceNow's OAuth 2.0 JWT grant
// (RFC 7523). Signing is pure compute via Node's built-in `crypto` (no new
// dependency, no network); the caller reads the PEM private key from disk and
// passes it in, so this module performs no IO. Both the CLI and the MCP server
// mint assertions through here so they cannot drift on header/claim shape.
import { createSign } from "crypto";

/** Supported RSA signing algorithms (ServiceNow's JWT provider default is RS256). */
export type JwtSigningAlgorithm = "RS256" | "RS384" | "RS512";

const ALGORITHM_TO_NODE: Record<JwtSigningAlgorithm, string> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
};

/** Registered JWT claims used by ServiceNow's JWT bearer flow (extra claims allowed). */
export type JwtClaims = {
  /** Issuer — the OAuth client id (or a configured issuer identity). */
  iss: string;
  /** Subject — usually the requesting user (or the client id for service accounts). */
  sub?: string;
  /** Audience — the token endpoint / instance the assertion is intended for. */
  aud: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Issued-at, seconds since the epoch. */
  iat?: number;
  [claim: string]: string | number | boolean | undefined;
};

export type JwtAssertionOptions = {
  /** `kid` JOSE header — the key id ServiceNow maps to its verifier certificate. */
  kid?: string;
  /** Passphrase for an encrypted PEM private key. */
  passphrase?: string;
  /** Signing algorithm; defaults to RS256. */
  algorithm?: JwtSigningAlgorithm;
};

/** URL-safe base64 with padding stripped, per the JWS compact serialization. */
function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build and sign a JWT bearer assertion for ServiceNow's OAuth JWT grant.
 * Pure compute — no IO: the caller supplies the PEM private key. Returns the
 * compact `header.payload.signature` token.
 */
export function createJwtAssertion(
  privateKeyPem: string,
  claims: JwtClaims,
  options: JwtAssertionOptions = {}
): string {
  const algorithm = options.algorithm ?? "RS256";
  const nodeAlgorithm = ALGORITHM_TO_NODE[algorithm];
  if (!nodeAlgorithm) {
    throw new Error(`Unsupported JWT signing algorithm: ${algorithm}`);
  }
  const header: Record<string, string> = { alg: algorithm, typ: "JWT" };
  if (options.kid) {
    header.kid = options.kid;
  }
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims)
  )}`;
  const signer = createSign(nodeAlgorithm);
  signer.update(signingInput);
  signer.end();
  const signature = options.passphrase
    ? signer.sign({ key: privateKeyPem, passphrase: options.passphrase })
    : signer.sign(privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

export type JwtClaimInputs = {
  /** Explicit issuer override; defaults to `clientId`. */
  iss?: string;
  /** Explicit subject override; defaults to `user`, then `clientId`. */
  sub?: string;
  /** Explicit audience override; defaults to `instanceBaseUrl`. */
  aud?: string;
  clientId: string;
  user?: string;
  instanceBaseUrl: string;
  /** Assertion lifetime in seconds (default 300). */
  ttlSeconds?: number;
  /** Current time, seconds since the epoch — injected so this stays pure/testable. */
  nowSeconds: number;
};

/**
 * Derive the standard JWT claims for a ServiceNow assertion, filling issuer /
 * subject / audience defaults from the connection identity. Shared so the CLI
 * and MCP mint identical claims. Pure: time is injected via `nowSeconds`.
 */
export function buildJwtClaims(inputs: JwtClaimInputs): JwtClaims {
  const iat = inputs.nowSeconds;
  const ttl =
    typeof inputs.ttlSeconds === "number" && inputs.ttlSeconds > 0
      ? inputs.ttlSeconds
      : 300;
  return {
    iss: (inputs.iss || "").trim() || inputs.clientId,
    sub: (inputs.sub || "").trim() || inputs.user || inputs.clientId,
    aud: (inputs.aud || "").trim() || inputs.instanceBaseUrl,
    iat,
    exp: iat + ttl,
  };
}
