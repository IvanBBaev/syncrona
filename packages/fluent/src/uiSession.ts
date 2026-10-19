// SPDX-License-Identifier: GPL-3.0-or-later
//
// UI session login for the SDK's session-only endpoints.
//
// A few instance endpoints the ServiceNow SDK calls are UI processors, not REST
// APIs: `sn_appclient_upload_processor.do` (install), `xmlhttp.do` (reinstall)
// and `fluent_update_set_export.do` (transform from an update set). They
// authenticate with a browser session — the `JSESSIONID`/`glide_*` cookies plus
// the `X-UserToken` CSRF token — and reject a bare Basic header. This module
// performs the same two-step form login the SDK's own `auth` command does and
// returns the cookie and token in the shape the SDK's credential accepts.
//
// Credentials are only ever placed in the request body. Nothing here logs them,
// and no error message echoes them.

/** The parts of `fetch` this module uses; injectable so tests make no network calls. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect?: "manual" | "follow" },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  json(): Promise<unknown>;
}>;

export interface UiSession {
  type: "basic";
  /** The `X-UserToken` CSRF token; empty when the instance did not issue one. */
  token: string;
  /** `name=value; name=value` — the session cookies, ready for a `Cookie` header. */
  cookie: string;
}

export class FluentLoginError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FluentLoginError";
    this.code = code;
  }
}

/** Ordered cookie jar: a later `Set-Cookie` for the same name replaces the earlier value. */
export function mergeSetCookies(jar: Map<string, string>, setCookies: readonly string[]): void {
  for (const header of setCookies) {
    const pair = header.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

export function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function setCookiesOf(headers: { get(name: string): string | null; getSetCookie?(): string[] }): string[] {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function baseUrl(instanceUrl: string): string {
  return instanceUrl.endsWith("/") ? instanceUrl : `${instanceUrl}/`;
}

/**
 * Log in through `angular.do` and return the session cookie and CSRF token.
 *
 * Step 1 posts the login form and collects the session cookies; step 2 asks
 * for the current user with those cookies, which is the response that carries
 * `X-UserToken-Response`. The token is read even from a 401 on step 2, the way
 * the SDK does: some instances answer the probe with 401 yet still issue it.
 */
export async function loginUiSession(
  instanceUrl: string,
  username: string,
  password: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<UiSession> {
  const base = baseUrl(instanceUrl);
  const jar = new Map<string, string>();
  const body = new URLSearchParams({
    sysparm_type: "login",
    "ni.nolog.user_password": "true",
    user_name: username,
    user_password: password,
  }).toString();

  const login = await fetchImpl(`${base}angular.do?sysparm_type=view_form.login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    redirect: "manual",
  });
  if (login.status === 404) {
    throw new FluentLoginError(`Instance not found: ${base}`, "FLUENT_INSTANCE_NOT_FOUND");
  }
  if (!login.ok) {
    throw new FluentLoginError(
      `UI session login failed: ${login.status} ${login.statusText}`.trim(),
      "FLUENT_LOGIN_FAILED",
    );
  }
  mergeSetCookies(jar, setCookiesOf(login.headers));

  const payload = (await login.json().catch(() => ({}))) as { status?: unknown; message?: unknown };
  if (payload.status === "mfa_code_required") {
    throw new FluentLoginError(
      "UI session login needs a multi-factor code, which `syncrona fluent` cannot supply. " +
        "Use an OAuth profile, or a service account exempt from MFA.",
      "FLUENT_LOGIN_MFA",
    );
  }
  if (payload.status === "error") {
    const message = typeof payload.message === "string" && payload.message ? payload.message : "invalid credentials";
    throw new FluentLoginError(`UI session login failed: ${message}`, "FLUENT_LOGIN_FAILED");
  }

  const user = await fetchImpl(`${base}angular.do?sysparm_type=get_user`, {
    method: "POST",
    headers: { Accept: "application/json", Cookie: cookieHeader(jar) },
    redirect: "manual",
  });
  mergeSetCookies(jar, setCookiesOf(user.headers));
  const token = user.headers.get("x-usertoken-response") ?? "";

  return { type: "basic", token, cookie: cookieHeader(jar) };
}
