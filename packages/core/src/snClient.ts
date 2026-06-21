import { Sync, SN } from "@syncro-now-ai/types";
import axios, { AxiosPromise, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from "axios";
import rateLimit from "axios-rate-limit";
import {
  SCOPED_API_PREFIXES_ENV,
  isEndpointNotFoundStatus,
  orderScopedApiPrefixes,
  parseConfiguredScopedApiPrefixes,
  shouldRetryStatus,
} from "@syncro-now-ai/sn-transport";
import { wait } from "./genericUtils";
import { logger } from "./Logger";
import { createTokenManager, OAuthConfig, TokenPoster } from "./oauth";
import { resolveCredentialsFromStore } from "./auth";

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

export const snClient = (
  baseURL: string,
  username: string,
  password: string,
  oauth?: OAuthConfig
) => {
  // OAuth mode (G1): Bearer token instead of Basic, refreshed on expiry/401.
  // Basic auth stays the default when no OAuth client is configured.
  const base = axios.create({
    withCredentials: true,
    headers: { "Content-Type": "application/json" },
    baseURL,
    ...(oauth ? {} : { auth: { username, password } }),
  });

  if (oauth) {
    const tokenHttp = axios.create({
      baseURL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
        sysparm_query: `scope=${scopeName}`,
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
        sysparm_query: `user_name=${resolvedUserName}`,
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

// In-memory cache populated from auth store at bootstrap
let storedCredentialsCache: { user: string; password: string; instance: string } | null = null;

export async function preloadStoredCredentials(profile?: string): Promise<void> {
  const creds = await resolveCredentialsFromStore(profile);
  if (creds) {
    storedCredentialsCache = {
      instance: creds.instance,
      user: creds.user,
      password: creds.password,
    };
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
  | "credential store (syncro-now-ai login)"
  | "instance profile env vars"
  | "environment (.env / shell SN_* vars)"
  | "none (credentials missing)";

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

  // Env vars take priority only when user credentials are present; instance-only env vars
  // do not suppress the credential store so a stale .env cannot block a fresh login.
  const hasEnvCreds = !!(SN_USER || userFromProfile);
  if (!hasEnvCreds && storedCredentialsCache && !normalizedProfile) {
    return {
      creds: {
        user: storedCredentialsCache.user,
        password: storedCredentialsCache.password,
        instance: storedCredentialsCache.instance,
        profile: undefined,
      },
      source: "credential store (syncro-now-ai login)",
    };
  }

  const clientId =
    process.env[profileEnvVar("SN_OAUTH_CLIENT_ID", normalizedProfile)] ||
    process.env.SN_OAUTH_CLIENT_ID ||
    "";
  const clientSecret =
    process.env[profileEnvVar("SN_OAUTH_CLIENT_SECRET", normalizedProfile)] ||
    process.env.SN_OAUTH_CLIENT_SECRET ||
    "";
  const creds: SNCredentials = {
    user: userFromProfile || SN_USER,
    password: passwordFromProfile || SN_PASSWORD,
    instance: instanceFromProfile || SN_INSTANCE,
    profile: normalizedProfile,
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
  };
  // profileEnvVar() falls back to the base var name when no profile is set, so
  // "came from a profile" requires both a profile AND a profile-specific value.
  const usedProfile = !!normalizedProfile && !!userFromProfile;
  const source: CredentialSource = creds.user
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
  return `${credentials.profile || "default"}|${credentials.instance}|${credentials.user}|${credentials.password}|${credentials.clientId || ""}`;
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

export const defaultClient = (profile?: string) => {
  const credentials = resolveCredentials(profile);
  const nextKey = credentialsKey(credentials);

  if (internalClient && internalClientKey === nextKey) {
    return internalClient;
  }

  const oauth =
    credentials.clientId && credentials.clientSecret
      ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret }
      : undefined;
  internalClient = snClient(
    `https://${credentials.instance}/`,
    credentials.user,
    credentials.password,
    oauth
  );
  internalClientKey = nextKey;
  return internalClient;
};

export type SNClient = ReturnType<typeof snClient>;

export const unwrapSNResponse = async <T>(
  clientPromise: AxiosPromise<Sync.SNAPIResponse<T>>
): Promise<T> => {
  try {
    const resp = await clientPromise;
    return resp.data.result;
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
