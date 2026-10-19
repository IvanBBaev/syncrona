// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import {
  getActiveInstanceSync,
  loadCredentialsSync,
  type StoredCredentials,
} from "@syncrona/credential-store";
import {
  MAX_RPS_ENV,
  resolveMaxRequestsPerSecond,
  shouldRetryStatus,
  createTokenManager,
  resolveAuthMethod,
  apiKeyHeaderName,
  resolveTlsPolicy,
  buildJwtClaims,
  createJwtAssertion,
  AUTH_METHOD_ENV,
  API_KEY_ENV,
  API_KEY_HEADER_ENV,
  OAUTH_CLIENT_ID_ENV,
  OAUTH_CLIENT_SECRET_ENV,
  JWT_KEY_ENV,
  JWT_KID_ENV,
  JWT_ISS_ENV,
  JWT_SUB_ENV,
  JWT_AUD_ENV,
  CA_BUNDLE_ENV,
  TLS_REJECT_UNAUTHORIZED_ENV,
  CLIENT_CERT_ENV,
  CLIENT_KEY_ENV,
  CLIENT_KEY_PASSPHRASE_ENV,
  BEARER_TOKEN_ENV,
  type AuthMethod,
  type OAuthConfig,
  type TokenManager,
  type TokenPoster,
  type OAuthTokenResponse,
} from "@syncrona/sn-transport";
import {
  Agent,
  EnvHttpProxyAgent,
  type Dispatcher,
  type buildConnector,
} from "undici";
import { logger } from "./logger";
import {
  SCRIPTS_BACKGROUND_PATH,
  extractCsrfToken,
  parseScriptsBackgroundResponse,
} from "./scriptsBackgroundPage";

// Node's global fetch honours a non-standard `dispatcher` option (it is undici
// under the hood) but the DOM `RequestInit` type omits it. Widen it locally so
// mutual-TLS / custom-CA / proxied requests can attach an undici dispatcher
// (an Agent, or an EnvHttpProxyAgent when HTTP(S)_PROXY is set) without
// resorting to an `any` cast.
type FetchInit = NonNullable<Parameters<typeof fetch>[1]> & { dispatcher?: Dispatcher };

type SNConfig = {
  instance: string;
  user: string;
  password: string;
  // G1: when both are set (SN_OAUTH_CLIENT_ID / SN_OAUTH_CLIENT_SECRET), the
  // MCP client authenticates with OAuth 2.0 Bearer instead of Basic.
  clientId?: string;
  clientSecret?: string;
  // Explicit auth-method selector (SN_AUTH_METHOD). When absent it is inferred
  // exactly as before: oauth-password if client id+secret+password are all
  // present, else basic — so existing setups keep behaving identically.
  authMethod?: AuthMethod;
  // Inbound REST API Key (api-key method).
  apiKey?: string;
  apiKeyHeader?: string;
  // Pre-issued OAuth access token (bearer method, env-only).
  bearerToken?: string;
  // JWT bearer grant material (oauth-jwt-bearer method).
  jwtKey?: string;
  jwtKid?: string;
  jwtIss?: string;
  jwtSub?: string;
  jwtAud?: string;
  // Mutual TLS / custom CA — orthogonal to the Authorization method above and
  // applied at the transport layer via an undici dispatcher.
  caBundlePath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  clientKeyPassphrase?: string;
  rejectUnauthorized?: boolean;
  /** True when any non-default TLS setting requires a custom dispatcher. */
  tlsCustom?: boolean;
};

// Cache one token manager per instance+client across the long-running server,
// so token caching/refresh actually persists between tool calls.
const tokenManagers = new Map<string, TokenManager>();

// Bound the token-manager cache so a long-running server that authenticates to
// many distinct instances/identities cannot grow it without limit. LRU: the
// least-recently-used identity is dropped once the cap is reached. (REV-109)
const MAX_CACHED_TOKEN_MANAGERS = 32;

// Absolute deadlines (ms epoch) of the requests currently waiting on a token,
// keyed like tokenManagers. The token endpoint must observe the caller's timeout
// too: an unsignalled fetch hangs until undici's default 300s headers timeout,
// so a tool call that declared a 1s budget would stall for minutes. TokenPoster's
// shape is fixed by @syncrona/sn-transport, so the budget travels through here.
const tokenBudgets = new Map<string, Set<number>>();

// Floor for the token leg so a nearly-exhausted budget still gets a usable
// attempt rather than aborting before the request leaves.
const MIN_TOKEN_TIMEOUT_MS = 1000;
// Applied when no caller registered a budget (e.g. a token acquired outside the
// request loop), keeping a hung token endpoint far below undici's 300s default.
const DEFAULT_TOKEN_TIMEOUT_MS = 30000;

// Test seam: token managers are module state and otherwise leak cached tokens
// between unit tests that reuse the same instance/client identity.
export function clearTokenManagerCache(): void {
  tokenManagers.clear();
  tokenBudgets.clear();
}

// Evict the least-recently-used token managers until there is room for one more.
// Insertion order is the LRU order because getTokenManager re-inserts an entry
// on every cache hit. (REV-109)
function evictTokenManagersToCap(): void {
  while (tokenManagers.size >= MAX_CACHED_TOKEN_MANAGERS) {
    const oldest = tokenManagers.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    tokenManagers.delete(oldest);
  }
}

// A token fetch is de-duplicated across concurrent callers, so bound it by the
// most generous pending deadline: aborting on the shortest would cancel a fetch
// that a more patient caller still needs. Each caller's own budget is enforced
// separately by the abort signal on its main request.
function tokenTimeoutFor(key: string): number {
  const deadlines = tokenBudgets.get(key);
  const budget =
    deadlines && deadlines.size > 0
      ? Math.max(...deadlines) - Date.now()
      : DEFAULT_TOKEN_TIMEOUT_MS;
  return Math.max(budget, MIN_TOKEN_TIMEOUT_MS);
}

// Registers `deadline` for the duration of `work`, so a token fetch triggered by
// it is bounded by this caller's remaining budget.
async function withTokenBudget<T>(key: string, deadline: number, work: () => Promise<T>): Promise<T> {
  let deadlines = tokenBudgets.get(key);
  if (!deadlines) {
    deadlines = new Set();
    tokenBudgets.set(key, deadlines);
  }
  deadlines.add(deadline);
  try {
    return await work();
  } finally {
    deadlines.delete(deadline);
    if (deadlines.size === 0) {
      tokenBudgets.delete(key);
    }
  }
}

function credentialFingerprint(config: SNConfig): string {
  // Key managers by the full secret set, not just instance+clientId. Two users
  // on one instance (or the same user after a password/secret rotation) would
  // otherwise share a cached token and act as the wrong — or stale — identity.
  // The method + jwt key + api key are included so distinct grants configured
  // with the same client secret never collide on one cached token.
  return createHash("sha256")
    .update(
      [
        config.password,
        config.clientSecret ?? "",
        config.authMethod ?? "",
        config.jwtKey ?? "",
        config.apiKey ?? "",
      ].join("\0")
    )
    .digest("hex");
}

// Read PEM material that may be supplied inline (starts with a PEM armor) or as
// a filesystem path. Used for the JWT bearer signing key (SN_JWT_KEY).
//
// REV-208: readFileSync must never throw its own error out of here. Node puts the
// path argument into the message verbatim ("ENOENT: no such file or directory, open
// '<value>'", or ENAMETOOLONG for anything past the OS filename limit) and also
// attaches it as `err.path`. This function reaches the filesystem for exactly the
// values that are NOT armored, so a key supplied base64-encoded — the standard way
// to carry a PEM in one environment variable or CI secret — becomes a private key
// reproduced in full inside an error message. From a tool failure that message fans
// out to all three sinks index.ts builds: the stderr logger (no redaction), the
// audit event, and the structured error text returned to the client. The audit
// scanner cannot save it: audit.ts matches literal `-----BEGIN ... PRIVATE KEY-----`
// armor, precisely the shape short-circuited above, and the message is well under
// SECRET_SCAN_BUDGET.
//
// The replacement keeps every fact needed to debug a genuine path typo — which
// setting was read, that it was read as a path, the fs error code, the value's size
// — and none of the value. The original error is deliberately not attached as
// `cause`, since a cause chain is stringified by enough loggers that keeping it
// would re-open the leak one indirection later.
function readPemMaterial(value: string): string {
  if (value.includes("-----BEGIN")) {
    return value;
  }
  try {
    return readFileSync(value, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(
      `Could not read the JWT signing key: the configured value carries no PEM armor, ` +
        `so it was treated as a filesystem path and reading it failed with ${code} ` +
        `(${Buffer.byteLength(value, "utf-8")} bytes supplied). Point ${JWT_KEY_ENV} at a ` +
        `readable .pem file, or supply the key inline including its ` +
        `"-----BEGIN ... PRIVATE KEY-----" lines. The value itself is withheld from ` +
        `this message because it may be the key.`
    );
  }
}

// Translate a resolved config into the OAuth grant descriptor the shared token
// manager consumes. Mirrors the core CLI's buildClientAuth so the two clients
// cannot drift on grant selection. Only called when the config uses OAuth.
function buildOAuthConfig(config: SNConfig, baseUrl: string): OAuthConfig {
  const clientId = config.clientId as string;
  const clientSecret = config.clientSecret as string;
  if (config.authMethod === "oauth-client-credentials") {
    return { clientId, clientSecret, grantType: "client_credentials" };
  }
  if (config.authMethod === "oauth-jwt-bearer") {
    const keyPem = readPemMaterial(config.jwtKey || "");
    return {
      clientId,
      clientSecret,
      grantType: "jwt-bearer",
      // A fresh, unexpired assertion is minted for every acquisition.
      buildAssertion: () =>
        createJwtAssertion(
          keyPem,
          buildJwtClaims({
            iss: config.jwtIss,
            sub: config.jwtSub,
            aud: config.jwtAud,
            clientId,
            user: config.user || undefined,
            instanceBaseUrl: baseUrl,
            nowSeconds: Math.floor(Date.now() / 1000),
          }),
          config.jwtKid ? { kid: config.jwtKid } : {}
        ),
    };
  }
  return { clientId, clientSecret, grantType: "password" };
}

// Whether this config authenticates with an OAuth Bearer token. Backward
// compatible: an unset method with a client id+secret pair still means the
// password grant, exactly as before the multi-method work.
function usesOAuth(config: SNConfig): boolean {
  const method = config.authMethod;
  if (
    method === "oauth-password" ||
    method === "oauth-client-credentials" ||
    method === "oauth-jwt-bearer"
  ) {
    return !!(config.clientId && config.clientSecret);
  }
  if (!method) {
    return !!(config.clientId && config.clientSecret);
  }
  return false;
}

// Non-OAuth Authorization headers: the inbound API key header, or Basic when a
// username+password are present. Returns none for an mTLS-only config, where the
// client certificate is the identity and no Authorization header is sent.
function staticAuthHeaders(config: SNConfig): Record<string, string> {
  if (config.authMethod === "api-key" && config.apiKey) {
    return { [apiKeyHeaderName(config.apiKeyHeader)]: config.apiKey };
  }
  if (config.authMethod === "bearer" && config.bearerToken) {
    return { Authorization: `Bearer ${config.bearerToken}` };
  }
  if (config.user && config.password) {
    return {
      Authorization: `Basic ${Buffer.from(
        `${config.user}:${config.password}`
      ).toString("base64")}`,
    };
  }
  return {};
}

// Cache one undici dispatcher per distinct TLS material + proxy environment so
// mutual-TLS / custom-CA / proxied connections reuse a single dispatcher across
// the long-running server instead of rebuilding (and re-reading the cert/key
// files) on every request.
const dispatchers = new Map<string, Dispatcher>();

// Bound the dispatcher cache the same way as the token managers so an unbounded
// set of distinct TLS materials cannot leak Agents (and their socket pools) for
// the life of the process. (REV-109)
const MAX_CACHED_DISPATCHERS = 32;

// Test seam: dispatcher cache is module state.
export function clearDispatcherCache(): void {
  dispatchers.clear();
}

// Evict the least-recently-used dispatchers until there is room for one more,
// closing each victim so its socket pools are released. Insertion order is LRU
// because getDispatcher re-inserts an entry on every cache hit. (REV-109)
function evictDispatchersToCap(): void {
  while (dispatchers.size >= MAX_CACHED_DISPATCHERS) {
    const oldest = dispatchers.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    const victim = dispatchers.get(oldest);
    dispatchers.delete(oldest);
    void victim?.close().catch(() => {});
  }
}

// Test seam: expose cache occupancy and caps so LRU eviction is observable in
// unit tests without reaching into these module-private Maps.
export function getCacheStatsForTest(): {
  tokenManagers: number;
  dispatchers: number;
  maxTokenManagers: number;
  maxDispatchers: number;
} {
  return {
    tokenManagers: tokenManagers.size,
    dispatchers: dispatchers.size,
    maxTokenManagers: MAX_CACHED_TOKEN_MANAGERS,
    maxDispatchers: MAX_CACHED_DISPATCHERS,
  };
}

// A cert/key/CA renewed in place keeps its path but changes its bytes (and mtime).
// Folding each file's mtimeMs into the cache key means an in-place rotation drops
// the stale Agent and rebuilds one with the fresh material, instead of pinning the
// expired cert until the process restarts (a total mTLS outage at cert expiry).
// (REV-92)
function certFileStamp(certPath?: string): string {
  if (!certPath) {
    return "";
  }
  try {
    return String(statSync(certPath).mtimeMs);
  } catch {
    // A missing file is surfaced loudly by the readFileSync below; keep the key
    // stable here so that clear error path stays unchanged.
    return "missing";
  }
}

// Sample the proxy configuration from an env object, mirroring undici's own
// EnvHttpProxyAgent precedence exactly: the lowercase variable wins over the
// uppercase one (`http_proxy ?? HTTP_PROXY`, etc.), and because `??` only skips
// nullish values an empty lowercase variable masks a populated uppercase one.
// Empty strings then count as unset, so `HTTPS_PROXY=` disables proxying. (G9)
function proxyEnv(env: NodeJS.ProcessEnv): {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
} {
  const pick = (lower?: string, upper?: string): string | undefined => {
    const value = lower ?? upper;
    return value ? value : undefined;
  };
  return {
    httpProxy: pick(env.http_proxy, env.HTTP_PROXY),
    httpsProxy: pick(env.https_proxy, env.HTTPS_PROXY),
    noProxy: pick(env.no_proxy, env.NO_PROXY),
  };
}

// EnvHttpProxyAgent's TS Options type omits `requestTls` (it belongs to the
// inner ProxyAgent), but the constructor forwards every non-proxy option to its
// inner ProxyAgent(s) verbatim, so it is honoured at runtime. Widen the type
// narrowly here instead of casting through `any`. (G9)
type EnvProxyOptions = EnvHttpProxyAgent.Options & {
  requestTls?: buildConnector.BuildOptions;
};

// Build (or reuse) the undici dispatcher for a config: an Agent that carries
// the client certificate / custom CA, an EnvHttpProxyAgent when a proxy is set,
// or the two combined. Returns undefined when default TLS applies and no proxy
// is configured, so callers omit the dispatcher and let global fetch use its
// built-in agent. Exported as a test seam so the dispatcher-building path can
// be exercised without a live handshake.
//
// (G9) Corporate proxies: native fetch ignores HTTP_PROXY/HTTPS_PROXY/NO_PROXY,
// so behind a proxy the MCP client could not reach the instance at all.
// EnvHttpProxyAgent implements the standard semantics of those variables —
// including NO_PROXY host/port/wildcard matching — so we do not hand-roll them.
// The sampled env is folded into the cache key so a changed proxy setting
// rebuilds the dispatcher instead of reusing a stale one.
export function getDispatcher(
  config: SNConfig,
  env: NodeJS.ProcessEnv = process.env
): Dispatcher | undefined {
  const { httpProxy, httpsProxy, noProxy } = proxyEnv(env);
  // NO_PROXY alone is a no-op: with no proxy URL there is nothing to bypass.
  const hasProxy = Boolean(httpProxy || httpsProxy);
  if (!hasProxy && !config.tlsCustom) {
    return undefined;
  }
  const key = [
    config.caBundlePath ?? "",
    certFileStamp(config.caBundlePath),
    config.clientCertPath ?? "",
    certFileStamp(config.clientCertPath),
    config.clientKeyPath ?? "",
    certFileStamp(config.clientKeyPath),
    config.clientKeyPassphrase ?? "",
    config.rejectUnauthorized === false ? "0" : "1",
    httpProxy ?? "",
    httpsProxy ?? "",
    noProxy ?? "",
  ].join("|");
  const existing = dispatchers.get(key);
  if (existing) {
    // LRU touch: re-insert so this material moves to the most-recently-used end.
    dispatchers.delete(key);
    dispatchers.set(key, existing);
    return existing;
  }
  // TLS overrides only for tlsCustom configs. With default TLS and a proxy, no
  // connect options are passed at all, so the default trust store applies and
  // NODE_EXTRA_CA_CERTS keeps working. (G9)
  let connect: Record<string, unknown> | undefined;
  if (config.tlsCustom) {
    connect = {
      rejectUnauthorized: config.rejectUnauthorized !== false,
    };
    if (config.caBundlePath) {
      connect.ca = readFileSync(config.caBundlePath);
    }
    // A client cert/key misconfiguration must be loud, not silently downgraded to
    // no-mTLS — readFileSync throws here and surfaces the bad path immediately.
    if (config.clientCertPath) {
      connect.cert = readFileSync(config.clientCertPath);
    }
    if (config.clientKeyPath) {
      connect.key = readFileSync(config.clientKeyPath);
    }
    if (config.clientKeyPassphrase) {
      connect.passphrase = config.clientKeyPassphrase;
    }
  }
  let dispatcher: Dispatcher;
  if (hasProxy) {
    // EnvHttpProxyAgent forwards all non-proxy options to BOTH its inner direct
    // Agent (used for NO_PROXY-bypassed hosts, which honours `connect`) and its
    // inner ProxyAgent(s) (which build the origin TLS through the CONNECT
    // tunnel from `requestTls` and override a generic `connect` with their own
    // tunnel connector), so custom TLS material must travel under both names.
    // The proxy fields are passed explicitly — empty string for unset — to pin
    // the dispatcher to the env sampled for the cache key above, instead of
    // letting undici re-read process.env behind our back. (G9)
    const options: EnvProxyOptions = {
      httpProxy: httpProxy ?? "",
      httpsProxy: httpsProxy ?? "",
      noProxy: noProxy ?? "",
    };
    if (connect) {
      options.connect = connect;
      options.requestTls = connect;
    }
    dispatcher = new EnvHttpProxyAgent(options);
  } else {
    // No proxy: today's direct-Agent path, reached only for tlsCustom configs
    // (the default-TLS, no-proxy case returned undefined above).
    dispatcher = new Agent({ connect });
  }
  evictDispatchersToCap();
  dispatchers.set(key, dispatcher);
  return dispatcher;
}

// REV-153: the key carried no TLS material, so two configs that differ ONLY in
// their client certificate / CA (same instance, user, client id and secrets)
// collided on one cached token manager — and the survivor's poster closure was
// pinned to the FIRST config's TLS paths, so the second identity's token leg
// silently presented the wrong client certificate. The paths (not their mtimes)
// are folded in: rotating a cert in place must not throw away a still-valid
// token, and freshness of the material is handled per POST by getDispatcher.
function tokenManagerTlsKey(config: SNConfig): string {
  return [
    config.tlsCustom ? "1" : "0",
    config.caBundlePath ?? "",
    config.clientCertPath ?? "",
    config.clientKeyPath ?? "",
    config.rejectUnauthorized === false ? "0" : "1",
  ].join("|");
}

function tokenManagerKey(config: SNConfig): string {
  return `${config.instance}|${config.user}|${config.clientId ?? ""}|${credentialFingerprint(
    config
  )}|${tokenManagerTlsKey(config)}`;
}

function getTokenManager(config: SNConfig, baseUrl: string): TokenManager {
  const key = tokenManagerKey(config);
  const existing = tokenManagers.get(key);
  if (existing) {
    // LRU touch: re-insert so this identity moves to the most-recently-used end.
    tokenManagers.delete(key);
    tokenManagers.set(key, existing);
    return existing;
  }
  const poster: TokenPoster = async (tokenPath, body) => {
    // REV-153: the dispatcher used to be resolved ONCE, when the token manager was
    // created, and captured here for the life of the process. That pinned the token
    // leg to a single Agent, so (a) an in-place cert rotation rebuilt the dispatcher
    // for data requests but the token endpoint kept presenting the expired material
    // until restart — defeating REV-92 exactly where it matters, since a failing
    // token leg breaks every OAuth call — and (b) once the LRU evicted (and closed)
    // that Agent, every later token POST hit a destroyed client. Resolve per POST:
    // getDispatcher is a cheap cache hit in the steady state and rebuilds on demand.
    const dispatcher = getDispatcher(config);
    const init: FetchInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(tokenTimeoutFor(key)),
    };
    if (dispatcher) {
      init.dispatcher = dispatcher;
    }
    const res = await fetch(`${baseUrl}${tokenPath}`, init);
    const text = await res.text();
    if (!res.ok) {
      // The token endpoint returns 4xx/5xx with an error body (often HTML on a
      // gateway failure). Surface a clear error instead of letting JSON.parse
      // throw a cryptic SyntaxError or — worse — caching `Bearer undefined`.
      // `httpStatus` lets a caller tell a rejected credential (4xx) from a
      // transient token-endpoint failure (5xx), as core reads its axios error.
      throw Object.assign(
        new Error(
          `OAuth token request failed (${res.status} ${res.statusText}): ${text.slice(0, 200)}`
        ),
        { httpStatus: res.status }
      );
    }
    try {
      return JSON.parse(text) as OAuthTokenResponse;
    } catch {
      throw new Error(
        `OAuth token response was not valid JSON: ${text.slice(0, 200)}`
      );
    }
  };
  const manager = createTokenManager(
    { username: config.user, password: config.password },
    buildOAuthConfig(config, baseUrl),
    poster
  );
  evictTokenManagersToCap();
  tokenManagers.set(key, manager);
  return manager;
}

export type SecretsProvider = {
  name: string;
  load: (projectDir: string) => Record<string, string>;
};

const MAX_REQUEST_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 120;
// Per-attempt timeout floor. The deadline is shared across attempts and the
// backoff sleeps draw from the same budget, so a later retry could otherwise be
// handed a ~1ms timeout and abort before the request even leaves — making the
// retry pointless. Guarantee each attempt at least this much (capped by the
// caller's own timeout so a tiny timeout is still honoured).
const MIN_ATTEMPT_TIMEOUT_MS = 1000;

// ERR-1: only idempotent methods may be re-sent freely. A non-idempotent write
// (POST/PATCH) that already reached the instance must never be replayed — a
// re-sent POST can start a background script twice or create a duplicate record.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Syscall codes that prove the request never left the client, so re-sending a
// non-idempotent write is safe. undici wraps network failures in a TypeError
// whose `.cause` carries the underlying syscall `code`; a client-side timeout
// abort is NOT here (the server may still be executing the aborted request).
const PRE_SEND_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

const preSendErrorCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

export function cleanEnvValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export function parseDotEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = cleanEnvValue(trimmed.slice(idx + 1));
    result[key] = value;
  }

  return result;
}

function loadFromProcessEnv(): Record<string, string> {
  return {
    SN_INSTANCE: cleanEnvValue(process.env.SN_INSTANCE || ""),
    SN_USER: cleanEnvValue(process.env.SN_USER || ""),
    SN_PASSWORD: cleanEnvValue(process.env.SN_PASSWORD || ""),
  };
}

function loadFromAuthStore(): Record<string, string> {
  const activeInstance = getActiveInstanceSync();
  if (!activeInstance) {
    return {};
  }

  const creds = loadCredentialsSync(activeInstance);
  if (!creds) {
    return {};
  }

  return {
    SN_INSTANCE: cleanEnvValue(creds.instance || activeInstance || ""),
    SN_USER: cleanEnvValue(creds.user || ""),
    // REV-157: cleanEnvValue trims whitespace and strips one leading/trailing
    // quote — dotenv semantics, applied here to a secret that never went through
    // dotenv. The credential store deliberately keeps passwords verbatim
    // (see normalizeStoredCredentials: "Do not coerce/trim secrets"), and the core
    // CLI uses them verbatim, so a password like `"pa$$` or one with a trailing
    // space authenticated from the CLI but was silently mangled here into a 401
    // that looks like a wrong password rather than a client-side bug.
    SN_PASSWORD: creds.password || "",
  };
}

export function loadAuthStoreProfile(instanceName: string): SNConfig | null {
  const cleaned = cleanEnvValue(instanceName);
  if (!cleaned) {
    return null;
  }

  const creds = loadCredentialsSync(cleaned);
  if (!creds) {
    return null;
  }

  const instance = cleanEnvValue(creds.instance || cleaned);
  const user = cleanEnvValue(creds.user || "");
  // REV-157: store-origin secret, used verbatim — see loadFromAuthStore.
  const password = creds.password || "";
  if (!instance || !user || !password) {
    return null;
  }
  return { instance, user, password };
}

function loadFromDotEnv(projectDir: string): Record<string, string> {
  const envPath = path.join(projectDir, ".env");
  try {
    return parseDotEnv(readFileSync(envPath, "utf-8"));
  } catch (error) {
    logger.debug("secrets.dotenv.read_failed", {
      path: envPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function loadFromSecretsFile(projectDir: string): Record<string, string> {
  const fromEnv = cleanEnvValue(process.env.SYNCRONA_SECRETS_FILE || "");
  const secretsPath = fromEnv || path.join(projectDir, ".syncrona-mcp", "secrets.json");
  if (!existsSync(secretsPath)) {
    return {};
  }

  try {
    const parsed = asRecord(JSON.parse(readFileSync(secretsPath, "utf-8")));
    const serviceNow = asRecord(parsed.servicenow);

    const instance = cleanEnvValue(
      String(parsed.SN_INSTANCE || serviceNow.instance || "")
    );
    const user = cleanEnvValue(String(parsed.SN_USER || serviceNow.user || ""));
    const password = cleanEnvValue(
      String(parsed.SN_PASSWORD || serviceNow.password || "")
    );

    return {
      SN_INSTANCE: instance,
      SN_USER: user,
      SN_PASSWORD: password,
    };
  } catch (error) {
    logger.debug("secrets.file.parse_failed", {
      path: secretsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

// Provider precedence mirrors the core CLI, where project-local sources
// (.env loaded into the environment) win over the global credential store:
// process env > explicit MCP secrets file > project .env > auth store.
const DEFAULT_SECRETS_PROVIDERS: SecretsProvider[] = [
  {
    name: "process-env",
    load: () => loadFromProcessEnv(),
  },
  {
    name: "secrets-file",
    load: (projectDir: string) => loadFromSecretsFile(projectDir),
  },
  {
    name: "dotenv",
    load: (projectDir: string) => loadFromDotEnv(projectDir),
  },
  {
    name: "auth-store",
    load: () => loadFromAuthStore(),
  },
];

// Resolving secrets touches the filesystem and (for the auth store) runs a
// blocking scrypt key derivation, so the result is cached per projectDir for
// a short TTL instead of being recomputed on every ServiceNow request.
const SECRETS_CACHE_TTL_MS = 30_000;
const secretsCache = new Map<string, { config: SNConfig; expiresAt: number }>();

export function clearServiceNowSecretsCache(): void {
  secretsCache.clear();
}

export function resolveServiceNowSecrets(
  projectDir: string = process.cwd(),
  providers: SecretsProvider[] = DEFAULT_SECRETS_PROVIDERS
): SNConfig {
  const merged: Record<string, string> = {
    SN_INSTANCE: "",
    SN_USER: "",
    SN_PASSWORD: "",
  };
  // Which provider filled each key — the stored-material fallback below must
  // know whether the identity came from an env-side source or the auth store.
  const sourceByKey: Record<string, string> = {};

  for (const provider of providers) {
    // Stop as soon as every key is filled so lower-priority providers
    // (notably the scrypt-backed auth store) are not consulted needlessly.
    if (Object.values(merged).every((value) => value !== "")) {
      break;
    }
    const values = provider.load(projectDir);
    // A provider that names a different instance than the one already chosen
    // must not lend its identity to it: secrets.json pointing at the active
    // instance plus a .env for another one used to pair that .env user and
    // password with the wrong instance.
    const providerInstance = cleanEnvValue(String(values.SN_INSTANCE || ""));
    const namesOtherInstance =
      merged.SN_INSTANCE !== "" &&
      providerInstance !== "" &&
      instanceKey(providerInstance) !== instanceKey(merged.SN_INSTANCE);
    for (const key of Object.keys(merged)) {
      if (namesOtherInstance && key !== "SN_INSTANCE") {
        continue;
      }
      const raw = String(values[key] || "");
      // REV-157: this loop used to re-run cleanEnvValue over every provider's
      // output. That was a no-op for the env/.env/secrets-file providers (which
      // already normalize their own values) but silently rewrote the credential
      // store's verbatim password. Keep dotenv-style cleanup for the identifier
      // fields and pass the secret through untouched; presence is still judged on
      // the trimmed form so a whitespace-only value counts as absent, as before.
      const candidate = key === "SN_PASSWORD" ? raw : cleanEnvValue(raw);
      if (!merged[key] && candidate.trim()) {
        merged[key] = candidate;
        sourceByKey[key] = provider.name;
      }
    }
  }

  const instance = merged.SN_INSTANCE;
  const user = merged.SN_USER;
  const password = merged.SN_PASSWORD;

  // Every method targets an instance, so that is the one always-required field.
  if (!instance) {
    throw new Error(
      "Missing ServiceNow instance. Provide SN_INSTANCE via env, auth store (syncrona login), .syncrona-mcp/secrets.json, or .env in project root."
    );
  }

  // Additional auth material (OAuth client, API key, JWT) is read from the
  // process environment first, mirroring how SN_OAUTH_CLIENT_ID/SECRET have
  // always been read here.
  const env = (name: string): string => cleanEnvValue(process.env[name] || "");
  let clientId = env(OAUTH_CLIENT_ID_ENV);
  let clientSecret = env(OAUTH_CLIENT_SECRET_ENV);
  let apiKey = env(API_KEY_ENV);
  let apiKeyHeader = env(API_KEY_HEADER_ENV);
  // A pre-issued bearer token is env-only: `syncrona login` never stores one.
  const bearerToken = env(BEARER_TOKEN_ENV);
  let jwtKey = env(JWT_KEY_ENV);
  let jwtKid = env(JWT_KID_ENV);
  let jwtIss = env(JWT_ISS_ENV);
  let jwtSub = env(JWT_SUB_ENV);
  let jwtAud = env(JWT_AUD_ENV);
  let explicitMethod = env(AUTH_METHOD_ENV);

  // `syncrona login` persists the same multi-method material in the credential
  // store, and the core CLI consumes it from there (snClient's stored-credentials
  // path) — so a non-Basic login used to authenticate from the CLI while the MCP
  // server silently fell back to Basic or refused to start. Mirror the CLI here,
  // with the same all-or-nothing rule so a stored secret can never pair with an
  // env client id: the active store record supplies the method and its material
  // only when the environment supplies none, the identity did not come from an
  // env-side source, and the record targets the SAME instance (extras from login
  // X must never be sent to an env-configured instance Y). mTLS stays env-only,
  // exactly like the CLI's buildHttpsAgent.
  const identityFromEnv = ["SN_USER", "SN_PASSWORD"].some(
    (key) => merged[key] !== "" && sourceByKey[key] !== "auth-store"
  );
  const hasEnvAuthMaterial = !!(
    explicitMethod ||
    clientId ||
    clientSecret ||
    apiKey ||
    bearerToken ||
    jwtKey
  );
  if (!identityFromEnv && !hasEnvAuthMaterial) {
    const activeInstance = getActiveInstanceSync();
    const stored: StoredCredentials | null = activeInstance
      ? loadCredentialsSync(activeInstance)
      : null;
    if (stored && cleanEnvValue(stored.instance || activeInstance || "") === instance) {
      explicitMethod = stored.authMethod || "";
      clientId = stored.clientId || "";
      // REV-157: store-origin secrets are used verbatim, never dotenv-cleaned.
      clientSecret = stored.clientSecret || "";
      apiKey = stored.apiKey || "";
      jwtKey = stored.jwtKeyPath || "";
      // Non-secret modifiers keep the usual env-wins precedence.
      apiKeyHeader = apiKeyHeader || stored.apiKeyHeader || "";
      jwtKid = jwtKid || stored.jwtKid || "";
      jwtIss = jwtIss || stored.jwtIss || "";
      jwtSub = jwtSub || stored.jwtSub || "";
      jwtAud = jwtAud || stored.jwtAud || "";
    }
  }

  const resolved = resolveAuthMethod({
    explicit: explicitMethod,
    hasPassword: !!password,
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret,
    hasApiKey: !!apiKey,
    hasJwtKey: !!jwtKey,
    hasBearerToken: !!bearerToken,
  });

  // Mutual TLS / custom CA is orthogonal to the Authorization method.
  const tls = resolveTlsPolicy(
    process.env[CA_BUNDLE_ENV],
    process.env[TLS_REJECT_UNAUTHORIZED_ENV],
    process.env[CLIENT_CERT_ENV],
    process.env[CLIENT_KEY_ENV],
    process.env[CLIENT_KEY_PASSPHRASE_ENV]
  );
  const hasMtls = !!(tls.clientCertPath && tls.clientKeyPath);

  // Per-method credential validation. Basic and OAuth password additionally
  // need a username (the shared resolver only checks the password). mTLS-only
  // is allowed to skip the Authorization-material requirement, because the
  // client certificate provides transport-level identity on its own.
  const needsUser =
    resolved.method === "basic" || resolved.method === "oauth-password";
  const issues = [...resolved.issues];
  if (needsUser && !user) {
    issues.push(`${resolved.method} requires SN_USER.`);
  }
  // REV-201: the mTLS excuse used to cover EVERY issue, which quietly re-opened
  // the hole the unknown-selector check was added to close. A client certificate
  // supplies transport-level identity, so it can stand in for missing
  // Authorization material — but it says nothing about an unrecognized
  // SN_AUTH_METHOD, which is a typo that silently reroutes which grant runs.
  // Concretely: SN_AUTH_METHOD=oauth-jwt (the real name is oauth-jwt-bearer) plus
  // mTLS plus leftover client id/secret/password resolved to oauth-password and
  // posted the user's password to /oauth_token.do, with the server starting clean
  // — while README documents that it "refuses to start". So the selector fails
  // closed regardless of mTLS; only the material issues are excusable.
  if (issues.length > 0 && (!hasMtls || resolved.unknownExplicit)) {
    const prefix = resolved.unknownExplicit
      ? `Refusing to start on an unusable ServiceNow auth configuration (fell back to ${resolved.method}):`
      : `Missing ServiceNow credentials for ${resolved.method} auth:`;
    throw new Error(
      `${prefix} ${issues.join(
        " "
      )} Provide them via env, auth store (syncrona login), .syncrona-mcp/secrets.json, or .env in project root.`
    );
  }

  return {
    instance,
    user,
    password,
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
    authMethod: resolved.method,
    apiKey: apiKey || undefined,
    apiKeyHeader: apiKeyHeader || undefined,
    bearerToken: bearerToken || undefined,
    jwtKey: jwtKey || undefined,
    jwtKid: jwtKid || undefined,
    jwtIss: jwtIss || undefined,
    jwtSub: jwtSub || undefined,
    jwtAud: jwtAud || undefined,
    caBundlePath: tls.caBundlePath,
    clientCertPath: tls.clientCertPath,
    clientKeyPath: tls.clientKeyPath,
    clientKeyPassphrase: tls.clientKeyPassphrase,
    rejectUnauthorized: tls.rejectUnauthorized,
    tlsCustom: tls.custom,
  };
}

export function getServiceNowConfig(projectDir: string = process.cwd()): SNConfig {
  const cached = secretsCache.get(projectDir);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const config = resolveServiceNowSecrets(projectDir);
  secretsCache.set(projectDir, {
    config,
    expiresAt: Date.now() + SECRETS_CACHE_TTL_MS,
  });
  return config;
}

function instanceKey(instance: string): string {
  return instance.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function instanceToBaseUrl(instance: string): string {
  if (instance.startsWith("http://") || instance.startsWith("https://")) {
    return `${instance.replace(/\/$/, "")}/`;
  }
  return `https://${instance.replace(/\/$/, "")}/`;
}

export { shouldRetryStatus };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// G4: client-side rate limiting matching the core CLI's axios-rate-limit
// (shared MAX_REQUESTS_PER_SECOND policy, lowered by SN_MAX_RPS) — requests are
// spaced by a minimum interval instead of relying solely on 429 retries. The
// interval is resolved per request so the knob follows the server's env.
let nextRequestSlotAt = 0;

async function acquireRequestSlot(): Promise<void> {
  const minIntervalMs = Math.ceil(1000 / resolveMaxRequestsPerSecond(process.env[MAX_RPS_ENV]));
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestSlotAt - now);
  nextRequestSlotAt = Math.max(now, nextRequestSlotAt) + minIntervalMs;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

/** Per-call transport options for {@link snRequest} / {@link snRequestWithConfig}. */
export interface SnRequestOptions {
  /**
   * Whether a transient failure (a retryable status, a network error, a failed
   * auth-header build) is re-sent here, a few sub-second backoffs apart.
   * Default true. A caller with its own retry loop passes false so the request
   * is sent once, like core's axios client, and its loop owns every retry. The
   * OAuth 401 token refresh is not a transient retry and still happens.
   */
  retryTransient?: boolean;
}

export async function snRequest(
  method: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  projectDir: string = process.cwd(),
  options: SnRequestOptions = {}
): Promise<{ status: number; data: unknown; text: string }> {
  return snRequestWithConfig(getServiceNowConfig(projectDir), method, endpoint, body, timeoutMs, options);
}

export async function snRequestWithConfig(
  config: SNConfig,
  method: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  options: SnRequestOptions = {}
): Promise<{ status: number; data: unknown; text: string }> {
  const retryTransient = options.retryTransient !== false;
  const { instance } = config;
  const baseUrl = instanceToBaseUrl(instance);
  const startedAt = Date.now();
  // ERR-1: a POST/PATCH is only re-sent when we can prove it never reached the
  // instance (a pre-send network error). Idempotent methods retry as before.
  const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());
  // Authorization: OAuth Bearer for the OAuth grants, the inbound API-key header
  // for api-key, else Basic. One token manager per instance+client (cached) so
  // refresh persists across tool calls. An mTLS-only config sends none of these
  // (the client certificate is the identity); mTLS/custom CA is applied via the
  // dispatcher attached below.
  const useOAuth = usesOAuth(config);
  const tokens = useOAuth ? getTokenManager(config, baseUrl) : null;
  const tokenKey = tokenManagerKey(config);
  const dispatcher = getDispatcher(config);
  let oauthRetried = false;

  const remainingBudget = (): number => {
    const elapsed = Date.now() - startedAt;
    return Math.max(timeoutMs - elapsed, Math.min(timeoutMs, MIN_ATTEMPT_TIMEOUT_MS));
  };

  const buildAuthHeaders = async (): Promise<Record<string, string>> =>
    tokens
      ? {
          Authorization: `Bearer ${await withTokenBudget(
            tokenKey,
            Date.now() + remainingBudget(),
            () => tokens.getToken()
          )}`,
        }
      : staticAuthHeaders(config);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    await acquireRequestSlot();

    // Resolve auth BEFORE arming the timer: token acquisition has its own budget
    // (this controller cannot cancel it), and arming first would let a slow token
    // fetch abort the signal so the request below rejects instantly without ever
    // being sent — burning a retry attempt.
    let authHeaders: Record<string, string>;
    try {
      authHeaders = await buildAuthHeaders();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_REQUEST_ATTEMPTS || !retryTransient) {
        throw error;
      }
      await sleep(Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 800));
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingBudget());

    try {
      const requestInit: FetchInit = {
        method,
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, text/html",
        },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      };
      if (dispatcher) {
        requestInit.dispatcher = dispatcher;
      }
      const response = await fetch(
        `${baseUrl}${endpoint.replace(/^\//, "")}`,
        requestInit
      );

      // OAuth: a 401 usually means the token expired — refresh once and retry.
      if (tokens && response.status === 401 && attempt < MAX_REQUEST_ATTEMPTS) {
        if (!oauthRetried) {
          oauthRetried = true;
          await tokens.forceRefresh();
          continue;
        }
        // A 401 that SURVIVED the forced refresh means the cached credentials
        // themselves are stale — e.g. rotated on the instance while the 30s
        // secrets cache still holds the old secret. Drop this token manager and
        // bust the secrets cache so the NEXT request re-resolves fresh
        // credentials instead of serving the stale token for the rest of the
        // SECRETS_CACHE_TTL_MS window. (REV-109)
        tokenManagers.delete(tokenKey);
        clearServiceNowSecretsCache();
      }

      const text = await response.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch (_) {}

      // Only idempotent methods may be re-sent on a retryable status: a 5xx can
      // arrive AFTER a POST already committed on the instance, so replaying it
      // would double-apply the write. A non-idempotent method returns its
      // response to the caller unretried. (ERR-1)
      if (
        retryTransient &&
        attempt < MAX_REQUEST_ATTEMPTS &&
        shouldRetryStatus(response.status) &&
        isIdempotent
      ) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 800);
        await sleep(delay);
        continue;
      }

      return {
        status: response.status,
        data,
        text,
      };
    } catch (error) {
      lastError = error;
      // ERR-1: a non-idempotent method is retried ONLY on a pre-send network
      // error (connection refused / DNS failure) that proves the request never
      // reached the instance. A client-side timeout abort is not re-sent — the
      // server may still be executing the aborted write. Idempotent methods
      // retry on any transient failure as before.
      const neverReachedServer = PRE_SEND_ERROR_CODES.has(
        preSendErrorCode(error) ?? ""
      );
      const mayRetry = retryTransient && (isIdempotent || neverReachedServer);
      if (attempt >= MAX_REQUEST_ATTEMPTS || !mayRetry) {
        throw error;
      }
      const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 800);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("ServiceNow request failed after retry attempts.");
}

// snRequest falls back to the raw text when a body is not JSON, and
// toTableResultRows reads anything without a `result` array as no rows. A 2xx
// that is not a Table API JSON object (a login or maintenance page served as
// HTML, for instance) must therefore be rejected before it is read as an empty
// result. Returns a description of the bad payload, or null for a Table API one.
export function describeNonTablePayload(status: number, data: unknown): string | null {
  const isTablePayload =
    !!data && typeof data === "object" && !Array.isArray(data) &&
    Array.isArray((data as Record<string, unknown>).result);
  if (isTablePayload) {
    return null;
  }
  const kind = typeof data === "string" ? "a non-JSON body" : "an unexpected JSON payload";
  return (
    `HTTP ${status} with ${kind} instead of a Table API result; ` +
    "the instance may be serving a login or maintenance page"
  );
}

// A session that expired or was never accepted is answered with the login form
// and a 2xx status. Only a non-JSON body is checked, and only for the form's
// markup (a password input or a form posting to login.do): script output that
// merely mentions login.do is HTML-escaped by sys.scripts.do, and a custom
// endpoint answers JSON, so it does not match.
export function describeLoginPage(data: unknown): string | null {
  if (typeof data !== "string") {
    return null;
  }
  const isLoginForm =
    /<input\b[^>]*\bname\s*=\s*["']user_password["']/i.test(data) ||
    /<form\b[^>]*\baction\s*=\s*["'][^"']*login\.do/i.test(data);
  return isLoginForm
    ? "the instance answered with its login page; the credentials or session were not accepted"
    : null;
}

// The single-record counterpart of describeNonTablePayload, for a POST or PATCH
// whose Table API answer is `result` as one object. A 2xx without a record that
// carries a sys_id (a login page, an empty body, a proxy's JSON) means nothing is
// known to have been written, so it must not read as a created or updated record.
export function describeNonRecordPayload(status: number, data: unknown): string | null {
  const result =
    !!data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).result
      : undefined;
  const isRecord =
    !!result && typeof result === "object" && !Array.isArray(result) &&
    typeof (result as Record<string, unknown>).sys_id === "string" &&
    ((result as Record<string, unknown>).sys_id as string).length > 0;
  if (isRecord) {
    return null;
  }
  const kind = typeof data === "string" ? "a non-JSON body" : "a payload without a record sys_id";
  return (
    `HTTP ${status} with ${kind} instead of a Table API record; ` +
    "the instance may be serving a login or maintenance page"
  );
}

export function toTableResultRows(data: unknown): Record<string, unknown>[] {
  const obj = asRecord(data);
  const result = obj.result;
  if (!Array.isArray(result)) {
    return [];
  }
  return result.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === "object"
  );
}

export function summarizeRows(
  rows: Record<string, unknown>[],
  analyzeField: string
): Record<string, number> {
  // Field values come from the instance, so a value such as "constructor" or
  // "__proto__" must not resolve to an inherited Object.prototype member.
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[analyzeField] ?? "<empty>");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

type BackgroundScriptResponse = { status: number; data: unknown; text: string; usedEndpoint: string };

const SCRIPTS_BACKGROUND_ENDPOINT = `/${SCRIPTS_BACKGROUND_PATH}`;

/**
 * A short-lived UI session against the instance: a cookie jar plus the
 * Authorization headers the REST transport would send, over the same mTLS /
 * custom-CA dispatcher and request pacing. Redirects are not followed, so a
 * login or session-timeout redirect surfaces instead of being silently chased.
 */
class UiSession {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly dispatcher: Dispatcher | undefined,
    private readonly signal: AbortSignal
  ) {}

  async send(
    method: "GET" | "POST",
    pathName: string,
    form?: Record<string, string>
  ): Promise<{ status: number; location: string; text: string }> {
    await acquireRequestSlot();
    const headers: Record<string, string> = {
      ...this.headers,
      Accept: "text/html,application/xhtml+xml,text/plain",
    };
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    const init: FetchInit = { method, headers, redirect: "manual", signal: this.signal };
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }
    if (this.dispatcher) {
      init.dispatcher = this.dispatcher;
    }
    const response = await fetch(`${this.baseUrl}${pathName}`, init);
    const responseHeaders = response.headers as Headers | undefined;
    const setCookies =
      responseHeaders && typeof responseHeaders.getSetCookie === "function"
        ? responseHeaders.getSetCookie()
        : [];
    for (const cookie of setCookies) {
      const pair = cookie.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return {
      status: response.status,
      location: (responseHeaders && typeof responseHeaders.get === "function" && responseHeaders.get("location")) || "",
      text: await response.text(),
    };
  }
}

// Basic credentials (and the OAuth password grant, which carries the same user
// and password) open the session through the standard login form: the instance
// does not render UI pages for a Basic-authenticated request (it answers an
// empty 200), so a header alone never yields the CSRF token. The other methods
// have no password to post and rely on their Authorization header instead.
function signsInWithPassword(config: SNConfig): boolean {
  const method = config.authMethod;
  if (method === "api-key" || method === "bearer" || method === "oauth-client-credentials" || method === "oauth-jwt-bearer") {
    return false;
  }
  return !!(config.user && config.password);
}

function backgroundScriptFailure(status: number, reason: string, body: string): BackgroundScriptResponse {
  // A login page stays the data so describeLoginPage still names it; any other
  // body is replaced by the reason, which is what the caller needs to read.
  const data = describeLoginPage(body) ? body : { error: reason };
  return { status, data, text: reason, usedEndpoint: SCRIPTS_BACKGROUND_ENDPOINT };
}

/**
 * Runs a server-side script on the instance.
 *
 * Without `endpointPath` the script goes through the platform's own
 * "Scripts - Background" page (sys.scripts.do), which every instance has, so no
 * scoped application has to be installed: sign in to a UI session, read the
 * session's CSRF token from the form, post the form, parse the output, sign out.
 * The script runs in the global scope with the platform's own transaction quota,
 * and the platform records it in sys_script_execution_history. A 2xx answer
 * carries `data.result` = { output, scope, executionHistoryId, error? }; a session
 * or CSRF failure is reported as a non-2xx status without the script having run.
 *
 * With `endpointPath` the script is posted as `{ script }` JSON to that REST
 * endpoint instead — for an instance that exposes its own execution API.
 */
export async function runBackgroundScript(
  script: string,
  timeoutMs: number,
  endpointPath?: string,
  projectDir: string = process.cwd()
): Promise<BackgroundScriptResponse> {
  if (typeof endpointPath === "string" && endpointPath.trim().length > 0) {
    return {
      ...(await snRequest("POST", endpointPath, { script }, timeoutMs, projectDir)),
      usedEndpoint: endpointPath,
    };
  }

  return withUiSession(timeoutMs, projectDir, async (session) => {
    const form = await openScriptsBackgroundForm(session);
    if ("failure" in form) {
      return form.failure;
    }
    const posted = await session.send("POST", SCRIPTS_BACKGROUND_PATH, {
      script,
      runscript: "Run script",
      sysparm_ck: form.csrfToken,
      sys_scope: "global",
      quota_managed_transaction: "on",
    });
    const parsed = parseScriptsBackgroundResponse(posted.text);
    if (!parsed) {
      const reason = posted.text.trim() === "not authorized"
        ? "sys.scripts.do rejected the session's CSRF token; the script did not run"
        : `sys.scripts.do answered HTTP ${posted.status} without a script result; the script did not run`;
      const status = posted.status >= 200 && posted.status < 300 ? 502 : posted.status;
      return backgroundScriptFailure(status, reason, posted.text);
    }
    return {
      status: posted.status,
      data: { result: parsed },
      text: parsed.output,
      usedEndpoint: SCRIPTS_BACKGROUND_ENDPOINT,
    };
  });
}

/**
 * Read-only reachability probe for {@link runBackgroundScript}: opens the UI
 * session and renders the background-script form, but posts nothing.
 */
export async function probeBackgroundScriptPage(
  timeoutMs: number,
  projectDir: string = process.cwd()
): Promise<BackgroundScriptResponse> {
  return withUiSession(timeoutMs, projectDir, async (session) => {
    const form = await openScriptsBackgroundForm(session);
    if ("failure" in form) {
      return form.failure;
    }
    return {
      status: 200,
      data: { result: { csrfToken: "present" } },
      text: "sys.scripts.do form rendered with a CSRF token",
      usedEndpoint: SCRIPTS_BACKGROUND_ENDPOINT,
    };
  });
}

async function openScriptsBackgroundForm(
  session: UiSession
): Promise<{ csrfToken: string } | { failure: BackgroundScriptResponse }> {
  const page = await session.send("GET", SCRIPTS_BACKGROUND_PATH);
  const csrfToken = page.status >= 200 && page.status < 300 ? extractCsrfToken(page.text) : null;
  if (csrfToken) {
    return { csrfToken };
  }
  const where = page.location ? ` (redirected to ${page.location})` : "";
  const reason =
    `sys.scripts.do did not render its form for this session: HTTP ${page.status}${where}. ` +
    "Background scripts need an interactive session of a user with the admin role; " +
    "check the credentials, multi-factor or SSO enforcement, and the user's roles";
  const status = page.status >= 200 && page.status < 300 ? 401 : page.status;
  return { failure: backgroundScriptFailure(status, reason, page.text) };
}

async function withUiSession(
  timeoutMs: number,
  projectDir: string,
  work: (session: UiSession) => Promise<BackgroundScriptResponse>
): Promise<BackgroundScriptResponse> {
  const config = getServiceNowConfig(projectDir);
  const baseUrl = instanceToBaseUrl(config.instance);
  const withPassword = signsInWithPassword(config);

  // Resolve auth BEFORE arming the abort timer — the same ordering rule as
  // snRequestWithConfig. The token leg is bounded by its own budget, and arming
  // first would let a slow token acquisition abort the signal so the requests
  // below reject without ever being sent, the budget silently consumed by auth.
  let headers: Record<string, string> = {};
  if (!withPassword) {
    headers = usesOAuth(config)
      ? {
          Authorization: `Bearer ${await withTokenBudget(
            tokenManagerKey(config),
            Date.now() + timeoutMs,
            () => getTokenManager(config, baseUrl).getToken()
          )}`,
        }
      : staticAuthHeaders(config);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const session = new UiSession(baseUrl, headers, getDispatcher(config), controller.signal);
  try {
    if (withPassword) {
      const login = await session.send("POST", "login.do", {
        user_name: config.user,
        user_password: config.password,
        sys_action: "sysverb_login",
        sysparm_login_url: "welcome.do",
      });
      if (login.status >= 400) {
        return backgroundScriptFailure(
          login.status,
          `Signing in through login.do failed with HTTP ${login.status}; the script did not run`,
          login.text
        );
      }
    }
    return await work(session);
  } finally {
    // Sign the session out so each call leaves no UI session behind. Best effort:
    // the work's own answer stands whatever happens here.
    if (withPassword && !controller.signal.aborted) {
      await session.send("GET", "logout.do").catch(() => undefined);
    }
    clearTimeout(timer);
  }
}

export function hasEnvFile(projectDir: string = process.cwd()): boolean {
  return existsSync(path.join(projectDir, ".env"));
}
