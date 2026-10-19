// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync, SN } from "@syncrona/types";
import https from "node:https";
import fs from "node:fs";
import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosPromise,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import rateLimit from "axios-rate-limit";
import {
  CA_BUNDLE_ENV,
  MAX_RPS_ENV,
  TLS_REJECT_UNAUTHORIZED_ENV,
  CLIENT_CERT_ENV,
  CLIENT_KEY_ENV,
  CLIENT_KEY_PASSPHRASE_ENV,
  AUTH_METHOD_ENV,
  API_KEY_ENV,
  API_KEY_HEADER_ENV,
  BEARER_TOKEN_ENV,
  OAUTH_CLIENT_ID_ENV,
  OAUTH_CLIENT_SECRET_ENV,
  JWT_KEY_ENV,
  JWT_KID_ENV,
  JWT_ISS_ENV,
  JWT_SUB_ENV,
  JWT_AUD_ENV,
  escapeQueryValue,
  isEndpointNotFoundStatus,
  resolveTlsPolicy,
  resolveMaxRequestsPerSecond,
  resolveAuthMethod,
  apiKeyHeaderName,
  buildJwtClaims,
  computeRetryDelay,
  createJwtAssertion,
  shouldRetryStatus,
  type AuthMethod,
} from "@syncrona/sn-transport";
import { wait } from "./genericUtils.js";
import { logger } from "./Logger.js";
import { createTokenManager, OAuthConfig, TokenPoster } from "./oauth.js";
import { resolveCredentialsFromStore, type StoredCredentials } from "./auth.js";
import { normalizeInstanceHost } from "./instanceHost.js";

// REV-170: default socket/response timeout for every request this client makes.
// axios defaults to NO timeout, so a request to a hung or silently dropped instance
// connection never settles: `push`, `download` and `dev` waited forever holding
// the collaboration lock, with no output and no way to distinguish a slow
// instance from a dead one. Two minutes is well above the slowest legitimate
// bulk Table-API page and still bounded. `SN_REQUEST_TIMEOUT` (milliseconds)
// overrides it; 0 restores the unbounded behaviour for the rare very large pull.
export const REQUEST_TIMEOUT_ENV = "SN_REQUEST_TIMEOUT";
export const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

// The redirect cap for the sn_cicd calls. follow-redirects (axios) defaults to
// 21, while the native fetch (undici) that `sync_cicd_run` uses stops at 20, so
// the same redirect chain could pass on one side and fail on the other. 20 keeps
// the CLI and the MCP tool on the same limit.
export const CICD_MAX_REDIRECTS = 20;

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

// G9: corporate proxy + TLS support. HTTPS_PROXY / NO_PROXY are honored
// automatically by axios's Node adapter, so proxying needs no extra wiring. A
// custom CA bundle (corporate / self-signed CA), an explicit verification
// opt-out, or a mutual-TLS client certificate are applied here via a shared
// https.Agent. TLS material is process-global (like the CA bundle) — it is not
// per-profile suffixed.

/** The TLS settings read from the environment, ready for an agent or a dispatcher. */
export interface TlsMaterial {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
  rejectUnauthorized: boolean;
}

// Reads the TLS environment. Returns undefined when no non-default TLS setting
// is configured, so the standard agent is used.
export function resolveTlsMaterial(): TlsMaterial | undefined {
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
  return {
    ca,
    cert,
    key,
    ...(policy.clientKeyPassphrase ? { passphrase: policy.clientKeyPassphrase } : {}),
    rejectUnauthorized: policy.rejectUnauthorized,
  };
}

export function buildHttpsAgent(): https.Agent | undefined {
  const tls = resolveTlsMaterial();
  return tls ? new https.Agent(tls) : undefined;
}

/** Where Node's bundled undici keeps the dispatcher its global `fetch` uses. */
export const FETCH_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/**
 * A dispatcher that carries `tls` to Node's global `fetch` (its `dispatcher`
 * init option). Node does not export its bundled undici and core adds no
 * undici dependency, so the `Agent` class is taken from the default dispatcher
 * Node installs when it loads undici; touching a fetch global loads it.
 */
export function buildFetchDispatcher(tls: TlsMaterial): object {
  void globalThis.Response;
  const current = (globalThis as Record<symbol, unknown>)[FETCH_GLOBAL_DISPATCHER];
  const Agent = (current as { constructor?: unknown } | undefined)?.constructor;
  if (typeof Agent !== "function" || Agent.name !== "Agent") {
    throw new Error(
      "Cannot apply the TLS settings to fetch: Node's default fetch dispatcher is not an undici Agent."
    );
  }
  return new (Agent as new (options: unknown) => object)({ connect: { ...tls } });
}

/** Root of the Table API; every record call below is relative to it. */
const TABLE_API_ROOT = "api/now/table";

/** Per-user preference rows (current application, current update set). */
const USER_PREFERENCE_TABLE = "sys_user_preference";
const VARIABLE_VALUE_TABLE = "sys_variable_value";
const GLOBAL_SCOPE = "global";

/**
 * Table API path of a table, or of one record when `sysId` is given. The
 * segments are used as passed: callers that take them from file paths encode
 * them first.
 */
function tablePath(table: string, sysId?: string): string {
  const tableUrl = `${TABLE_API_ROOT}/${table}`;
  return sysId === undefined ? tableUrl : `${tableUrl}/${sysId}`;
}

/** sys_id of the platform's "Me" dynamic filter option (the session user). */
const CURRENT_USER_DYNAMIC_FILTER = "90d1921e5f510100a9ad2572f2b477fe";

export function getErrorResponseStatus(e: unknown): number | undefined {
  return axios.isAxiosError(e) ? e.response?.status : undefined;
}

// The instance refused to store an ATF step script. Carries the HTTP status,
// so the push retry loop still sees a 4xx refusal as final rather than
// retrying a wrapped message it can no longer classify.
export class AtfStepScriptError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.name = "AtfStepScriptError";
    this.status = status;
  }
}

// Network errors (no HTTP response) are retryable; HTTP errors follow the
// shared retry-status policy so 4xx failures (bad credentials, missing
// record) fail fast instead of hammering the instance.
export function isRetryableRequestError(e: unknown): boolean {
  if (e instanceof AtfStepScriptError) {
    const status = e.status;
    return status === undefined ? false : shouldRetryStatus(status);
  }
  const status = getErrorResponseStatus(e);
  if (status === undefined) {
    return true;
  }
  return shouldRetryStatus(status);
}

// How long the server asked the client to back off (a 429 or 503 carrying
// `Retry-After`), bounded by the shared ceiling; 0 when it asked for nothing.
// A zero `random` makes computeRetryDelay's backoff branch return 0, so only a
// parsable header yields a non-zero delay.
function serverRetryAfterMs(e: unknown): number {
  if (!axios.isAxiosError(e)) {
    return 0;
  }
  // Node lowercases response header names, but an AxiosHeaders instance keeps
  // whatever case it was given; its get() matches case-insensitively. Checked
  // by shape, not instanceof, so suites that mock axios keep working.
  const headers = e.response?.headers;
  const header: unknown =
    typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  if (typeof header !== "string") {
    return 0;
  }
  return computeRetryDelay(0, header, { random: () => 0 });
}

/**
 * Run `attempt` and re-run it after a failure, at most `retries` more times.
 * `onRetry` hears how many re-runs remain once one is scheduled, and
 * `isRetryable` (when given) can stop the loop on the first failure it
 * rejects. Between attempts the loop sleeps `pauseMs`, or longer when the
 * failed response named its own back-off.
 */
export const retryOnErr = async <T>(
  attempt: () => Promise<T>,
  retries: number,
  pauseMs = 0,
  onRetry?: (retriesLeft: number) => void,
  isRetryable?: (e: unknown) => boolean
): Promise<T> => {
  for (let remaining = retries; ; ) {
    try {
      return await attempt();
    } catch (e) {
      remaining -= 1;
      const giveUp = (isRetryable !== undefined && !isRetryable(e)) || remaining < 0;
      if (giveUp) {
        throw e;
      }
      onRetry?.(remaining);
      // A throttled instance that names its own back-off wins over the fixed
      // spacing: retrying sooner only earns another 429.
      await wait(Math.max(pauseMs, serverRetryAfterMs(e)));
    }
  }
};

/**
 * Turn the answer to a record write into the push outcome the pipelines log.
 * Anything outside 2xx fails; a 404 gets its own wording because it means the
 * record is not on the instance at all.
 */
export const processPushResponse = (response: AxiosResponse, summary: string): Sync.PushResult => {
  const { status } = response;
  const accepted = !(status === 404 || status < 200 || status > 299);
  if (accepted) {
    return { success: true, message: `${summary} pushed successfully!` };
  }
  const message =
    status === 404
      ? `Could not find ${summary} on the server.`
      : `Failed to push ${summary}. Received an unexpected response (${status})`;
  return { success: false, message };
};

/** Optional extras for `tableAPIGet`: additional sysparm_* params and a per-request timeout (ms). */
export type TableAPIGetExtra = {
  params?: Record<string, string>;
  timeout?: number;
};

/**
 * Static-header auth: an inbound-REST API key under its header, or a pre-issued
 * bearer token as `Authorization: Bearer <token>`. Sent as is, never refreshed.
 */
export type ApiKeyAuth = { header: string; value: string };

/** What the OAuth wiring needs to reach the token endpoint the data client uses. */
type TokenLeg = {
  instanceUrl: string;
  userName: string;
  password: string;
  timeout: number;
  httpsAgent: https.Agent | undefined;
};

/**
 * Put OAuth in front of `data`: every request waits for a Bearer token, and a
 * 401 on a data call forces one token refresh and one replay of that call.
 */
function attachOAuth(data: AxiosInstance, oauth: OAuthConfig, leg: TokenLeg): void {
  const tokenHttp = axios.create({
    baseURL: leg.instanceUrl,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    // REV-171: the token client had no timeout either, and it is worse than
    // the data client: every request waits on getToken() in the request
    // interceptor, so one hung /oauth_token.do stalled the whole command with
    // no request ever reaching the instance — and the per-call timeouts
    // (checkConnection) apply to the data client, never to this leg.
    timeout: leg.timeout,
    ...(leg.httpsAgent ? { httpsAgent: leg.httpsAgent } : {}),
  });
  // A token request that fails in the request interceptor rejects the data
  // request with the token endpoint's own axios error, which the response
  // interceptor below would read as a data 401: it forced a second grant and
  // could re-send the token request through the data client. Such an error is
  // marked so it is passed on as is — one token POST, as sync_cicd_run sends.
  const failedTokenCalls = new WeakSet<object>();
  const postToTokenEndpoint: TokenPoster = async (path, body) => {
    try {
      return (await tokenHttp.post(path, body)).data;
    } catch (e) {
      if (e !== null && typeof e === "object") failedTokenCalls.add(e);
      throw e;
    }
  };
  const tokens = createTokenManager(
    { username: leg.userName, password: leg.password },
    oauth,
    postToTokenEndpoint
  );
  const setBearer = (headers: unknown, token: string): void => {
    (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  };

  data.interceptors.request.use(async (config) => {
    config.headers = config.headers ?? {};
    setBearer(config.headers, await tokens.getToken());
    return config;
  });
  data.interceptors.response.use(undefined, async (error: AxiosError) => {
    const replay = error.config as (InternalAxiosRequestConfig & { _oauthRetried?: boolean }) | undefined;
    const staleToken =
      error.response?.status === 401 && replay !== undefined && !replay._oauthRetried && !failedTokenCalls.has(error);
    if (!staleToken) {
      return Promise.reject(error);
    }
    replay._oauthRetried = true;
    setBearer(replay.headers, await tokens.forceRefresh());
    return data.request(replay);
  });
}

/**
 * The REST client for one instance. `instanceUrl` is the `https://host/` base
 * every relative endpoint below resolves against.
 */
export const snClient = (
  instanceUrl: string,
  userName: string,
  password: string,
  oauth?: OAuthConfig,
  apiKey?: ApiKeyAuth
) => {
  // Authorization modes, in precedence order:
  //  - OAuth (G1): Bearer token (password / client_credentials / jwt-bearer),
  //    refreshed on expiry/401.
  //  - Static header: an API key (default `x-sn-apikey`) or a pre-issued bearer
  //    token, never refreshed.
  //  - Basic (default): user name + password, used whenever both are present
  //    and no OAuth/API-key mode is selected. Empty credentials send no
  //    Authorization header (supports mTLS-only, where the client cert maps to
  //    a user).
  // G9: a shared https.Agent carries any custom CA bundle / TLS opt-out / mTLS
  // client cert to every request (and to the OAuth token endpoint).
  const httpsAgent = buildHttpsAgent();
  const staticHeader = oauth ? undefined : apiKey;
  const basicAuth = !oauth && !staticHeader && !!userName && !!password;
  const timeout = resolveRequestTimeout();
  const data = axios.create({
    withCredentials: true,
    headers: {
      "Content-Type": "application/json",
      ...(staticHeader ? { [staticHeader.header]: staticHeader.value } : {}),
    },
    baseURL: instanceUrl,
    // REV-170: without an explicit timeout axios waits forever, so a blackholed
    // socket parked a download/push pool slot for good; see
    // resolveRequestTimeout. Individual calls that pass their own timeout
    // (checkConnection) still override this.
    timeout,
    ...(httpsAgent ? { httpsAgent } : {}),
    ...(basicAuth ? { auth: { username: userName, password } } : {}),
  });
  if (oauth) {
    attachOAuth(data, oauth, { instanceUrl, userName, password, timeout, httpsAgent });
  }

  const client = rateLimit(data, {
    maxRPS: resolveMaxRequestsPerSecond(process.env[MAX_RPS_ENV]),
  });

  /**
   * Store an ATF step's script. The step keeps it in its `inputs` glide_var
   * column, which the Table API neither writes on the step itself nor on
   * insert, so the value goes to the step's `sys_variable_value` row for the
   * `script` input. The platform creates that row with the step (holding the
   * step config's template), so a step without one has no script input.
   */
  const writeAtfStepScript = async (contents: string, sysId: string) => {
    const query =
      `document=sys_atf_step^document_key=${escapeQueryValue(sysId)}` +
      "^variable.element=script";
    const rows = await unwrapSNResponse<{ sys_id?: unknown }[]>(
      client.get(tablePath(VARIABLE_VALUE_TABLE), {
        params: { sysparm_query: query, sysparm_fields: "sys_id", sysparm_limit: "1" },
      })
    );
    const valueId = Array.isArray(rows) && typeof rows[0]?.sys_id === "string" ? rows[0].sys_id : "";
    if (!valueId) {
      throw new AtfStepScriptError(
        `The ATF step ${sysId} has no script input on the instance, so its script cannot be stored.`,
        undefined
      );
    }
    try {
      return await client.patch(tablePath(VARIABLE_VALUE_TABLE, valueId), { value: contents });
    } catch (e) {
      const status = getErrorResponseStatus(e);
      if (status === 401 || status === 403) {
        // Stock Flow Designer ACLs let REST write sys_variable_value rows of
        // flow step definitions only, and admin does not override them.
        throw new AtfStepScriptError(
          `The instance refused to store the script of ATF step ${sysId} (HTTP ${status} on ` +
            `${VARIABLE_VALUE_TABLE}). Its ACLs must allow writing ${VARIABLE_VALUE_TABLE} rows ` +
            "whose document is sys_atf_step; until then, edit the script in the ATF step form.",
          status
        );
      }
      throw e;
    }
  };

  const updateRecord = async (table: string, sysId: string, changes: Record<string, string>) => {
    // Only when the update carries a script, as createRecord does: a push of an
    // ATF step's `.meta.json` alone has no `inputs.script`, and writing the
    // script then would replace the step's script with nothing.
    const atfScript = changes["inputs.script"];
    if (table === "sys_atf_step" && typeof atfScript === "string") {
      await writeAtfStepScript(atfScript, sysId);
    }
    return client.patch(tablePath(table, sysId), changes);
  };

  const tableAPIGet = (
    table: string,
    sysparmQuery: string,
    sysparmFields: string,
    sysparmLimit = 500,
    sysparmOffset = 0,
    // `syncrona query` passes the rest of the Table API read surface
    // (sysparm_display_value, sysparm_view, ...) and its own per-request
    // timeout; every other caller omits it and sends exactly the base params.
    extra?: TableAPIGetExtra
  ) => {
    return client.get(tablePath(table), {
      params: {
        sysparm_query: sysparmQuery,
        sysparm_fields: sysparmFields,
        sysparm_limit: String(sysparmLimit),
        ...(sysparmOffset > 0
          ? { sysparm_offset: String(sysparmOffset) }
          : {}),
        ...extra?.params,
      },
      ...(extra?.timeout !== undefined ? { timeout: extra.timeout } : {}),
    });
  };

  /**
   * Create one record through the Table API and return its sys_id.
   *
   * Deliberately NOT retried here: a POST is not idempotent, and a timeout or a
   * 5xx can arrive after the instance has already inserted the row. The caller
   * re-checks with findRecordByName before any second attempt.
   *
   * The ATF side-call mirrors updateRecord: a step's script lives in its
   * `sys_variable_value` row, which the platform creates with the step, so it
   * is written after the POST.
   */
  const createRecord = async (
    table: string,
    // Values are strings for every file-backed record; `init --new` also sends
    // a JSON boolean (`active: true`) in its sys_app body.
    fields: Record<string, string | boolean>
  ): Promise<{ sys_id: string }> => {
    type CreateResponse = Sync.SNAPIResponse<{ sys_id?: unknown }>;
    const resp = await client.post<CreateResponse>(tablePath(table), fields, {
      params: { sysparm_fields: "sys_id" },
    });
    const created = assertSNApiResponse(resp);
    const sysId =
      created && typeof created.sys_id === "string" ? created.sys_id : "";
    if (!sysId) {
      throw new Error(
        `Creating a ${table} record returned no sys_id (HTTP ${resp.status}).`
      );
    }
    const atfScript = fields["inputs.script"];
    if (table === "sys_atf_step" && typeof atfScript === "string") {
      try {
        await writeAtfStepScript(atfScript, sysId);
      } catch (e) {
        // The insert already succeeded: say so, or the step reads as never
        // created while it sits on the instance with its default script.
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Created the ${table} record ${sysId}, but its script was not sent: ${reason}`
        );
      }
    }
    return { sys_id: sysId };
  };

  /**
   * sys_ids of the records in `scopeId` whose `nameField` equals `name`. At most
   * two are fetched: the caller only distinguishes none, one and "more than
   * one". Every interpolated value is escaped, so a record name taken from a
   * file path cannot add conditions and slip past the scope filter.
   */
  const findRecordByName = async (
    table: string,
    nameField: string,
    name: string,
    scopeId: string
  ): Promise<string[]> => {
    const query =
      `${escapeQueryValue(nameField)}=${escapeQueryValue(name)}` +
      `^sys_scope=${escapeQueryValue(scopeId)}`;
    const records = await unwrapSNResponse<{ sys_id?: unknown }[]>(
      tableAPIGet(table, query, "sys_id", 2)
    );
    return (Array.isArray(records) ? records : [])
      .map((record) => record?.sys_id)
      .filter(
        (sysId): sysId is string => typeof sysId === "string" && sysId !== ""
      );
  };

  /** Table API URL of one record; both path segments are URL-encoded. */
  const recordEndpoint = (table: string, sysId: string) =>
    tablePath(encodeURIComponent(table), encodeURIComponent(sysId));

  /**
   * The record's sys_id and owning scope (`push --prune` reads this before any
   * DELETE). Resolves undefined when the instance answers 404: the record is
   * already gone. Every other failure is thrown for the caller to report.
   * `sysparm_exclude_reference_link` keeps sys_scope a plain sys_id string; the
   * `{ value }` reference shape is normalized too, in case an instance ignores it.
   */
  const getRecordScope = async (
    table: string,
    sysId: string
  ): Promise<{ sys_id: string; sys_scope: string } | undefined> => {
    type ScopeOf = { sys_id?: unknown; sys_scope?: unknown };
    let resp: AxiosResponse<Sync.SNAPIResponse<ScopeOf>>;
    try {
      resp = await client.get<Sync.SNAPIResponse<ScopeOf>>(
        recordEndpoint(table, sysId),
        {
          params: {
            sysparm_fields: "sys_id,sys_scope",
            sysparm_exclude_reference_link: "true",
          },
        }
      );
    } catch (e) {
      if (getErrorResponseStatus(e) === 404) return undefined;
      throw e;
    }
    const record = assertSNApiResponse(resp);
    const rawScope = record?.sys_scope;
    const scope =
      typeof rawScope === "string"
        ? rawScope
        : rawScope &&
            typeof rawScope === "object" &&
            typeof (rawScope as { value?: unknown }).value === "string"
          ? (rawScope as { value: string }).value
          : "";
    const id = typeof record?.sys_id === "string" ? record.sys_id : sysId;
    return { sys_id: id, sys_scope: scope };
  };

  /**
   * Delete one record through the Table API. Not retried here: the caller
   * decides (a DELETE is idempotent, and a 404 on a retry means it landed).
   */
  const deleteRecord = (table: string, sysId: string) =>
    client.delete(recordEndpoint(table, sysId));

  /**
   * GET the sys_id column of the `table` rows matching `query`. The scope,
   * user and preference lookups below are all this one request shape.
   */
  const selectSysIds = <Row>(table: string, query: string) =>
    client.get<Sync.SNAPIResponse<Row[]>>(tablePath(table), {
      params: { sysparm_query: query, sysparm_fields: "sys_id" },
    });

  // Scope comes from the project config file — escape it so a crafted config
  // cannot smuggle extra `^` conditions into the lookup.
  const getScopeId = (scopeName: string) =>
    selectSysIds<SN.ScopeRecord>("sys_scope", `scope=${escapeQueryValue(scopeName)}`);

  const getUserSysId = (userName?: string) => {
    // Resolve through the credential chain (env/profile/store) rather than
    // reading SN_USER directly, which is empty for store-based logins.
    const name = userName || resolveCredentials().user;
    // API-key and client-credentials logins carry no user name, and
    // `user_name=` matches every user whose name is empty — the scope and
    // update-set preferences then went to an arbitrary one of them. Without a
    // name, ask for the authenticated user through the "Me" dynamic filter.
    const query = name
      ? `user_name=${escapeQueryValue(name)}`
      : `sys_idDYNAMIC${CURRENT_USER_DYNAMIC_FILTER}`;
    return selectSysIds<SN.UserRecord>("sys_user", query);
  };

  // The session's current application and update set are both per-user
  // sys_user_preference rows, keyed by the preference name; one set of
  // find / overwrite / insert calls serves either.
  const sessionPreference = (preference: string) => ({
    find: (userSysId: string) =>
      selectSysIds<SN.UserPrefRecord>(USER_PREFERENCE_TABLE, `user=${userSysId}^name=${preference}`),
    overwrite: (value: string, preferenceSysId: string) =>
      client.put(tablePath(USER_PREFERENCE_TABLE, preferenceSysId), { value }),
    insert: (value: string, userSysId: string) =>
      client.post(tablePath(USER_PREFERENCE_TABLE), { value, name: preference, type: "string", user: userSysId }),
  });
  const currentApp = sessionPreference("apps.current_app");
  const currentUpdateSet = sessionPreference("sys_update_set");

  /**
   * The session's current application: the user's `apps.current_app`
   * preference names a sys_scope row by sys_id. A user without the preference,
   * or one pointing at a scope that no longer exists, works in global.
   */
  const getSessionScope = async (): Promise<SN.ScopeObj> => {
    const users = await unwrapSNResponse(getUserSysId());
    const userSysId = Array.isArray(users) ? users[0]?.sys_id : undefined;
    if (!userSysId) {
      throw new Error("Could not resolve the session user, so its current application is unknown.");
    }
    type PrefRow = { value?: unknown };
    const prefs = await unwrapSNResponse<PrefRow[]>(
      client.get(tablePath(USER_PREFERENCE_TABLE), {
        params: {
          sysparm_query: `user=${escapeQueryValue(userSysId)}^name=apps.current_app^ORDERBYDESCsys_updated_on`,
          sysparm_fields: "value",
          sysparm_limit: "1",
        },
      })
    );
    const appId = Array.isArray(prefs) && typeof prefs[0]?.value === "string" ? prefs[0].value : "";
    if (!appId || appId === GLOBAL_SCOPE) {
      return { scope: GLOBAL_SCOPE, sys_id: GLOBAL_SCOPE };
    }
    type ScopeRow = { sys_id?: unknown; scope?: unknown };
    const scopes = await unwrapSNResponse<ScopeRow[]>(
      client.get(tablePath("sys_scope"), {
        params: {
          sysparm_query: `sys_id=${escapeQueryValue(appId)}`,
          sysparm_fields: "sys_id,scope",
          sysparm_limit: "1",
        },
      })
    );
    const row = Array.isArray(scopes) ? scopes[0] : undefined;
    if (!row || typeof row.scope !== "string" || row.scope === "") {
      return { scope: GLOBAL_SCOPE, sys_id: GLOBAL_SCOPE };
    }
    return { scope: row.scope, sys_id: typeof row.sys_id === "string" ? row.sys_id : appId };
  };

  /** Reachability and authentication check: one row of sys_scope. */
  const checkConnection = async (timeout = 5000): Promise<void> => {
    await client.get(tablePath("sys_scope"), {
      params: { sysparm_limit: "1", sysparm_fields: "sys_id" },
      timeout,
    });
  };

  const createUpdateSet = (updateSetName: string) =>
    client.post<Sync.SNAPIResponse<SN.UpdateSetRecord>>(tablePath("sys_update_set"), { name: updateSetName });

  // WP-5 (R6): the CI/CD REST API (`sn_cicd`). Deliberately thin — the command
  // layer owns paths, parameters, polling and the error envelopes, so these two
  // stay trivially mockable. sn_cicd reads its arguments from the QUERY STRING
  // (as now-sdk sends them), not from a JSON body, so a POST carries no body.
  const cicdPost = <T = unknown>(path: string, params: Record<string, string> = {}) =>
    client.post<T>(`api/sn_cicd/${path.replace(/^\/+/, "")}`, undefined, {
      params,
      maxRedirects: CICD_MAX_REDIRECTS,
    });

  const cicdGet = <T = unknown>(path: string) =>
    client.get<T>(`api/sn_cicd/${path.replace(/^\/+/, "")}`, { maxRedirects: CICD_MAX_REDIRECTS });

  // WP-3 (R3): the instance's application vendor prefix, as App Creator and
  // now-sdk read it. A platform (Java) REST resource, not a scripted API; the
  // WP-0 spike saw `{"result":"x_acme_"}` (the value includes `x_` and the
  // trailing underscore). The caller normalizes it.
  const getVendorPrefix = () =>
    client.get<Sync.SNAPIResponse<string>>("api/now/appcreator/app/vendorprefix");

  return {
    // Records through the Table API.
    tableAPIGet,
    findRecordByName,
    getRecordScope,
    createRecord,
    updateRecord,
    deleteRecord,
    // Session context: scope, user, current application and update set.
    getScopeId,
    getUserSysId,
    getSessionScope,
    getCurrentAppUserPrefSysId: currentApp.find,
    updateCurrentAppUserPref: currentApp.overwrite,
    createCurrentAppUserPref: currentApp.insert,
    createUpdateSet,
    getCurrentUpdateSetUserPref: currentUpdateSet.find,
    updateCurrentUpdateSetUserPref: currentUpdateSet.overwrite,
    createCurrentUpdateSetUserPref: currentUpdateSet.insert,
    getVendorPrefix,
    checkConnection,
    // CI/CD REST API.
    cicdPost,
    cicdGet,
  };
};

// The process-wide client `defaultClient` hands out, remembered together with
// the fingerprint of the credentials it was built from: a command that switches
// profile or instance gets a fresh client, every other call shares this one.
let sharedClient: { fingerprint: string; client: SNClient } | undefined;
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
  /** A pre-issued OAuth access token (`SN_BEARER_TOKEN`), environment only. */
  bearerToken?: string;
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

// A named profile that defines no instance falls back to the base SN_INSTANCE by
// design (profile overlay — a credentials-only profile is legitimate, which is
// why this is a warning and not an error). But the user NAMED that profile, so
// the silent retarget is exactly what they did not ask for — worst on the `mcp`
// path, where the fallback instance is persisted into .syncrona-mcp/secrets.json
// and every later MCP session inherits it. Same dedupe rationale as
// warnedAuthIssues: resolution runs several times per command.
const warnedProfileFallbacks = new Set<string>();

function warnAboutProfileInstanceFallback(profile: string, fallbackInstance: string): void {
  const profileVar = profileEnvVar("SN_INSTANCE", profile);
  const line =
    `Instance profile "${profile}" defines no instance (${profileVar} is not set): ` +
    `falling back to the base SN_INSTANCE "${fallbackInstance}". ` +
    `If that target is intended, set ${profileVar} to it explicitly to silence this warning.`;
  if (warnedProfileFallbacks.has(line)) {
    return;
  }
  warnedProfileFallbacks.add(line);
  logger.warn(line);
}

/** Test seam: the dedupe cache would otherwise leak between cases. */
export function resetProfileFallbackWarnings(): void {
  warnedProfileFallbacks.clear();
}

// Re-exported so the existing `snClient` import surface keeps working; the
// implementation lives in its own module (see instanceHost.ts).
export { normalizeInstanceHost };

// The correction is reported, not silently applied: the value in the user's
// .env or store is still wrong, and anything else reading it — a sibling tool,
// a CI variable copied elsewhere — will fail the same way. Deduped for the same
// reason as the other credential warnings: resolution runs several times per
// command with no memoization.
const warnedInstanceHosts = new Set<string>();

function normalizeInstanceHostWithNotice(raw: string, origin: string): string {
  const host = normalizeInstanceHost(raw);
  if (!raw || host === raw) {
    return host;
  }
  const line =
    `Instance "${raw}" (${origin}) is a URL, not a host — using "${host}". ` +
    "Store the bare host name (e.g. dev12345.service-now.com) to silence this warning.";
  if (!warnedInstanceHosts.has(line)) {
    warnedInstanceHosts.add(line);
    logger.warn(line);
  }
  return host;
}

/** Test seam: the dedupe cache would otherwise leak between cases. */
export function resetInstanceHostWarnings(): void {
  warnedInstanceHosts.clear();
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
  // A bearer token is valid only on the instance that issued it, so a profile
  // that names its own instance never borrows the unprofiled token — it belongs
  // to SN_INSTANCE, and inferring bearer from it would send it to the profile's.
  const bearerToken =
    process.env[profileEnvVar(BEARER_TOKEN_ENV, normalizedProfile)] ||
    (normalizedProfile && instanceFromProfile ? "" : process.env[BEARER_TOKEN_ENV] || "");
  const jwtKey = envVar(JWT_KEY_ENV);
  const jwtKid = envVar(JWT_KID_ENV);
  const jwtIss = envVar(JWT_ISS_ENV);
  const jwtSub = envVar(JWT_SUB_ENV);
  const jwtAud = envVar(JWT_AUD_ENV);
  const explicitMethod = envVar(AUTH_METHOD_ENV);
  const password = passwordFromProfile || SN_PASSWORD;

  // Env vars take priority only when a usable credential is present; instance-only
  // env vars do not suppress the credential store so a stale .env cannot block a
  // fresh login. "Usable" now spans every method: a user, an OAuth client, an
  // API key, or a pre-issued bearer token.
  const hasEnvCreds = !!(SN_USER || userFromProfile || clientId || apiKey || bearerToken);
  if (!hasEnvCreds && storedCredentialsCache && !normalizedProfile) {
    return {
      creds: credentialsFromStore(storedCredentialsCache),
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
    hasBearerToken: !!bearerToken,
  });
  warnAboutAuthIssues(
    resolved,
    normalizedProfile ? `profile ${normalizedProfile}` : "environment"
  );

  if (normalizedProfile && !instanceFromProfile && SN_INSTANCE) {
    warnAboutProfileInstanceFallback(normalizedProfile, SN_INSTANCE);
  }

  const creds: SNCredentials = {
    user: userFromProfile || SN_USER,
    password,
    instance: instanceFromProfile
      ? normalizeInstanceHostWithNotice(
          instanceFromProfile,
          profileEnvVar("SN_INSTANCE", normalizedProfile)
        )
      : normalizeInstanceHostWithNotice(SN_INSTANCE, "SN_INSTANCE"),
    profile: normalizedProfile,
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
  };
  // profileEnvVar() falls back to the base var name when no profile is set, so
  // "came from a profile" requires both a profile AND a profile-specific value
  // (for any of the methods).
  const usedProfile =
    !!normalizedProfile &&
    (!!userFromProfile ||
      !!process.env[profileEnvVar(API_KEY_ENV, normalizedProfile)] ||
      !!process.env[profileEnvVar(BEARER_TOKEN_ENV, normalizedProfile)] ||
      !!process.env[profileEnvVar(OAUTH_CLIENT_ID_ENV, normalizedProfile)]);
  // A configuration is "present" when any method has its identifying credential.
  const hasCredential =
    !!creds.user ||
    !!creds.apiKey ||
    !!creds.bearerToken ||
    !!(creds.clientId && creds.clientSecret);
  const source: CredentialSource = hasCredential
    ? usedProfile
      ? "instance profile env vars"
      : "environment (.env / shell SN_* vars)"
    : "none (credentials missing)";
  return { creds, source };
}

/**
 * The client credentials a credential-store record stands for. Shared by the
 * store fallback of credential resolution and by `init`, which reads the
 * active profile directly and must authenticate with the same method.
 */
export function credentialsFromStore(stored: StoredCredentials): SNCredentials {
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
    user: stored.user,
    password: stored.password,
    instance: normalizeInstanceHostWithNotice(stored.instance, "credential store"),
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
  };
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
    credentials.clientSecret || "",
    credentials.authMethod || "",
    credentials.apiKey || "",
    credentials.apiKeyHeader || "",
    credentials.bearerToken || "",
    credentials.jwtKey || "",
    credentials.jwtKid || "",
    credentials.jwtIss || "",
    credentials.jwtSub || "",
    credentials.jwtAud || "",
  ].join("|");
}

export function setActiveInstanceProfile(profile?: string): void {
  activeInstanceProfile = normalizeProfileName(profile);
}

export function getActiveInstanceProfile(): string | undefined {
  return activeInstanceProfile;
}

export const resetClient = (): void => {
  sharedClient = undefined;
};

// Read PEM material that may be supplied inline (starts with a PEM armor) or as
// a filesystem path. Used for the JWT bearer signing key (SN_JWT_KEY).
//
// REV-208: the readFileSync call must never be allowed to throw its own error out
// of here. Node puts the path argument into the message verbatim ("ENOENT: no such
// file or directory, open '<value>'", or ENAMETOOLONG for anything past the OS
// filename limit) and also hangs it off `err.path`. Since this function reaches the
// filesystem for exactly the values that are NOT armored, a key supplied base64-
// encoded — the standard way to carry a PEM in one environment variable or CI
// secret — is a private key reproduced in full inside an error message, which then
// fans out to stderr logs, the audit trail and the error text returned to a client.
// The audit secret scanner cannot save us either: it matches literal
// `-----BEGIN ... PRIVATE KEY-----` armor, precisely the shape this function
// short-circuits on, so a non-armored key structurally never matches.
//
// The replacement message keeps every fact needed to debug a genuine path typo —
// which setting was read, that it was interpreted as a path, the fs error code, and
// the value's size — while carrying none of the value. The original error is
// deliberately NOT attached as `cause`: a cause chain is stringified by enough
// loggers that keeping it would re-open the same leak one indirection later.
function readPemMaterial(value: string): string {
  if (value.includes("-----BEGIN")) {
    return value;
  }
  try {
    return fs.readFileSync(value, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(
      `Could not read the JWT signing key: the configured value carries no PEM armor, ` +
        `so it was treated as a filesystem path and reading it failed with ${code} ` +
        `(${Buffer.byteLength(value, "utf8")} bytes supplied). Point SN_JWT_KEY at a ` +
        `readable .pem file, or supply the key inline including its ` +
        `"-----BEGIN ... PRIVATE KEY-----" lines. The value itself is withheld from ` +
        `this message because it may be the key.`
    );
  }
}

// Translate resolved credentials into the transport-level auth descriptor the
// snClient factory consumes: an OAuth config (for the three OAuth grants) or a
// static header (an API key, or a pre-issued bearer token). Basic auth needs neither — username/password flow directly.
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
  if (method === "bearer" && credentials.bearerToken) {
    return {
      apiKey: { header: "Authorization", value: `Bearer ${credentials.bearerToken}` },
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
  if (method === "bearer") {
    if (!credentials.bearerToken) missing.push("bearer token (SN_BEARER_TOKEN)");
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

export const defaultClient = (profile?: string): SNClient => {
  const credentials = resolveCredentials(profile);
  const fingerprint = credentialsKey(credentials);
  if (sharedClient?.fingerprint !== fingerprint) {
    const { oauth, apiKey } = buildClientAuth(credentials);
    const client = snClient(
      `https://${credentials.instance}/`,
      credentials.user,
      credentials.password,
      oauth,
      apiKey
    );
    sharedClient = { fingerprint, client };
  }
  return sharedClient.client;
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

/** A pending Table / scripted REST call whose body is the `{ result }` envelope. */
type PendingSNCall<T> = AxiosPromise<Sync.SNAPIResponse<T>>;

/**
 * Log why a response could not be unwrapped. A not-found status stays quiet:
 * the Table API answers it for a missing table or record, which the callers
 * handle themselves (a skipped table, an already-deleted record).
 */
function reportUnwrapFailure(e: unknown): void {
  const status = getErrorResponseStatus(e);
  if (typeof status === "number" && isEndpointNotFoundStatus(status)) {
    return;
  }
  logger.error("Error processing server response");
  logger.error(e instanceof Error ? e.message : String(e));
}

/** Await `pending` and return its `result`; failures are logged and rethrown as they are. */
export const unwrapSNResponse = async <T>(pending: PendingSNCall<T>): Promise<T> => {
  try {
    return assertSNApiResponse(await pending);
  } catch (e) {
    reportUnwrapFailure(e);
    throw e;
  }
};

/**
 * The first row of a list answer, or one column of it. An empty list is an
 * error here; use unwrapTableAPIFirstItemOrEmpty where "none" is a valid answer.
 */
export async function unwrapTableAPIFirstItem<T>(pending: PendingSNCall<T[]>): Promise<T>;
export async function unwrapTableAPIFirstItem<T>(pending: PendingSNCall<T[]>, column: keyof T): Promise<string>;
export async function unwrapTableAPIFirstItem<T extends Record<string, string>>(
  pending: PendingSNCall<T[]>,
  column?: keyof T
): Promise<T | string> {
  const rows = await unwrapSNResponse(pending);
  if (rows.length === 0) {
    throw new Error("Response was not a populated array!");
  }
  const [first] = rows;
  return column ? first[column] : first;
}

// Non-throwing variant for "find or create" flows: an empty result returns ""
// so the caller can take the create path instead of failing.
export async function unwrapTableAPIFirstItemOrEmpty<T>(
  pending: PendingSNCall<T[]>,
  column: keyof T
): Promise<string> {
  const rows = await unwrapSNResponse(pending);
  return rows.length === 0 ? "" : String(rows[0][column] ?? "");
}
