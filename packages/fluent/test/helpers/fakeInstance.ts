// SPDX-License-Identifier: GPL-3.0-or-later
// A scripted ServiceNow instance and a probe project for the native install tests.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstallFetch, InstallResponse } from "../../src/install";

const FIXTURE = path.join(__dirname, "..", "fixtures", "probe-app");
export const INSTANCE = "https://dev.example.com";
const dirs: string[] = [];

/** Remove every project {@link probeProject} made; call it from `afterAll`. */
export function removeProbeProjects(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The probe app with its build in `dist/app`, the config overridden by `config`. */
export function probeProject(config: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "syncrona-install-"));
  dirs.push(dir);
  const base = JSON.parse(readFileSync(path.join(FIXTURE, "now.config.json"), "utf8"));
  writeFileSync(path.join(dir, "now.config.json"), JSON.stringify({ ...base, ...config }));
  cpSync(path.join(FIXTURE, "package.json"), path.join(dir, "package.json"));
  cpSync(path.join(FIXTURE, "build-output"), path.join(dir, "dist", "app"), { recursive: true });
  return dir;
}

export const THROWS = Symbol("json throws");

export interface Reply {
  status?: number;
  statusText?: string;
  type?: string;
  headers?: Record<string, string | undefined>;
  setCookie?: string[];
  /** Omit `getSetCookie`, so the single `set-cookie` header is read instead. */
  legacyHeaders?: boolean;
  text?: string;
}

export function res(body: unknown = {}, init: Reply = {}): InstallResponse {
  const status = init.status ?? 200;
  const headers = { "content-type": "application/json", ...init.headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? "",
    type: init.type,
    headers: init.legacyHeaders
      ? { get: (name) => headers[name.toLowerCase() as keyof typeof headers] ?? null }
      : { get: (name) => headers[name.toLowerCase() as keyof typeof headers] ?? null, getSetCookie: () => init.setCookie ?? [] },
    json: async () => {
      if (body === THROWS) throw new SyntaxError("bad json");
      return body;
    },
    text: async () => init.text ?? "",
  };
}

export type Init = Parameters<InstallFetch>[1];
export type Responder = InstallResponse | ((init: Init, url: URL) => InstallResponse | Promise<InstallResponse>);

/** A scripted instance: each route answers from its queue, the last answer repeating. */
export class FakeInstance {
  readonly calls: Array<{ method: string; url: URL; init: Init }> = [];
  private readonly routes = new Map<string, Responder[]>();

  constructor() {
    this.on("GET", "api/now/table/sys_upgrade_history", res({ result: [] }));
    this.on("GET", "api/now/table/sys_scope", res({ result: [] }));
    this.on("POST", "sn_appclient_upload_processor.do", res({ executionTracker: "t1", rollbackContext: "r1" }));
    this.on("GET", "api/sn_cicd/progress/t1", res({ result: { status: "2" } }));
    this.on("POST", "api/now/wfa_fluent/activate_flows", res({ result: { summary: { total: 2, succeeded: 2, failed: 0 } } }));
  }

  on(method: string, route: string, ...responders: Responder[]): this {
    this.routes.set(`${method} /${route}`, responders);
    return this;
  }

  readonly fetch: InstallFetch = async (url, init) => {
    const parsed = new URL(url);
    this.calls.push({ method: init.method, url: parsed, init });
    const queue = this.routes.get(`${init.method} ${parsed.pathname}`);
    if (!queue) throw new Error(`unexpected ${init.method} ${parsed.pathname}`);
    const next = queue.length > 1 ? (queue.shift() as Responder) : queue[0];
    return typeof next === "function" ? next(init, parsed) : next;
  };

  to(route: string): Array<{ method: string; url: URL; init: Init }> {
    return this.calls.filter((c) => c.url.pathname === `/${route}`);
  }
}
