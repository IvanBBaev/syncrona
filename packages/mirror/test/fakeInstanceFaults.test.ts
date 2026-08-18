// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * WP-M2 acceptance, the adversarial half: everything the fake instance does
 * *wrong* on purpose.
 *
 * Three of the four §12 acceptance clauses live here — 429 with and without
 * `Retry-After`, hibernation serving HTML, and insert/delete mid-sweep. The
 * fourth (plain paging correctness) is in `fakeInstance.test.ts` and determinism
 * is in `fakeInstanceCorpus.test.ts`.
 *
 * Every failure response is validated by feeding it back through the real
 * `classifyError` / `diagnoseReachability` / `computeRetryDelay` from
 * `@syncrona/sn-transport`. Checking the status code alone would prove the fake
 * agrees with itself; routing the body through WP-M0's classifier proves the two
 * halves of the retry contract still meet. The fake is only worth having if a
 * response it emits provokes the same decision a real instance's would.
 */
import {
  buildKeysetQuery,
  classifyError,
  computeRetryDelay,
  diagnoseReachability,
} from "@syncrona/sn-transport";
import type { FixtureRow } from "./fakeInstance/corpus";
import {
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  rateLimitWithoutRetryAfter,
  rateLimitWithRetryAfter,
  type MutationScript,
  type WireRow,
} from "./fakeInstance/server";
import { fetchJson, fetchRaw, tableUrl, type FakeResponse, type TableApiResult } from "./fakeInstance/client";

const AUTH = { auth: DEFAULT_CREDENTIALS } as const;

/** sys_script holds nine rows; three-row pages make the cursor land mid-table. */
const SCRIPT_PAGE = 3;
const SCRIPT_ROWS = 9;

/** Build the URL the mirror's own pager would issue for one page. */
function pageUrl(server: FakeInstanceServer, table: string, cursor: string | null, pageSize: number): string {
  const query = buildKeysetQuery(table, cursor, pageSize, { fields: ["sys_id", "sys_updated_on", "name"] });
  const url = new URL(query.path, server.baseUrl);
  for (const [key, value] of Object.entries(query.params)) url.searchParams.set(key, value);
  return url.toString();
}

interface SweepResult {
  rows: WireRow[];
  /** Delays a real retrying client would have slept, in issue order. */
  delays: number[];
  pages: number;
}

/**
 * Walk a table with the retry posture §10/R1 prescribes: transient failures are
 * retried from the SAME cursor, never skipped.
 *
 * The delay is computed with a fixed `random` so the assertion is on the value,
 * not on the jitter; the sleep itself is skipped because waiting out a real
 * backoff would add seconds to the suite to prove nothing the arithmetic does
 * not already prove.
 */
async function sweepWithRetry(
  server: FakeInstanceServer,
  table: string,
  pageSize: number,
  maxAttempts = 4
): Promise<SweepResult> {
  const rows: WireRow[] = [];
  const delays: number[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (let guard = 0; guard < 200; guard += 1) {
    let response: FakeResponse | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      response = await fetchRaw(pageUrl(server, table, cursor, pageSize), AUTH);
      if (response.status === 200) break;
      const parsed: unknown = JSON.parse(response.text);
      const classified = classifyError(response.status, parsed).classified;
      if (classified !== "transient") throw new Error(`sweep hit ${classified} ${response.status}: ${response.text}`);
      const header = response.headers["retry-after"];
      delays.push(computeRetryDelay(attempt, typeof header === "string" ? header : undefined, { random: () => 0.5 }));
    }
    if (!response || response.status !== 200) throw new Error(`sweep of ${table} exhausted its retries`);

    pages += 1;
    const page = (JSON.parse(response.text) as TableApiResult<WireRow[]>).result;
    rows.push(...page);
    if (page.length < pageSize) return { rows, delays, pages };
    cursor = (page[page.length - 1] as WireRow).sys_id as string;
  }
  throw new Error(`sweep of ${table} did not terminate`);
}

const scriptRow = (sysId: string, name: string): FixtureRow => ({
  sys_id: sysId,
  name,
  sys_updated_on: "2026-07-01 00:00:00",
});

/** Run one sweep against a server carrying a single scripted mutation. */
async function sweepWithMutation(mutation: MutationScript): Promise<{
  server: FakeInstanceServer;
  rows: WireRow[];
  ids: string[];
}> {
  const server = await FakeInstanceServer.start({ mutations: [mutation] });
  const { rows } = await sweepWithRetry(server, "sys_script", SCRIPT_PAGE);
  return { server, rows, ids: rows.map((row) => row.sys_id as string) };
}

describe("rate limiting (§12: 429 with and without Retry-After)", () => {
  it("answers 429 with no Retry-After header at all, as D6 measured", async () => {
    const server = await FakeInstanceServer.start({
      faults: [rateLimitWithoutRetryAfter({ route: "table-page" })],
    });
    try {
      const response = await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), AUTH);
      expect(response.status).toBe(429);
      // The absence is the measurement. D6 found a real PDI's 429 carries no
      // rate-limit headers, so a client that waits for `Retry-After` before
      // retrying would hang forever — this asserts the fake reproduces the
      // silence rather than helpfully inventing a header.
      expect(response.headers["retry-after"]).toBeUndefined();
      expect(response.headers["x-ratelimit-remaining"]).toBeUndefined();

      const body: unknown = JSON.parse(response.text);
      expect(classifyError(429, body).classified).toBe("transient");
      // With no header, the client falls back to full-jitter exponential backoff.
      expect(computeRetryDelay(0, undefined, { random: () => 0.5 })).toBe(500);
      expect(computeRetryDelay(3, undefined, { random: () => 1 })).toBe(8_000);

      // `times` defaults to 1, so the next request succeeds — the fault is a
      // burst, not a permanent state.
      expect((await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), AUTH)).status).toBe(200);
      server.assertNoViolations();
    } finally {
      await server.close();
    }
  });

  it("answers 429 with Retry-After when the rule asks for one, and the header wins", async () => {
    const server = await FakeInstanceServer.start({
      faults: [rateLimitWithRetryAfter(7, { route: "table-page" })],
    });
    try {
      const response = await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), AUTH);
      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBe("7");
      // Seconds on the wire, milliseconds in the policy. Reading the header as
      // milliseconds would retry 1000x too fast and re-trip the limit.
      expect(computeRetryDelay(0, "7", { random: () => 0.5 })).toBe(7_000);
      // And it beats the jitter path even on a high attempt number, which is the
      // whole point of honouring it.
      expect(computeRetryDelay(9, "7", { random: () => 1 })).toBe(7_000);
    } finally {
      await server.close();
    }
  });

  it("completes a sweep across a 429 by retrying the same cursor (R1)", async () => {
    const server = await FakeInstanceServer.start({
      // Let page 1 through, rate-limit page 2 once.
      faults: [rateLimitWithoutRetryAfter({ route: "table-page", table: "sys_script", skip: 1, times: 1 })],
    });
    try {
      const { rows, delays, pages } = await sweepWithRetry(server, "sys_script", SCRIPT_PAGE);
      const ids = rows.map((row) => row.sys_id as string);
      expect(ids).toHaveLength(SCRIPT_ROWS);
      // The retry must resume from the cursor, not advance past it: skipping the
      // rate-limited page would silently drop three records from the mirror and
      // the resulting tree would still look internally consistent.
      expect(new Set(ids).size).toBe(SCRIPT_ROWS);
      expect(ids).toEqual([...ids].sort());
      expect(delays).toEqual([500]);
      // Four pages for nine rows at three a page: when the row count is an exact
      // multiple of the page size, the last full page is indistinguishable from
      // a page that happens to end at a boundary, so a keyset pager always pays
      // for one confirming empty request. Worth pinning — a "fix" that stops at
      // the first exactly-full page would drop the tail of every such table.
      expect(pages).toBe(4);
      server.assertNoViolations();
    } finally {
      await server.close();
    }
  });

  it("serves a 5xx burst bounded by skip and times", async () => {
    const server = await FakeInstanceServer.start({
      faults: [{ route: "table-page", table: "sys_dictionary", status: 503, skip: 2, times: 2 }],
    });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const response = await fetchRaw(
          tableUrl(server.baseUrl, "sys_dictionary", { sysparm_limit: 1, sysparm_query: "ORDERBYsys_id" }),
          AUTH
        );
        statuses.push(response.status);
        if (response.status === 503) {
          expect(classifyError(503, JSON.parse(response.text)).classified).toBe("transient");
        }
      }
      expect(statuses).toEqual([200, 200, 503, 503, 200]);

      // Scoped by table: the burst must not bleed into an unrelated sweep, or a
      // test asserting "table A survived" would be measuring table B's luck.
      expect((await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), AUTH)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("serves a non-JSON fault body the way a proxy in front of an instance does", async () => {
    const html = "<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>";
    const server = await FakeInstanceServer.start({
      faults: [{ route: "table-page", status: 502, contentType: "text/html; charset=utf-8", body: html }],
    });
    try {
      const response = await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), AUTH);
      expect(response.status).toBe(502);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.text).toBe(html);

      // No envelope to read: `classifyError` must fall back to the status rather
      // than throw while reaching for `body.error.message`.
      expect(classifyError(502, response.text)).toEqual({
        httpStatus: 502,
        message: "HTTP 502",
        detail: null,
        classified: "transient",
      });
      // And the reachability probe must call it a proxy, not a hibernating
      // instance — the remedies differ (wait vs. wake the PDI).
      const diagnosis = diagnoseReachability({
        status: 502,
        contentType: response.headers["content-type"],
        body: response.text,
      });
      expect(diagnosis.state).toBe("unreachable");
      expect(diagnosis.detail).toContain("HTML, not JSON");
    } finally {
      await server.close();
    }
  });
});

describe("ACL denial (F5)", () => {
  it("answers 403 on a denied table with an envelope the classifier reads as acl", async () => {
    const server = await FakeInstanceServer.start({ aclDeniedTables: ["sys_properties"] });
    try {
      const { status, json } = await fetchJson(tableUrl(server.baseUrl, "sys_properties", {}), AUTH);
      expect(status).toBe(403);
      expect(JSON.stringify(json)).toContain("sys_properties");
      // `acl` rather than `fatal`: F5 says a denied table is a gap to record and
      // continue past, not a reason to abort the whole mirror.
      expect(classifyError(status, json).classified).toBe("acl");

      expect((await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), AUTH)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("answers 403 from the aggregate API alone, so the count fallback is reachable (§5.10)", async () => {
    const server = await FakeInstanceServer.start({ aggregateDeniedTables: ["sys_script"] });
    try {
      const aggregate = await fetchJson(`${server.baseUrl}/api/now/stats/sys_script?sysparm_count=true`, AUTH);
      expect(aggregate.status).toBe(403);
      expect(classifyError(aggregate.status, aggregate.json).classified).toBe("acl");

      // The Table API is untouched, which is exactly the situation the fallback
      // exists for: aggregate ACLs are configured separately on a real instance,
      // so "cannot count" does not imply "cannot read".
      const rows = await fetchJson<TableApiResult<WireRow[]>>(
        tableUrl(server.baseUrl, "sys_script", { sysparm_query: "ORDERBYsys_id", sysparm_fields: "sys_id" }),
        AUTH
      );
      expect(rows.status).toBe(200);
      expect(rows.json.result).toHaveLength(SCRIPT_ROWS);
    } finally {
      await server.close();
    }
  });
});

describe("hibernation (§12: hibernation mode serves HTML)", () => {
  it("answers every path with the HTML page the real classifier calls hibernating", async () => {
    const server = await FakeInstanceServer.start({ hibernating: true });
    try {
      for (const path of ["/api/now/table/sys_script", "/api/now/stats/sys_script", "/nonsense"]) {
        const response = await fetchRaw(`${server.baseUrl}${path}`, AUTH);
        // HTTP 200 with an HTML body, which is the trap: status-first
        // classification reads this as a successful empty sweep and mirrors an
        // empty instance over a good one.
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
        expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(response.text).toContain("<html");

        const diagnosis = diagnoseReachability({
          status: response.status,
          contentType: response.headers["content-type"],
          body: response.text,
        });
        expect(diagnosis.state).toBe("hibernating");
        expect(diagnosis.detail).toContain("developer.servicenow.com");
      }
    } finally {
      await server.close();
    }
  });

  it("serves HTML even without credentials, because a sleeping instance authenticates nobody", async () => {
    const server = await FakeInstanceServer.start({ hibernating: true });
    try {
      const response = await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}));
      expect(response.status).toBe(200);
      expect(
        diagnoseReachability({
          status: response.status,
          contentType: response.headers["content-type"],
          body: response.text,
        }).state
      ).toBe("hibernating");
    } finally {
      await server.close();
    }
  });

  it("can hibernate mid-sweep and recover on the same cursor (F4)", async () => {
    const server = await FakeInstanceServer.start();
    try {
      const first = await fetchJson<TableApiResult<WireRow[]>>(
        pageUrl(server, "sys_script", null, SCRIPT_PAGE),
        AUTH
      );
      expect(first.json.result).toHaveLength(SCRIPT_PAGE);
      const cursor = (first.json.result[SCRIPT_PAGE - 1] as WireRow).sys_id as string;

      server.setHibernating(true);
      const asleep = await fetchRaw(pageUrl(server, "sys_script", cursor, SCRIPT_PAGE), AUTH);
      expect(asleep.status).toBe(200);
      expect(asleep.text).toContain("hibernating");
      // F4's whole danger: the interrupted sweep must be resumable, not
      // restarted and not silently truncated at the page it died on.
      expect(
        diagnoseReachability({
          status: asleep.status,
          contentType: asleep.headers["content-type"],
          body: asleep.text,
        }).state
      ).toBe("hibernating");

      server.setHibernating(false);
      const resumed = await sweepWithRetry(server, "sys_script", SCRIPT_PAGE);
      expect(resumed.rows).toHaveLength(SCRIPT_ROWS);
      server.assertNoViolations();
    } finally {
      await server.close();
    }
  });
});

describe("latency injection", () => {
  it("delays one route without delaying the others", async () => {
    const server = await FakeInstanceServer.start({ latencyMsByRoute: { "table-page": 120 } });
    try {
      const startPage = Date.now();
      await fetchRaw(tableUrl(server.baseUrl, "sys_script", { sysparm_limit: 1 }), AUTH);
      const pageElapsed = Date.now() - startPage;

      const startStats = Date.now();
      await fetchRaw(`${server.baseUrl}/api/now/stats/sys_script?sysparm_count=true`, AUTH);
      const statsElapsed = Date.now() - startStats;

      // Per-route latency is what makes "the count probe is fast but the page
      // fetch times out" reproducible — the shape of a real quiescence stall.
      expect(pageElapsed).toBeGreaterThanOrEqual(110);
      expect(statsElapsed).toBeLessThan(110);
    } finally {
      await server.close();
    }
  });

  it("applies a global latency to every route and still closes cleanly", async () => {
    const server = await FakeInstanceServer.start({ latencyMs: 40 });
    const start = Date.now();
    await fetchRaw(`${server.baseUrl}/api/now/stats/sys_script?sysparm_count=true`, AUTH);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
    // Closing while a sleep is pending must not leave a timer behind; a leaked
    // handle here is what makes Jest hang and the whole package look broken.
    const pending = fetchRaw(tableUrl(server.baseUrl, "sys_script", { sysparm_limit: 1 }), AUTH).catch(
      (error: NodeJS.ErrnoException) => error.code ?? "error"
    );
    await server.close();
    await pending;
  });
});

describe("mid-sweep mutation (§12: insert/delete mid-sweep; analyses §1)", () => {
  const behindCursor = "00000000000000000000000000000001";
  const aheadOfCursor = "ffffffffffffffffffffffffffffff01";
  /** The third sys_script row — the cursor after a single three-row page. */
  const cursorRow = "4ad92f6e2e539f29528a4ef0bf9bbd8a";
  /** The last sys_script row, comfortably ahead of the cursor. */
  const lastRow = "c01fd9157ddb68e892c2b708c64d9d48";

  it("misses a row inserted behind the cursor", async () => {
    const { server, ids } = await sweepWithMutation({
      table: "sys_script",
      afterPages: 1,
      insertRows: [scriptRow(behindCursor, "Inserted Behind The Cursor")],
    });
    try {
      // Not a bug in the fake — a fact about keyset paging that WP-M10 has to
      // handle: a row inserted with a sys_id below the cursor is invisible to
      // the running sweep, so the watermark check after the sweep is what
      // catches it. Asserting the miss pins the behaviour the mirror compensates
      // for, instead of leaving it to be rediscovered against a live instance.
      expect(ids).toHaveLength(SCRIPT_ROWS);
      expect(ids).not.toContain(behindCursor);
      expect(server.rowsOf("sys_script")).toHaveLength(SCRIPT_ROWS + 1);
    } finally {
      await server.close();
    }
  });

  it("picks up a row inserted ahead of the cursor", async () => {
    const { server, ids } = await sweepWithMutation({
      table: "sys_script",
      afterPages: 1,
      insertRows: [scriptRow(aheadOfCursor, "Inserted Ahead Of The Cursor")],
    });
    try {
      expect(ids).toHaveLength(SCRIPT_ROWS + 1);
      expect(ids).toContain(aheadOfCursor);
      expect(ids).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await server.close();
    }
  });

  it("skips a row deleted ahead of the cursor without erroring", async () => {
    const { server, ids } = await sweepWithMutation({
      table: "sys_script",
      afterPages: 1,
      deleteSysIds: [lastRow],
    });
    try {
      expect(ids).toHaveLength(SCRIPT_ROWS - 1);
      expect(ids).not.toContain(lastRow);
      expect(server.rowsOf("sys_script")).toHaveLength(SCRIPT_ROWS - 1);
    } finally {
      await server.close();
    }
  });

  it("keeps paging when the cursor row itself is deleted", async () => {
    const { server, ids } = await sweepWithMutation({
      table: "sys_script",
      afterPages: 1,
      deleteSysIds: [cursorRow],
    });
    try {
      // The cursor is a value, not an index, so a deleted cursor still orders
      // the remaining keys correctly. An offset-based fake would have shifted
      // here and duplicated or dropped a row — which is precisely why the
      // fake refuses `sysparm_offset` at all.
      expect(ids).toHaveLength(SCRIPT_ROWS);
      expect(new Set(ids).size).toBe(SCRIPT_ROWS);
      expect(ids).toEqual([...ids].sort());
      // The sweep still carries the row that was deleted after it was served —
      // the stale record the repair pass exists to reconcile.
      expect(ids).toContain(cursorRow);
      expect(server.rowsOf("sys_script").map((row) => row.sys_id)).not.toContain(cursorRow);
    } finally {
      await server.close();
    }
  });

  it("returns the post-update value for a row updated ahead of the cursor", async () => {
    const { server, rows } = await sweepWithMutation({
      table: "sys_script",
      afterPages: 1,
      updateRows: [{ sysId: lastRow, fields: { name: "Renamed Mid Sweep", sys_updated_on: "2026-07-02 11:22:33" } }],
    });
    try {
      const updated = rows.find((row) => row.sys_id === lastRow);
      expect(updated).toMatchObject({ name: "Renamed Mid Sweep", sys_updated_on: "2026-07-02 11:22:33" });
      // The bumped watermark is what makes the change detectable at all: §5.10
      // compares max(sys_updated_on) before and after, so an update that did not
      // move it would defeat the quiescence proof.
      const { json } = await fetchJson<TableApiResult<{ stats: { max: Record<string, string> } }>>(
        `${server.baseUrl}/api/now/stats/sys_script?sysparm_max_fields=sys_updated_on`,
        AUTH
      );
      expect(json.result.stats.max.sys_updated_on).toBe("2026-07-02 11:22:33");
    } finally {
      await server.close();
    }
  });

  it("applies a harness mutation immediately without weakening the GET-only posture", async () => {
    const server = await FakeInstanceServer.start();
    try {
      server.mutate({ table: "sys_script", insertRows: [scriptRow(aheadOfCursor, "Direct Insert")] });
      const { rows } = await sweepWithRetry(server, "sys_script", SCRIPT_PAGE);
      expect(rows).toHaveLength(SCRIPT_ROWS + 1);
      // `mutate()` is a harness call, not an HTTP verb, so nothing was recorded
      // as a protocol violation — the corpus changed without a write ever
      // reaching the router.
      server.assertNoViolations();
      expect(server.requests.every((entry) => entry.method === "GET")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
