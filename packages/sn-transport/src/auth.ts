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
  // Own properties only: a bare `METHOD_ALIASES[value]` also resolves inherited
  // Object.prototype members, so "constructor" (the one prototype key that
  // survives the lowercasing above) returned the Object function — a truthy
  // non-method that passed for a method and skipped credential validation.
  if (!Object.prototype.hasOwnProperty.call(METHOD_ALIASES, value)) {
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
  /**
   * Problems with the configuration (empty ⇒ config is complete): missing fields
   * for the chosen method, plus an unrecognized {@link AUTH_METHOD_ENV} selector.
   */
  issues: string[];
  /**
   * The unrecognized-selector issue on its own, when there is one. It is also the
   * first entry of {@link issues}, but callers need it separately: a missing field
   * surfaces on its own the moment a request is attempted, whereas an unrecognized
   * selector *succeeds* under an inferred method, so it is the one issue that has
   * to be reported even where reporting every issue would be noise (REV-201).
   * Exposed as a field rather than left to `issues[0]` so no caller has to
   * re-derive the wording or depend on the list's order.
   */
  unknownExplicitIssue?: string;
};

/** Longest echo of an untrusted selector; a real method name is ~24 characters. */
const MAX_ECHOED_SELECTOR = 64;

/**
 * Renders an unrecognized selector for inclusion in an issue string.
 *
 * The selector is the one piece of untrusted text that gets echoed back, and the
 * issues list is not a dead end: core/snClient logs it, core/diagnosticsCommands
 * pushes it verbatim into the reported "missing env vars" list, and
 * mcp-server/servicenowCore embeds it in the Error it refuses to start with. All
 * three are line-oriented reports read by an operator or an LLM, so an
 * `SN_AUTH_METHOD` carrying newlines forges lines in them — a property test shrank
 * it to `SN_AUTH_METHOD="basic\nSN_PASSWORD requires nothing."`, which reproduces
 * this module's own issue wording inside the report. Same indirect-injection class
 * as the ADF code-fence escape (REV-202), reachable from a `.env` in any workspace
 * the agent was pointed at. Escape the line terminators and control characters, and
 * bound the length, so the echo stays diagnosable without being able to add a line.
 */
function describeSelector(raw: string): string {
  const escaped = raw.replace(
    // No eslint-disable here: `no-control-regex` is not enabled for this package,
    // and `npm run lint` runs with --max-warnings=0, so a needless directive is
    // itself a lint failure. Matching control characters is the point of the class.
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (char) => `\\u${(char.codePointAt(0) as number).toString(16).padStart(4, "0")}`
  );
  return escaped.length > MAX_ECHOED_SELECTOR
    ? `${escaped.slice(0, MAX_ECHOED_SELECTOR)}...`
    : escaped;
}

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
 * `issues` list reports any credential fields the chosen method still needs, and
 * an unrecognized explicit selector.
 */
export function resolveAuthMethod(inputs: AuthMethodInputs): ResolvedAuthMethod {
  const explicit = normalizeAuthMethod(inputs.explicit);
  const rawExplicit = (inputs.explicit || "").trim();
  const hadExplicitValue = !!rawExplicit;
  let method: AuthMethod;
  if (explicit) {
    method = explicit;
  } else if (inputs.hasClientId && inputs.hasClientSecret && inputs.hasPassword) {
    method = "oauth-password";
  } else {
    method = "basic";
  }
  const unknownExplicit = hadExplicitValue && !explicit;
  const issues = validateAuthMethod(method, inputs);
  // A typo'd selector used to be reported ONLY through `unknownExplicit`, which
  // no production caller reads (snClient, servicenowCore and the diagnostics
  // commands all consume just `.method` and `.issues`). So an unrecognized
  // SN_AUTH_METHOD fell through to inference silently, and when the leftover
  // credentials happened to complete the inferred method the issues list was
  // empty — e.g. SN_AUTH_METHOD=oauth-jwt (not an alias) with stale client
  // id/secret/password still in .env resolved to oauth-password and posted the
  // user's password to /oauth_token.do, with doctor reporting a healthy config.
  // Reporting it as an issue makes the misconfiguration fail loudly everywhere
  // the issues list is already surfaced.
  let unknownExplicitIssue: string | undefined;
  if (unknownExplicit) {
    unknownExplicitIssue = `Unknown ${AUTH_METHOD_ENV} "${describeSelector(
      rawExplicit
    )}"; expected one of: ${AUTH_METHODS.join(", ")}.`;
    issues.unshift(unknownExplicitIssue);
  }
  return {
    method,
    explicit: !!explicit,
    unknownExplicit,
    issues,
    ...(unknownExplicitIssue ? { unknownExplicitIssue } : {}),
  };
}
