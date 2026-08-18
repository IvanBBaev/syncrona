// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * WP-M2 acceptance, half two: the fake instance passes a self-test suite
 * covering keyset paging correctness, the wire shapes analyses §7 measured, and
 * the two postures the fake refuses to be lenient about (GET-only, keyset-only).
 *
 * The paging tests drive the server through `buildKeysetQuery` from
 * `@syncrona/sn-transport` rather than through hand-written query strings. That
 * is the point of the exercise: the fake exists to be the far side of the real
 * pager, so the self-test uses the real pager as its client. A hand-rolled query
 * string would prove the fake is self-consistent and nothing more — and the
 * failure mode that actually costs a day is the fake and WP-M0 agreeing on a
 * shape ServiceNow does not use.
 *
 * Error bodies are likewise pinned by feeding them back through the real
 * `classifyError` and `diagnoseReachability`. Asserting `status === 401` proves
 * the number; asserting `classifyError(...).classified === "auth"` proves the
 * envelope text still hits the marker patterns the mirror will route on.
 *
 * Fault injection, latency, hibernation and mid-sweep mutation live in
 * `fakeInstanceFaults.test.ts`; corpus determinism lives in
 * `fakeInstanceCorpus.test.ts`.
 */
import { buildKeysetQuery, classifyError, SYS_ID_RE } from "@syncrona/sn-transport";
import { createHash } from "node:crypto";
import { synthesizeAttachmentBytes, type FixtureRow } from "./fakeInstance/corpus";
import {
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  type WireRow,
  type WireValue,
} from "./fakeInstance/server";
import { fetchJson, fetchRaw, tableUrl, type TableApiResult } from "./fakeInstance/client";

const AUTH = { auth: DEFAULT_CREDENTIALS } as const;

/** A page's worth of rows, or a thrown error carrying the status. */
const getRows = async (url: string): Promise<WireRow[]> => {
  const { status, json } = await fetchJson<TableApiResult<WireRow[]>>(url, AUTH);
  if (status !== 200) throw new Error(`expected 200 from ${url}, got ${status}: ${JSON.stringify(json)}`);
  return json.result;
};

/**
 * Walk a table the way the mirror will: `buildKeysetQuery`, cursor from the last
 * row of the previous page, stop on a short page.
 *
 * `onPage` fires after each page so a mutation test can observe the cursor at
 * the exact moment the corpus changes underneath it.
 */
async function sweep(
  server: FakeInstanceServer,
  table: string,
  pageSize: number,
  fields: readonly string[] = ["sys_id", "sys_updated_on", "name"]
): Promise<WireRow[]> {
  const collected: WireRow[] = [];
  let cursor: string | null = null;
  // A bound rather than `while (true)`: a paging bug that fails to advance the
  // cursor is an infinite loop, and an infinite loop in a test suite reads as a
  // hung CI job rather than as the defect it is.
  for (let page = 0; page < 200; page += 1) {
    const query = buildKeysetQuery(table, cursor, pageSize, { fields });
    const url = new URL(query.path, server.baseUrl);
    for (const [key, value] of Object.entries(query.params)) url.searchParams.set(key, value);
    const rows = await getRows(url.toString());
    collected.push(...rows);
    if (rows.length < pageSize) return collected;
    cursor = (rows[rows.length - 1] as WireRow).sys_id as string;
  }
  throw new Error(`sweep of ${table} did not terminate within 200 pages`);
}

describe("fake instance lifecycle", () => {
  it("binds an ephemeral loopback port and reports it", async () => {
    const first = await FakeInstanceServer.start();
    const second = await FakeInstanceServer.start();
    try {
      expect(first.port).toBeGreaterThan(0);
      expect(first.baseUrl).toBe(`http://127.0.0.1:${first.port}`);
      // Distinct ports are the whole reason for binding port 0: a fixed port
      // makes two CI jobs on one runner fight over the same socket, and the
      // loser fails with EADDRINUSE in a test that has nothing to do with ports.
      expect(second.port).not.toBe(first.port);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("stops listening on close, and closing twice is harmless", async () => {
    const server = await FakeInstanceServer.start();
    const url = tableUrl(server.baseUrl, "sys_script", {});
    expect((await fetchRaw(url, AUTH)).status).toBe(200);

    await server.close();
    // Idempotence matters because `close()` is called from `afterEach` and again
    // from a `finally` in tests that start their own server.
    await server.close();
    await expect(fetchRaw(url, AUTH)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("fake instance protocol", () => {
  let server: FakeInstanceServer;

  beforeAll(async () => {
    server = await FakeInstanceServer.start();
  });

  afterAll(async () => {
    // Every test in this block is a well-behaved client, so the recorded
    // violation list must still be empty at the end. The dedicated
    // ill-behaved-client cases run against their own server below.
    server.assertNoViolations();
    await server.close();
  });

  describe("authentication", () => {
    it("answers 401 with an envelope the real classifier reads as auth", async () => {
      const { status, json } = await fetchJson(tableUrl(server.baseUrl, "sys_script", {}));
      expect(status).toBe(401);
      expect(json).toEqual({
        error: { message: "User Not Authenticated", detail: "Required to provide Auth information" },
        status: "failure",
      });
      // The pin. If the 401 text drifts out of AUTH_MARKERS, the mirror would
      // classify a credential failure as `fatal` and abort the sweep with the
      // wrong reason — and the shape assertion above would not notice.
      expect(classifyError(status, json).classified).toBe("auth");
    });

    it("rejects a wrong password and accepts the right one", async () => {
      const wrong = await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), {
        auth: { username: DEFAULT_CREDENTIALS.username, password: "not-it" },
      });
      expect(wrong.status).toBe(401);
      expect((await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), AUTH)).status).toBe(200);
    });

    it("accepts a bearer token when one is configured", async () => {
      const bearer = await FakeInstanceServer.start({ bearerToken: "oauth-access-token" });
      try {
        const url = tableUrl(bearer.baseUrl, "sys_script", {});
        expect((await fetchRaw(url, { bearer: "oauth-access-token" })).status).toBe(200);
        expect((await fetchRaw(url, { bearer: "stale" })).status).toBe(401);
        // Basic still works alongside it: the mirror may be configured either
        // way, and an OAuth-enabled fake that broke Basic would force every
        // other test to know which one it got.
        expect((await fetchRaw(url, AUTH)).status).toBe(200);
      } finally {
        await bearer.close();
      }
    });

    it("serves anonymously when credentials are disabled", async () => {
      const open = await FakeInstanceServer.start({ credentials: null });
      try {
        expect((await fetchRaw(tableUrl(open.baseUrl, "sys_script", {}))).status).toBe(200);
      } finally {
        await open.close();
      }
    });
  });

  describe("keyset paging (§12: paging correctness)", () => {
    it("visits every row exactly once, in strictly increasing sys_id order", async () => {
      const expected = server.rowsOf("sys_dictionary");
      expect(expected.length).toBeGreaterThan(100);

      const rows = await sweep(server, "sys_dictionary", 25);
      const ids = rows.map((row) => row.sys_id as string);
      expect(ids).toHaveLength(expected.length);
      expect(new Set(ids).size).toBe(ids.length);
      // Strictly increasing is stronger than "sorted": it also rules out the
      // off-by-one where a page repeats its own last row as the next page's
      // first, which `>=` on the cursor would produce and a set comparison alone
      // would still catch — but only after the duplicate had already been
      // written to disk.
      expect(ids).toEqual([...ids].sort());
      for (let index = 1; index < ids.length; index += 1) {
        expect((ids[index] as string) > (ids[index - 1] as string)).toBe(true);
      }
      expect(new Set(ids)).toEqual(new Set(expected.map((row) => row.sys_id)));
    });

    it("issues no sysparm_offset while doing so", async () => {
      const pages = server.requests.filter((entry) => entry.route === "table-page");
      expect(pages.length).toBeGreaterThan(0);
      for (const entry of pages) {
        expect(entry.query).not.toHaveProperty("sysparm_offset");
      }
    });

    it("pages a table larger than the fanout threshold without materializing the corpus", async () => {
      // 24 000 rows at 1 000 a page is 24 requests, which is the point: this is
      // the only test that exercises the synthetic table's lazily materialized
      // key array through the HTTP surface rather than through TableState.
      const rows = await sweep(server, "x_syn_demo_bulk", 1_000, ["sys_id", "name"]);
      expect(rows).toHaveLength(24_000);
      const ids = rows.map((row) => row.sys_id as string);
      expect(new Set(ids).size).toBe(24_000);
      expect(ids).toEqual([...ids].sort());
      for (const id of ids.slice(0, 50)) expect(id).toMatch(SYS_ID_RE);
    });

    it("returns an empty result for an empty table without erroring", async () => {
      expect(await sweep(server, "x_syn_demo_empty", 10)).toEqual([]);
    });

    it("honours sysparm_limit and refuses a limit that is not a positive integer", async () => {
      const rows = await getRows(
        tableUrl(server.baseUrl, "sys_dictionary", { sysparm_query: "ORDERBYsys_id", sysparm_limit: 3 })
      );
      expect(rows).toHaveLength(3);

      for (const bad of ["0", "-5", "1.5", "many"]) {
        const { status, json } = await fetchJson(
          tableUrl(server.baseUrl, "sys_dictionary", { sysparm_limit: bad }),
          AUTH
        );
        expect({ bad, status }).toEqual({ bad, status: 400 });
        expect(classifyError(status, json).classified).toBe("fatal");
      }
    });

    it("emits pagination headers only when they are not suppressed", async () => {
      const suppressed = await fetchRaw(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: "ORDERBYsys_id",
          sysparm_suppress_pagination_header: "true",
        }),
        AUTH
      );
      expect(suppressed.headers["x-total-count"]).toBeUndefined();
      expect(suppressed.headers.link).toBeUndefined();

      // Making the parameter observable is the reason it is honoured at all: the
      // mirror always sends it, and a test can now prove that rather than trust it.
      const plain = await fetchRaw(
        tableUrl(server.baseUrl, "sys_script", { sysparm_query: "ORDERBYsys_id" }),
        AUTH
      );
      expect(plain.headers["x-total-count"]).toBe(String(server.rowsOf("sys_script").length));
      expect(plain.headers.link).toContain('rel="next"');
    });
  });

  describe("projection (M7, M8, M12, M17, F5)", () => {
    it("returns exactly the requested fields", async () => {
      const rows = await getRows(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: "ORDERBYsys_id",
          sysparm_fields: "sys_id,name",
          sysparm_exclude_reference_link: "true",
        })
      );
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(["name", "sys_id"]);
    });

    it("omits a field the row does not carry rather than returning it empty (F5)", async () => {
      const rows = await getRows(
        tableUrl(server.baseUrl, "sys_ui_action", {
          sysparm_query: "ORDERBYsys_id",
          sysparm_fields: "sys_id,name,hint",
        })
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toHaveProperty("name");
        // Omitted, not `""`. The distinction is the whole of F5: a mirror that
        // reads `row.hint ?? ""` cannot tell a column the ACL hides from a
        // column that is genuinely empty, and only the first is a data-loss bug.
        expect(row).not.toHaveProperty("hint");
      }
    });

    it("silently drops a condition naming an unknown column and matches every row (M12)", async () => {
      const before = server.requests.length;
      const rows = await getRows(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: "no_such_column=whatever^ORDERBYsys_id",
          sysparm_fields: "sys_id",
        })
      );
      // This is the trap M12 documents: a typo'd scope filter does not fail, it
      // mirrors the entire instance. The fake reproduces the silence on the wire
      // and reports the drop through the request log, where a test can see it
      // and the client under test cannot.
      expect(rows).toHaveLength(server.rowsOf("sys_script").length);
      const record = server.requests[before];
      expect(record?.droppedQueryFields).toEqual(["no_such_column"]);
    });

    it("shapes a reference field per sysparm_exclude_reference_link (M7)", async () => {
      const linked = await getRows(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: "ORDERBYsys_id",
          sysparm_fields: "sys_id,sys_scope",
          sysparm_limit: 1,
        })
      );
      const value = (linked[0] as WireRow).sys_scope as Exclude<WireValue, string>;
      expect(typeof value).toBe("object");
      expect(value.value).toMatch(SYS_ID_RE);
      expect(value.link).toContain("/api/now/table/sys_scope/");

      const plain = await getRows(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: "ORDERBYsys_id",
          sysparm_fields: "sys_id,sys_scope",
          sysparm_exclude_reference_link: "true",
          sysparm_limit: 1,
        })
      );
      // A string here and an object there, from the same row, off one parameter.
      // A serializer written against only one of the two shapes produces either
      // `[object Object]` or a silently absent scope.
      expect(typeof (plain[0] as WireRow).sys_scope).toBe("string");
      expect((plain[0] as WireRow).sys_scope).toBe(value.value);
    });

    it("expands every field into an object under sysparm_display_value=all (M17)", async () => {
      const rows = await getRows(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: "sys_scope=f558dac9e622ac23f4a7aa4c3be2cc46^ORDERBYsys_id",
          sysparm_fields: "sys_id,name,sys_scope",
          sysparm_display_value: "all",
          sysparm_limit: 1,
        })
      );
      const row = rows[0] as WireRow;
      const name = row.name as Exclude<WireValue, string>;
      expect(name).toEqual({ value: expect.any(String), display_value: expect.any(String) });
      const scope = row.sys_scope as Exclude<WireValue, string>;
      expect(scope.value).toBe("f558dac9e622ac23f4a7aa4c3be2cc46");
      // The display value of a reference is the referenced row's name — which is
      // exactly why the mirror sends `sysparm_display_value=false`: a mirror keyed
      // on display values would rename half its files when someone edits a label.
      expect(scope.display_value).toBe("Global");
      expect(scope.link).toContain("/api/now/table/sys_scope/f558dac9e622ac23f4a7aa4c3be2cc46");
    });

    it("substitutes display values under sysparm_display_value=true", async () => {
      const rows = await getRows(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: "sys_scope=f558dac9e622ac23f4a7aa4c3be2cc46^ORDERBYsys_id",
          sysparm_fields: "sys_id,sys_scope",
          sysparm_limit: 1,
        }) + "&sysparm_display_value=true"
      );
      expect((rows[0] as WireRow).sys_scope).toBe("Global");
    });

    it("returns every value as a string when the mirror's own parameters are used (M8)", async () => {
      const query = buildKeysetQuery("sys_properties", null, 50, { fields: ["name", "value", "type"] });
      const url = new URL(query.path, server.baseUrl);
      for (const [key, value] of Object.entries(query.params)) url.searchParams.set(key, value);
      const rows = await getRows(url.toString());
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["name", "sys_id", "type", "value"]);
        for (const value of Object.values(row)) expect(typeof value).toBe("string");
      }
    });
  });

  describe("single-record and error routes", () => {
    it("serves one record by sys_id", async () => {
      const first = server.rowsOf("sys_script")[0] as FixtureRow;
      const { status, json } = await fetchJson<TableApiResult<WireRow>>(
        `${server.baseUrl}/api/now/table/sys_script/${first.sys_id}?sysparm_exclude_reference_link=true`,
        AUTH
      );
      expect(status).toBe(200);
      expect(json.result.sys_id).toBe(first.sys_id);
      expect(json.result.name).toBe(first.name);
    });

    it("answers 404 with a null detail for a sys_id the table does not hold (M1)", async () => {
      const { status, json } = await fetchJson(
        `${server.baseUrl}/api/now/table/sys_script/00000000000000000000000000000000`,
        AUTH
      );
      expect(status).toBe(404);
      expect(json).toEqual({ error: { message: "No Record found", detail: null }, status: "failure" });
      // The tombstone probe reads exactly this: `not-found` means the record is
      // gone, which is a fact to record, not a failure to retry.
      expect(classifyError(status, json).classified).toBe("not-found");
    });

    it("answers 400, not 404, for a table that does not exist", async () => {
      const { status, json } = await fetchJson(tableUrl(server.baseUrl, "no_such_table", {}), AUTH);
      // A real instance answers 400 here. The difference matters: `not-found`
      // would tell the catalog the table was deleted, while `fatal` tells it the
      // request was wrong — and only one of those should stop a sweep.
      expect(status).toBe(400);
      expect(JSON.stringify(json)).toContain("no_such_table");
      expect(classifyError(status, json).classified).toBe("fatal");
    });

    it("answers 404 for a path that is not an API route", async () => {
      const { status, json } = await fetchJson(`${server.baseUrl}/api/now/nonsense/thing`, AUTH);
      expect(status).toBe(404);
      expect(classifyError(status, json).classified).toBe("not-found");
    });

    it("refuses query syntax it will not guess at", async () => {
      const refusals: Array<[string, string]> = [
        ["active=true^ORactive=false", "disjunctions"],
        ["active=true^NQname=x", "new-query"],
        ["!!!", "unparseable"],
        ["nameISEMPTYvalue", "takes no value"],
      ];
      for (const [query, fragment] of refusals) {
        const { status, json } = await fetchJson(
          tableUrl(server.baseUrl, "sys_script", { sysparm_query: query }),
          AUTH
        );
        // 400 rather than "ignore the part I did not understand": a fake that
        // quietly drops an unrecognised condition turns "the mirror sent a
        // malformed query" into "the mirror returned too many rows", and the
        // second symptom surfaces three work packages downstream.
        expect({ query, status }).toEqual({ query, status: 400 });
        expect(JSON.stringify(json)).toContain(fragment);
      }
    });

    it("evaluates the operators the planner actually emits", async () => {
      const rows = server.rowsOf("sys_script");
      const watermark = rows.map((row) => row.sys_updated_on as string).sort()[1] as string;
      const newer = await getRows(
        tableUrl(server.baseUrl, "sys_script", {
          sysparm_query: `sys_updated_on>=${watermark}^ORDERBYsys_id`,
          sysparm_fields: "sys_id,sys_updated_on",
        })
      );
      // `>=` must be tried before `>` when parsing, or this filter silently
      // becomes `sys_updated_on > "=2026-..."` and matches nothing — a watermark
      // sweep that returns an empty page looks exactly like a quiet instance.
      expect(newer.length).toBe(rows.filter((row) => (row.sys_updated_on as string) >= watermark).length);
      expect(newer.length).toBeGreaterThan(0);
      expect(newer.length).toBeLessThan(rows.length);
    });
  });

  describe("aggregate API (§5.10, M5)", () => {
    it("returns the row count as a string", async () => {
      const { status, json } = await fetchJson<TableApiResult<{ stats: { count: string } }>>(
        `${server.baseUrl}/api/now/stats/sys_dictionary?sysparm_count=true`,
        AUTH
      );
      expect(status).toBe(200);
      // M5: a string. A fake returning a number would let a consumer write
      // `stats.count + 1` and get 1201 on a real instance instead of 121.
      expect(typeof json.result.stats.count).toBe("string");
      expect(json.result.stats.count).toBe(String(server.rowsOf("sys_dictionary").length));
    });

    it("counts the synthetic table without paging it", async () => {
      const { json } = await fetchJson<TableApiResult<{ stats: { count: string } }>>(
        `${server.baseUrl}/api/now/stats/x_syn_demo_bulk?sysparm_count=true`,
        AUTH
      );
      expect(json.result.stats.count).toBe("24000");
    });

    it("returns max(sys_updated_on), which is the quiescence probe (D1)", async () => {
      const { json } = await fetchJson<TableApiResult<{ stats: { max: Record<string, string> } }>>(
        `${server.baseUrl}/api/now/stats/sys_script?sysparm_max_fields=sys_updated_on`,
        AUTH
      );
      const expected = server
        .rowsOf("sys_script")
        .map((row) => row.sys_updated_on as string)
        .sort()
        .pop();
      expect(json.result.stats.max.sys_updated_on).toBe(expected);
    });

    it("applies conditions to both count and max", async () => {
      const scope = "f558dac9e622ac23f4a7aa4c3be2cc46";
      const { json } = await fetchJson<TableApiResult<{ stats: { count: string; max: Record<string, string> } }>>(
        `${server.baseUrl}/api/now/stats/sys_script?sysparm_count=true&sysparm_max_fields=sys_updated_on` +
          `&sysparm_query=${encodeURIComponent(`sys_scope=${scope}`)}`,
        AUTH
      );
      const matching = server.rowsOf("sys_script").filter((row) => row.sys_scope === scope);
      expect(matching.length).toBeGreaterThan(0);
      expect(matching.length).toBeLessThan(server.rowsOf("sys_script").length);
      expect(json.result.stats.count).toBe(String(matching.length));
      expect(json.result.stats.max.sys_updated_on).toBe(
        matching.map((row) => row.sys_updated_on as string).sort().pop()
      );
    });

    it("answers an empty table with a zero count and an empty max", async () => {
      const { json } = await fetchJson<TableApiResult<{ stats: { count: string; max: Record<string, string> } }>>(
        `${server.baseUrl}/api/now/stats/x_syn_demo_empty?sysparm_count=true&sysparm_max_fields=sys_updated_on`,
        AUTH
      );
      expect(json.result.stats.count).toBe("0");
      // `""`, not null and not absent: the same M8 rule that governs row fields
      // governs aggregate results, and §5.10 needs "no watermark" to be
      // representable without a type change.
      expect(json.result.stats.max.sys_updated_on).toBe("");
    });

    it("refuses aggregates it does not implement rather than answering wrongly", async () => {
      for (const parameter of ["sysparm_min_fields=x", "sysparm_avg_fields=x", "sysparm_group_by=name"]) {
        const { status } = await fetchJson(`${server.baseUrl}/api/now/stats/sys_script?${parameter}`, AUTH);
        expect({ parameter, status }).toEqual({ parameter, status: 400 });
      }
      const { status } = await fetchJson(`${server.baseUrl}/api/now/stats/sys_script`, AUTH);
      expect(status).toBe(400);
    });
  });

  describe("attachment API", () => {
    it("lists attachment metadata", async () => {
      const { status, json } = await fetchJson<TableApiResult<WireRow[]>>(
        `${server.baseUrl}/api/now/attachment?sysparm_query=ORDERBYsys_id&sysparm_exclude_reference_link=true`,
        AUTH
      );
      expect(status).toBe(200);
      expect(json.result).toHaveLength(server.corpus.attachments.length);
      for (const row of json.result) {
        expect(row.sys_id).toMatch(SYS_ID_RE);
        expect(row).toHaveProperty("file_name");
        expect(row).toHaveProperty("size_bytes");
      }
    });

    it("serves one attachment's metadata and 404s an unknown one", async () => {
      const attachment = server.corpus.attachments[0];
      const { status, json } = await fetchJson<TableApiResult<WireRow>>(
        `${server.baseUrl}/api/now/attachment/${attachment?.sysId}`,
        AUTH
      );
      expect(status).toBe(200);
      expect(json.result.file_name).toBe(attachment?.fileName);

      const missing = await fetchJson(
        `${server.baseUrl}/api/now/attachment/ffffffffffffffffffffffffffffffff`,
        AUTH
      );
      expect(missing.status).toBe(404);
    });

    it("serves attachment bytes that hash to the committed digest", async () => {
      for (const attachment of server.corpus.attachments) {
        const response = await fetchRaw(
          `${server.baseUrl}/api/now/attachment/${attachment.sysId}/file`,
          AUTH
        );
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe(attachment.contentType);
        expect(response.headers["content-disposition"]).toContain(attachment.fileName);
        expect(response.body).toHaveLength(attachment.sizeBytes);
        // The digest, not just the length: §5.9 routes anything over
        // LFS_THRESHOLD_BYTES down a different path, and a truncated large
        // attachment would still look plausible on length alone.
        expect(createHash("sha256").update(response.body).digest("hex")).toBe(attachment.sha256);
        expect(
          response.body.equals(Buffer.from(synthesizeAttachmentBytes(attachment.contentSeed, attachment.sizeBytes)))
        ).toBe(true);
      }
    });

    it("404s the binary route for an unknown attachment", async () => {
      const { status, json } = await fetchJson(
        `${server.baseUrl}/api/now/attachment/ffffffffffffffffffffffffffffffff/file`,
        AUTH
      );
      expect(status).toBe(404);
      expect(classifyError(status, json).classified).toBe("not-found");
    });
  });

  describe("request log", () => {
    it("records route, table, status and row count for each request", async () => {
      const before = server.requests.length;
      await getRows(
        tableUrl(server.baseUrl, "sys_script", { sysparm_query: "ORDERBYsys_id", sysparm_limit: 2 })
      );
      const record = server.requests[before];
      expect(record).toMatchObject({
        method: "GET",
        path: "/api/now/table/sys_script",
        route: "table-page",
        table: "sys_script",
        status: 200,
        rowCount: 2,
      });
      expect(record?.query.sysparm_limit).toBe("2");
    });
  });
});

describe("fake instance refusals (INV-2, keyset-only)", () => {
  let server: FakeInstanceServer;

  beforeEach(async () => {
    // Its own server per test: these cases deliberately record violations, and a
    // shared server would leak them into the well-behaved suite's afterAll.
    server = await FakeInstanceServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("answers 405 to every non-GET verb and records the attempt (INV-2)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), {
        method,
        body: '{"name":"nope"}',
        headers: { "Content-Type": "application/json" },
        ...AUTH,
      });
      expect({ method, status: response.status }).toEqual({ method, status: 405 });
      expect(response.headers.allow).toBe("GET");
    }

    expect(server.violations.map((item) => item.method)).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
    expect(server.violations.every((item) => item.kind === "non-get-verb")).toBe(true);
    // The status alone is not enough. A client that ignores 405 and carries on
    // would still look green, so the violation is recorded and `assertNoViolations`
    // is what actually fails the test.
    expect(() => server.assertNoViolations()).toThrow(/non-get-verb/);
  });

  it("records the verb even when auth would have failed anyway", async () => {
    const response = await fetchRaw(tableUrl(server.baseUrl, "sys_script", {}), { method: "DELETE" });
    // The verb check runs before authentication on purpose: an unauthenticated
    // write attempt is still a write attempt, and answering 401 first would hide
    // it from INV-2's audit.
    expect(response.status).toBe(405);
    expect(server.violations).toHaveLength(1);
  });

  it("refuses sysparm_offset with 400 and records it, even at offset 0", async () => {
    for (const offset of ["0", "100"]) {
      const { status, json } = await fetchJson(
        tableUrl(server.baseUrl, "sys_script", { sysparm_query: "ORDERBYsys_id", sysparm_offset: offset }),
        AUTH
      );
      expect({ offset, status }).toEqual({ offset, status: 400 });
      expect(JSON.stringify(json)).toContain("sysparm_offset");
    }
    // Offset 0 is included because it is the one a "harmless" first page uses,
    // and accepting it would let offset paging into the codebase one page at a
    // time.
    expect(server.violations.map((item) => item.kind)).toEqual(["offset-pagination", "offset-pagination"]);
  });
});
