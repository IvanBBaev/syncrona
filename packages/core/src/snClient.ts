import { Sync, SN } from "@syncrona/types";
import axios, { AxiosPromise, AxiosResponse } from "axios";
import rateLimit from "axios-rate-limit";
import {
  SCOPED_API_PREFIXES_ENV,
  orderScopedApiPrefixes,
  parseConfiguredScopedApiPrefixes,
} from "@syncrona/sn-transport";
import { wait } from "./genericUtils";
import { logger } from "./Logger";
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
    [400, 403, 404].includes(error.response.status)
  );
}

export const retryOnErr = async <T>(
  f: () => Promise<T>,
  allowedRetries: number,
  msBetween = 0,
  onRetry?: (retriesLeft: number) => void
): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    const newRetries = allowedRetries - 1;
    if (newRetries < 0) {
      throw e;
    }
    if (onRetry) {
      onRetry(newRetries);
    }
    await wait(msBetween);
    return retryOnErr(f, newRetries, msBetween, onRetry);
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
  password: string
) => {
  const client = rateLimit(
    axios.create({
      withCredentials: true,
      auth: {
        username,
        password,
      },
      headers: {
        "Content-Type": "application/json",
      },
      baseURL,
    }),
    { maxRPS: 20 }
  );

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
    sysparmLimit = 500
  ) => {
    const endpoint = `api/now/table/${table}`;
    return client.get(endpoint, {
      params: {
        sysparm_query: sysparmQuery,
        sysparm_fields: sysparmFields,
        sysparm_limit: String(sysparmLimit),
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

  const getUserSysId = (userName: string = process.env.SN_USER as string) => {
    const endpoint = "api/now/table/sys_user";
    type UserResponse = Sync.SNAPIResponse<SN.UserRecord[]>;
    return client.get<UserResponse>(endpoint, {
      params: {
        sysparm_query: `user_name=${userName}`,
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

export function resolveCredentials(profile?: string): SNCredentials {
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
      user: storedCredentialsCache.user,
      password: storedCredentialsCache.password,
      instance: storedCredentialsCache.instance,
      profile: undefined,
    };
  }

  return {
    user: userFromProfile || SN_USER,
    password: passwordFromProfile || SN_PASSWORD,
    instance: instanceFromProfile || SN_INSTANCE,
    profile: normalizedProfile,
  };
}

function credentialsKey(credentials: SNCredentials): string {
  return `${credentials.profile || "default"}|${credentials.instance}|${credentials.user}|${credentials.password}`;
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

  internalClient = snClient(
    `https://${credentials.instance}/`,
    credentials.user,
    credentials.password
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
    const isExpectedFallback = typeof status === "number" && [400, 403, 404].includes(status);

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
  try {
    const resp = await unwrapSNResponse(clientPromise);
    if (resp.length === 0) {
      throw new Error("Response was not a populated array!");
    }
    if (!extractField) {
      return resp[0];
    }
    return resp[0][extractField];
  } catch (e) {
    throw e;
  }
}
