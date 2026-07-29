// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync, SN } from "@syncrona/types";
import https from "node:https";
import fs from "node:fs";
import axios, { AxiosPromise, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from "axios";
import rateLimit from "axios-rate-limit";
import {
  CA_BUNDLE_ENV,
  SCOPED_API_PREFIXES_ENV,
  TLS_REJECT_UNAUTHORIZED_ENV,
  CLIENT_CERT_ENV,
  CLIENT_KEY_ENV,
  CLIENT_KEY_PASSPHRASE_ENV,
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
  escapeQueryValue,
  isEndpointNotFoundStatus,
  orderScopedApiPrefixes,
  parseConfiguredScopedApiPrefixes,
  resolveTlsPolicy,
  resolveAuthMethod,
  apiKeyHeaderName,
  buildJwtClaims,
  createJwtAssertion,
  shouldRetryStatus,
  type AuthMethod,
} from "@syncrona/sn-transport";
import { wait } from "./genericUtils.js";
import { logger } from "./Logger.js";
import { createTokenManager, OAuthConfig, TokenPoster } from "./oauth.js";
import { resolveCredentialsFromStore, type StoredCredentials } from "./auth.js";

// REV-170: default socket/response timeout for every request this client makes.
// axios defaults to NO timeout, so a request to a hung or silently dropped instance
// connection never settles: `push`, `download` and `dev` waited forever holding
// the collaboration lock, with no output and no way to distinguish a slow
// instance from a dead one. Two minutes is well above the slowest legitimate
// bulk Table-API page and still bounded. `SN_REQUEST_TIMEOUT` (milliseconds)
// overrides it; 0 restores the unbounded behaviour for the rare very large pull.
export const REQUEST_TIMEOUT_ENV = "SN_REQUEST_TIMEOUT";
export const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

export function resolveRequestTimeout(): number {
  const raw = String(process.env[REQUEST_TIMEOUT_ENV] ?? "").trim();
  if (raw === "") {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

let cachedScopedEndpointPrefix: string | undefined;

export function getScopedEndpointPrefix(): string | undefined {
  return cachedScopedEndpointPrefix;
}

function endpointPrefixOrder(): string[] {
  const configured = parseConfiguredScopedApiPrefixes(
    String(process.env[SCOPED_API_PREFIXES_ENV] || "").trim()
  );
  return orderScopedApiPrefixes(
    configured,
    cachedScopedEndpointPrefix ? [cachedScopedEndpointPrefix] : []
  );
}

// G9: corporate proxy + TLS support. HTTPS_PROXY / NO_PROXY are honored
// automatically by axios's Node adapter, so proxying needs no extra wiring. A
// custom CA bundle (corporate / self-signed CA), an explicit verification
// opt-out, or a mutual-TLS client certificate are applied here via a shared
// https.Agent. Returns undefined when no non-default TLS setting is configured,
// so the standard agent is used. TLS material is process-global (like the CA
// bundle) — it is not per-profile suffixed.
export function buildHttpsAgent(): https.Agent | undefined {
  const policy = resolveTlsPolicy(
    process.env[CA_BUNDLE_ENV],
    process.env[TLS_REJECT_UNAUTHORIZED_ENV],
    process.env[CLIENT_CERT_ENV],
    process.env[CLIENT_KEY_ENV],
    process.env[CLIENT_KEY_PASSPHRASE_ENV]
  );
  if (!policy.custom) {
    return undefined;
  }
  let ca: Buffer | undefined;
  if (policy.caBundlePath) {
    try {
      ca = fs.readFileSync(policy.caBundlePath);
    } catch (e) {
      logger.warn(
        `Could not read CA bundle at ${policy.caBundlePath}: ${(e as Error).message}`
      );
    }
  }
  // Mutual TLS: the client certificate + private key authenticate THIS client to
  // the instance (orthogonal to the Authorization method — combines with Basic,
  // OAuth, or API key). Referenced by path, never copied into the credential
  // store. Unlike the CA bundle, an unreadable cert/key is fatal for mTLS — let
  // the read throw so the misconfiguration is loud rather than silently degrading
  // to a request with no client certificate.
  let cert: Buffer | undefined;
  let key: Buffer | undefined;
  if (policy.clientCertPath) {
    cert = fs.readFileSync(policy.clientCertPath);
  }
  if (policy.clientKeyPath) {
    key = fs.readFileSync(policy.clientKeyPath);
  }
  if (!policy.rejectUnauthorized) {
    logger.warn(
      `TLS certificate verification is DISABLED (${TLS_REJECT_UNAUTHORIZED_ENV}). Use only against trusted test instances.`
    );
  }
  return new https.Agent({
    ca,
    cert,
    key,
    ...(policy.clientKeyPassphrase ? { passphrase: policy.clientKeyPassphrase } : {}),
    rejectUnauthorized: policy.rejectUnauthorized,
  });
}

function isEndpointNotFound(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    typeof error.response?.status === "number" &&
    isEndpointNotFoundStatus(error.response.status)
  );
}

export function getErrorResponseStatus(e: unknown): number | undefined {
  return axios.isAxiosError(e) ? e.response?.status : undefined;
}

// Network errors (no HTTP response) are retryable; HTTP errors follow the
// shared retry-status policy so 4xx failures (bad credentials, missing
// record) fail fast instead of hammering the instance.
export function isRetryableRequestError(e: unknown): boolean {
  const status = getErrorResponseStatus(e);
  if (status === undefined) {
    return true;
  }
  return shouldRetryStatus(status);
}

export const retryOnErr = async <T>(
  f: () => Promise<T>,
  allowedRetries: number,
  msBetween = 0,
  onRetry?: (retriesLeft: number) => void,
  shouldRetry?: (e: unknown) => boolean
): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (shouldRetry && !shouldRetry(e)) {
      throw e;
    }
    const newRetries = allowedRetries - 1;
    if (newRetries < 0) {
      throw e;
    }
    if (onRetry) {
      onRetry(newRetries);
    }
    await wait(msBetween);
    return retryOnErr(f, newRetries, msBetween, onRetry, shouldRetry);
  }
};

export const processPushResponse = (
  response: AxiosResponse,
  recSummary: string
): Sync.PushResult => {
  const { status } = response;
  if (status === 404) {
    return {
      success: false,
      message: `Could not find ${recSummary} on the server.`,
    };
  }
  if (status < 200 || status > 299) {
    return {
      success: false,
      message: `Failed to push ${recSummary}. Received an unexpected response (${status})`,
    };
  }
  return {
    success: true,
    message: `${recSummary} pushed successfully!`,
  };
};

/** Inbound-REST API key auth: a static key sent as a fixed HTTP header. */
export type ApiKeyAuth = { header: string; value: string };

export const snClient = (
  baseURL: string,
  username: string,
  password: string,
  oauth?: OAuthConfig,
  apiKey?: ApiKeyAuth
) => {
  // Authorization modes, in precedence order:
  //  - OAuth (G1): Bearer token (password / client_credentials / jwt-bearer),
  //    refreshed on expiry/401.
  //  - API key: a static header (default `x-sn-apikey`), no Basic/Bearer.
  //  - Basic (default): username + password, used whenever both are present and
  //    no OAuth/API-key mode is selected. Empty credentials send no Authorization
  //    header (supports mTLS-only, where the client cert maps to a user).
  // G9: a shared https.Agent carries any custom CA bundle / TLS opt-out / mTLS
  // client cert to every request (and to the OAuth token endpoint).
  const httpsAgent = buildHttpsAgent();
  const useApiKey = !oauth && !!apiKey;
  const useBasic = !oauth && !useApiKey && !!username && !!password;
  const requestTimeout = resolveRequestTimeout();
  const base = axios.create({
    withCredentials: true,
    headers: {
      "Content-Type": "application/json",
      ...(useApiKey && apiKey ? { [apiKey.header]: apiKey.value } : {}),
    },
    baseURL,
    // REV-170: without an explicit timeout axios waits forever, so a blackholed
    // socket parked a download/push pool slot for good; see
    // resolveRequestTimeout. Individual calls that pass their own timeout
    // (checkConnection) still override this.
    timeout: requestTimeout,
    ...(httpsAgent ? { httpsAgent } : {}),
    ...(useBasic ? { auth: { username, password } } : {}),
  });

  if (oauth) {
    const tokenHttp = axios.create({
      baseURL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // REV-171: the token client had no timeout either, and it is worse than
      // the data client: every request waits on getToken() in the request
      // interceptor, so one hung /oauth_token.do stalled the whole command with
      // no request ever reaching the instance — and the per-call timeouts
      // (checkConnection) apply to `base`, never to this leg.
      timeout: requestTimeout,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const poster: TokenPoster = async (path, body) => (await tokenHttp.post(path, body)).data;
    const tokens = createTokenManager({ username, password }, oauth, poster);

    base.interceptors.request.use(async (config) => {
      config.headers = config.headers ?? {};
      (config.headers as Record<string, string>).Authorization = `Bearer ${await tokens.getToken()}`;
      return config;
    });
    base.interceptors.response.use(undefined, async (error: AxiosError) => {
      const cfg = error.config as
        | (InternalAxiosRequestConfig & { _oauthRetried?: boolean })
        | undefined;
      if (error.response?.status === 401 && cfg && !cfg._oauthRetried) {
        cfg._oauthRetried = true;
        (cfg.headers as Record<string, string>).Authorization = `Bearer ${await tokens.forceRefresh()}`;
        return base.request(cfg);
      }
      return Promise.reject(error);
    });
  }

  const client = rateLimit(base, { maxRPS: 20 });

  const requestScopedEndpoint = async <T>(
    method: "get" | "post",
    route: string,
    data?: unknown,
    config?: Record<string, unknown>
  ): Promise<AxiosResponse<T>> => {
    let last404: unknown;

    for (const prefix of endpointPrefixOrder()) {
      const endpoint = `api/${prefix}/${route.replace(/^\/+/, "")}`;
      try {
        const response =
          method === "get"
            ? await client.get<T>(endpoint, config)
            : config !== undefined
              ? await client.post<T>(endpoint, data, config)
              : await client.post<T>(endpoint, data);
        cachedScopedEndpointPrefix = prefix;
        return response;
      } catch (error) {
        if (!isEndpointNotFound(error)) {
          throw error;
        }
        last404 = error;
      }
    }

    throw last404;
  };

  const getAppList = () => {
    type AppListResponse = Sync.SNAPIResponse<SN.App[]>;
    return requestScopedEndpoint<AppListResponse>("get", "sinc/getAppList");
  };

  const updateATFfile = (contents: string, sysId: string) => {
    return requestScopedEndpoint("post", "pushATFfile", {
      file: contents,
      sys_id: sysId,
    });
  };

  const updateRecord = async (
    table: string,
    recordId: string,
    fields: Record<string, string>
  ) => {
    if (table === "sys_atf_step") {
      await updateATFfile(fields["inputs.script"], recordId);
    }
    const endpoint = `api/now/table/${table}/${recordId}`;
    return client.patch(endpoint, fields);
  };

  const tableAPIGet = (
    table: string,
    sysparmQuery: string,
    sysparmFields: string,
    sysparmLimit = 500,
    sysparmOffset = 0
  ) => {
    const endpoint = `api/now/table/${table}`;
    return client.get(endpoint, {
      params: {
        sysparm_query: sysparmQuery,
        sysparm_fields: sysparmFields,
        sysparm_limit: String(sysparmLimit),
        ...(sysparmOffset > 0
          ? { sysparm_offset: String(sysparmOffset) }
          : {}),
      },
    });
  };

  const getScopeId = (scopeName: string) => {
    const endpoint = "api/now/table/sys_scope";
    type ScopeResponse = Sync.SNAPIResponse<SN.ScopeRecord[]>;
    return client.get<ScopeResponse>(endpoint, {
      params: {
        // Scope comes from the project config file — escape it so a crafted
        // config cannot smuggle extra `^` conditions into the lookup.
        sysparm_query: `scope=${escapeQueryValue(scopeName)}`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const getUserSysId = (userName?: string) => {
    // Resolve through the credential chain (env/profile/store) rather than
    // reading SN_USER directly, which is empty for store-based logins.
    const resolvedUserName = userName || resolveCredentials().user;
    const endpoint = "api/now/table/sys_user";
    type UserResponse = Sync.SNAPIResponse<SN.UserRecord[]>;
    return client.get<UserResponse>(endpoint, {
      params: {
        sysparm_query: `user_name=${escapeQueryValue(resolvedUserName)}`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const getCurrentAppUserPrefSysId = (userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    type UserPrefResponse = Sync.SNAPIResponse<SN.UserPrefRecord[]>;
    return client.get<UserPrefResponse>(endpoint, {
      params: {
        sysparm_query: `user=${userSysId}^name=apps.current_app`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const updateCurrentAppUserPref = (
    appSysId: string,
    userPrefSysId: string
  ) => {
    const endpoint = `api/now/table/sys_user_preference/${userPrefSysId}`;
    return client.put(endpoint, { value: appSysId });
  };

  const createCurrentAppUserPref = (appSysId: string, userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    return client.post(endpoint, {
      value: appSysId,
      name: "apps.current_app",
      type: "string",
      user: userSysId,
    });
  };

  const getCurrentScope = () => {
    type ScopeResponse = Sync.SNAPIResponse<SN.ScopeObj>;
    return requestScopedEndpoint<ScopeResponse>("get", "sinc/getCurrentScope");
  };

  const checkConnection = async (timeout = 5000): Promise<void> => {
    try {
      type ScopeResponse = Sync.SNAPIResponse<SN.ScopeObj>;
      await requestScopedEndpoint<ScopeResponse>(
        "get",
        "sinc/getCurrentScope",
        undefined,
        { timeout }
      );
    } catch (e: unknown) {
      if (isEndpointNotFound(e)) {
        // Custom scope not installed — verify with standard Table API ping
        await client.get("api/now/table/sys_scope", {
          params: { sysparm_limit: "1", sysparm_fields: "sys_id" },
          timeout,
        });
        return;
      }
      throw e;
    }
  };

  const createUpdateSet = (updateSetName: string) => {
    const endpoint = `api/now/table/sys_update_set`;
    type UpdateSetCreateResponse = Sync.SNAPIResponse<SN.UpdateSetRecord>;
    return client.post<UpdateSetCreateResponse>(endpoint, {
      name: updateSetName,
    });
  };

  const getCurrentUpdateSetUserPref = (userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    type CurrentUpdateSetResponse = Sync.SNAPIResponse<SN.UserPrefRecord[]>;
    return client.get<CurrentUpdateSetResponse>(endpoint, {
      params: {
        sysparm_query: `user=${userSysId}^name=sys_update_set`,
        sysparm_fields: "sys_id",
      },
    });
  };
  const updateCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userPrefSysId: string
  ) => {
    const endpoint = `api/now/table/sys_user_preference/${userPrefSysId}`;
    return client.put(endpoint, { value: updateSetSysId });
  };

  const createCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userSysId: string
  ) => {
    const endpoint = `api/now/table/sys_user_preference`;
    return client.post(endpoint, {
      value: updateSetSysId,
      name: "sys_update_set",
      type: "string",
      user: userSysId,
    });
  };

  const getMissingFiles = (
    missingFiles: SN.MissingFileTableMap,
    tableOptions: Sync.ITableOptionsMap
  ) => {
    type TableMap = Sync.SNAPIResponse<SN.TableMap>;
    return requestScopedEndpoint<TableMap>("post", "sinc/bulkDownload", {
      missingFiles,
      tableOptions,
    });
  };

  const getManifest = (
    scope: string,
    config: Sync.Config,
    withFiles = false
  ) => {
    const { includes = {}, excludes = {}, tableOptions = {} } = config;
    type AppResponse = Sync.SNAPIResponse<SN.AppManifest>;
    return requestScopedEndpoint<AppResponse>(
      "post",
      `sinc/getManifest/${scope}`,
      {
        includes,
        excludes,
        tableOptions,
        withFiles,
      }
    );
  };

  return {
    getAppList,
    updateRecord,
    getScopeId,
    getUserSysId,
    getCurrentAppUserPrefSysId,
    updateCurrentAppUserPref,
    createCurrentAppUserPref,
    getCurrentScope,
    checkConnection,
    tableAPIGet,
    createUpdateSet,
    getCurrentUpdateSetUserPref,
    updateCurrentUpdateSetUserPref,
    createCurrentUpdateSetUserPref,
    getMissingFiles,
    getManifest,
  };
};

let internalClient: SNClient | undefined = undefined;
let internalClientKey: string | undefined = undefined;
let activeInstanceProfile: string | undefined;

// In-memory cache populated from auth store at bootstrap. Carries the full
// stored record (including any multi-method material) so a login with no `.env`
// still drives the right auth method on the next command, not just Basic.
let storedCredentialsCache: StoredCredentials | null = null;

export async function preloadStoredCredentials(profile?: string): Promise<void> {
  const creds = await resolveCredentialsFromStore(profile);
  if (creds) {
    storedCredentialsCache = creds;
  }
}

export function clearStoredCredentialsCache(): void {
  storedCredentialsCache = null;
}

export type SNCredentials = {
  user: string;
  password: string;
  instance: string;
  profile?: string;
  // G1: when both are set (via SN_OAUTH_CLIENT_ID / SN_OAUTH_CLIENT_SECRET, with
  // optional _<PROFILE> suffix), the client uses OAuth 2.0 instead of Basic auth.
  clientId?: string;
  clientSecret?: string;
  // Multi-method auth: the resolved method (from SN_AUTH_METHOD or inference) and
  // the fields the newer methods need. All optional so a Basic/OAuth-password
  // setup keeps behaving exactly as before.
  authMethod?: AuthMethod;
  apiKey?: string;
  apiKeyHeader?: string;
  /** Path to (or inline PEM of) the JWT bearer signing key. */
  jwtKey?: string;
  jwtKid?: string;
  jwtIss?: string;
  jwtSub?: string;
  jwtAud?: string;
};

function normalizeProfileName(profile?: string): string | undefined {
  const normalized = String(profile || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");

  return normalized ? normalized : undefined;
}

function profileEnvVar(baseName: string, profile?: string): string {
  const normalized = normalizeProfileName(profile);
  if (!normalized) {
    return baseName;
  }
  return `${baseName}_${normalized}`;
}

// Human-readable origin of the resolved credentials, surfaced by `status` so
// users can tell whether a command is talking to .env, a profile, or the store.
export type CredentialSource =
  | "credential store (syncrona login)"
  | "instance profile env vars"
  | "environment (.env / shell SN_* vars)"
  | "none (credentials missing)";

// REV-201: the resolver's `issues` list was computed here and thrown away — only
// `.method` was read. `syncrona doctor` reports those issues and the MCP server
// refuses to start on them, so every command that actually transmits the
// credential was the one place a typo'd SN_AUTH_METHOD stayed silent: it fell
// through to inference and, when leftover credentials happened to complete the
// inferred method, nothing surfaced at all.
//
// Warn rather than throw. `doctor` itself resolves credentials to run its checks
// (diagnosticsCommands.ts calls resolveCredentials), so hard-failing here would
// remove the very diagnostic that explains the problem — and `status` would stop
// being able to describe a broken configuration.
//
// Only the unrecognized-selector issue is reported. A missing field announces
// itself the moment a request is attempted, and `init` / `login` / `check-env`
// legitimately resolve credentials before any exist, so warning about every issue
// would print "basic requires SN_PASSWORD." during normal setup. An unrecognized
// selector is the opposite: it *succeeds* under an inferred method, so nothing
// else ever surfaces it. The message names the rejected selector and the accepted
// values only — never a credential.
const warnedAuthIssues = new Set<string>();

/**
 * Surface an auth-selector issue once per distinct message. Credential resolution
 * runs several times per command (eight call sites, no memoization), so an
 * unconditional warn would repeat the same line within a single invocation.
 */
function warnAboutAuthIssues(
  resolved: { unknownExplicitIssue?: string; method: string },
  origin: string
): void {
  if (!resolved.unknownExplicitIssue) {
    return;
  }
  const line = `ServiceNow auth configuration (${origin}): ${resolved.unknownExplicitIssue} Falling back to ${resolved.method}.`;
  if (warnedAuthIssues.has(line)) {
    return;
  }
  warnedAuthIssues.add(line);
  logger.warn(line);
}

/** Test seam: the dedupe cache would otherwise leak between cases. */
export function resetAuthIssueWarnings(): void {
  warnedAuthIssues.clear();
}

// Single source of truth for both the credentials and where they came from, so
// the precedence logic is never duplicated between resolution and reporting.
function resolveCredentialsInternal(profile?: string): {
  creds: SNCredentials;
  source: CredentialSource;
} {
  const normalizedProfile = normalizeProfileName(profile) || normalizeProfileName(activeInstanceProfile);
  const userFromProfile = process.env[profileEnvVar("SN_USER", normalizedProfile)] || "";
  const passwordFromProfile = process.env[profileEnvVar("SN_PASSWORD", normalizedProfile)] || "";
  const instanceFromProfile = process.env[profileEnvVar("SN_INSTANCE", normalizedProfile)] || "";
  const { SN_USER = "", SN_PASSWORD = "", SN_INSTANCE = "" } = process.env;

  // Resolve the newer auth fields up front (before the store-path gate) so an
  // API-key or client-credentials setup with no SN_USER still counts as
  // configured-via-env and doesn't fall through to a stale stored login.
  const envVar = (base: string): string =>
    process.env[profileEnvVar(base, normalizedProfile)] || process.env[base] || "";
  const clientId = envVar(OAUTH_CLIENT_ID_ENV);
  const clientSecret = envVar(OAUTH_CLIENT_SECRET_ENV);
  const apiKey = envVar(API_KEY_ENV);
  const apiKeyHeader = envVar(API_KEY_HEADER_ENV);
  const jwtKey = envVar(JWT_KEY_ENV);
  const jwtKid = envVar(JWT_KID_ENV);
  const jwtIss = envVar(JWT_ISS_ENV);
  const jwtSub = envVar(JWT_SUB_ENV);
  const jwtAud = envVar(JWT_AUD_ENV);
  const explicitMethod = envVar(AUTH_METHOD_ENV);
  const password = passwordFromProfile || SN_PASSWORD;

  // Env vars take priority only when a usable credential is present; instance-only
  // env vars do not suppress the credential store so a stale .env cannot block a
  // fresh login. "Usable" now spans every method: a user, an OAuth client, or an
  // API key.
  const hasEnvCreds = !!(SN_USER || userFromProfile || clientId || apiKey);
  if (!hasEnvCreds && storedCredentialsCache && !normalizedProfile) {
    const stored = storedCredentialsCache;
    // Re-infer the method when the stored record predates the multi-method
    // fields (legacy three-field logins have no authMethod), so old stores keep
    // resolving to Basic / OAuth-password exactly as before.
    const storedMethod = resolveAuthMethod({
      explicit: stored.authMethod || "",
      hasPassword: !!stored.password,
      hasClientId: !!stored.clientId,
      hasClientSecret: !!stored.clientSecret,
      hasApiKey: !!stored.apiKey,
      hasJwtKey: !!stored.jwtKeyPath,
    });
    // A store record normally comes from `syncrona login`'s method picker, but it
    // can also be hand-edited or written by a newer version that knows a method
    // this one does not — in which case the same silent fallback applies.
    warnAboutAuthIssues(storedMethod, "credential store");
    return {
      creds: {
        user: stored.user,
        password: stored.password,
        instance: stored.instance,
        profile: undefined,
        clientId: stored.clientId || undefined,
        clientSecret: stored.clientSecret || undefined,
        authMethod: storedMethod.method,
        apiKey: stored.apiKey || undefined,
        apiKeyHeader: stored.apiKeyHeader || undefined,
        jwtKey: stored.jwtKeyPath || undefined,
        jwtKid: stored.jwtKid || undefined,
        jwtIss: stored.jwtIss || undefined,
        jwtSub: stored.jwtSub || undefined,
        jwtAud: stored.jwtAud || undefined,
      },
      source: "credential store (syncrona login)",
    };
  }

  const resolved = resolveAuthMethod({
    explicit: explicitMethod,
    hasPassword: !!password,
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret,
    hasApiKey: !!apiKey,
    hasJwtKey: !!jwtKey,
  });
  warnAboutAuthIssues(
    resolved,
    normalizedProfile ? `profile ${normalizedProfile}` : "environment"
  );

  const creds: SNCredentials = {
    user: userFromProfile || SN_USER,
    password,
    instance: instanceFromProfile || SN_INSTANCE,
    profile: normalizedProfile,
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
  };
  // profileEnvVar() falls back to the base var name when no profile is set, so
  // "came from a profile" requires both a profile AND a profile-specific value
  // (for any of the methods).
  const usedProfile =
    !!normalizedProfile &&
    (!!userFromProfile ||
      !!process.env[profileEnvVar(API_KEY_ENV, normalizedProfile)] ||
      !!process.env[profileEnvVar(OAUTH_CLIENT_ID_ENV, normalizedProfile)]);
  // A configuration is "present" when any method has its identifying credential.
  const hasCredential =
    !!creds.user || !!creds.apiKey || !!(creds.clientId && creds.clientSecret);
  const source: CredentialSource = hasCredential
    ? usedProfile
      ? "instance profile env vars"
      : "environment (.env / shell SN_* vars)"
    : "none (credentials missing)";
  return { creds, source };
}

export function resolveCredentials(profile?: string): SNCredentials {
  return resolveCredentialsInternal(profile).creds;
}

export function describeCredentialSource(profile?: string): string {
  return resolveCredentialsInternal(profile).source;
}

export type CredentialDiagnostics = {
  profile?: string;
  baseEnvPresent: { instance: boolean; user: boolean; password: boolean };
  profileEnvPresent?: { instance: boolean; user: boolean; password: boolean };
  source: CredentialSource;
  resolvedInstance: string;
  resolvedUser: string;
};

// Structured breakdown of every env-based credential source for the
// `status --debug-credentials` view. The credential store (async) is reported
// separately by the caller; here we cover env presence + the resolved winner,
// reusing the same profile-var naming so it can never drift from resolution.
export function diagnoseCredentials(profile?: string): CredentialDiagnostics {
  const normalizedProfile =
    normalizeProfileName(profile) || normalizeProfileName(activeInstanceProfile);
  const { creds, source } = resolveCredentialsInternal(profile);
  const present = (v?: string): boolean => !!(v && v.length > 0);

  const diag: CredentialDiagnostics = {
    profile: normalizedProfile,
    baseEnvPresent: {
      instance: present(process.env.SN_INSTANCE),
      user: present(process.env.SN_USER),
      password: present(process.env.SN_PASSWORD),
    },
    source,
    resolvedInstance: creds.instance,
    resolvedUser: creds.user,
  };
  if (normalizedProfile) {
    diag.profileEnvPresent = {
      instance: present(process.env[profileEnvVar("SN_INSTANCE", normalizedProfile)]),
      user: present(process.env[profileEnvVar("SN_USER", normalizedProfile)]),
      password: present(process.env[profileEnvVar("SN_PASSWORD", normalizedProfile)]),
    };
  }
  return diag;
}

function credentialsKey(credentials: SNCredentials): string {
  return [
    credentials.profile || "default",
    credentials.instance,
    credentials.user,
    credentials.password,
    credentials.clientId || "",
    credentials.authMethod || "",
    credentials.apiKey || "",
    credentials.jwtKey || "",
  ].join("|");
}

export function setActiveInstanceProfile(profile?: string): void {
  activeInstanceProfile = normalizeProfileName(profile);
}

export function getActiveInstanceProfile(): string | undefined {
  return activeInstanceProfile;
}

export const resetClient = (): void => {
  internalClient = undefined;
  internalClientKey = undefined;
  cachedScopedEndpointPrefix = undefined;
};

// Read PEM material that may be supplied inline (starts with a PEM armor) or as
// a filesystem path. Used for the JWT bearer signing key (SN_JWT_KEY).
function readPemMaterial(value: string): string {
  if (value.includes("-----BEGIN")) {
    return value;
  }
  return fs.readFileSync(value, "utf8");
}

// Translate resolved credentials into the transport-level auth descriptor the
// snClient factory consumes: an OAuth config (for the three OAuth grants) or an
// API-key header. Basic auth needs neither — username/password flow directly.
// mTLS is orthogonal and applied by buildHttpsAgent, so it is not represented here.
export function buildClientAuth(credentials: SNCredentials): {
  oauth?: OAuthConfig;
  apiKey?: ApiKeyAuth;
} {
  const method = credentials.authMethod ?? "basic";
  const { clientId, clientSecret } = credentials;
  const hasOAuthClient = !!clientId && !!clientSecret;

  if (method === "api-key" && credentials.apiKey) {
    return {
      apiKey: {
        header: apiKeyHeaderName(credentials.apiKeyHeader),
        value: credentials.apiKey,
      },
    };
  }
  if (method === "oauth-client-credentials" && hasOAuthClient) {
    return {
      oauth: { clientId, clientSecret, grantType: "client_credentials" },
    };
  }
  if (method === "oauth-jwt-bearer" && hasOAuthClient && credentials.jwtKey) {
    const keyPem = readPemMaterial(credentials.jwtKey);
    const instanceBaseUrl = `https://${credentials.instance}/`;
    return {
      oauth: {
        clientId,
        clientSecret,
        grantType: "jwt-bearer",
        // A fresh, unexpired assertion is minted for every acquisition.
        buildAssertion: () =>
          createJwtAssertion(
            keyPem,
            buildJwtClaims({
              iss: credentials.jwtIss,
              sub: credentials.jwtSub,
              aud: credentials.jwtAud,
              clientId,
              user: credentials.user || undefined,
              instanceBaseUrl,
              nowSeconds: Math.floor(Date.now() / 1000),
            }),
            credentials.jwtKid ? { kid: credentials.jwtKid } : {}
          ),
      },
    };
  }
  if (method === "oauth-password" && hasOAuthClient) {
    return {
      oauth: { clientId, clientSecret, grantType: "password" },
    };
  }

  // REV-172: every branch above requires its own credential material. When a branch was
  // selected but its material is incomplete, this function used to fall through
  // to `return {}` — which the snClient factory reads as "no OAuth, no API key",
  // i.e. plain Basic auth with whatever user/password happens to be around. A
  // half-configured api-key or JWT setup therefore silently sent the user's
  // password to the instance under a weaker scheme instead of failing, and the
  // only symptom was a confusing 401 (or, worse, success with the wrong
  // identity). Fail loudly with the exact missing piece instead.
  const missing = missingAuthMaterial(method, credentials);
  if (missing.length > 0) {
    throw new Error(
      `Authentication method "${method}" is selected but incomplete: missing ${missing.join(", ")}. ` +
        `Set the missing value(s) or choose a different method (SN_AUTH_METHOD / 'syncrona login --auth-method').`
    );
  }
  return {};
}

// Which credential pieces a non-basic method needs but does not have. Empty for
// "basic" (and for any future method that needs nothing extra).
function missingAuthMaterial(method: AuthMethod, credentials: SNCredentials): string[] {
  const missing: string[] = [];
  const needsOAuthClient = (): void => {
    if (!credentials.clientId) missing.push("client id (SN_OAUTH_CLIENT_ID)");
    if (!credentials.clientSecret) missing.push("client secret (SN_OAUTH_CLIENT_SECRET)");
  };

  if (method === "api-key") {
    if (!credentials.apiKey) missing.push("API key (SN_API_KEY)");
    return missing;
  }
  if (method === "oauth-client-credentials" || method === "oauth-password") {
    needsOAuthClient();
    return missing;
  }
  if (method === "oauth-jwt-bearer") {
    needsOAuthClient();
    if (!credentials.jwtKey) missing.push("JWT signing key (SN_JWT_KEY)");
    return missing;
  }
  return missing;
}

export const defaultClient = (profile?: string) => {
  const credentials = resolveCredentials(profile);
  const nextKey = credentialsKey(credentials);

  if (internalClient && internalClientKey === nextKey) {
    return internalClient;
  }

  const { oauth, apiKey } = buildClientAuth(credentials);
  internalClient = snClient(
    `https://${credentials.instance}/`,
    credentials.user,
    credentials.password,
    oauth,
    apiKey
  );
  internalClientKey = nextKey;
  return internalClient;
};

export type SNClient = ReturnType<typeof snClient>;

// #12: a hibernating PDI wake-up page, SSO redirect, or proxy error page is
// often served with a 200 status and an HTML body. Without a shape check
// `resp.data.result` is `undefined`, and the first downstream `Object.keys()`
// crashes with an opaque "Cannot convert undefined or null to object" that the
// DX19 taxonomy can't classify. This typed error names the real cause.
export class NonApiResponseError extends Error {
  readonly contentType?: string;
  constructor(contentType: string | undefined, snippet: string) {
    super(
      "Instance returned a non-API response — likely an HTML login/" +
        "hibernation page or proxy error, not JSON" +
        (contentType ? ` (content-type: ${contentType})` : "") +
        (snippet ? `. Response starts with: ${snippet}` : "") +
        ". Confirm the instance is awake and the credentials are valid."
    );
    this.name = "NonApiResponseError";
    this.contentType = contentType;
  }
}

function assertSNApiResponse<T>(resp: AxiosResponse<Sync.SNAPIResponse<T>>): T {
  const data: unknown = resp.data;
  if (data && typeof data === "object" && !Array.isArray(data) && "result" in data) {
    return (data as Sync.SNAPIResponse<T>).result;
  }
  const contentType =
    typeof resp.headers?.["content-type"] === "string"
      ? (resp.headers["content-type"] as string)
      : undefined;
  const snippet =
    typeof data === "string"
      ? data.slice(0, 120).replace(/\s+/g, " ").trim()
      : "";
  throw new NonApiResponseError(contentType, snippet);
}

export const unwrapSNResponse = async <T>(
  clientPromise: AxiosPromise<Sync.SNAPIResponse<T>>
): Promise<T> => {
  try {
    const resp = await clientPromise;
    return assertSNApiResponse(resp);
  } catch (e) {
    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
    const isExpectedFallback = typeof status === "number" && isEndpointNotFoundStatus(status);

    if (!isExpectedFallback) {
      let message
      if (e instanceof Error) message = e.message
      else message = String(e)
      logger.error("Error processing server response");
      logger.error(message);
    }

    throw e;
  }
};

export async function unwrapTableAPIFirstItem<T>(
  clientPromise: AxiosPromise<Sync.SNAPIResponse<T[]>>
): Promise<T>;
export async function unwrapTableAPIFirstItem<T>(
  clientPromise: AxiosPromise<Sync.SNAPIResponse<T[]>>,
  extractField: keyof T
): Promise<string>;
export async function unwrapTableAPIFirstItem<T extends Record<string, string>>(
  clientPromise: AxiosPromise<Sync.SNAPIResponse<T[]>>,
  extractField?: keyof T
): Promise<T | string> {
  const resp = await unwrapSNResponse(clientPromise);
  if (resp.length === 0) {
    throw new Error("Response was not a populated array!");
  }
  if (!extractField) {
    return resp[0];
  }
  return resp[0][extractField];
}

// Non-throwing variant for "find or create" flows: an empty result returns ""
// so the caller can take the create path instead of failing.
export async function unwrapTableAPIFirstItemOrEmpty<T>(
  clientPromise: AxiosPromise<Sync.SNAPIResponse<T[]>>,
  extractField: keyof T
): Promise<string> {
  const resp = await unwrapSNResponse(clientPromise);
  if (resp.length === 0) {
    return "";
  }
  return String(resp[0][extractField] ?? "");
}
