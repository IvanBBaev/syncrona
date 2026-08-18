// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * FakeInstanceServer — a local stand-in for a ServiceNow instance (§5.14).
 *
 * Built on Node's `http` module with no framework and no new dependency. A
 * framework would buy routing for six routes and cost the mirror package a
 * production-adjacent dependency in a file that must never ship; §5.14 says
 * this server is test-only, and `packages/mirror/tsconfig.json` guarantees that
 * structurally by compiling `src` alone.
 *
 * What the server is FOR determines what it refuses to be forgiving about:
 *
 *   - GET only. INV-2 says the mirror issues GETs through Phase 3. A fake that
 *     accepted a POST would let a write slip into the very work package that
 *     exists to prove no write happens, so every other verb is 405 AND is
 *     recorded as a protocol violation (see {@link FakeInstanceServer.assertNoViolations}).
 *   - Keyset paging only. `sysparm_offset` is answered with 400 and recorded,
 *     because offset paging on a mutating table skips and duplicates rows — the
 *     exact defect the keyset design exists to prevent. Silently honouring it
 *     would let a regression pass here and corrupt a real mirror.
 *   - Unknown query syntax is 400, never "ignored". See `query.ts`.
 *
 * What it is DELIBERATELY faithful about, because analyses §7 measured it:
 *
 *   - The error envelope is `{"error":{"message","detail"},"status":"failure"}`
 *     with a nullable `detail` (M1), and the 401/403 texts hit the marker
 *     patterns `classifyError` matches on — so a self-test can pin the fake
 *     against the real WP-M0 classifier instead of against a guess.
 *   - Hibernation answers HTTP **200** with an HTML page (§5.1). Serving 503
 *     would be easier and would make `diagnoseReachability`'s "HTML before
 *     status" ordering untestable, which is the one thing about hibernation
 *     that is easy to get wrong.
 *   - 429 carries `Retry-After` only when a fault rule asks for it. D6 measured
 *     the header as usually ABSENT, so the default path must be the headerless
 *     one or `computeRetryDelay`'s fallback never gets exercised.
 *   - Aggregate counts come back as STRINGS (M5), not numbers.
 *
 * Lifecycle: bind `127.0.0.1:0` and report the assigned port, so two CI jobs
 * cannot collide on a fixed one. {@link FakeInstanceServer.close} calls
 * `closeAllConnections()` before `close()`; without it a keep-alive socket
 * holds the event loop open and Jest reports the whole package as hanging.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  generateCorpus,
  synthesizeAttachmentBytes,
  wireColumnsByTable,
  type FixtureAttachment,
  type FixtureColumn,
  type FixtureCorpus,
  type FixtureRow,
} from "./corpus";
import { parseEncodedQuery, UnsupportedQueryError, type ParsedQuery } from "./query";
import { TableState } from "./tableState";

export type RouteKind =
  | "table-page"
  | "table-record"
  | "aggregate"
  | "attachment-meta"
  | "attachment-binary"
  | "unknown";

/** A value as it appears in a Table API response (M7, M17). */
export type WireValue = string | { value: string; link?: string; display_value?: string };
export type WireRow = Record<string, WireValue>;

export interface RequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  route: RouteKind;
  table: string | null;
  status: number;
  /** Rows in the response body, or null for a non-row route. */
  rowCount: number | null;
  /** Query fields the table silently ignored (M12). */
  droppedQueryFields: string[];
}

export interface ProtocolViolation {
  kind: "non-get-verb" | "offset-pagination";
  method: string;
  path: string;
  detail: string;
}

/**
 * A scripted failure.
 *
 * `skip` then `times` is what makes "the 5xx burst starts at page 3 and lasts
 * two pages" expressible without any per-test bookkeeping — the shape every
 * retry test actually needs.
 */
export interface FaultRule {
  /** Restrict to one route kind. Omitted → any route. */
  route?: RouteKind;
  /** Restrict to one table. Omitted → any table. */
  table?: string;
  /** Matching requests to let through before firing. Default 0. */
  skip?: number;
  /** Matching requests to fail once firing. Default 1. */
  times?: number;
  status: number;
  /**
   * `Retry-After` value. OMIT IT to reproduce the measured default: D6 found no
   * rate-limit headers on a real PDI's 429, so the headerless path is the
   * common case and the header is the exception a test opts into.
   */
  retryAfter?: string;
  /** Response body override. Defaults to the standard envelope for `status`. */
  body?: unknown;
  contentType?: string;
}

/** A change applied to the corpus between two pages (analyses §1). */
export interface MutationScript {
  table: string;
  /** Fires immediately after this many pages of `table` have been served. */
  afterPages: number;
  insertRows?: readonly FixtureRow[];
  updateRows?: ReadonlyArray<{ sysId: string; fields: Record<string, string> }>;
  deleteSysIds?: readonly string[];
}

export interface FakeInstanceCredentials {
  username: string;
  password: string;
}

export interface FakeInstanceOptions {
  corpus?: FixtureCorpus;
  /** Basic-auth pair, or null to disable authentication entirely. */
  credentials?: FakeInstanceCredentials | null;
  /** Accepted `Authorization: Bearer` token, in addition to Basic. */
  bearerToken?: string;
  hibernating?: boolean;
  /** Tables the Table API answers 403 for (F5). */
  aclDeniedTables?: readonly string[];
  /** Tables the Aggregate API answers 403 for — the null-count fallback (§5.10). */
  aggregateDeniedTables?: readonly string[];
  latencyMs?: number;
  latencyMsByRoute?: Partial<Record<RouteKind, number>>;
  faults?: readonly FaultRule[];
  mutations?: readonly MutationScript[];
}

export const DEFAULT_CREDENTIALS: FakeInstanceCredentials = {
  username: "mirror.svc",
  password: "fake-instance-secret",
};

/**
 * The hibernation page.
 *
 * Contains both markers `HIBERNATION_MARKERS` looks for ("hibernat" and "wake
 * your instance"). A page carrying only one would still pass the current
 * classifier and would stop passing the moment either marker is tightened, so
 * the fixture covers both on purpose.
 */
const HIBERNATION_HTML = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Instance Hibernating</title></head>',
  "<body>",
  "<h1>This instance is hibernating</h1>",
  "<p>Your Personal Developer Instance was put to sleep after a period of inactivity.</p>",
  '<p><a href="https://developer.servicenow.com/">Wake your instance</a> to continue.</p>',
  "</body>",
  "</html>",
  "",
].join("\n");

/** M1: `detail` is nullable and is frequently null on a real instance. */
const envelope = (message: string, detail: string | null = null): unknown => ({
  error: { message, detail },
  status: "failure",
});

/**
 * Default bodies per status.
 *
 * The 401 and 403 texts are chosen to match `classifyError`'s AUTH_MARKERS and
 * ACL_MARKERS respectively; `fakeInstance.test.ts` feeds them back through the
 * real classifier so this coupling is checked rather than assumed.
 */
function defaultBodyFor(status: number, table: string | null): unknown {
  if (status === 401) return envelope("User Not Authenticated", "Required to provide Auth information");
  if (status === 403) {
    return envelope(
      "Insufficient rights",
      `Operation against file '${table ?? "unknown"}' was denied due to a security constraint`
    );
  }
  if (status === 429) return envelope("Rate limit exceeded", "Too many requests");
  if (status >= 500) return envelope("Internal server error", null);
  return envelope("Request failed", null);
}

interface RouteMatch {
  kind: RouteKind;
  table: string | null;
  sysId: string | null;
}

function matchRoute(pathname: string): RouteMatch {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const [api, now, resource, ...rest] = segments;
  if (api !== "api" || now !== "now") return { kind: "unknown", table: null, sysId: null };

  if (resource === "table") {
    if (rest.length === 1) return { kind: "table-page", table: rest[0] as string, sysId: null };
    if (rest.length === 2) return { kind: "table-record", table: rest[0] as string, sysId: rest[1] as string };
    return { kind: "unknown", table: null, sysId: null };
  }
  if (resource === "stats" && rest.length === 1) {
    return { kind: "aggregate", table: rest[0] as string, sysId: null };
  }
  if (resource === "attachment") {
    if (rest.length === 0) return { kind: "attachment-meta", table: "sys_attachment", sysId: null };
    if (rest.length === 1) return { kind: "attachment-meta", table: "sys_attachment", sysId: rest[0] as string };
    if (rest.length === 2 && rest[1] === "file") {
      return { kind: "attachment-binary", table: "sys_attachment", sysId: rest[0] as string };
    }
  }
  return { kind: "unknown", table: null, sysId: null };
}

interface FaultState {
  rule: FaultRule;
  seen: number;
  fired: number;
}

interface PendingTimer {
  timer?: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

/** Thrown inside a handler to produce an error response without unwinding the server. */
class HttpError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, payload: unknown, headers: Record<string, string> = {}) {
    super(`fake instance responded ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.payload = payload;
    this.headers = headers;
  }
}

/**
 * What a route handler produces.
 *
 * The payload is RETURNED rather than stashed on the server. An earlier draft
 * kept it in an instance field, which is wrong the moment two requests overlap
 * — and they overlap by construction here, because latency injection exists
 * precisely to make them overlap.
 */
interface RouteOutcome {
  payload: unknown;
  rowCount: number | null;
  droppedFields: string[];
}

export class FakeInstanceServer {
  readonly corpus: FixtureCorpus;
  readonly baseUrl: string;
  readonly port: number;

  readonly #server: Server;
  readonly #tables: Map<string, TableState>;
  readonly #attachments: Map<string, FixtureAttachment>;
  readonly #options: Required<Pick<FakeInstanceOptions, "latencyMs">> & FakeInstanceOptions;
  readonly #faults: FaultState[];
  readonly #mutations: Array<{ script: MutationScript; fired: boolean }>;
  readonly #pagesServed = new Map<string, number>();
  readonly #pending = new Set<PendingTimer>();
  readonly #requests: RequestRecord[] = [];
  readonly #violations: ProtocolViolation[] = [];
  #hibernating: boolean;
  #closed = false;

  private constructor(server: Server, port: number, options: FakeInstanceOptions) {
    this.#server = server;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.corpus = options.corpus ?? generateCorpus();
    this.#options = { latencyMs: 0, ...options };
    this.#hibernating = options.hibernating ?? false;
    this.#faults = (options.faults ?? []).map((rule) => ({ rule, seen: 0, fired: 0 }));
    this.#mutations = (options.mutations ?? []).map((script) => ({ script, fired: false }));

    const columns = wireColumnsByTable(this.corpus);
    this.#tables = new Map(
      this.corpus.tables.map((table) => [table.name, new TableState(table, columns.get(table.name) ?? [])] as const)
    );
    this.#attachments = new Map(this.corpus.attachments.map((item) => [item.sysId, item] as const));
  }

  /** Start on an ephemeral loopback port. */
  static async start(options: FakeInstanceOptions = {}): Promise<FakeInstanceServer> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // 127.0.0.1 rather than 0.0.0.0: a fixture instance has no business being
      // reachable from outside the machine, and port 0 lets the OS pick a free
      // port so parallel CI jobs cannot collide.
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const instance = new FakeInstanceServer(server, address.port, options);
    server.on("request", (request, response) => {
      void instance.#handle(request, response);
    });
    return instance;
  }

  get requests(): readonly RequestRecord[] {
    return this.#requests;
  }

  get violations(): readonly ProtocolViolation[] {
    return this.#violations;
  }

  /** Flip hibernation at runtime, so a sweep can be interrupted by it (F4). */
  setHibernating(value: boolean): void {
    this.#hibernating = value;
  }

  /**
   * Apply a mutation immediately.
   *
   * This is a harness call, not an HTTP verb: it does not go through the router
   * and therefore cannot weaken the GET-only posture the router enforces.
   */
  mutate(mutation: Omit<MutationScript, "afterPages">): void {
    this.#applyMutation(mutation);
  }

  /** A copy of a table's current rows, for assertions. */
  rowsOf(table: string): FixtureRow[] {
    return this.#tableOrThrow(table).allRows();
  }

  /**
   * Throw if the client under test broke the protocol.
   *
   * Called from an `afterEach`, this is what turns "the fake tolerated a POST"
   * from a silent pass into a failure. A returned 405 alone is not enough: a
   * client that ignores the status code would still look green.
   */
  assertNoViolations(): void {
    if (this.#violations.length === 0) return;
    const lines = this.#violations.map((item) => `  ${item.kind}: ${item.method} ${item.path} — ${item.detail}`);
    throw new Error(`fake instance recorded protocol violations:\n${lines.join("\n")}`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Resolve rather than abandon: a latency sleep left pending would keep its
    // handler frame alive and, with it, a reference to the socket.
    for (const entry of this.#pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve();
    }
    this.#pending.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  // -------------------------------------------------------------------------
  // Request pipeline
  // -------------------------------------------------------------------------

  #sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const entry: PendingTimer = { resolve };
      entry.timer = setTimeout(() => {
        this.#pending.delete(entry);
        resolve();
      }, ms);
      this.#pending.add(entry);
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Drain the body unconditionally. A 405 that never reads the request stream
    // makes the client see ECONNRESET instead of the status it needs to assert.
    request.resume();

    const url = new URL(request.url ?? "/", this.baseUrl);
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    // Order is deliberate. The verb check comes FIRST, before hibernation and
    // before fault injection, so no configuration of this server can hide a
    // non-GET request from INV-2's audit.
    if (request.method !== "GET") {
      this.#violations.push({
        kind: "non-get-verb",
        method: request.method ?? "?",
        path: url.pathname,
        detail: "the mirror issues GET only through Phase 3 (INV-2)",
      });
      this.#record(request, url, query, "unknown", null, 405, null, []);
      response.setHeader("Allow", "GET");
      this.#send(response, 405, envelope("Method not allowed", "the fake instance is GET-only (INV-2)"));
      return;
    }

    // Hibernation next, and before routing: a hibernating instance answers the
    // HTML page on every path, including ones that do not exist.
    if (this.#hibernating) {
      this.#record(request, url, query, "unknown", null, 200, null, []);
      await this.#sleep(this.#latencyFor("unknown"));
      this.#sendRaw(response, 200, "text/html; charset=utf-8", Buffer.from(HIBERNATION_HTML, "utf8"));
      return;
    }

    const route = matchRoute(url.pathname);
    let status = 200;
    let rowCount: number | null = null;
    let dropped: string[] = [];
    let outcome: RouteOutcome;

    try {
      if (Object.prototype.hasOwnProperty.call(query, "sysparm_offset")) {
        this.#violations.push({
          kind: "offset-pagination",
          method: "GET",
          path: url.pathname,
          detail: "offset paging skips and duplicates rows on a mutating table; the mirror must keyset (§5.5)",
        });
        throw new HttpError(
          400,
          envelope("Unsupported parameter", "sysparm_offset is refused by the fake instance; use keyset paging")
        );
      }

      this.#checkFaults(route);
      this.#checkAuth(request);

      outcome = this.#dispatch(route, url, query, response);
      rowCount = outcome.rowCount;
      dropped = outcome.droppedFields;
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        this.#record(request, url, query, route.kind, route.table, status, rowCount, dropped);
        for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value);
        await this.#sleep(this.#latencyFor(route.kind));
        this.#send(response, status, error.payload);
        return;
      }
      /* c8 ignore next 4 -- a non-HttpError here is a defect in the fake itself */
      status = 500;
      this.#record(request, url, query, route.kind, route.table, status, rowCount, dropped);
      this.#send(response, 500, envelope("fake instance failure", String(error)));
      return;
    }

    this.#record(request, url, query, route.kind, route.table, status, rowCount, dropped);
    await this.#sleep(this.#latencyFor(route.kind));
    this.#send(response, status, outcome.payload);
    this.#runMutationsFor(route);
  }

  #latencyFor(route: RouteKind): number {
    return this.#options.latencyMsByRoute?.[route] ?? this.#options.latencyMs;
  }

  #record(
    request: IncomingMessage,
    url: URL,
    query: Record<string, string>,
    route: RouteKind,
    table: string | null,
    status: number,
    rowCount: number | null,
    droppedQueryFields: string[]
  ): void {
    this.#requests.push({
      method: request.method ?? "?",
      path: url.pathname,
      query,
      route,
      table,
      status,
      rowCount,
      droppedQueryFields,
    });
  }

  #checkFaults(route: RouteMatch): void {
    for (const state of this.#faults) {
      const { rule } = state;
      if (rule.route && rule.route !== route.kind) continue;
      if (rule.table && rule.table !== route.table) continue;
      state.seen += 1;
      if (state.seen <= (rule.skip ?? 0)) continue;
      if (state.fired >= (rule.times ?? 1)) continue;
      state.fired += 1;
      // The header is attached only when the rule asks for it. D6 measured a
      // real PDI's 429 as carrying no rate-limit headers at all, so an
      // unconditional `Retry-After` here would mean `computeRetryDelay`'s
      // exponential fallback is never once exercised by this suite.
      const headers: Record<string, string> = {};
      if (rule.retryAfter !== undefined) headers["Retry-After"] = rule.retryAfter;
      if (rule.contentType === undefined) {
        throw new HttpError(rule.status, rule.body ?? defaultBodyFor(rule.status, route.table), headers);
      }
      // A non-JSON fault body exists for the proxy/CDN case: a load balancer in
      // front of an instance answers 502 with an HTML page, and `classifyError`
      // must not choke trying to read `error.message` out of it.
      headers["Content-Type"] = rule.contentType;
      throw new HttpError(rule.status, Buffer.from(String(rule.body ?? ""), "utf8"), headers);
    }
  }

  #checkAuth(request: IncomingMessage): void {
    const credentials = this.#options.credentials === undefined ? DEFAULT_CREDENTIALS : this.#options.credentials;
    if (credentials === null && this.#options.bearerToken === undefined) return;

    const header = request.headers.authorization ?? "";
    if (this.#options.bearerToken !== undefined && header === `Bearer ${this.#options.bearerToken}`) return;
    if (credentials !== null && header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
      if (decoded === `${credentials.username}:${credentials.password}`) return;
    }
    throw new HttpError(401, defaultBodyFor(401, null));
  }

  #tableOrThrow(name: string | null): TableState {
    const table = name === null ? undefined : this.#tables.get(name);
    if (!table) {
      // A real instance answers 400 (not 404) for an unknown table, with the
      // table name echoed in `message` — the shape `classifyError` sees.
      throw new HttpError(400, envelope(`Invalid table ${name ?? ""}`, "Requested URI does not represent any resource"));
    }
    return table;
  }

  #assertTableReadable(name: string): void {
    if (this.#options.aclDeniedTables?.includes(name)) {
      throw new HttpError(403, defaultBodyFor(403, name));
    }
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  #dispatch(
    route: RouteMatch,
    url: URL,
    query: Record<string, string>,
    response: ServerResponse
  ): RouteOutcome {
    switch (route.kind) {
      case "table-page":
        return this.#servePage(route.table as string, query, response);
      case "table-record":
        return this.#serveRecord(route.table as string, route.sysId as string, query);
      case "aggregate":
        return this.#serveAggregate(route.table as string, query);
      case "attachment-meta":
        return this.#serveAttachmentMeta(route.sysId, query);
      case "attachment-binary":
        return this.#serveAttachmentBinary(route.sysId as string, response);
      default:
        throw new HttpError(404, envelope("No matching resource", `no route for ${url.pathname}`));
    }
  }

  #parseQuery(query: Record<string, string>): ParsedQuery {
    try {
      return parseEncodedQuery(query.sysparm_query ?? "");
    } catch (error) {
      if (error instanceof UnsupportedQueryError) {
        throw new HttpError(400, envelope("Invalid query", error.message));
      }
      /* c8 ignore next 2 -- parseEncodedQuery throws nothing else */
      throw error;
    }
  }

  #parseLimit(query: Record<string, string>): number {
    const raw = query.sysparm_limit;
    if (raw === undefined) return 10_000;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new HttpError(400, envelope("Invalid parameter", `sysparm_limit must be a positive integer, got ${raw}`));
    }
    return value;
  }

  #servePage(tableName: string, query: Record<string, string>, response: ServerResponse): RouteOutcome {
    this.#assertTableReadable(tableName);
    const table = this.#tableOrThrow(tableName);
    const parsed = this.#parseQuery(query);
    const limit = this.#parseLimit(query);
    const page = table.page(parsed, limit);
    const rows = page.rows.map((row) => this.#project(row, table, query));

    // `sysparm_suppress_pagination_header=true` is what `buildKeysetQuery`
    // sends. Emitting the headers only when it is absent makes the parameter
    // observable, so a test can prove the client actually sent it rather than
    // trusting that it did.
    if (query.sysparm_suppress_pagination_header !== "true") {
      if (page.total !== null) response.setHeader("X-Total-Count", String(page.total));
      const last = page.rows[page.rows.length - 1];
      if (last) {
        response.setHeader(
          "Link",
          `<${this.baseUrl}/api/now/table/${tableName}?sysparm_query=sys_id>${last.sys_id}^ORDERBYsys_id>;rel="next"`
        );
      }
    }

    this.#pagesServed.set(tableName, (this.#pagesServed.get(tableName) ?? 0) + 1);
    return { payload: { result: rows }, rowCount: rows.length, droppedFields: page.droppedFields };
  }

  #serveRecord(tableName: string, sysId: string, query: Record<string, string>): RouteOutcome {
    this.#assertTableReadable(tableName);
    const table = this.#tableOrThrow(tableName);
    const row = table.rowOf(sysId);
    if (!row) {
      // 404 with `detail: null` — M1 measured the nullable detail on exactly
      // this response, and it is the tombstone probe's expected answer.
      throw new HttpError(404, envelope("No Record found", null));
    }
    return { payload: { result: this.#project(row, table, query) }, rowCount: 1, droppedFields: [] };
  }

  #serveAggregate(tableName: string, query: Record<string, string>): RouteOutcome {
    if (this.#options.aggregateDeniedTables?.includes(tableName)) {
      // §5.10: the catalog must treat an unavailable aggregate as "count
      // unknown" and fall back, not as a fatal error. Without a table that
      // reliably refuses, that fallback is never executed.
      throw new HttpError(403, defaultBodyFor(403, tableName));
    }
    this.#assertTableReadable(tableName);
    const table = this.#tableOrThrow(tableName);
    const parsed = this.#parseQuery(query);

    const wantsCount = query.sysparm_count === "true";
    const maxFields = (query.sysparm_max_fields ?? "").split(",").filter((field) => field !== "");
    const unsupported = ["sysparm_min_fields", "sysparm_avg_fields", "sysparm_sum_fields", "sysparm_group_by"].filter(
      (parameter) => query[parameter] !== undefined
    );
    if (unsupported.length > 0) {
      throw new HttpError(400, envelope("Unsupported aggregate", `not implemented: ${unsupported.join(", ")}`));
    }
    if (!wantsCount && maxFields.length === 0) {
      throw new HttpError(400, envelope("Invalid request", "one of sysparm_count or sysparm_max_fields is required"));
    }

    const stats: { count?: string; max?: Record<string, string> } = {};
    // M5: counts arrive as STRINGS. A fake returning a number would let a
    // consumer get away with `stats.count + 1` and fail on a real instance.
    if (wantsCount) stats.count = String(table.countMatching(parsed.conditions));
    if (maxFields.length > 0) {
      const max: Record<string, string> = {};
      for (const field of maxFields) {
        // An empty table yields "" rather than null — the same M8 rule that
        // governs row fields governs aggregate results.
        max[field] = field === "sys_updated_on" ? table.maxUpdatedOn(parsed.conditions) ?? "" : "";
      }
      stats.max = max;
    }
    return { payload: { result: { stats } }, rowCount: null, droppedFields: [] };
  }

  #serveAttachmentMeta(sysId: string | null, query: Record<string, string>): RouteOutcome {
    const table = this.#tableOrThrow("sys_attachment");
    if (sysId !== null) {
      const row = table.rowOf(sysId);
      if (!row) throw new HttpError(404, envelope("No Record found", null));
      return { payload: { result: this.#project(row, table, query) }, rowCount: 1, droppedFields: [] };
    }
    const parsed = this.#parseQuery(query);
    const page = table.page(parsed, this.#parseLimit(query));
    return {
      payload: { result: page.rows.map((row) => this.#project(row, table, query)) },
      rowCount: page.rows.length,
      droppedFields: page.droppedFields,
    };
  }

  #serveAttachmentBinary(sysId: string, response: ServerResponse): RouteOutcome {
    const attachment = this.#attachments.get(sysId);
    if (!attachment) throw new HttpError(404, envelope("No Record found", null));
    const bytes = synthesizeAttachmentBytes(attachment.contentSeed, attachment.sizeBytes);
    response.setHeader("Content-Type", attachment.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${attachment.fileName}"`);
    return { payload: Buffer.from(bytes), rowCount: null, droppedFields: [] };
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  /**
   * Apply `sysparm_fields`, `sysparm_exclude_reference_link` and
   * `sysparm_display_value` to one row.
   *
   * A field named in `sysparm_fields` that the row does not carry is OMITTED,
   * not emitted as `""`. That is the F5 `column-missing` case, and the corpus's
   * phantom column exists so a projection can trigger it on demand.
   */
  #project(row: FixtureRow, table: TableState, query: Record<string, string>): WireRow {
    const requested = (query.sysparm_fields ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field !== "");
    const fields = requested.length > 0 ? requested : Object.keys(row);
    const excludeLinks = query.sysparm_exclude_reference_link === "true";
    const displayMode = query.sysparm_display_value ?? "false";

    const out: WireRow = {};
    for (const field of fields) {
      const value = row[field];
      if (value === undefined) continue;
      const column = table.columns.get(field);
      const link =
        column?.reference && value !== "" ? `${this.baseUrl}/api/now/table/${column.reference}/${value}` : undefined;

      if (displayMode === "all") {
        // M17: every field becomes an object, and reference fields additionally
        // carry `link`.
        const entry: { value: string; display_value: string; link?: string } = {
          value,
          display_value: this.#displayValue(column, value),
        };
        if (link && !excludeLinks) entry.link = link;
        out[field] = entry;
        continue;
      }
      if (displayMode === "true") {
        out[field] = this.#displayValue(column, value);
        continue;
      }
      // M7: without `sysparm_exclude_reference_link=true`, a reference field is
      // an object rather than a string — which is why `buildKeysetQuery` always
      // sends the parameter, and why the fake must change shape without it.
      out[field] = link && !excludeLinks ? { link, value } : value;
    }
    return out;
  }

  /** Display value of a reference: the referenced row's name, or the raw value. */
  #displayValue(column: FixtureColumn | undefined, value: string): string {
    if (!column?.reference || value === "") return value;
    const referenced = this.#tables.get(column.reference)?.rowOf(value);
    if (!referenced) return value;
    return referenced.sys_name ?? referenced.name ?? referenced.label ?? referenced.file_name ?? value;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  #runMutationsFor(route: RouteMatch): void {
    if (route.kind !== "table-page" || route.table === null) return;
    const served = this.#pagesServed.get(route.table) ?? 0;
    for (const entry of this.#mutations) {
      if (entry.fired) continue;
      if (entry.script.table !== route.table) continue;
      if (entry.script.afterPages !== served) continue;
      entry.fired = true;
      this.#applyMutation(entry.script);
    }
  }

  #applyMutation(mutation: Omit<MutationScript, "afterPages">): void {
    const table = this.#tableOrThrow(mutation.table);
    for (const row of mutation.insertRows ?? []) table.insert(row);
    for (const patch of mutation.updateRows ?? []) table.update(patch.sysId, patch.fields);
    for (const sysId of mutation.deleteSysIds ?? []) table.remove(sysId);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  #send(response: ServerResponse, status: number, payload: unknown): void {
    if (Buffer.isBuffer(payload)) {
      this.#sendRaw(response, status, response.getHeader("Content-Type")?.toString() ?? "application/octet-stream", payload);
      return;
    }
    this.#sendRaw(response, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(payload), "utf8"));
  }

  #sendRaw(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
    // `close()` may have destroyed the socket while a latency sleep was
    // pending; writing then throws ERR_STREAM_DESTROYED out of a detached
    // promise and fails an unrelated test with an unhandled rejection.
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", String(body.byteLength));
    response.end(body);
  }
}

/** Convenience: the fault rule shape for a 429 WITHOUT `Retry-After` (D6's measured default). */
export const rateLimitWithoutRetryAfter = (overrides: Partial<FaultRule> = {}): FaultRule => ({
  status: 429,
  ...overrides,
});

/** Convenience: a 429 WITH `Retry-After`, the case `computeRetryDelay` prefers when present. */
export const rateLimitWithRetryAfter = (seconds: number, overrides: Partial<FaultRule> = {}): FaultRule => ({
  status: 429,
  retryAfter: String(seconds),
  ...overrides,
});
