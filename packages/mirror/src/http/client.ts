// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * MirrorHttpClient — the mirror's own ServiceNow transport (architecture §5.2, Δ1).
 *
 * Δ1 makes this package the owner of its HTTP client rather than a consumer of
 * the core CLI's `snClient`. That is not duplication for its own sake: the mirror
 * needs binary GET for attachments, a rate limit it sets per sweep, and a retry
 * policy tied to the F1–F9 taxonomy — three things the v1 client does not do and
 * should not learn. What is NOT duplicated is the policy: classification, the
 * reachability tri-state, backoff and keyset query construction all come from
 * `@syncrona/sn-transport`, so the mirror and the two v1 clients cannot drift on
 * the decisions that matter.
 *
 * **INV-2 — GET only.** This module issues no state-changing request, in any
 * phase through Phase 3. The invariant is enforced three ways, deliberately
 * overlapping: {@link MirrorHttpRequestInit} types the verb as the literal
 * `"GET"` so the seam cannot express another one; every call site here goes
 * through the single `send` helper; and a test greps the package's built output
 * for state-changing verbs, because the first two guarantees are erased at
 * runtime and the invariant is a claim about the shipped artifact.
 *
 * **Transport mechanism.** §5.2 describes "thin axios + axios-rate-limit". This
 * implementation instead speaks through {@link MirrorFetch}, an injected
 * one-function seam whose default binding is the platform's native fetch. Two
 * reasons: the package declares no third-party runtime dependency (adding axios
 * to a leaf library that the CLI already depends on is a dependency the mirror
 * does not need to own), and an injected seam is what makes the client testable
 * without a network, a server or a module mock — it is the design that keeps the
 * client testable forever rather than only until the fake server lands. Rate
 * limiting is a first-class concern of this class instead of a decorator, and is
 * implemented as request spacing, which is precisely what the MCP server's
 * client does with the same shared ceiling.
 *
 * **Secrets (§9).** Credentials are resolved from `@syncrona/credential-store`
 * and nowhere else. They live in one field, are attached to outgoing requests,
 * and are never logged, never returned, never written: this module has no
 * filesystem import and no console call, which the test suite asserts
 * structurally rather than by review.
 */
import {
  buildKeysetQuery,
  classifyError,
  computeRetryDelay,
  diagnoseReachability,
  apiKeyHeaderName,
  type ReachabilityStatus,
  type SnErrorEnvelope,
} from "@syncrona/sn-transport";
import {
  getActiveInstanceSync,
  loadCredentialsSync,
  type StoredCredentials,
} from "@syncrona/credential-store";

import { PAGE_SIZE_DEFAULT, RPS_DEFAULT, RPS_MAX, SYS_ID_RE } from "../constants";
import type {
  AttachmentBinary,
  AttachmentMeta,
  MirrorConfig,
  MirrorFailureClass,
  MirrorFetch,
  MirrorHttpResponse,
  TableAggregate,
  TablePage,
} from "../contracts";

/** Aggregate API base — the counts endpoint (§5.2). */
const STATS_API_BASE = "/api/now/stats";
/** Attachment API base — metadata rows and, with `/file`, the bytes themselves. */
const ATTACHMENT_API_BASE = "/api/now/attachment";
/**
 * Probe target for the reachability check: the table catalog the mirror has to
 * read anyway. A 403 here is an ACL fact about one table rather than a
 * reachability problem, and `diagnoseReachability` treats it as such.
 */
const PROBE_PATH = "/api/now/table/sys_db_object";

/** Total attempts per request, first try included. */
const DEFAULT_MAX_ATTEMPTS = 4;
/**
 * Per-request deadline. A ServiceNow request that has neither answered nor
 * failed after a minute has stalled, and a stalled request in a sweep of tens of
 * thousands of requests is an unbounded hang rather than a slow page.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A request that failed, carrying the taxonomy class the run report aggregates.
 *
 * The class, not the status, is what callers branch on: F1 retries, F2 and F4
 * stop the run (exit 1), F3 and F5 mark a table partial and continue (exit 2).
 * The raw envelope is preserved so a report can still quote what the instance
 * actually said.
 */
export class MirrorHttpError extends Error {
  /** Where this failure lands in the F1–F9 taxonomy. */
  readonly failureClass: MirrorFailureClass;
  /** HTTP status, or null when no response arrived at all. */
  readonly httpStatus: number | null;
  /** The normalized ServiceNow error envelope, when the response carried one. */
  readonly envelope: SnErrorEnvelope | null;

  constructor(
    failureClass: MirrorFailureClass,
    message: string,
    details: { httpStatus?: number | null; envelope?: SnErrorEnvelope | null } = {}
  ) {
    super(message);
    this.name = "MirrorHttpError";
    this.failureClass = failureClass;
    this.httpStatus = details.httpStatus ?? null;
    this.envelope = details.envelope ?? null;
  }
}

/**
 * The two credential-store reads the mirror performs, as an injectable pair.
 *
 * Injectable so the client can be tested without a credential store, a keychain
 * prompt or a home directory — not so that credentials can come from somewhere
 * else. §9 is unambiguous that the store is the only source in production, and
 * the default binding below is the only one this package ships.
 */
export interface MirrorCredentialSource {
  /** The instance marked active by `syncrona use`, or null when none is. */
  getActiveInstance(): string | null;
  /** Stored credentials for an instance, or null when there are none. */
  loadCredentials(instance: string): StoredCredentials | null;
}

/** The production credential source: `@syncrona/credential-store`, directly. */
export const credentialStoreSource: MirrorCredentialSource = {
  getActiveInstance: getActiveInstanceSync,
  loadCredentials: loadCredentialsSync,
};

/** Resolved instance plus the headers that authenticate to it. */
export interface MirrorAuthorization {
  /** Instance host the credentials belong to. */
  instance: string;
  /** Headers added to every request. Contains a secret — never log it. */
  headers: Readonly<Record<string, string>>;
}

/**
 * Which instance a run is against, before anything is known about how to authenticate.
 *
 * Split out of {@link resolveMirrorAuthorization} because a caller that supplies
 * its own headers still needs the answer and must not pay for it with a credential
 * lookup — the two questions ("which host" and "what secret") only travel together
 * on the store-backed path.
 *
 * @throws {MirrorHttpError} classified `auth` when no instance is named anywhere.
 */
function resolveInstanceTarget(
  instance: string | undefined,
  source: MirrorCredentialSource
): string {
  const target = (instance ?? source.getActiveInstance() ?? "").trim();
  if (target === "") {
    throw new MirrorHttpError(
      "auth",
      "No ServiceNow instance selected: set `instance` in mirror.config.js, or pick one with `syncrona use <instance>`."
    );
  }
  return target;
}

/**
 * Build the authorization headers for a mirror run from the credential store (§9).
 *
 * Basic and inbound-API-key credentials are usable directly. The three OAuth
 * grants are NOT, and the reason is INV-2 rather than laziness: obtaining an
 * OAuth token means sending a state-changing request to `oauth_token.do`, and
 * this package must not contain one in any phase through Phase 3. A caller that
 * needs OAuth mints the token with the core CLI's existing token manager and
 * passes the resulting header in through {@link MirrorHttpClientOptions.headers},
 * which keeps the exchange on the side of the boundary that is allowed to make it.
 *
 * @param instance Instance alias, or undefined to use the active instance.
 * @throws {MirrorHttpError} classified `auth` when no usable credential exists.
 */
export function resolveMirrorAuthorization(
  instance?: string,
  source: MirrorCredentialSource = credentialStoreSource
): MirrorAuthorization {
  const target = resolveInstanceTarget(instance, source);

  const credentials = source.loadCredentials(target);
  if (!credentials) {
    throw new MirrorHttpError(
      "auth",
      `No stored credentials for ${target}: run \`syncrona login\` for that instance first.`
    );
  }

  // A store written before the auth-method selector existed has three fields and
  // no method; that shape has always meant Basic.
  const method = credentials.authMethod ?? "basic";

  if (method === "api-key") {
    const apiKey = (credentials.apiKey ?? "").trim();
    if (apiKey === "") {
      throw new MirrorHttpError(
        "auth",
        `Stored credentials for ${target} select API-key auth but hold no key: run \`syncrona login\` again for that instance.`
      );
    }
    return {
      instance: target,
      headers: { [apiKeyHeaderName(credentials.apiKeyHeader)]: apiKey },
    };
  }

  if (method === "basic") {
    const user = (credentials.user ?? "").trim();
    if (user === "" || (credentials.password ?? "") === "") {
      throw new MirrorHttpError(
        "auth",
        `Stored credentials for ${target} are incomplete (user and password are both required for basic auth): run \`syncrona login\` again for that instance.`
      );
    }
    const encoded = Buffer.from(`${user}:${credentials.password}`, "utf8").toString("base64");
    return { instance: target, headers: { Authorization: `Basic ${encoded}` } };
  }

  throw new MirrorHttpError(
    "auth",
    `Stored credentials for ${target} use ${method}, which the mirror client cannot perform: acquiring an OAuth token is a state-changing request and INV-2 forbids one in @syncrona/mirror. Supply a ready Authorization header through the client's \`headers\` option, or log in with basic auth or an inbound API key.`
  );
}

/** Construction parameters for {@link MirrorHttpClient}. */
export interface MirrorHttpClientOptions {
  /** Instance host (`dev12345.service-now.com`) or a full base URL. */
  instance: string;
  /** Authentication headers — see {@link resolveMirrorAuthorization}. */
  headers: Readonly<Record<string, string>>;
  /** Sustained request rate; clamped to `RPS_MAX`. Defaults to `RPS_DEFAULT`. */
  requestsPerSecond?: number;
  /** Rows per page when a caller does not pass one. Defaults to `PAGE_SIZE_DEFAULT`. */
  pageSize?: number;
  /** Total attempts per request, first try included. */
  maxAttempts?: number;
  /** Per-request deadline in milliseconds; 0 disables the deadline. */
  timeoutMs?: number;
  /** The transport seam. Defaults to the platform's native fetch. */
  fetch?: MirrorFetch;
  /** Injected for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for deterministic tests; defaults to the wall clock. */
  now?: () => number;
  /** Injected for deterministic tests; defaults to the platform RNG. */
  random?: () => number;
}

/** Optional per-page overrides for {@link MirrorHttpClient.getPage}. */
export interface PageRequest {
  /** Columns to request. Required and non-empty — see `buildKeysetQuery`. */
  fields: readonly string[];
  /** Extra encoded-query conditions ANDed before the cursor (e.g. a watermark). */
  extraQuery?: string;
  /** Page size for this request; defaults to the client's configured size. */
  pageSize?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultFetch: MirrorFetch = (url, init) => fetch(url, init);

/**
 * Normalize an instance alias to a base URL with no trailing slash.
 *
 * Matches the convention the rest of the repository already uses: a value that
 * carries a scheme is taken as-is, anything else is an HTTPS host. No
 * `.service-now.com` is appended — the stored instance is a full host, and
 * guessing a suffix would silently redirect a sweep at a different instance than
 * the operator named.
 */
const toBaseUrl = (instance: string): string => {
  const trimmed = instance.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/** Parse a body as JSON, returning the raw text when it is not JSON at all. */
const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** Extract a `{ code, message }` shape from whatever the transport threw. */
const describeNetworkError = (error: unknown): { code?: string; message?: string } => {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { code, message: error.message };
  }
  return { message: String(error) };
};

/** Map sn-transport's classification onto the mirror's F1–F9 vocabulary. */
const toFailureClass = (classified: SnErrorEnvelope["classified"]): MirrorFailureClass => {
  if (classified === "transient" || classified === "auth" || classified === "acl") {
    return classified;
  }
  // `not-found` and `fatal` both mean "the instance rejected a request the plan
  // considered valid" — a table that vanished, a column that no longer exists, a
  // query the catalog said was well-formed. From the mirror's side that is F5,
  // schema drift. The envelope rides along on the error so a report can still
  // distinguish a missing table from a malformed query.
  return "schema-drift";
};

/** Map the reachability tri-state onto the taxonomy, preserving all three states. */
const REACHABILITY_FAILURE: Record<
  Exclude<ReachabilityStatus["state"], "ok">,
  MirrorFailureClass
> = {
  "auth-failed": "auth",
  unreachable: "unreachable",
  hibernating: "hibernating",
};

/**
 * The mirror's ServiceNow client: rate-limited, retrying, GET-only (§5.2).
 *
 * One instance per sweep. The rate limit is per client, so two clients against
 * one instance would each get the configured budget — which is why the sweep
 * constructs exactly one and hands it to every stage.
 */
export class MirrorHttpClient {
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly intervalMs: number;
  private readonly pageSize: number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: MirrorFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  /** Serializes the rate-limit decision so concurrent callers cannot both pass. */
  private gate: Promise<void> = Promise.resolve();
  /** Earliest time, on the injected clock, at which the next request may leave. */
  private nextAllowedAt = 0;

  constructor(options: MirrorHttpClientOptions) {
    this.baseUrl = toBaseUrl(options.instance);
    this.headers = { ...options.headers };
    // Clamped rather than validated, because this constructor can be reached
    // with a config object that was assembled in code and never passed through
    // `loadMirrorConfig` (which does reject an out-of-range value, with an
    // explanation). The ceiling is a property of the instance, so the last line
    // of defence belongs where the requests actually leave.
    const rps = Math.min(Math.max(options.requestsPerSecond ?? RPS_DEFAULT, 1), RPS_MAX);
    this.intervalMs = 1_000 / rps;
    this.pageSize = options.pageSize ?? PAGE_SIZE_DEFAULT;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * One keyset-paginated page of a table (§5.1, §5.2).
   *
   * The query is built by `buildKeysetQuery`, which is also what makes offset
   * paging unreachable from here: this class has no code path that can emit a
   * `sysparm_offset`, and M6 verified the keyset walk is strictly increasing
   * with zero overlap.
   *
   * @param table Table to page.
   * @param cursor Last `sys_id` of the previous page, or null to start.
   */
  async getPage(table: string, cursor: string | null, request: PageRequest): Promise<TablePage> {
    const pageSize = request.pageSize ?? this.pageSize;
    const query = buildKeysetQuery(table, cursor, pageSize, {
      fields: request.fields,
      extraQuery: request.extraQuery,
    });

    const payload = await this.requestJson(query.path, query.params);
    const rows = readResultArray(payload).map((row) => toStringRecord(row));

    // The cursor for the next page is read out of the last row, so a row without
    // a usable sys_id would stall the walk on a repeating page rather than fail.
    // Refusing here converts a silent infinite loop into a named error.
    const lastRow = rows[rows.length - 1];
    let lastSysId: string | null = null;
    if (lastRow !== undefined) {
      const candidate = lastRow.sys_id ?? "";
      if (!SYS_ID_RE.test(candidate)) {
        throw new MirrorHttpError(
          "schema-drift",
          `Table ${table} returned a row whose sys_id is not a sys_id (${JSON.stringify(candidate)}); the keyset cursor cannot advance.`
        );
      }
      lastSysId = candidate;
    }

    // A short page is the only end-of-table signal available: the pagination
    // header that would otherwise say so is suppressed on purpose, because
    // producing it costs the instance a COUNT on every page.
    return { rows, lastSysId, done: rows.length < pageSize };
  }

  /**
   * Row count and high-water mark for a table, or null when unavailable (§5.2).
   *
   * Null is the planner's signal to sweep without counts, and the endpoint is
   * genuinely optional: it can be denied by ACL or absent behind a proxy. So an
   * ACL denial, a schema complaint, an exhausted retry budget or an unreadable
   * body all become null.
   *
   * What does NOT become null: auth failure, an unreachable instance, and
   * hibernation. §5.2 says "never throws" about the endpoint being optional, not
   * about the instance being gone — swallowing F2/F4 here would let a sweep
   * proceed against a dead instance and then report the resulting emptiness as
   * fact. Those three keep propagating, and the run stops (exit 1) as R1 requires.
   */
  async getAggregate(table: string, extraQuery?: string): Promise<TableAggregate | null> {
    const params: Record<string, string> = {
      sysparm_count: "true",
      sysparm_max_fields: "sys_updated_on",
    };
    if (extraQuery !== undefined && extraQuery.trim() !== "") {
      params.sysparm_query = extraQuery.trim();
    }

    let payload: unknown;
    try {
      payload = await this.requestJson(`${STATS_API_BASE}/${table}`, params);
    } catch (error) {
      if (
        error instanceof MirrorHttpError &&
        error.failureClass !== "auth" &&
        error.failureClass !== "unreachable" &&
        error.failureClass !== "hibernating"
      ) {
        return null;
      }
      throw error;
    }

    const stats = readRecord(readRecord(readRecord(payload)?.result)?.stats);
    if (!stats) {
      return null;
    }
    // M3: the Aggregate API sends the count as a STRING. Converting once, here,
    // is what stops a downstream `"1000" > "999"` from comparing lexically. The
    // empty string is excluded explicitly because `Number("")` is 0, and a
    // count of zero is a claim the completeness check would act on.
    const raw = stats.count;
    const count =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : Number.NaN;
    if (!Number.isFinite(count)) {
      return null;
    }
    const max = readRecord(stats.max);
    const maxUpdatedOn = typeof max?.sys_updated_on === "string" ? max.sys_updated_on : null;
    return { count, maxUpdatedOn: maxUpdatedOn === "" ? null : maxUpdatedOn };
  }

  /** Attachment metadata rows hanging off one record (§5.2). */
  async getAttachmentMeta(table: string, recordSysId: string): Promise<AttachmentMeta[]> {
    if (!SYS_ID_RE.test(recordSysId)) {
      // INV-6. An unchecked value here would be interpolated into an encoded
      // query, where a `^` reads as a condition separator.
      throw new MirrorHttpError(
        "schema-drift",
        `Refusing to list attachments: ${JSON.stringify(recordSysId)} is not a sys_id.`
      );
    }
    const payload = await this.requestJson(ATTACHMENT_API_BASE, {
      sysparm_query: `table_name=${table}^table_sys_id=${recordSysId}^ORDERBYsys_id`,
      sysparm_fields: "sys_id,table_name,table_sys_id,file_name,content_type,size_bytes",
      sysparm_limit: String(this.pageSize),
    });

    return readResultArray(payload).map((row) => {
      const record = toStringRecord(row);
      const rawSize = record.size_bytes ?? "";
      const size = Number(rawSize);
      return {
        sysId: record.sys_id ?? "",
        tableName: record.table_name ?? "",
        tableSysId: record.table_sys_id ?? "",
        fileName: record.file_name ?? "",
        contentType: record.content_type ? record.content_type : null,
        // A missing size stays null rather than becoming 0: the value decides
        // LFS storage, and "unknown" must not read as "small enough to inline".
        // The blank case is spelled out because `Number("")` is 0, which is
        // exactly the wrong answer here.
        sizeBytes: rawSize.trim() === "" || !Number.isFinite(size) ? null : size,
      };
    });
  }

  /**
   * One attachment's bytes (§5.2, Δ1).
   *
   * The binary path is the reason the mirror owns a client at all: the v1
   * clients are JSON-only, and routing megabytes of attachment through a
   * text decode would corrupt them.
   */
  async getAttachmentBinary(attachmentSysId: string): Promise<AttachmentBinary> {
    if (!SYS_ID_RE.test(attachmentSysId)) {
      throw new MirrorHttpError(
        "schema-drift",
        `Refusing to download an attachment: ${JSON.stringify(attachmentSysId)} is not a sys_id.`
      );
    }
    const response = await this.send(
      this.url(`${ATTACHMENT_API_BASE}/${attachmentSysId}/file`, {}),
      "application/octet-stream"
    );

    const contentType = response.headers.get("content-type");
    if (isHtml(contentType)) {
      // A hibernating instance answers HTTP 200 with an HTML page. Handing that
      // to the writer would commit a login page under an attachment's name.
      const text = await response.text();
      throw this.reachabilityError(response.status, contentType, text);
    }

    const buffer = await response.arrayBuffer();
    return { bytes: new Uint8Array(buffer), contentType };
  }

  /**
   * Pre-flight reachability check (§10, D4).
   *
   * Never throws and never retries: its whole purpose is to REPORT the state,
   * and the three failure states carry three different operator actions — fix
   * credentials, fix the network, or wake the instance. The detail strings are
   * produced by `diagnoseReachability` and are meant to be surfaced verbatim.
   */
  async probeReachability(): Promise<ReachabilityStatus> {
    await this.throttle();
    const url = this.url(PROBE_PATH, {
      sysparm_limit: "1",
      sysparm_fields: "sys_id",
    });

    let response: MirrorHttpResponse;
    try {
      response = await this.fetchImpl(url, this.init("application/json"));
    } catch (error) {
      return diagnoseReachability({ networkError: describeNetworkError(error) });
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    const text = await response.text();
    return diagnoseReachability({
      status: response.status,
      contentType,
      body: parseBody(text),
    });
  }

  // --- internals ------------------------------------------------------------

  /** Assemble an absolute URL with encoded query parameters. */
  private url(path: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    return query === "" ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}?${query}`;
  }

  /** The request init for every call. INV-2 lives in this literal. */
  private init(accept: string): { method: "GET"; headers: Record<string, string>; signal?: AbortSignal } {
    return {
      method: "GET",
      headers: { ...this.headers, Accept: accept },
      ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
    };
  }

  /**
   * Space requests to the configured rate.
   *
   * A chained promise rather than a timer wheel: it serializes the decision, so
   * a hundred concurrent callers still leave one interval apart, and it uses the
   * injected clock and sleep, so the spacing is assertable in a test without
   * real time passing.
   */
  private throttle(): Promise<void> {
    const scheduled = this.gate.then(async () => {
      const now = this.now();
      const wait = this.nextAllowedAt - now;
      if (wait > 0) {
        await this.sleep(wait);
      }
      this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.intervalMs;
    });
    this.gate = scheduled;
    return scheduled;
  }

  /** Turn a probe observation into the tri-state error §10 requires. */
  private reachabilityError(
    status: number,
    contentType: string | null,
    text: string
  ): MirrorHttpError {
    const diagnosis = diagnoseReachability({
      status,
      contentType: contentType ?? undefined,
      body: parseBody(text),
    });
    if (diagnosis.state === "ok") {
      return new MirrorHttpError(
        "parse",
        `Instance answered HTTP ${status} with a body that is not JSON.`,
        { httpStatus: status }
      );
    }
    return new MirrorHttpError(REACHABILITY_FAILURE[diagnosis.state], diagnosis.detail, {
      httpStatus: status,
    });
  }

  /**
   * Issue one request, retrying transient failures (F1).
   *
   * Returns the response with its body unread, so the caller decides between
   * text and bytes — a distinction that matters exactly once, for attachments.
   */
  private async send(url: string, accept: string): Promise<MirrorHttpResponse> {
    for (let attempt = 0; ; attempt += 1) {
      await this.throttle();

      let response: MirrorHttpResponse;
      try {
        response = await this.fetchImpl(url, this.init(accept));
      } catch (error) {
        // F4: no response at all. The taxonomy says checkpoint and stop rather
        // than retry — a sweep that cannot reach the instance has nothing to
        // gain from trying the same DNS answer three more times, and stopping
        // keeps the tree honest instead of half-written.
        const diagnosis = diagnoseReachability({ networkError: describeNetworkError(error) });
        throw new MirrorHttpError(REACHABILITY_FAILURE.unreachable, diagnosis.detail);
      }

      if (response.status >= 200 && response.status < 300) {
        return response;
      }

      const contentType = response.headers.get("content-type");
      const text = await response.text();
      const body = parseBody(text);
      const diagnosis = diagnoseReachability({
        status: response.status,
        contentType: contentType ?? undefined,
        body,
      });

      // Hibernation and auth are decided BEFORE the retry budget is consulted,
      // and neither is retried. Waking an instance is a manual action a human
      // takes at developer.servicenow.com, and credentials do not start working
      // partway through a sweep — three more attempts would only delay the
      // message the operator needs by half a minute.
      if (diagnosis.state === "hibernating" || diagnosis.state === "auth-failed") {
        throw new MirrorHttpError(REACHABILITY_FAILURE[diagnosis.state], diagnosis.detail, {
          httpStatus: response.status,
        });
      }

      const envelope = classifyError(response.status, body);

      if (envelope.classified === "transient") {
        if (attempt + 1 < this.maxAttempts) {
          // D6: `Retry-After` wins when present, and M2 measured that a default
          // ServiceNow response carries no rate-limit header at all — so this
          // reads as null day to day and the jittered backoff is what runs.
          const delay = computeRetryDelay(attempt, response.headers.get("retry-after"), {
            random: this.random,
            now: this.now,
          });
          await this.sleep(delay);
          continue;
        }
        // The budget is spent, and the failure stays F1 rather than being
        // relabelled F4. That distinction decides the exit code: F1 lets the
        // caller degrade (the aggregate becomes null, the table is marked
        // partial, exit 2) while F4 stops the run outright (exit 1). A gateway
        // that 503s three times is a flaky endpoint, not a missing instance.
        // The MESSAGE still prefers the reachability wording when there is one,
        // because "HTTP 503 returned HTML" tells the operator more than the
        // classification alone.
        throw new MirrorHttpError(
          "transient",
          diagnosis.state === "ok" ? envelope.message : diagnosis.detail,
          { httpStatus: response.status, envelope }
        );
      }

      if (diagnosis.state === "unreachable") {
        // A non-transient status carrying an HTML body: something in front of
        // the instance is answering instead of the instance.
        throw new MirrorHttpError("unreachable", diagnosis.detail, {
          httpStatus: response.status,
          envelope,
        });
      }

      throw new MirrorHttpError(toFailureClass(envelope.classified), envelope.message, {
        httpStatus: response.status,
        envelope,
      });
    }
  }

  /** Issue a request and parse a JSON body, diagnosing anything that is not one. */
  private async requestJson(path: string, params: Record<string, string>): Promise<unknown> {
    const response = await this.send(this.url(path, params), "application/json");
    const contentType = response.headers.get("content-type");
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A 200 that is not JSON is how a hibernating instance answers, so the
      // tri-state gets the first look; only a genuinely malformed JSON body
      // falls through to F6.
      throw this.reachabilityError(response.status, contentType, text);
    }
  }
}

/** `{ result: [...] }`, or an empty list when the payload is shaped otherwise. */
const readResultArray = (payload: unknown): unknown[] => {
  const result = readRecord(payload)?.result;
  return Array.isArray(result) ? result : [];
};

/** Narrow to a plain object, or undefined. */
const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Coerce a wire row to `Record<string, string>`.
 *
 * M7 and M8 say every value should already be a string
 * (`sysparm_exclude_reference_link=true`, empties as `""`), but a single
 * unexpected object would otherwise reach the serializer as `[object Object]`
 * and be committed. Non-string values are dropped instead, which is a visible
 * absence rather than an invented value.
 */
const toStringRecord = (row: unknown): Record<string, string> => {
  const source = readRecord(row) ?? {};
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
};

/** Whether a content type says HTML — the shape a hibernation page arrives in. */
const isHtml = (contentType: string | null): boolean =>
  (contentType ?? "").toLowerCase().includes("html");

/**
 * Build a client for a resolved config, taking credentials from the store (§9).
 *
 * The convenience path: config in, client out, with the credential lookup and
 * the rate limit wired the way a sweep needs them. Tests and future callers that
 * need a different transport construct {@link MirrorHttpClient} directly.
 *
 * A caller that supplies `overrides.headers` has already authenticated, and this
 * function then does not touch the store at all. That is not an optimisation: §9
 * relocated the OAuth exchange to the core CLI because INV-2 forbids the token
 * POST in this package, so headers arriving from core are precisely the `oauth-*`
 * case {@link resolveMirrorAuthorization} throws `auth` on. Resolving first —
 * which this used to do — rejected every instance the relocation exists to serve,
 * and left core no way in but constructing {@link MirrorHttpClient} by hand.
 */
export function createMirrorHttpClient(
  config: MirrorConfig,
  overrides: Partial<MirrorHttpClientOptions> = {},
  source: MirrorCredentialSource = credentialStoreSource
): MirrorHttpClient {
  const auth: MirrorAuthorization =
    overrides.headers === undefined
      ? resolveMirrorAuthorization(config.instance, source)
      : {
          instance: resolveInstanceTarget(overrides.instance ?? config.instance, source),
          headers: overrides.headers,
        };
  return new MirrorHttpClient({
    instance: auth.instance,
    headers: auth.headers,
    requestsPerSecond: config.sync.requestsPerSecond,
    pageSize: config.sync.pageSize,
    ...overrides,
  });
}
