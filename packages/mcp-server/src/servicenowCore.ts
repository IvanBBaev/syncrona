// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import {
  getActiveInstanceSync,
  loadCredentialsSync,
} from "@syncrona/credential-store";
import {
  DEFAULT_SCOPED_API_PREFIXES,
  MAX_REQUESTS_PER_SECOND,
  SCOPED_API_PREFIXES_ENV,
  isEndpointNotFoundStatus,
  orderScopedApiPrefixes,
  parseConfiguredScopedApiPrefixes,
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
function readPemMaterial(value: string): string {
  if (value.includes("-----BEGIN")) {
    return value;
  }
  return readFileSync(value, "utf-8");
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

function tokenManagerKey(config: SNConfig): string {
  return `${config.instance}|${config.user}|${config.clientId ?? ""}|${credentialFingerprint(
    config
  )}`;
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
  const dispatcher = getDispatcher(config);
  const poster: TokenPoster = async (tokenPath, body) => {
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
      throw new Error(
        `OAuth token request failed (${res.status} ${res.statusText}): ${text.slice(0, 200)}`
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

let cachedScopedApiPrefix: string | null = null;

// Test seam: the last-successful-prefix cache is module state and otherwise
// leaks ordering effects between unit tests.
export function clearScopedApiPrefixCache(): void {
  cachedScopedApiPrefix = null;
}

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
    SN_PASSWORD: cleanEnvValue(creds.password || ""),
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
  const password = cleanEnvValue(creds.password || "");
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

  for (const provider of providers) {
    // Stop as soon as every key is filled so lower-priority providers
    // (notably the scrypt-backed auth store) are not consulted needlessly.
    if (Object.values(merged).every((value) => value !== "")) {
      break;
    }
    const values = provider.load(projectDir);
    for (const key of Object.keys(merged)) {
      const candidate = cleanEnvValue(String(values[key] || ""));
      if (!merged[key] && candidate) {
        merged[key] = candidate;
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

  // Additional auth material (OAuth client, API key, JWT, mTLS) is read straight
  // from the process environment, mirroring how SN_OAUTH_CLIENT_ID/SECRET have
  // always been read here. The credential store persists these in a later phase.
  const env = (name: string): string => cleanEnvValue(process.env[name] || "");
  const clientId = env(OAUTH_CLIENT_ID_ENV);
  const clientSecret = env(OAUTH_CLIENT_SECRET_ENV);
  const apiKey = env(API_KEY_ENV);
  const apiKeyHeader = env(API_KEY_HEADER_ENV);
  const jwtKey = env(JWT_KEY_ENV);
  const jwtKid = env(JWT_KID_ENV);
  const jwtIss = env(JWT_ISS_ENV);
  const jwtSub = env(JWT_SUB_ENV);
  const jwtAud = env(JWT_AUD_ENV);
  const explicitMethod = env(AUTH_METHOD_ENV);

  const resolved = resolveAuthMethod({
    explicit: explicitMethod,
    hasPassword: !!password,
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret,
    hasApiKey: !!apiKey,
    hasJwtKey: !!jwtKey,
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
  if (issues.length > 0 && !hasMtls) {
    throw new Error(
      `Missing ServiceNow credentials for ${resolved.method} auth: ${issues.join(
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
// (shared MAX_REQUESTS_PER_SECOND policy) — requests are spaced by a minimum
// interval instead of relying solely on 429 retries.
const MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_REQUESTS_PER_SECOND);
let nextRequestSlotAt = 0;

async function acquireRequestSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestSlotAt - now);
  nextRequestSlotAt = Math.max(now, nextRequestSlotAt) + MIN_REQUEST_INTERVAL_MS;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function buildScopedEndpoint(prefix: string, route: string): string {
  return `/api/${prefix}/${route.replace(/^\/+/, "")}`;
}

function scopedPrefixOrder(preferredPrefixes: string[] = []): string[] {
  const configured = parseConfiguredScopedApiPrefixes(
    cleanEnvValue(process.env[SCOPED_API_PREFIXES_ENV] || "")
  );
  return orderScopedApiPrefixes(configured, [
    ...preferredPrefixes,
    ...(cachedScopedApiPrefix ? [cachedScopedApiPrefix] : []),
  ]);
}

export async function snScopedApiRequest(
  method: string,
  route: string,
  body: unknown,
  timeoutMs: number,
  projectDir: string = process.cwd(),
  preferredPrefixes: string[] = []
): Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }> {
  let lastNotFound: { status: number; data: unknown; text: string; usedEndpoint: string } | null = null;

  for (const prefix of scopedPrefixOrder(preferredPrefixes)) {
    const endpoint = buildScopedEndpoint(prefix, route);
    const response = await snRequest(method, endpoint, body, timeoutMs, projectDir);

    // Shared policy (matches the core CLI): 400/403/404 all mean "this scoped
    // namespace is unavailable", so try the next prefix.
    if (isEndpointNotFoundStatus(response.status)) {
      lastNotFound = { ...response, usedEndpoint: endpoint };
      continue;
    }

    // Only a successful response proves the prefix works — caching it on a
    // 5xx would poison subsequent requests with a bad prefix order.
    if (response.status >= 200 && response.status < 300) {
      cachedScopedApiPrefix = prefix;
    }
    return { ...response, usedEndpoint: endpoint };
  }

  if (lastNotFound) {
    return lastNotFound;
  }

  const fallbackPrefix = scopedPrefixOrder(preferredPrefixes)[0] || DEFAULT_SCOPED_API_PREFIXES[0];
  const fallbackEndpoint = buildScopedEndpoint(fallbackPrefix, route);
  const fallbackResponse = await snRequest(method, fallbackEndpoint, body, timeoutMs, projectDir);
  return { ...fallbackResponse, usedEndpoint: fallbackEndpoint };
}

export async function getCurrentScopeWithFallback(
  timeoutMs: number,
  projectDir: string = process.cwd()
): Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }> {
  return snScopedApiRequest("GET", "sinc/getCurrentScope", undefined, timeoutMs, projectDir);
}

export async function snRequest(
  method: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  projectDir: string = process.cwd()
): Promise<{ status: number; data: unknown; text: string }> {
  return snRequestWithConfig(getServiceNowConfig(projectDir), method, endpoint, body, timeoutMs);
}

export async function snRequestWithConfig(
  config: SNConfig,
  method: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; data: unknown; text: string }> {
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
      if (attempt >= MAX_REQUEST_ATTEMPTS) {
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
      const mayRetry = isIdempotent || neverReachedServer;
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
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row[analyzeField] ?? "<empty>");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export async function runBackgroundScript(
  script: string,
  timeoutMs: number,
  endpointPath?: string,
  projectDir: string = process.cwd()
): Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }> {
  const apiAttempt =
    typeof endpointPath === "string" && endpointPath.trim().length > 0
      ? {
          ...(await snRequest("POST", endpointPath, { script }, timeoutMs, projectDir)),
          usedEndpoint: endpointPath,
        }
      : await snScopedApiRequest("POST", "sinc/runBackgroundScript", { script }, timeoutMs, projectDir);

  if (apiAttempt.status >= 200 && apiAttempt.status < 300) {
    return apiAttempt;
  }

  // 400/403/404 all mean the scoped `sinc/*` API is unavailable (same policy as
  // snScopedApiRequest). A live instance without the scoped app installed answers
  // 400 "Requested URI does not represent any resource", not 404 — so keying only
  // on 404 here left the sys.scripts.do fallback unreachable in exactly the case
  // it exists for (verified live against a PDI, CR22).
  if (!isEndpointNotFoundStatus(apiAttempt.status)) {
    return apiAttempt;
  }

  const config = getServiceNowConfig(projectDir);
  const baseUrl = instanceToBaseUrl(config.instance);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new URLSearchParams();
    form.set("script", script);
    form.set("runscript", "Run script");

    // sys.scripts.do is a UI processor that accepts Basic (and OAuth Bearer)
    // session auth. Reuse the same Authorization the REST path would send, plus
    // the mTLS/custom-CA dispatcher, so mTLS-secured instances still reach it.
    const authHeaders = usesOAuth(config)
      ? {
          Authorization: `Bearer ${await getTokenManager(
            config,
            baseUrl
          ).getToken()}`,
        }
      : staticAuthHeaders(config);
    const init: FetchInit = {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/json,text/plain",
      },
      body: form.toString(),
      signal: controller.signal,
    };
    const dispatcher = getDispatcher(config);
    if (dispatcher) {
      init.dispatcher = dispatcher;
    }
    const response = await fetch(`${baseUrl}sys.scripts.do`, init);

    const text = await response.text();
    return {
      status: response.status,
      data: text,
      text,
      usedEndpoint: "/sys.scripts.do",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function hasEnvFile(projectDir: string = process.cwd()): boolean {
  return existsSync(path.join(projectDir, ".env"));
}
