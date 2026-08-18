// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `MirrorHttpClient` — the mirror's own ServiceNow transport (§5.2, Δ1).
 *
 * Two kinds of test here, deliberately:
 *
 *  - **Seam tests** drive the client through the injected {@link MirrorFetch},
 *    with an injected clock and RNG. That is what makes the retry schedule, the
 *    rate limit and every failure branch assertable as VALUES rather than as
 *    elapsed wall time: "it slept twice for 250 ms" is a fact, "the suite took
 *    about half a second" is a guess. It also means the whole failure taxonomy
 *    is reachable, including the network error that no cooperating server can
 *    be persuaded to produce on demand.
 *  - **One loopback test** runs the client with NO injection at all against a
 *    `node:http` server started inside this file. It exists to prove the seam is
 *    not a fiction: the platform's own `fetch`/`Response` satisfy
 *    {@link MirrorHttpResponse} structurally, the default sleep is a real timer,
 *    and the request that leaves the process carries the header and the query the
 *    seam tests only observed in the abstract.
 *
 * The loopback server is local to this file on purpose. WP-M2's
 * `FakeInstanceServer` under `test/fakeInstance/` is being built concurrently;
 * depending on it would couple this suite to a moving target, and the injected
 * seam is the design that keeps the client testable regardless.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  MirrorHttpClient,
  MirrorHttpError,
  createMirrorHttpClient,
  credentialStoreSource,
  resolveMirrorAuthorization,
  type MirrorCredentialSource,
} from "../src/http/client";
import { loadMirrorConfig } from "../src/config/loadConfig";
import type { MirrorFetch, MirrorHttpRequestInit, MirrorHttpResponse } from "../src/contracts";

// --- fixtures ---------------------------------------------------------------

const SYS_ID_A = "0123456789abcdef0123456789abcdef";
const SYS_ID_B = "fedcba9876543210fedcba9876543210";

/** The hibernation page, reduced to the marker `diagnoseReachability` looks for. */
const HIBERNATION_HTML =
  "<html><body>This instance is hibernating. Wake your instance at developer.servicenow.com</body></html>";

const response = (
  status: number,
  body: string,
  headers: Record<string, string> = {}
): MirrorHttpResponse => ({
  status,
  headers: {
    get: (name: string): string | null => headers[name.toLowerCase()] ?? null,
  },
  text: () => Promise.resolve(body),
  arrayBuffer: () =>
    Promise.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer),
});

const json = (
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): MirrorHttpResponse =>
  response(status, JSON.stringify(payload), {
    "content-type": "application/json",
    ...headers,
  });

const rows = (...sysIds: string[]): MirrorHttpResponse =>
  json(200, { result: sysIds.map((sysId) => ({ sys_id: sysId, name: `row-${sysId}` })) });

interface Recorded {
  url: string;
  init: MirrorHttpRequestInit;
}

interface Transport {
  calls: Recorded[];
  fetch: MirrorFetch;
}

/** A transport whose Nth call is decided by `handler`. Throwing simulates a socket error. */
const transport = (
  handler: (call: number, url: string) => MirrorHttpResponse
): Transport => {
  const calls: Recorded[] = [];
  const fetchImpl: MirrorFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(calls.length - 1, url));
  };
  return { calls, fetch: fetchImpl };
};

/** Always answers the same way. */
const always = (value: MirrorHttpResponse): Transport => transport(() => value);

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
}

/**
 * A clock that only moves when the code under test sleeps.
 *
 * That is what makes the rate limiter assertable: real time passing between two
 * calls would make the spacing depend on how fast the machine ran the test.
 */
const fakeClock = (): Clock => {
  let current = 0;
  const slept: number[] = [];
  return {
    now: () => current,
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
};

const client = (
  fetchImpl: MirrorFetch,
  clock: Clock = fakeClock(),
  overrides: Partial<ConstructorParameters<typeof MirrorHttpClient>[0]> = {}
): MirrorHttpClient =>
  new MirrorHttpClient({
    instance: "dev12345.service-now.com",
    headers: { Authorization: "Basic c2VjcmV0" },
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    // A fixed RNG turns full jitter into an exact number, so the backoff is
    // asserted rather than bounded.
    random: () => 0.5,
    ...overrides,
  });

/** Run a call that must fail, and hand back the error it failed with. */
const failure = async (run: () => Promise<unknown>): Promise<MirrorHttpError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MirrorHttpError);
    return error as MirrorHttpError;
  }
  throw new Error("expected the call to fail, but it resolved");
};

const PAGE = { fields: ["sys_id", "name"] } as const;

// --- request shape ----------------------------------------------------------

describe("MirrorHttpClient: request construction", () => {
  it("builds a keyset page request against the instance base URL", async () => {
    const net = always(rows(SYS_ID_A));
    await client(net.fetch).getPage("sys_script", null, PAGE);

    const url = new URL(net.calls[0].url);
    expect(url.origin).toBe("https://dev12345.service-now.com");
    expect(url.pathname).toBe("/api/now/table/sys_script");
    expect(url.searchParams.get("sysparm_query")).toBe("ORDERBYsys_id");
    expect(url.searchParams.get("sysparm_limit")).toBe("1000");
    expect(url.searchParams.get("sysparm_fields")).toBe("sys_id,name");
    // The walk is keyset-only (§5.1): an offset parameter would silently skip
    // rows whenever a record is inserted mid-sweep.
    expect(url.searchParams.get("sysparm_offset")).toBeNull();
  });

  it("carries the cursor, the watermark and the page size into the query", async () => {
    const net = always(rows(SYS_ID_B));
    await client(net.fetch).getPage("sys_script", SYS_ID_A, {
      fields: ["sys_id"],
      extraQuery: "sys_updated_on>=2026-01-01",
      pageSize: 25,
    });

    const url = new URL(net.calls[0].url);
    expect(url.searchParams.get("sysparm_query")).toBe(
      `sys_updated_on>=2026-01-01^sys_id>${SYS_ID_A}^ORDERBYsys_id`
    );
    expect(url.searchParams.get("sysparm_limit")).toBe("25");
  });

  it("sends the auth headers, asks for JSON, and issues only GET", async () => {
    const net = always(rows(SYS_ID_A));
    await client(net.fetch).getPage("sys_script", null, PAGE);

    expect(net.calls[0].init.method).toBe("GET");
    expect(net.calls[0].init.headers).toEqual({
      Authorization: "Basic c2VjcmV0",
      Accept: "application/json",
    });
  });

  it("applies a request deadline by default and honours turning it off", async () => {
    const net = always(rows(SYS_ID_A));
    await client(net.fetch).getPage("sys_script", null, PAGE);
    expect(net.calls[0].init.signal).toBeInstanceOf(AbortSignal);

    const unbounded = always(rows(SYS_ID_A));
    await client(unbounded.fetch, fakeClock(), { timeoutMs: 0 }).getPage(
      "sys_script",
      null,
      PAGE
    );
    expect(unbounded.calls[0].init.signal).toBeUndefined();
  });

  it("normalizes an instance that already carries a scheme or a trailing slash", async () => {
    const withScheme = always(rows(SYS_ID_A));
    await client(withScheme.fetch, fakeClock(), {
      instance: "http://localhost:8080/",
    }).getPage("sys_script", null, PAGE);
    expect(withScheme.calls[0].url.startsWith("http://localhost:8080/api/now/table/")).toBe(
      true
    );

    const bare = always(rows(SYS_ID_A));
    await client(bare.fetch, fakeClock(), { instance: "dev999.service-now.com/" }).getPage(
      "sys_script",
      null,
      PAGE
    );
    expect(bare.calls[0].url.startsWith("https://dev999.service-now.com/api/now/table/")).toBe(
      true
    );
  });

  it("copies the caller's headers instead of aliasing them", () => {
    // A caller that reused its header object for a second instance would
    // otherwise retro-actively change the credentials of a client already in
    // flight — a bug that only shows up under concurrency.
    const headers: Record<string, string> = { Authorization: "Basic one" };
    const net = always(rows(SYS_ID_A));
    const subject = client(net.fetch, fakeClock(), { headers });
    headers.Authorization = "Basic two";

    return subject.getPage("sys_script", null, PAGE).then(() => {
      expect(net.calls[0].init.headers.Authorization).toBe("Basic one");
    });
  });
});

// --- paging -----------------------------------------------------------------

describe("MirrorHttpClient.getPage", () => {
  it("returns the rows, the next cursor, and 'not done' on a full page", async () => {
    const net = always(rows(SYS_ID_A, SYS_ID_B));
    const page = await client(net.fetch).getPage("sys_script", null, {
      ...PAGE,
      pageSize: 2,
    });

    expect(page.rows).toEqual([
      { sys_id: SYS_ID_A, name: `row-${SYS_ID_A}` },
      { sys_id: SYS_ID_B, name: `row-${SYS_ID_B}` },
    ]);
    expect(page.lastSysId).toBe(SYS_ID_B);
    expect(page.done).toBe(false);
  });

  it("reports done on a short page — the only end-of-table signal it trusts", async () => {
    const net = always(rows(SYS_ID_A));
    const page = await client(net.fetch).getPage("sys_script", null, {
      ...PAGE,
      pageSize: 2,
    });
    expect(page.done).toBe(true);
  });

  it("returns an empty page with a null cursor rather than a fabricated one", async () => {
    const net = always(json(200, { result: [] }));
    const page = await client(net.fetch).getPage("sys_script", null, PAGE);
    expect(page).toEqual({ rows: [], lastSysId: null, done: true });
  });

  it("tolerates a payload that is not the shape the Table API promises", async () => {
    const net = always(json(200, { result: "unexpected" }));
    await expect(client(net.fetch).getPage("sys_script", null, PAGE)).resolves.toEqual({
      rows: [],
      lastSysId: null,
      done: true,
    });
  });

  it("drops non-string values instead of stringifying them into the mirror", async () => {
    // M7/M8 say every value arrives as a string. A stray object would otherwise
    // be committed as "[object Object]", which is data the instance never had.
    const net = always(
      json(200, { result: [{ sys_id: SYS_ID_A, ref: { value: "x" }, n: 1, ok: "" }] })
    );
    const page = await client(net.fetch).getPage("sys_script", null, PAGE);
    expect(page.rows[0]).toEqual({ sys_id: SYS_ID_A, ok: "" });
  });

  it("survives a result entry that is not an object at all", async () => {
    const net = always(json(200, { result: [null, { sys_id: SYS_ID_A }] }));
    const page = await client(net.fetch).getPage("sys_script", null, PAGE);
    expect(page.rows).toEqual([{}, { sys_id: SYS_ID_A }]);
  });

  it.each([
    ["is not a sys_id", { sys_id: "nope" }, '"nope"'],
    ["is missing entirely", { name: "no identifier here" }, '""'],
  ])("refuses to advance a cursor on a row whose sys_id %s", async (_name, row, quoted) => {
    // Without this the walk would re-request the same page forever, quietly.
    const net = always(json(200, { result: [row] }));
    const error = await failure(() =>
      client(net.fetch).getPage("sys_script", null, { ...PAGE, pageSize: 1 })
    );
    expect(error.failureClass).toBe("schema-drift");
    expect(error.message).toContain("keyset cursor cannot advance");
    expect(error.message).toContain(quoted);
  });
});

// --- aggregate --------------------------------------------------------------

describe("MirrorHttpClient.getAggregate", () => {
  it("asks the Aggregate API for the count and the high-water mark", async () => {
    const net = always(
      json(200, { result: { stats: { count: "1000", max: { sys_updated_on: "2026-08-01" } } } })
    );
    const aggregate = await client(net.fetch).getAggregate("sys_script", "active=true");

    const url = new URL(net.calls[0].url);
    expect(url.pathname).toBe("/api/now/stats/sys_script");
    expect(url.searchParams.get("sysparm_count")).toBe("true");
    expect(url.searchParams.get("sysparm_max_fields")).toBe("sys_updated_on");
    expect(url.searchParams.get("sysparm_query")).toBe("active=true");
    // M3: the wire value is the string "1000". A downstream comparison against a
    // number must not be lexical.
    expect(aggregate).toEqual({ count: 1000, maxUpdatedOn: "2026-08-01" });
  });

  it("omits an empty extra query rather than sending a blank condition", async () => {
    const net = always(json(200, { result: { stats: { count: "0" } } }));
    await client(net.fetch).getAggregate("sys_script", "   ");
    expect(new URL(net.calls[0].url).searchParams.get("sysparm_query")).toBeNull();
  });

  it("accepts a numeric count and reports an empty high-water mark as null", async () => {
    const net = always(json(200, { result: { stats: { count: 7, max: { sys_updated_on: "" } } } }));
    await expect(client(net.fetch).getAggregate("sys_script")).resolves.toEqual({
      count: 7,
      maxUpdatedOn: null,
    });
  });

  it.each([
    ["no stats object", { result: {} }],
    ["a count that is not a number", { result: { stats: { count: "many" } } }],
    ["a blank count, which Number() would read as zero", { result: { stats: { count: "" } } }],
    ["a missing count", { result: { stats: { max: { sys_updated_on: "x" } } } }],
  ])("returns null for %s", async (_name, payload) => {
    const net = always(json(200, payload));
    await expect(client(net.fetch).getAggregate("sys_script")).resolves.toBeNull();
  });

  it("returns null when the endpoint is denied — counts are optional (§5.2)", async () => {
    const net = always(json(403, { error: { message: "insufficient rights" } }));
    await expect(client(net.fetch).getAggregate("sys_script")).resolves.toBeNull();
  });

  it("returns null when the endpoint is absent behind a proxy", async () => {
    const net = always(json(404, { error: { message: "not found" } }));
    await expect(client(net.fetch).getAggregate("sys_script")).resolves.toBeNull();
  });

  it("still propagates an unreachable instance instead of reporting 'no counts'", async () => {
    // "Never throws" is a statement about the ENDPOINT being optional. An
    // instance that is gone is not optional: swallowing it here would let the
    // sweep continue and then report the resulting emptiness as fact.
    const net = always(response(200, HIBERNATION_HTML, { "content-type": "text/html" }));
    const error = await failure(() => client(net.fetch).getAggregate("sys_script"));
    expect(error.failureClass).toBe("hibernating");
  });
});

// --- attachments ------------------------------------------------------------

describe("MirrorHttpClient attachments (Δ1)", () => {
  it("lists attachment metadata for one record", async () => {
    const net = always(
      json(200, {
        result: [
          {
            sys_id: SYS_ID_B,
            table_name: "incident",
            table_sys_id: SYS_ID_A,
            file_name: "diagram.png",
            content_type: "image/png",
            size_bytes: "262145",
          },
        ],
      })
    );
    const meta = await client(net.fetch).getAttachmentMeta("incident", SYS_ID_A);

    expect(new URL(net.calls[0].url).pathname).toBe("/api/now/attachment");
    expect(new URL(net.calls[0].url).searchParams.get("sysparm_query")).toBe(
      `table_name=incident^table_sys_id=${SYS_ID_A}^ORDERBYsys_id`
    );
    expect(meta).toEqual([
      {
        sysId: SYS_ID_B,
        tableName: "incident",
        tableSysId: SYS_ID_A,
        fileName: "diagram.png",
        contentType: "image/png",
        sizeBytes: 262_145,
      },
    ]);
  });

  it("keeps an unknown size as null so it cannot read as 'small enough to inline'", async () => {
    const net = always(
      json(200, {
        result: [
          { sys_id: SYS_ID_B, file_name: "a.bin", size_bytes: "" },
          { sys_id: SYS_ID_A, file_name: "b.bin", size_bytes: "unknown", content_type: "" },
        ],
      })
    );
    const meta = await client(net.fetch).getAttachmentMeta("incident", SYS_ID_A);
    expect(meta.map((entry) => entry.sizeBytes)).toEqual([null, null]);
    expect(meta[1].contentType).toBeNull();
    expect(meta[0].tableName).toBe("");
  });

  it("degrades a metadata row that carries no fields into empties, not undefineds", async () => {
    // The row shape is what the writer names files from; `undefined` reaching it
    // would become the literal string "undefined" on disk.
    const net = always(json(200, { result: [{}] }));
    const meta = await client(net.fetch).getAttachmentMeta("incident", SYS_ID_A);
    expect(meta).toEqual([
      {
        sysId: "",
        tableName: "",
        tableSysId: "",
        fileName: "",
        contentType: null,
        sizeBytes: null,
      },
    ]);
  });

  it("downloads bytes without decoding them", async () => {
    const payload = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const binary: MirrorHttpResponse = {
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
      text: () => Promise.reject(new Error("a binary body must not be read as text")),
      arrayBuffer: () => Promise.resolve(payload.buffer as ArrayBuffer),
    };
    const net = always(binary);
    const result = await client(net.fetch).getAttachmentBinary(SYS_ID_B);

    expect(new URL(net.calls[0].url).pathname).toBe(`/api/now/attachment/${SYS_ID_B}/file`);
    expect(new URL(net.calls[0].url).search).toBe("");
    expect(net.calls[0].init.headers.Accept).toBe("application/octet-stream");
    expect(Array.from(result.bytes)).toEqual(Array.from(payload));
    expect(result.contentType).toBe("image/png");
  });

  it("accepts bytes from a server that declares no content type", async () => {
    const net = always(response(200, "plain bytes"));
    const result = await client(net.fetch).getAttachmentBinary(SYS_ID_B);
    expect(result.contentType).toBeNull();
    expect(new TextDecoder().decode(result.bytes)).toBe("plain bytes");
  });

  it("refuses to write a login page under an attachment's name", async () => {
    const net = always(response(200, HIBERNATION_HTML, { "content-type": "text/html" }));
    const error = await failure(() => client(net.fetch).getAttachmentBinary(SYS_ID_B));
    expect(error.failureClass).toBe("hibernating");
  });

  it.each([
    ["listing", (c: MirrorHttpClient) => c.getAttachmentMeta("incident", "not-a-sys-id")],
    ["downloading", (c: MirrorHttpClient) => c.getAttachmentBinary("../../etc/passwd")],
  ])("rejects a non-sys_id before %s (INV-6)", async (_name, run) => {
    const net = always(json(200, { result: [] }));
    const subject = client(net.fetch);
    const error = await failure(() => run(subject));
    expect(error.failureClass).toBe("schema-drift");
    // Nothing left the process: the check is a gate, not a post-hoc complaint.
    expect(net.calls).toHaveLength(0);
  });
});

// --- rate limiting ----------------------------------------------------------

describe("MirrorHttpClient rate limiting", () => {
  it("spaces requests to the configured rate", async () => {
    const clock = fakeClock();
    const net = always(rows(SYS_ID_A));
    const subject = client(net.fetch, clock, { requestsPerSecond: 4 });

    await subject.getPage("a_table", null, PAGE);
    await subject.getPage("a_table", null, PAGE);
    await subject.getPage("a_table", null, PAGE);

    // 4 rps is one request every 250 ms. The first leaves immediately.
    expect(clock.slept).toEqual([250, 250]);
  });

  it("spaces concurrent callers too, rather than letting them all through at once", async () => {
    const clock = fakeClock();
    const net = always(rows(SYS_ID_A));
    const subject = client(net.fetch, clock, { requestsPerSecond: 2 });

    await Promise.all([
      subject.getPage("a_table", null, PAGE),
      subject.getPage("a_table", null, PAGE),
      subject.getPage("a_table", null, PAGE),
    ]);

    expect(clock.slept).toEqual([500, 500]);
  });

  it("clamps a rate above the platform ceiling instead of exceeding it", async () => {
    // The loader refuses an out-of-range value with an explanation; this is the
    // last line of defence for a config assembled in code and never loaded.
    const clock = fakeClock();
    const net = always(rows(SYS_ID_A));
    const subject = client(net.fetch, clock, { requestsPerSecond: 10_000 });

    await subject.getPage("a_table", null, PAGE);
    await subject.getPage("a_table", null, PAGE);

    expect(clock.slept).toEqual([50]);
  });

  it("clamps a rate below one request per second the same way", async () => {
    const clock = fakeClock();
    const net = always(rows(SYS_ID_A));
    const subject = client(net.fetch, clock, { requestsPerSecond: 0 });

    await subject.getPage("a_table", null, PAGE);
    await subject.getPage("a_table", null, PAGE);

    expect(clock.slept).toEqual([1000]);
  });
});

// --- retry and the failure taxonomy ----------------------------------------

describe("MirrorHttpClient retry policy (F1)", () => {
  it("retries a rate-limited response with full jitter and then succeeds", async () => {
    const clock = fakeClock();
    const net = transport((call) =>
      call === 0 ? json(429, { error: { message: "too many requests" } }) : rows(SYS_ID_A)
    );
    const page = await client(net.fetch, clock).getPage("sys_script", null, PAGE);

    expect(page.rows).toHaveLength(1);
    // Full jitter with a fixed RNG of 0.5 over a 1 s base window: 500 ms. The
    // retry waits longer than the 250 ms rate-limit spacing, so the limiter adds
    // no second sleep on top — backing off and then immediately being throttled
    // again would be paying the same debt twice.
    expect(clock.slept).toEqual([500]);
    expect(net.calls).toHaveLength(2);
  });

  it("lets Retry-After win when the instance sends one (D6)", async () => {
    const clock = fakeClock();
    const net = transport((call) =>
      call === 0
        ? json(503, { error: { message: "unavailable" } }, { "retry-after": "2" })
        : rows(SYS_ID_A)
    );
    await client(net.fetch, clock).getPage("sys_script", null, PAGE);
    expect(clock.slept[0]).toBe(2000);
  });

  it("gives up after the attempt budget and stays F1 rather than becoming F4", async () => {
    // The class decides the exit code: F1 lets the caller degrade to a partial
    // table (exit 2), F4 stops the whole run (exit 1). A flaky gateway is not a
    // missing instance.
    const clock = fakeClock();
    const net = always(json(429, { error: { message: "too many requests" } }));
    const error = await failure(() => client(net.fetch, clock).getPage("t_table", null, PAGE));

    expect(error.failureClass).toBe("transient");
    expect(error.httpStatus).toBe(429);
    expect(error.envelope?.classified).toBe("transient");
    expect(net.calls).toHaveLength(4);
    // Backoff doubles: 1 s, 2 s, 4 s windows, halved by the fixed jitter.
    expect(clock.slept).toEqual([500, 1000, 2000]);
  });

  it("prefers the reachability wording when an exhausted retry was a portal", async () => {
    const net = always(response(502, "<html>gateway</html>", { "content-type": "text/html" }));
    const error = await failure(() =>
      client(net.fetch, fakeClock(), { maxAttempts: 1 }).getPage("t_table", null, PAGE)
    );
    expect(error.failureClass).toBe("transient");
    expect(error.message).toContain("returned HTML, not JSON");
  });
});

describe("MirrorHttpClient failure classification", () => {
  it("stops on an unreachable instance without retrying it (F4)", async () => {
    const clock = fakeClock();
    const net = transport(() => {
      const error = new Error("connect ECONNREFUSED 10.0.0.1:443") as NodeJS.ErrnoException;
      error.code = "ECONNREFUSED";
      throw error;
    });
    const error = await failure(() => client(net.fetch, clock).getPage("t_table", null, PAGE));

    expect(error.failureClass).toBe("unreachable");
    expect(error.message).toBe("instance unreachable (ECONNREFUSED)");
    expect(error.httpStatus).toBeNull();
    expect(net.calls).toHaveLength(1);
    expect(clock.slept).toEqual([]);
  });

  it("describes a transport failure that is not an Error at all", async () => {
    const net = transport(() => {
      throw "socket hang up";
    });
    const error = await failure(() => client(net.fetch).getPage("t_table", null, PAGE));
    expect(error.message).toBe("instance unreachable (socket hang up)");
  });

  it("falls back to the message when a thrown Error carries no code", async () => {
    const net = transport(() => {
      throw new Error("aborted");
    });
    const error = await failure(() => client(net.fetch).getPage("t_table", null, PAGE));
    expect(error.message).toBe("instance unreachable (aborted)");
  });

  it("surfaces the three §10 states as three different messages", async () => {
    const cases: Array<[string, MirrorHttpResponse, string, string]> = [
      [
        "auth",
        json(401, { error: { message: "User Not Authenticated" } }),
        "auth",
        "auth failed",
      ],
      [
        "hibernating",
        response(200, HIBERNATION_HTML, { "content-type": "text/html" }),
        "hibernating",
        "instance hibernating (wake it at developer.servicenow.com)",
      ],
      [
        "portal",
        response(404, "<html>nope</html>", { "content-type": "text/html" }),
        "unreachable",
        "instance unreachable",
      ],
    ];

    const seen = new Set<string>();
    for (const [, wire, expectedClass, fragment] of cases) {
      const net = always(wire);
      const error = await failure(() => client(net.fetch).getPage("t_table", null, PAGE));
      expect(error.failureClass).toBe(expectedClass);
      expect(error.message).toContain(fragment);
      seen.add(error.message);
    }
    // Three states, three distinct operator actions, three distinct messages —
    // a client that collapsed them into "cannot connect" would send an operator
    // to check the network when the fix is a click on developer.servicenow.com.
    expect(seen.size).toBe(3);
  });

  it("does not retry an auth failure — credentials do not start working mid-sweep", async () => {
    const clock = fakeClock();
    const net = always(json(401, { error: { message: "User Not Authenticated" } }));
    await failure(() => client(net.fetch, clock).getPage("t_table", null, PAGE));
    expect(net.calls).toHaveLength(1);
  });

  it("never echoes the credential it sent into the failure it reports (§9)", async () => {
    const net = always(json(401, { error: { message: "User Not Authenticated" } }));
    const subject = client(net.fetch, fakeClock(), {
      headers: { Authorization: "Basic aHVudGVyMg==" },
    });
    const error = await failure(() => subject.getPage("t_table", null, PAGE));

    expect(error.message).not.toContain("aHVudGVyMg==");
    expect(JSON.stringify(error.envelope ?? {})).not.toContain("aHVudGVyMg==");
  });

  it.each([
    ["an ACL denial", 403, "insufficient rights", "acl"],
    ["a vanished table", 404, "no record found", "schema-drift"],
    ["a rejected query", 400, "Invalid table", "schema-drift"],
  ])("classifies %s as %s", async (_name, status, message, expected) => {
    const net = always(json(status, { error: { message } }));
    const error = await failure(() => client(net.fetch).getPage("t_table", null, PAGE));
    expect(error.failureClass).toBe(expected);
    expect(error.message).toBe(message);
    expect(error.httpStatus).toBe(status);
  });

  it.each([
    ["declares JSON and sends something else", { "content-type": "application/json" }],
    ["declares nothing at all", {}],
  ])("reports a body that %s as a parse failure, not as unreachable", async (_name, headers) => {
    const net = always(response(200, "{not json", headers));
    const error = await failure(() => client(net.fetch).getPage("t_table", null, PAGE));
    expect(error.failureClass).toBe("parse");
    expect(error.message).toContain("not JSON");
    expect(error.httpStatus).toBe(200);
  });

  it("classifies a failure that arrives with no content type", async () => {
    const net = always(response(403, "Insufficient rights"));
    const error = await failure(() => client(net.fetch).getPage("t_table", null, PAGE));
    expect(error.failureClass).toBe("acl");
  });

  it("carries no envelope when there was no response to read one from", () => {
    const bare = new MirrorHttpError("local-io", "disk full");
    expect(bare.envelope).toBeNull();
    expect(bare.httpStatus).toBeNull();
    expect(bare.name).toBe("MirrorHttpError");
    expect(bare).toBeInstanceOf(Error);
  });
});

// --- reachability probe -----------------------------------------------------

describe("MirrorHttpClient.probeReachability", () => {
  it("reports a reachable instance and asks for as little as possible", async () => {
    const net = always(json(200, { result: [] }));
    const status = await client(net.fetch).probeReachability();

    const url = new URL(net.calls[0].url);
    expect(url.pathname).toBe("/api/now/table/sys_db_object");
    expect(url.searchParams.get("sysparm_limit")).toBe("1");
    expect(url.searchParams.get("sysparm_fields")).toBe("sys_id");
    expect(status.state).toBe("ok");
  });

  it("reports each failure state without throwing", async () => {
    const hibernating = always(response(200, HIBERNATION_HTML, { "content-type": "text/html" }));
    await expect(client(hibernating.fetch).probeReachability()).resolves.toEqual({
      state: "hibernating",
      detail: "instance hibernating (wake it at developer.servicenow.com)",
    });

    const denied = always(json(401, { error: { message: "User Not Authenticated" } }));
    expect((await client(denied.fetch).probeReachability()).state).toBe("auth-failed");

    const offline = transport(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    expect((await client(offline.fetch).probeReachability()).state).toBe("unreachable");

    const noHeader = always(response(200, "{}"));
    expect((await client(noHeader.fetch).probeReachability()).state).toBe("ok");
  });
});

// --- credentials ------------------------------------------------------------

describe("resolveMirrorAuthorization (§9)", () => {
  const source = (
    credentials: Record<string, unknown> | null,
    active: string | null = "dev12345"
  ): MirrorCredentialSource => ({
    getActiveInstance: () => active,
    loadCredentials: () => credentials as never,
  });

  it("builds a basic header from the stored user and password", () => {
    const auth = resolveMirrorAuthorization(
      "dev12345",
      source({ instance: "dev12345", user: "admin", password: "hunter2", authMethod: "basic" })
    );
    expect(auth).toEqual({
      instance: "dev12345",
      headers: { Authorization: `Basic ${Buffer.from("admin:hunter2").toString("base64")}` },
    });
  });

  it("treats a store written before auth methods existed as basic", () => {
    const auth = resolveMirrorAuthorization(
      undefined,
      source({ instance: "dev12345", user: "admin", password: "hunter2" })
    );
    expect(auth.instance).toBe("dev12345");
    expect(auth.headers.Authorization).toContain("Basic ");
  });

  it("builds an inbound API-key header, honouring a custom header name", () => {
    const standard = resolveMirrorAuthorization(
      "dev12345",
      source({ instance: "dev12345", user: "", password: "", authMethod: "api-key", apiKey: "k" })
    );
    expect(standard.headers).toEqual({ "x-sn-apikey": "k" });

    const custom = resolveMirrorAuthorization(
      "dev12345",
      source({
        instance: "dev12345",
        user: "",
        password: "",
        authMethod: "api-key",
        apiKey: "k",
        apiKeyHeader: "x-my-key",
      })
    );
    expect(custom.headers).toEqual({ "x-my-key": "k" });
  });

  it.each([
    [
      "no instance is selected anywhere",
      source(null, null),
      undefined,
      ["No ServiceNow instance selected", "syncrona use"],
    ],
    [
      "the instance has no stored credentials",
      source(null),
      "dev12345",
      ["No stored credentials for dev12345", "syncrona login"],
    ],
    [
      "the stored basic credentials have a blank password",
      source({ instance: "dev12345", user: "admin", password: "", authMethod: "basic" }),
      "dev12345",
      ["user and password are both required", "syncrona login"],
    ],
    [
      "the stored basic credentials have no password field",
      source({ instance: "dev12345", user: "admin", authMethod: "basic" }),
      "dev12345",
      ["user and password are both required"],
    ],
    [
      "the stored basic credentials have no user field",
      source({ instance: "dev12345", password: "hunter2", authMethod: "basic" }),
      "dev12345",
      ["user and password are both required"],
    ],
    [
      "the stored API-key credential holds no key",
      source({ instance: "dev12345", user: "", password: "", authMethod: "api-key" }),
      "dev12345",
      ["select API-key auth but hold no key", "syncrona login"],
    ],
  ])("fails with an actionable message when %s", (_name, credentialSource, instance, says) => {
    let error: MirrorHttpError | undefined;
    try {
      resolveMirrorAuthorization(instance as string | undefined, credentialSource);
    } catch (thrown) {
      error = thrown as MirrorHttpError;
    }
    expect(error).toBeInstanceOf(MirrorHttpError);
    expect(error?.failureClass).toBe("auth");
    for (const fragment of says) {
      expect(error?.message).toContain(fragment);
    }
  });

  it.each(["oauth-password", "oauth-client-credentials", "oauth-jwt-bearer"])(
    "refuses %s and explains that the token request would break INV-2",
    (authMethod) => {
      const run = (): unknown =>
        resolveMirrorAuthorization(
          "dev12345",
          source({ instance: "dev12345", user: "u", password: "p", authMethod })
        );
      expect(run).toThrow(/state-changing request and INV-2 forbids one/);
      expect(run).toThrow(new RegExp(authMethod));
      // The escape hatch is named, so this is a routing instruction rather than
      // a dead end: mint the token on the side of the boundary allowed to POST.
      expect(run).toThrow(/Supply a ready Authorization header/);
    }
  );

  it("binds the production source to the credential store and nothing else", () => {
    // §9: the store is the only source. The seam exists for tests, not to make
    // the source configurable in production.
    expect(typeof credentialStoreSource.getActiveInstance).toBe("function");
    expect(typeof credentialStoreSource.loadCredentials).toBe("function");
    // The real store returns null for an instance nobody has logged into, and
    // does so without throwing or prompting.
    expect(credentialStoreSource.loadCredentials("instance.that.does.not.exist")).toBeNull();
  });

  it("reads from that store by default, so no caller has to pass one", () => {
    // Exercised with no source argument on purpose: an omitted default that
    // silently pointed somewhere else would make every other test in this block
    // a test of the fake rather than of the code. The instance name cannot
    // exist in any store, so the outcome does not depend on who runs the suite.
    expect(() => resolveMirrorAuthorization("instance.that.does.not.exist")).toThrow(
      /No stored credentials for instance\.that\.does\.not\.exist/
    );
  });
});

describe("createMirrorHttpClient", () => {
  it("wires a validated config's rate limit and page size into the client", async () => {
    const config = loadMirrorConfig({
      instance: "dev12345",
      sync: { requestsPerSecond: 2, pageSize: 42 },
    });
    const clock = fakeClock();
    const net = always(rows(SYS_ID_A));
    const subject = createMirrorHttpClient(
      config,
      { fetch: net.fetch, now: clock.now, sleep: clock.sleep },
      {
        getActiveInstance: () => null,
        loadCredentials: () =>
          ({ instance: "dev12345", user: "admin", password: "p" }) as never,
      }
    );

    await subject.getPage("sys_script", null, PAGE);
    await subject.getPage("sys_script", null, PAGE);

    expect(new URL(net.calls[0].url).origin).toBe("https://dev12345");
    expect(new URL(net.calls[0].url).searchParams.get("sysparm_limit")).toBe("42");
    expect(clock.slept).toEqual([500]);
  });

  it("falls back to the active instance when the config pins none", async () => {
    const net = always(rows(SYS_ID_A));
    const subject = createMirrorHttpClient(
      loadMirrorConfig({}),
      { fetch: net.fetch },
      {
        getActiveInstance: () => "active-instance",
        loadCredentials: () =>
          ({ instance: "active-instance", user: "a", password: "b" }) as never,
      }
    );
    await subject.getPage("sys_script", null, PAGE);
    expect(new URL(net.calls[0].url).origin).toBe("https://active-instance");
  });

  it("needs neither overrides nor a source to be handed to it", () => {
    // The production call shape: config in, client out. It reaches the real
    // credential store, which is the point — the defaults are the wiring.
    expect(() =>
      createMirrorHttpClient(loadMirrorConfig({ instance: "instance.that.does.not.exist" }))
    ).toThrow(/No stored credentials/);
  });

  it("takes supplied headers as the authentication and never opens the store", async () => {
    // §9's whole point: core mints the OAuth token, because INV-2 forbids the
    // POST here. A source that throws on contact is the assertion — reaching for
    // the store at all would throw `auth` for exactly these instances, which is
    // what this path used to do.
    const forbidden: MirrorCredentialSource = {
      getActiveInstance: () => {
        throw new Error("credential store consulted");
      },
      loadCredentials: () => {
        throw new Error("credential store consulted");
      },
    };
    const net = always(rows(SYS_ID_A));
    const subject = createMirrorHttpClient(
      loadMirrorConfig({ instance: "dev12345" }),
      { fetch: net.fetch, headers: { Authorization: "Bearer minted-by-core" } },
      forbidden
    );

    await subject.getPage("sys_script", null, PAGE);

    expect(new URL(net.calls[0].url).origin).toBe("https://dev12345");
    expect(net.calls[0].init.headers).toMatchObject({ Authorization: "Bearer minted-by-core" });
  });

  it("lets an overridden instance outrank the config's when headers come with it", async () => {
    const net = always(rows(SYS_ID_A));
    const subject = createMirrorHttpClient(
      loadMirrorConfig({ instance: "dev12345" }),
      {
        fetch: net.fetch,
        headers: { Authorization: "Bearer minted-by-core" },
        instance: "other-instance",
      },
      {
        getActiveInstance: () => {
          throw new Error("credential store consulted");
        },
        loadCredentials: () => {
          throw new Error("credential store consulted");
        },
      }
    );

    await subject.getPage("sys_script", null, PAGE);

    expect(new URL(net.calls[0].url).origin).toBe("https://other-instance");
  });

  it("still requires an instance from somewhere when headers are supplied", async () => {
    // Headers say who you are, not where you are going. With no config instance
    // the active marker answers — a read the store exposes without decrypting
    // any credential — and with neither, the same refusal as the resolved path.
    const net = always(rows(SYS_ID_A));
    const headers = { Authorization: "Bearer minted-by-core" };
    const activeOnly: MirrorCredentialSource = {
      getActiveInstance: () => "active-instance",
      loadCredentials: () => {
        throw new Error("credential store consulted");
      },
    };
    const subject = createMirrorHttpClient(
      loadMirrorConfig({}),
      { fetch: net.fetch, headers },
      activeOnly
    );
    await subject.getPage("sys_script", null, PAGE);
    expect(new URL(net.calls[0].url).origin).toBe("https://active-instance");

    expect(() =>
      createMirrorHttpClient(loadMirrorConfig({}), { headers }, { ...activeOnly, getActiveInstance: () => null })
    ).toThrow(/No ServiceNow instance selected/);
  });
});

// --- the seam is real -------------------------------------------------------

describe("MirrorHttpClient over the platform's own fetch", () => {
  let server: Server;
  let baseUrl: string;
  const received: Array<{ url: string; method: string; auth: string | undefined }> = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, reply: ServerResponse) => {
      received.push({
        url: request.url ?? "",
        method: request.method ?? "",
        auth: request.headers.authorization,
      });
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify({ result: [{ sys_id: SYS_ID_A, name: "from the wire" }] }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("talks to a real server with no seam injected at all", async () => {
    // No `fetch`, no `sleep`, no `now`: this exercises the production defaults,
    // and it is the assertion that the platform's `Response` really does satisfy
    // `MirrorHttpResponse` rather than merely being declared to.
    const subject = new MirrorHttpClient({
      instance: baseUrl,
      headers: { Authorization: "Basic bG9vcGJhY2s=" },
      // Two requests at 20 rps means one real 50 ms sleep — enough to prove the
      // default timer runs, short enough not to slow the suite.
      requestsPerSecond: 20,
    });

    const first = await subject.getPage("sys_script", null, PAGE);
    const second = await subject.getPage("sys_script", first.lastSysId, PAGE);

    expect(first.rows).toEqual([{ sys_id: SYS_ID_A, name: "from the wire" }]);
    expect(second.done).toBe(true);
    expect(received).toHaveLength(2);
    expect(received.every((entry) => entry.method === "GET")).toBe(true);
    expect(received[0].auth).toBe("Basic bG9vcGJhY2s=");
    expect(received[1].url).toContain(encodeURIComponent(`sys_id>${SYS_ID_A}`));
  });
});
