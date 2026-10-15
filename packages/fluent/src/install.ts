// SPDX-License-Identifier: GPL-3.0-or-later
//
// Native `fluent install` and `fluent status`: upload a packed app without the SDK.
//
// This reproduces the SDK's `Orchestrator.install` request for request:
//
// 1. `sys_upgrade_history` gives the id of the last install of the scope, so a
//    fallback poll can tell a new install from the previous one;
// 2. `sys_scope` says whether the app is already there and as which class
//    (`sys_app` or `sys_store_app`); a class the install would change is
//    refused unless `--reinstall`, which first uninstalls the app through the
//    `AppsAjaxProcessor` (`xmlhttp.do`) and waits for the update mutex;
// 3. the archive goes to `sn_appclient_upload_processor.do` as a multipart
//    upload carrying the `sysparm_fluent_*` parameters;
// 4. the execution tracker (`/api/sn_cicd/progress`) is polled until the
//    install succeeds or fails — or, when the instance answered without one,
//    `sys_upgrade_history` is polled for a new finished install;
// 5. the flows and actions in the build are activated
//    (`/api/now/wfa_fluent/activate_flows`) unless skipped.
//
// The upload processor and `xmlhttp.do` are UI processors: they take the
// session cookies and the `sysparm_ck` CSRF token, which is why the auth
// resolver hands over a UI session for a Basic profile.
//
// Two intended differences: the archive is packed before the instance is
// touched, so a build that cannot be packed never costs an uninstall; and the
// flows to activate are taken from the build's file names
// (`sys_hub_flow_<sys_id>.xml`) rather than the SDK's keys registry.

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SN } from "@syncrona/types";
import { FluentNativeError, nativePack, NativeProject, readNativeProject } from "./pack";

/** The response slice the native install reads. */
export interface InstallResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** `"opaqueredirect"` for a redirect `redirect: "manual"` did not follow. */
  type?: string;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The parts of `fetch` the native install uses; injectable so tests make no network calls. */
export type InstallFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | FormData;
    redirect?: "manual" | "follow";
    signal?: AbortSignal;
  },
) => Promise<InstallResponse>;

export interface NativeInstanceDeps {
  instanceUrl: string;
  auth: SN.FluentAuthResolver;
  logger: SN.FluentLogger;
  fetch?: InstallFetch;
  /** Waits between polls; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface NativeInstallOptions {
  clean?: boolean;
  installAsStoreApp?: boolean;
  installAsync?: boolean;
  demoData?: boolean;
  skipFlowActivation?: boolean;
}

export interface NativeInstallResult {
  trackerId?: string;
  rollbackId?: string;
}

/** `sys_execution_tracker` states. */
const TRACKER = { PENDING: "0", RUNNING: "1", SUCCESSFUL: "2", ERROR: "3" } as const;

const UPLOAD_TIMEOUT_MS = 300_000;
const TRACKER_POLL_MS = 2_000;
const TRACKER_LOG_EVERY = 15;
const STATUS_POLL_MS = 1_000;
const STATUS_POLL_ATTEMPTS = 30;
const UNINSTALL_POLL_MS = 1_000;
const UNINSTALL_LOG_EVERY = 30;
const MUTEX_POLL_ATTEMPTS = 30;
const FLOW_FAILURES_SHOWN = 5;
const HOSTED_PLUGIN_NOTE =
  "\n For apps with hosted_plugin content, please ensure sys_property 'glide.hosted_plugin.uninstall.disabled' is 'false'";

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setCookiesOf(headers: InstallResponse["headers"]): string[] {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/** Whether a `Set-Cookie` header expires its cookie (`Max-Age<=0` or an `Expires` in the past). */
function expires(attributes: readonly string[]): boolean {
  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    const key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? "" : attribute.slice(eq + 1).trim();
    if (key === "max-age" && Number(value) <= 0) return true;
    if (key === "expires" && Date.parse(value) < Date.now()) return true;
  }
  return false;
}

/** Apply `Set-Cookie` headers to `jar`: set, replace, or delete an expired cookie. */
export function applySetCookies(jar: Map<string, string>, setCookies: readonly string[]): void {
  for (const header of setCookies) {
    const [pair, ...attributes] = header.split(";");
    const eq = pair.indexOf("=");
    const name = eq < 0 ? "" : pair.slice(0, eq).trim();
    if (!name) continue;
    if (expires(attributes)) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1).trim());
  }
}

function parseCookieHeader(cookie: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) pairs.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return pairs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function jsonOf(response: InstallResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A session with the instance, as the SDK's `Connector` keeps one: auth
 * headers from the resolver, a cookie jar fed by every response, one retry
 * with fresh credentials after a 401, and the `sysparm_ck` CSRF token.
 */
export class InstanceSession {
  readonly origin: string;
  private readonly base: string;
  private readonly fetchImpl: InstallFetch;
  private readonly jar = new Map<string, string>();
  private resolved?: Promise<SN.FluentResolvedAuth>;
  private csrf?: Promise<string>;

  constructor(
    instanceUrl: string,
    private readonly resolver: SN.FluentAuthResolver,
    fetchImpl?: InstallFetch,
  ) {
    const url = new URL(instanceUrl);
    this.origin = url.origin;
    this.base = url.href.endsWith("/") ? url.href : `${url.href}/`;
    this.fetchImpl = fetchImpl ?? (fetch as unknown as InstallFetch);
  }

  private auth(): Promise<SN.FluentResolvedAuth> {
    this.resolved ??= this.resolver();
    return this.resolved;
  }

  private async once(url: string, init: Parameters<InstallFetch>[1]): Promise<InstallResponse> {
    const auth = await this.auth();
    const headers: Record<string, string> = { ...init.headers };
    const cookies = new Map(this.jar);
    if (auth.type === "basic") {
      if (auth.token) headers["X-UserToken"] = auth.token;
      for (const [name, value] of parseCookieHeader(auth.cookie)) cookies.set(name, value);
    } else {
      headers.Authorization = `Bearer ${auth.token}`;
    }
    if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await this.fetchImpl(url, { ...init, headers });
    applySetCookies(this.jar, setCookiesOf(response.headers));
    return response;
  }

  /** Send a request to `relative` (resolved against the instance); a 401 re-resolves the credential once. */
  async request(relative: string, init: Parameters<InstallFetch>[1]): Promise<InstallResponse> {
    const url = new URL(relative, this.base).href;
    const response = await this.once(url, init);
    if (response.status !== 401) return response;
    this.resolved = undefined;
    this.csrf = undefined;
    return this.once(url, init);
  }

  /** GET a Table API table and return its `result` rows. */
  async table(table: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams(params).toString();
    const response = await this.request(`api/now/table/${table}?${query}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new FluentNativeError(
        `Table API request to ${table} failed: ${response.status} ${response.statusText}`.trim(),
        "FLUENT_INSTANCE_REQUEST_FAILED",
      );
    }
    const result = record(await jsonOf(response)).result;
    return Array.isArray(result) ? result.map(record) : [];
  }

  /** The `sysparm_ck` the UI processors check; empty when the instance issued none. */
  sysparmCk(): Promise<string> {
    this.csrf ??= this.lookupCsrf();
    return this.csrf;
  }

  private async lookupCsrf(): Promise<string> {
    try {
      const auth = await this.auth();
      if (auth.type === "basic" && auth.token) return auth.token;
      const response = await this.request("api/now/ui/user/current_user", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const user = str(record(record(await jsonOf(response)).result).user_name);
      const sessionId = this.jar.get("glide_session_store");
      if (!sessionId && !user) return "";
      const rows = await this.table("sys_user_session", {
        sysparm_fields: "csrf_token,id",
        sysparm_query: sessionId ? `id=${sessionId}` : `name=${user}^ORDERBYDESClast_accessed`,
        sysparm_limit: "1",
      });
      return str(rows[0]?.csrf_token) ?? "";
    } catch {
      return "";
    }
  }

  /** POST to `com.snc.apps.AppsAjaxProcessor` through `xmlhttp.do`. */
  async appsAjax(params: Record<string, string>): Promise<InstallResponse> {
    const body = new URLSearchParams({
      sysparm_processor: "com.snc.apps.AppsAjaxProcessor",
      ...params,
      sysparm_ck: await this.sysparmCk(),
    }).toString();
    return this.request("xmlhttp.do", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "*/*" },
      body,
    });
  }

  /** The state of an execution tracker. */
  async progress(id: string): Promise<{ status?: string; status_message?: string; percent_complete?: number }> {
    const response = await this.request(`api/sn_cicd/progress/${id}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new FluentNativeError(`Failed to fetch progress status: ${response.statusText}`, "FLUENT_PROGRESS_FAILED");
    }
    const result = record(record(await jsonOf(response)).result);
    return {
      status: str(result.status),
      status_message: str(result.status_message),
      percent_complete: typeof result.percent_complete === "number" ? result.percent_complete : Number(result.percent_complete),
    };
  }
}

interface ScopeInfo {
  appId: string;
  sysClassName: string;
  active: boolean;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

async function getScopeInfo(session: InstanceSession, project: NativeProject): Promise<ScopeInfo | undefined> {
  const query = [project.scope && `scope=${project.scope}`, project.scopeId && `sys_id=${project.scopeId}`]
    .filter(Boolean)
    .join("^");
  const rows = await session.table("sys_scope", {
    sysparm_query: query,
    sysparm_fields: "sys_id,sys_class_name,active,scope,name,short_description",
    sysparm_limit: "2",
  });
  if (rows.length === 0) return undefined;
  if (rows.length > 1) {
    throw new FluentNativeError(
      `Multiple scopes detected with the scope name ${project.scope}! Please resolve the multiple application installations and try again.`,
      "FLUENT_SCOPE_AMBIGUOUS",
    );
  }
  const [row] = rows;
  return { appId: str(row.sys_id) ?? "", sysClassName: str(row.sys_class_name) ?? "", active: truthy(row.active) };
}

async function lastInstall(session: InstanceSession, scope: string): Promise<{ finished: boolean; id: string }> {
  const [row] = await session.table("sys_upgrade_history", {
    sysparm_query: `to_version=${scope}^ORDERBYDESCupgrade_started`,
    sysparm_fields: "upgrade_finished,sys_id",
    sysparm_limit: "1",
  });
  return { finished: Boolean(row?.upgrade_finished), id: str(row?.sys_id) ?? "" };
}

interface UninstallContext {
  session: InstanceSession;
  project: NativeProject;
  isStoreApp: boolean;
  logger: SN.FluentLogger;
  sleep: (ms: number) => Promise<void>;
}

async function waitForUninstall(ctx: UninstallContext, progressId: string): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const progress = await ctx.session.progress(progressId);
    const message = progress.status_message ?? "";
    const done =
      (progress.status === TRACKER.SUCCESSFUL && progress.percent_complete === 100) ||
      message.includes("Failed to completely delete application") ||
      message.includes("The store application was deactivated");
    if (done) {
      if (progress.status === TRACKER.ERROR) {
        ctx.logger.warn(
          "Deleted application and metadata. Some ACL protected metadata may remain. For a truly clean install, please delete/uninstall app from instance UI",
        );
      } else {
        ctx.logger.info(message);
      }
      return true;
    }
    if (progress.status !== TRACKER.PENDING && progress.status !== TRACKER.RUNNING && progress.status !== TRACKER.SUCCESSFUL) {
      ctx.logger.warn(message);
      return false;
    }
    if (attempt % UNINSTALL_LOG_EVERY === 0) ctx.logger.info(`Uninstall pending, waiting on ${message}`);
    await ctx.sleep(UNINSTALL_POLL_MS);
  }
}

async function waitForMutexRelease(ctx: UninstallContext): Promise<boolean> {
  for (let attempt = 1; attempt <= MUTEX_POLL_ATTEMPTS; attempt++) {
    const held = await ctx.session.table("sys_mutex", {
      sysparm_fields: "sys_id",
      sysparm_query: "name=Update-Mutex^acquiredISNOTEMPTY",
    });
    if (held.length === 0) return true;
    if (attempt < MUTEX_POLL_ATTEMPTS) await ctx.sleep(UNINSTALL_POLL_MS);
  }
  ctx.logger.warn("The update mutex is still held after the uninstall.");
  return false;
}

/** The SDK's `Uninstaller.process`: delete the app, wait for it, and check the scope is gone. */
async function uninstall(ctx: UninstallContext, appId: string): Promise<void> {
  const note = ctx.project.hostedPlugins ? HOSTED_PLUGIN_NOTE : "";
  const changed = await ctx.session.appsAjax({ sysparm_function: "changeApplication", sysparm_value: appId });
  if (!changed.ok) {
    throw new FluentNativeError(`Failed to set current application: ${changed.statusText}`, "FLUENT_UNINSTALL_FAILED");
  }
  const response = await ctx.session.appsAjax({
    sysparm_function: ctx.isStoreApp ? "uninstallApplication" : "deleteApplication",
    sysparm_sys_id: appId,
    sysparm_fluent_app: "true",
    sysparm_delete_all: "true",
  });
  if (!response.ok) {
    throw new FluentNativeError(
      `Failed to uninstall application: ${response.statusText}${note}`,
      "FLUENT_UNINSTALL_FAILED",
    );
  }
  const progressId = /<xml[^>]*\sanswer="([^"]*)"/.exec(await response.text())?.[1];
  if (!progressId || !(await waitForUninstall(ctx, progressId))) {
    throw new FluentNativeError(
      `App uninstall is taking too long or failed, please check the instance logs${note}`,
      "FLUENT_UNINSTALL_FAILED",
    );
  }
  if (!(await waitForMutexRelease(ctx))) {
    throw new FluentNativeError(
      "Error while waiting for app uninstall to complete, please check the instance logs",
      "FLUENT_UNINSTALL_FAILED",
    );
  }
  const after = await getScopeInfo(ctx.session, ctx.project);
  if (after?.appId && after.active) {
    throw new FluentNativeError("Failed to uninstall application, sys_scope record still exists", "FLUENT_UNINSTALL_FAILED");
  }
  ctx.logger.info(`Successfully uninstalled application with scope ID: ${appId}`);
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function upload(
  session: InstanceSession,
  project: NativeProject,
  zipPath: string,
  options: { loadDemoData: boolean; isStoreApp: boolean; installAsync: boolean },
): Promise<NativeInstallResult | undefined> {
  const form = new FormData();
  form.append("upload_type", "file");
  form.append("load_demo", String(options.loadDemoData));
  form.append("sysparm_ck", await session.sysparmCk());
  form.append("attachFile", new Blob([await readFile(zipPath)]), path.basename(zipPath));
  const params = new URLSearchParams({
    sysparm_track_fluent_install: "true",
    sysparm_async_fluent_install: String(options.installAsync),
    sysparm_fluent_scope_id: project.scopeId,
    sysparm_fluent_scope_name: project.scope,
    sysparm_fluent_app_version: project.packageVersion,
  });
  if (!options.isStoreApp) params.set("sysparm_request_type", "custom_app");

  let response: InstallResponse;
  try {
    response = await session.request(`sn_appclient_upload_processor.do?${params}`, {
      method: "POST",
      headers: {},
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new FluentNativeError("The deployment request timed out waiting for a response.", "FLUENT_INSTALL_TIMEOUT");
    }
    throw error;
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new FluentNativeError(
      "The install request was redirected away from the upload endpoint, which usually indicates a session or authentication conflict on the instance. The app was not installed.",
      "FLUENT_INSTALL_REDIRECTED",
    );
  }
  if (response.status === 401) {
    throw new FluentNativeError(
      "Insufficient permissions to install the app. Ensure you have the required roles.",
      "FLUENT_INSTALL_FORBIDDEN",
    );
  }
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson || !(response.ok || response.status === 400)) return undefined;
  const body = record(await jsonOf(response));
  const trackerId = str(body.executionTracker);
  if (!trackerId) return undefined;
  return { trackerId, rollbackId: str(body.rollbackContext) };
}

async function trackInstall(
  session: InstanceSession,
  result: NativeInstallResult & { trackerId: string },
  logger: SN.FluentLogger,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const trackerUrl = `${session.origin}/sys_execution_tracker.do?sys_id=${result.trackerId}`;
  for (let attempt = 1; ; attempt++) {
    let progress: Awaited<ReturnType<InstanceSession["progress"]>>;
    try {
      progress = await session.progress(result.trackerId);
    } catch (error) {
      throw new FluentNativeError(
        `Unable to track app install status due to a connection error. Monitor progress and verify the outcome at ${trackerUrl} (${errorMessage(error)})`,
        "FLUENT_INSTALL_UNTRACKED",
      );
    }
    if (progress.status === TRACKER.SUCCESSFUL) {
      if (result.rollbackId) {
        logger.info(`Rollback (undo installation): ${session.origin}/sys_rollback_context.do?sys_id=${result.rollbackId}`);
      }
      return;
    }
    if (progress.status === TRACKER.ERROR) {
      throw new FluentNativeError(
        `${progress.status_message || "App install failed"}. See execution details at ${trackerUrl}`,
        "FLUENT_INSTALL_FAILED",
      );
    }
    if (attempt % TRACKER_LOG_EVERY === 0) {
      logger.info(`App install pending: ${progress.percent_complete}% complete, ${progress.status_message ?? ""}`);
    }
    await sleep(TRACKER_POLL_MS);
  }
}

async function waitForNewInstall(
  session: InstanceSession,
  scope: string,
  previousId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS; attempt++) {
    const status = await lastInstall(session, scope);
    if (status.finished && status.id !== previousId) return;
    if (attempt < STATUS_POLL_ATTEMPTS) await sleep(STATUS_POLL_MS);
  }
  throw new FluentNativeError(
    "Could not determine app installation status. Check instance to verify installation.",
    "FLUENT_INSTALL_UNKNOWN",
  );
}

const FLOW_FILE = /^(sys_hub_flow|sys_hub_action_type_definition)_([0-9a-f]{32})\.xml$/;

/** The flows and actions in the build, by the `<table>_<sys_id>.xml` names the build writes. */
export function flowIds(project: NativeProject): { flows: string[]; actions: string[] } {
  const flows: string[] = [];
  const actions: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name));
        continue;
      }
      const match = FLOW_FILE.exec(entry.name);
      if (match) (match[1] === "sys_hub_flow" ? flows : actions).push(match[2]);
    }
  };
  visit(path.resolve(project.projectDir, project.appOutputDir));
  return { flows: flows.sort(), actions: actions.sort() };
}

interface FlowResult {
  flow_name?: string;
  sys_id?: string;
  message?: string;
  errorMessage?: string;
  success?: boolean;
}

/** Activate the build's flows and actions after the install, as the SDK's post-install task does. */
async function activateFlows(session: InstanceSession, project: NativeProject, logger: SN.FluentLogger): Promise<void> {
  const { flows, actions } = flowIds(project);
  if (flows.length === 0 && actions.length === 0) {
    logger.debug("No flows or actions to activate.");
    return;
  }
  const toEntry = (sysId: string) => ({ sys_id: sysId, active: "", state: "" });
  const response = await session.request(
    `api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=${encodeURIComponent(project.scopeId)}`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ flows: flows.map(toEntry), actions: actions.map(toEntry) }),
    },
  );
  const body = record(await jsonOf(response));
  if (!response.ok && response.status !== 422) {
    const message =
      str(record(record(body.result).error).message) ??
      str(record(body.error).message) ??
      str(body.message) ??
      response.statusText;
    if (message.includes("does not represent any resource")) {
      logger.debug(`Flow activation is not available on this instance: ${message}`);
      return;
    }
    throw new FluentNativeError(`Failed to activate flows: ${message}`, "FLUENT_FLOW_ACTIVATION_FAILED");
  }
  const result = record(body.result);
  const summary = record(result.summary);
  const total = Number(summary.total ?? 0);
  const succeeded = Number(summary.succeeded ?? 0);
  const failed = Number(summary.failed ?? 0);
  if (total === 0) {
    logger.debug("Flow activation found nothing to activate.");
    return;
  }
  if (failed === 0) {
    logger.info(`Flow activation complete: ${succeeded}/${total} succeeded`);
    return;
  }
  const failures = (Array.isArray(result.results) ? (result.results as FlowResult[]) : []).filter((r) => r.success === false);
  for (const failure of failures.slice(0, FLOW_FAILURES_SHOWN)) {
    const detail = failure.errorMessage ? `: ${failure.errorMessage}` : "";
    logger.warn(`  Failed: ${failure.flow_name ?? failure.sys_id} — ${failure.message ?? ""}${detail}`);
  }
  if (failures.length > FLOW_FAILURES_SHOWN) logger.warn(`  ... and ${failures.length - FLOW_FAILURES_SHOWN} more`);
  const message = `Flow activation complete: ${succeeded}/${total} succeeded, ${failed} failed`;
  if (succeeded === 0) throw new FluentNativeError(message, "FLUENT_FLOW_ACTIVATION_FAILED");
  logger.warn(message);
}

/** Pack the built app in `projectDir` and install it on the instance, the way `now-sdk install` does. */
export async function nativeInstall(
  projectDir: string,
  options: NativeInstallOptions,
  deps: NativeInstanceDeps,
): Promise<NativeInstallResult> {
  const { logger } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const project = readNativeProject(projectDir);
  const zipPath = nativePack(projectDir);
  const session = new InstanceSession(deps.instanceUrl, deps.auth, deps.fetch);

  const previous = await lastInstall(session, project.scope);
  const scopeInfo = await getScopeInfo(session, project);
  const isStoreApp = scopeInfo?.sysClassName === "sys_store_app";
  const wantsStoreApp = Boolean(options.installAsStoreApp) || project.hostedPlugins || project.installAs === "store";

  if (scopeInfo && !options.clean && wantsStoreApp !== isStoreApp) {
    if (scopeInfo.sysClassName === "sys_app" && (project.hostedPlugins || project.installAs === "store")) {
      throw new FluentNativeError(
        "Attempting to install app with hosted_plugin content which requires 'sys_store_app' deployment, but there is already a 'sys_app' record for this scope present on the instance. Install with flag '--reinstall' (-r) to delete existing app and reinstall",
        "FLUENT_INSTALL_CLASS_MISMATCH",
      );
    }
    if (!project.hostedPlugins) {
      throw new FluentNativeError(
        `Attempting to install ${options.installAsStoreApp ? "a store app" : "an app"} record but there is already a ${isStoreApp ? "sys_store_app" : "sys_app"} record for this scope present on the instance. Install with flag '--reinstall' (-r) to delete existing app and reinstall`,
        "FLUENT_INSTALL_CLASS_MISMATCH",
      );
    }
  }

  if (scopeInfo && options.clean) {
    logger.info(`Uninstalling application ${scopeInfo.appId} for clean installation...`);
    logger.warn(
      "A clean install deletes the application and all of its metadata on the instance, including records that are not part of this project.",
    );
    await uninstall({ session, project, isStoreApp, logger, sleep }, scopeInfo.appId);
  }

  if (project.hostedPlugins) {
    logger.warn("Hosted content will not be reloaded if the application version is unchanged.");
  }

  const result = await upload(session, project, zipPath, {
    loadDemoData: options.demoData ?? true,
    isStoreApp: isStoreApp || wantsStoreApp,
    installAsync: options.installAsync ?? true,
  });
  if (result?.trackerId) {
    await trackInstall(session, { ...result, trackerId: result.trackerId }, logger, sleep);
  } else {
    await waitForNewInstall(session, project.scope, previous.id, sleep);
  }

  if (!options.skipFlowActivation) {
    try {
      await activateFlows(session, project, logger);
    } catch (error) {
      logger.debug(`Post-install task "flow-activation" failed: ${errorMessage(error)}`);
    }
  }
  return result ?? {};
}

/** The latest install of the project's scope, as `now-sdk install --status` reports it. */
export async function nativeInstallStatus(
  projectDir: string,
  deps: Pick<NativeInstanceDeps, "instanceUrl" | "auth" | "fetch">,
): Promise<{ finished: boolean; id?: string }> {
  const project = readNativeProject(projectDir);
  const session = new InstanceSession(deps.instanceUrl, deps.auth, deps.fetch);
  return lastInstall(session, project.scope);
}
