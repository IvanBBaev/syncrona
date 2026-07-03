// SPDX-License-Identifier: GPL-3.0-or-later
// Shared, IO-free ServiceNow authentication-method resolution. The CLI (axios)
// and the MCP server (fetch) both read the environment/credential store, hand
// the presence flags to `resolveAuthMethod`, and wire the chosen method into
// their respective HTTP clients. Centralized here so the two clients can never
// drift on which method a given configuration selects, or on the env var names.

/**
 * Every ServiceNow authentication method SyncroNow AI supports.
 *
 * - `basic` — HTTP Basic (default).
 * - `oauth-password` — OAuth 2.0 Resource Owner Password grant (+ refresh).
 * - `oauth-client-credentials` — OAuth 2.0 Client Credentials grant (service-to-service).
 * - `oauth-jwt-bearer` — OAuth 2.0 JWT Bearer grant (signed assertion, RFC 7523).
 * - `api-key` — inbound REST API Key sent as an HTTP header (Vancouver+).
 *
 * Mutual TLS (client certificate) is orthogonal to this enum — it is applied at
 * the transport layer via {@link ResolvedTlsPolicy} and combines with ANY method.
 */
export type AuthMethod =
  | "basic"
  | "oauth-password"
  | "oauth-client-credentials"
  | "oauth-jwt-bearer"
  | "api-key";

/** All auth methods, in a stable order (for help text and pickers). */
export const AUTH_METHODS: readonly AuthMethod[] = [
  "basic",
  "oauth-password",
  "oauth-client-credentials",
  "oauth-jwt-bearer",
  "api-key",
];

/* ----------------------------------------------------------------------------
 * Canonical env var names — the single vocabulary both clients read. Each
 * supports a per-profile `_<PROFILE>` suffix via the core CLI's profileEnvVar
 * helper; the MCP server reads the un-suffixed name.
 * ------------------------------------------------------------------------- */
export const AUTH_METHOD_ENV = "SN_AUTH_METHOD";
export const API_KEY_ENV = "SN_API_KEY";
export const API_KEY_HEADER_ENV = "SN_API_KEY_HEADER";
export const OAUTH_CLIENT_ID_ENV = "SN_OAUTH_CLIENT_ID";
export const OAUTH_CLIENT_SECRET_ENV = "SN_OAUTH_CLIENT_SECRET";
export const JWT_KEY_ENV = "SN_JWT_KEY";
export const JWT_KID_ENV = "SN_JWT_KID";
export const JWT_ISS_ENV = "SN_JWT_ISS";
export const JWT_SUB_ENV = "SN_JWT_SUB";
export const JWT_AUD_ENV = "SN_JWT_AUD";
export const CLIENT_CERT_ENV = "SN_CLIENT_CERT";
export const CLIENT_KEY_ENV = "SN_CLIENT_KEY";
export const CLIENT_KEY_PASSPHRASE_ENV = "SN_CLIENT_KEY_PASSPHRASE";

/** ServiceNow's conventional inbound-REST API Key header name. */
export const DEFAULT_API_KEY_HEADER = "x-sn-apikey";

/** The API key header to use, defaulting to {@link DEFAULT_API_KEY_HEADER}. */
export function apiKeyHeaderName(override?: string): string {
  return (override || "").trim() || DEFAULT_API_KEY_HEADER;
}

const METHOD_ALIASES: Record<string, AuthMethod> = {
  basic: "basic",
  oauth: "oauth-password",
  password: "oauth-password",
  "oauth-password": "oauth-password",
  "client-credentials": "oauth-client-credentials",
  "oauth-client-credentials": "oauth-client-credentials",
  jwt: "oauth-jwt-bearer",
  "jwt-bearer": "oauth-jwt-bearer",
  "oauth-jwt-bearer": "oauth-jwt-bearer",
  apikey: "api-key",
  "api-key": "api-key",
};

/**
 * Normalize a raw `SN_AUTH_METHOD` value to a canonical {@link AuthMethod},
 * accepting a few friendly aliases (`oauth`, `client-credentials`, `jwt`, …)
 * and treating `_`/whitespace/casing loosely. Returns `undefined` for an
 * empty or unrecognized value so the caller can fall back to inference.
 */
export function normalizeAuthMethod(raw: string | undefined): AuthMethod | undefined {
  const value = (raw || "").trim().toLowerCase().replace(/_/g, "-");
  if (!value) {
    return undefined;
  }
  return METHOD_ALIASES[value];
}

/** Which credential fields are present, for method inference + validation. */
export type AuthMethodInputs = {
  /** Raw `SN_AUTH_METHOD` value, if any (an explicit selector wins over inference). */
  explicit?: string;
  hasPassword?: boolean;
  hasClientId?: boolean;
  hasClientSecret?: boolean;
  hasApiKey?: boolean;
  hasJwtKey?: boolean;
};

export type ResolvedAuthMethod = {
  method: AuthMethod;
  /** True when the method came from an explicit `SN_AUTH_METHOD`, not inference. */
  explicit: boolean;
  /** True when the raw explicit value was present but unrecognized (fell back to inference). */
  unknownExplicit: boolean;
  /** Missing-field problems for the chosen method (empty ⇒ config is complete). */
  issues: string[];
};

function validateAuthMethod(method: AuthMethod, inputs: AuthMethodInputs): string[] {
  const issues: string[] = [];
  const need = (present: boolean | undefined, envVar: string, label: string): void => {
    if (!present) {
      issues.push(`${label} requires ${envVar}.`);
    }
  };
  switch (method) {
    case "basic":
      need(inputs.hasPassword, "SN_PASSWORD", "basic");
      break;
    case "oauth-password":
      need(inputs.hasClientId, OAUTH_CLIENT_ID_ENV, "oauth-password");
      need(inputs.hasClientSecret, OAUTH_CLIENT_SECRET_ENV, "oauth-password");
      need(inputs.hasPassword, "SN_PASSWORD", "oauth-password");
      break;
    case "oauth-client-credentials":
      need(inputs.hasClientId, OAUTH_CLIENT_ID_ENV, "oauth-client-credentials");
      need(inputs.hasClientSecret, OAUTH_CLIENT_SECRET_ENV, "oauth-client-credentials");
      break;
    case "oauth-jwt-bearer":
      need(inputs.hasClientId, OAUTH_CLIENT_ID_ENV, "oauth-jwt-bearer");
      need(inputs.hasClientSecret, OAUTH_CLIENT_SECRET_ENV, "oauth-jwt-bearer");
      need(inputs.hasJwtKey, JWT_KEY_ENV, "oauth-jwt-bearer");
      break;
    case "api-key":
      need(inputs.hasApiKey, API_KEY_ENV, "api-key");
      break;
  }
  return issues;
}

/**
 * Resolve which authentication method a configuration selects.
 *
 * An explicit `SN_AUTH_METHOD` always wins. When it is absent (or unrecognized),
 * the method is inferred exactly as SyncroNow AI did before the multi-method
 * work — OAuth password when a client id + secret + password are all present,
 * otherwise Basic — so existing setups keep behaving identically. The returned
 * `issues` list reports any credential fields the chosen method still needs.
 */
export function resolveAuthMethod(inputs: AuthMethodInputs): ResolvedAuthMethod {
  const explicit = normalizeAuthMethod(inputs.explicit);
  const hadExplicitValue = !!(inputs.explicit || "").trim();
  let method: AuthMethod;
  if (explicit) {
    method = explicit;
  } else if (inputs.hasClientId && inputs.hasClientSecret && inputs.hasPassword) {
    method = "oauth-password";
  } else {
    method = "basic";
  }
  return {
    method,
    explicit: !!explicit,
    unknownExplicit: hadExplicitValue && !explicit,
    issues: validateAuthMethod(method, inputs),
  };
}
