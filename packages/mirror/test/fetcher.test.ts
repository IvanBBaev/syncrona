// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `fetchSweep` — the sweep executor (§5.5, WP-M8).
 *
 * The suite is in two halves, for the same reason `httpClient.test.ts` is:
 *
 *  - **Seam tests** drive the fetcher through a scripted {@link FetcherPageSource}.
 *    That is what makes the whole of the analyses §2 taxonomy reachable as VALUES —
 *    a `local-io` throw out of the row sink, a page that refuses to advance its
 *    cursor, a 401 that succeeds on the refresh and a 401 that does not — none of
 *    which a cooperating HTTP server can be talked into producing on demand. No
 *    timer is involved anywhere: the fetcher never sleeps, and any test here that
 *    needed one would be testing the client's retry schedule, which is already
 *    tested where it lives.
 *  - **Integration tests** run the shipped `MirrorHttpClient` against
 *    `FakeInstanceServer`, with only the rate limiter's WAIT stubbed out. They exist
 *    because the seam tests agree with a fake about the keyset contract, and a fake
 *    that agreed with a bug would still be green: only a real keyset walk over a real
 *    corpus proves the cursor threading, the short-page terminator, the projection
 *    and D20's watermark condition are what the instance actually accepts.
 *    `assertNoViolations()` closes each of those tests, which is how INV-2 (GET only)
 *    and the offset-paging ban are asserted here rather than assumed.
 *
 * Each failure test names the taxonomy row it pins. The mapping is not decoration —
 * F1 and F4 differ only in whether the sweep continues, F3 and F5 differ only in
 * which coverage reason lands, and a test that did not say which row it was defending
 * could be "fixed" by making the fetcher agree with itself instead of with §2.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  FieldDescriptor,
  PlannedTable,
  TableCatalogEntry,
  TablePage,
} from "../src/contracts";
import { MirrorHttpClient, MirrorHttpError, type PageRequest } from "../src/http/client";
import {
  fetchSweep,
  type FetchProgress,
  type FetcherPageSource,
  type SweepFetchResult,
} from "../src/sync/fetcher";
import {
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  loadCommittedCorpus,
  wireColumnsByTable,
  type FixtureColumn,
  type FixtureCorpus,
} from "./fakeInstance";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A sys_id from a small integer, so the fixtures sort the way they read. */
const sysId = (index: number): string => index.toString(16).padStart(32, "0");

const field = (element: string, overrides: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  element,
  internalType: "string",
  extractAs: null,
  isJsonBlob: false,
  isNoise: false,
  isDenied: false,
  reference: null,
  maxLength: 40,
  ...overrides,
});

/** The three columns every fixture table carries unless a test says otherwise. */
const defaultFields = (): FieldDescriptor[] => [
  field("sys_id", { internalType: "GUID", maxLength: 32 }),
  field("name"),
  field("sys_updated_on", { internalType: "glide_date_time", isNoise: true }),
];

const catalogEntry = (
  name: string,
  overrides: Partial<TableCatalogEntry> = {}
): TableCatalogEntry => ({
  name,
  sysId: sysId(0xfff),
  superClass: null,
  isMetadata: true,
  tier: 1,
  rowCount: null,
  maxUpdatedOn: null,
  fields: defaultFields(),
  status: "included",
  ...overrides,
});

const sweep = (name: string, overrides: Partial<TableCatalogEntry> = {}): PlannedTable => ({
  entry: catalogEntry(name, overrides),
  strategy: "sweep",
});

const watermarked = (
  name: string,
  watermark: string,
  overrides: Partial<TableCatalogEntry> = {}
): PlannedTable => ({
  entry: catalogEntry(name, overrides),
  strategy: "watermark",
  watermark,
});

const wireRow = (index: number): Record<string, string> => ({
  sys_id: sysId(index),
  name: `row-${String(index)}`,
  sys_updated_on: "2026-01-15 08:00:00",
});

// ---------------------------------------------------------------------------
// Scripted page source
// ---------------------------------------------------------------------------

/** One scripted answer: either a page, or the thing `getPage` throws instead. */
interface PageScript {
  rows?: Array<Record<string, string>>;
  /** Defaults to true — a scripted page is the last one unless a test says so. */
  done?: boolean;
  /** Overrides the cursor the page reports; defaults to the last row's sys_id. */
  lastSysId?: string | null;
  error?: unknown;
}

interface RecordedCall {
  table: string;
  cursor: string | null;
  request: PageRequest;
}

/**
 * A page source that answers from a per-table script.
 *
 * Deliberately dumb: it does not model a table, it replays answers. Modelling would
 * make the fake agree with the fetcher's idea of a keyset walk, and the point of the
 * seam tests is to assert what the fetcher DOES with an answer, including answers a
 * correct instance would never give.
 */
class ScriptedSource implements FetcherPageSource {
  readonly calls: RecordedCall[] = [];
  readonly #scripts: Map<string, PageScript[]>;

  constructor(scripts: Record<string, PageScript[]>) {
    this.#scripts = new Map(Object.entries(scripts).map(([table, steps]) => [table, [...steps]]));
  }

  getPage(table: string, cursor: string | null, request: PageRequest): Promise<TablePage> {
    this.calls.push({ table, cursor, request });
    const queue = this.#scripts.get(table);
    const step = queue === undefined ? undefined : queue.shift();
    if (step === undefined) {
      return Promise.reject(new Error(`ScriptedSource: no answer left for table ${table}`));
    }
    if (step.error !== undefined) {
      return Promise.reject(step.error);
    }
    const rows = step.rows ?? [];
    const fallback = rows.length === 0 ? null : rows[rows.length - 1].sys_id;
    return Promise.resolve({
      rows,
      lastSysId: step.lastSysId === undefined ? fallback : step.lastSysId,
      done: step.done ?? true,
    });
  }
}

/** The sink every test uses when it only cares that rows arrived. */
const collector = (
  into: Array<{ table: string; sysId: string }>
): ((row: Record<string, string>, table: string) => void) => {
  return (row, table) => {
    into.push({ table, sysId: row.sys_id });
  };
};

const outcomeFor = (result: SweepFetchResult, table: string): SweepFetchResult["tables"][number] => {
  const found = result.tables.find((outcome) => outcome.table === table);
  if (found === undefined) {
    throw new Error(`no outcome recorded for ${table}`);
  }
  return found;
};

// ---------------------------------------------------------------------------
// Structure — the properties that are cheaper to keep than to recover
// ---------------------------------------------------------------------------

describe("fetcher structure", () => {
  it("imports no filesystem module, so the fetcher cannot touch disk", () => {
    // §5.5 says "the Fetcher never touches the filesystem" and the docblock repeats
    // it. A claim in a comment is only as good as the thing that notices when it
    // stops being true; grepping the source is that thing. `node:fs/promises` and a
    // relative import of `write/fs` would both be equally fatal to the property, so
    // all three shapes are refused. The check is on THIS file's own imports, which is
    // the right granularity: the planner reaches `write/fs` for its shard reader, and
    // what must stay true here is that no code in this module can name a filesystem
    // function, not that no module it imports ever did.
    const source = readFileSync(join(__dirname, "..", "src", "sync", "fetcher.ts"), "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");
    expect(imports).not.toMatch(/node:fs/);
    expect(imports).not.toMatch(/node:path/);
    expect(imports).not.toMatch(/write\/fs/);
  });
});

// ---------------------------------------------------------------------------
// The happy path — ordering, cursor threading, projection, progress
// ---------------------------------------------------------------------------

describe("fetchSweep", () => {
  it("reads planned tables sequentially, in plan order", async () => {
    // Table-level concurrency is 1 (§5.5). Interleaved calls would make
    // `notAttempted` a guess, because more than one table would be in flight when a
    // fatal arrives.
    const source = new ScriptedSource({
      alpha: [{ rows: [wireRow(1)] }],
      beta: [{ rows: [wireRow(2)] }],
      gamma: [{ rows: [wireRow(3)] }],
    });
    const seen: Array<{ table: string; sysId: string }> = [];

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta"), sweep("gamma")],
      onRow: collector(seen),
    });

    expect(source.calls.map((call) => call.table)).toEqual(["alpha", "beta", "gamma"]);
    expect(seen.map((entry) => entry.table)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.tables.map((outcome) => outcome.table)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.fatal).toBeNull();
    expect(result.notAttempted).toEqual([]);
  });

  it("threads the cursor across pages and stops on the short page", async () => {
    const source = new ScriptedSource({
      alpha: [
        { rows: [wireRow(1), wireRow(2)], done: false },
        { rows: [wireRow(3), wireRow(4)], done: false },
        { rows: [wireRow(5)], done: true },
      ],
    });
    const seen: Array<{ table: string; sysId: string }> = [];

    const result = await fetchSweep({ client: source, plan: [sweep("alpha")], onRow: collector(seen) });

    expect(source.calls.map((call) => call.cursor)).toEqual([null, sysId(2), sysId(4)]);
    expect(seen.map((entry) => entry.sysId)).toEqual([1, 2, 3, 4, 5].map(sysId));
    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "complete",
      rowsFetched: 5,
      pages: 3,
      lastSysId: sysId(5),
      missingColumns: [],
    });
    expect(outcomeFor(result, "alpha").reason).toBeUndefined();
  });

  it("reports progress after every page, never before the rows are handed over", async () => {
    // The checkpoint claims "everything up to and including this sys_id is dealt
    // with" (§4.7). Reporting before the sink ran would let a crash between the two
    // resume past a page that was never written — the exact hole F8 exists to close.
    const source = new ScriptedSource({
      alpha: [
        { rows: [wireRow(1), wireRow(2)], done: false },
        { rows: [wireRow(3)], done: true },
      ],
    });
    const events: string[] = [];
    const progress: FetchProgress[] = [];

    await fetchSweep({
      client: source,
      plan: [sweep("alpha")],
      onRow: (row) => {
        events.push(`row:${row.sys_id}`);
      },
      onProgress: (update) => {
        progress.push(update);
        events.push(`progress:${update.lastSysId}`);
      },
    });

    expect(progress).toEqual([
      { table: "alpha", lastSysId: sysId(2), rowsFetched: 2, pages: 1 },
      { table: "alpha", lastSysId: sysId(3), rowsFetched: 3, pages: 2 },
    ]);
    expect(events).toEqual([
      `row:${sysId(1)}`,
      `row:${sysId(2)}`,
      `progress:${sysId(2)}`,
      `row:${sysId(3)}`,
      `progress:${sysId(3)}`,
    ]);
  });

  it("awaits the row sink before requesting the next page", async () => {
    // Back-pressure, and the reason the sink is a callback rather than a queue: a
    // slow disk must throttle the instance instead of accumulating pages in memory.
    const source = new ScriptedSource({
      alpha: [
        { rows: [wireRow(1)], done: false },
        { rows: [wireRow(2)], done: true },
      ],
    });
    const events: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;

    const sweeping = fetchSweep({
      client: source,
      plan: [sweep("alpha")],
      onRow: async (row) => {
        events.push(`start:${row.sys_id}`);
        if (gated) {
          gated = false;
          await gate;
        }
        events.push(`end:${row.sys_id}`);
      },
    });

    await Promise.resolve();
    expect(source.calls).toHaveLength(1);
    release();
    await sweeping;

    expect(events).toEqual([
      `start:${sysId(1)}`,
      `end:${sysId(1)}`,
      `start:${sysId(2)}`,
      `end:${sysId(2)}`,
    ]);
    expect(source.calls).toHaveLength(2);
  });

  it("emits no progress and completes when a table is empty", async () => {
    const source = new ScriptedSource({ alpha: [{ rows: [] }] });
    const progress: FetchProgress[] = [];

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha", { rowCount: 0 })],
      onRow: () => undefined,
      onProgress: (update) => {
        progress.push(update);
      },
    });

    expect(progress).toEqual([]);
    // An empty table must not report its whole projection as drifted; see
    // `missingColumnsOf`.
    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "complete",
      rowsFetched: 0,
      lastSysId: null,
      missingColumns: [],
    });
  });

  it("resumes a table from the supplied cursor and ignores unrelated entries", async () => {
    const source = new ScriptedSource({
      alpha: [{ rows: [wireRow(9)] }],
      beta: [{ rows: [wireRow(1)] }],
    });

    await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta")],
      onRow: () => undefined,
      resumeCursors: { alpha: sysId(8), zeta: sysId(4) },
    });

    expect(source.calls.map((call) => call.cursor)).toEqual([sysId(8), null]);
  });
});

// ---------------------------------------------------------------------------
// Projection and the watermark condition (§5.4, D19, D20)
// ---------------------------------------------------------------------------

describe("fetchSweep projection", () => {
  it("requests sys_id and every catalog column, sorted, minus denied types", async () => {
    // D19: `password2` arrives as ciphertext. The cheapest guarantee that it never
    // reaches a buffer or a heap dump is not to ask for it — the redactor's refusal
    // downstream is the second door, not the first.
    const source = new ScriptedSource({ alpha: [{ rows: [wireRow(1)] }] });

    await fetchSweep({
      client: source,
      plan: [
        sweep("alpha", {
          fields: [
            field("name"),
            field("secret", { internalType: "password2", isDenied: true }),
            field("sys_updated_by", { isNoise: true }),
            field("active", { internalType: "boolean" }),
          ],
        }),
      ],
      onRow: () => undefined,
    });

    // Noise columns stay in: `RecordEntry` carries sys_updated_by and the planner
    // reads sys_updated_on off the wire row for the next run's watermark.
    expect(source.calls[0].request.fields).toEqual(["active", "name", "sys_id", "sys_updated_by"]);
    expect(source.calls[0].request.extraQuery).toBeUndefined();
  });

  it("ANDs the planner's watermark clause into the request", async () => {
    // The clause is `plannedQueryFor`'s, verbatim — including its conversion of the
    // plan's ISO-8601 bound into the `glide_date_time` form an encoded query needs.
    // A local builder here would have concatenated the ISO string instead, which
    // ServiceNow does not read as a datetime: the condition would match the wrong
    // set of rows and the run would still report itself as a clean incremental.
    const source = new ScriptedSource({ alpha: [{ rows: [wireRow(1)] }] });

    await fetchSweep({
      client: source,
      plan: [watermarked("alpha", "2026-01-15T08:00:00.000Z")],
      onRow: () => undefined,
    });

    expect(source.calls[0].request.extraQuery).toBe("sys_updated_on>=2026-01-15 08:00:00");
  });

  it.each([
    [
      "a sweep that carries a watermark",
      { ...sweep("alpha"), watermark: "2026-01-15 08:00:00" } as PlannedTable,
      /planned as a full sweep but carries a watermark bound/,
    ],
    [
      "a watermark read with no bound",
      { entry: catalogEntry("alpha"), strategy: "watermark" } as PlannedTable,
      /carries no watermark/,
    ],
    [
      "a bound that is not a timestamp",
      watermarked("alpha", "2026-01-15 08:00:00^ORsys_id!=x"),
      /is not a fixed-width instant/,
    ],
    [
      "a table whose catalog has no sys_updated_on",
      watermarked("alpha", "2026-01-15T08:00:00Z", { fields: [field("name")] }),
      /is not in the catalog for alpha/,
    ],
  ])("refuses to start on %s, before any request is issued", async (_label, planned, message) => {
    // D20: "a planner-generated query with an uncataloged field is a hard internal
    // error, never sent". Validating the whole plan up front is what makes "never
    // sent" true for tables after the first one as well — a per-request check would
    // already have swept everything ahead of the broken entry. The last three cases
    // are the planner's own refusals; they are asserted from here because "never
    // sent" is a property of this module's call order, not of the validator.
    const source = new ScriptedSource({ alpha: [{ rows: [wireRow(1)] }] });

    await expect(
      fetchSweep({ client: source, plan: [planned], onRow: () => undefined })
    ).rejects.toThrow(message);
    expect(source.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The taxonomy — analyses §2
// ---------------------------------------------------------------------------

describe("fetchSweep failure taxonomy", () => {
  it("F1: an exhausted transient budget fails that table and the sweep continues", async () => {
    // The client has already spent four attempts by the time it throws `transient`;
    // retrying here would make it sixteen. Exit 2 in §2, not 1 — so `beta` is still
    // read and `fatal` stays null.
    const source = new ScriptedSource({
      alpha: [
        { rows: [wireRow(1)], done: false },
        { error: new MirrorHttpError("transient", "503 after 4 attempts", { httpStatus: 503 }) },
      ],
      beta: [{ rows: [wireRow(7)] }],
    });
    const seen: Array<{ table: string; sysId: string }> = [];

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta")],
      onRow: collector(seen),
    });

    expect(source.calls).toHaveLength(3);
    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "failed",
      reason: "transient-exhausted",
      failureClass: "transient",
      rowsFetched: 1,
      // The cursor the table reached, so a resume does not restart it from row one.
      lastSysId: sysId(1),
      detail: "503 after 4 attempts",
    });
    expect(outcomeFor(result, "beta").status).toBe("complete");
    expect(result.fatal).toBeNull();
    expect(result.notAttempted).toEqual([]);
  });

  it("F2: one credential refresh, then the same page is retried once", async () => {
    const source = new ScriptedSource({
      alpha: [
        { error: new MirrorHttpError("auth", "401 Unauthorized", { httpStatus: 401 }) },
        { rows: [wireRow(1)] },
      ],
    });
    const refreshAuth = jest.fn(() => Promise.resolve(true));

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha")],
      onRow: () => undefined,
      refreshAuth,
    });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    // Same cursor both times: a refresh is a different remedy, not a second attempt
    // at the failed one, so the walk must not skip the page it did not get.
    expect(source.calls.map((call) => call.cursor)).toEqual([null, null]);
    expect(outcomeFor(result, "alpha").status).toBe("complete");
    expect(result.fatal).toBeNull();
  });

  it("F2: a second auth failure is fatal for the whole run", async () => {
    const source = new ScriptedSource({
      alpha: [
        { error: new MirrorHttpError("auth", "401 Unauthorized", { httpStatus: 401 }) },
        { error: new MirrorHttpError("auth", "401 Unauthorized again", { httpStatus: 401 }) },
      ],
      beta: [{ rows: [wireRow(7)] }],
    });
    const refreshAuth = jest.fn(() => Promise.resolve(true));

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta")],
      onRow: () => undefined,
      refreshAuth,
    });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    // §2 gives F2 no coverage entry: it is a failure of the run, not a degradation
    // of a table's coverage. The table is accounted for by `fatal.table`.
    expect(result.tables).toEqual([]);
    expect(result.fatal).toEqual({
      table: "alpha",
      failureClass: "auth",
      diagnosis: "auth failed",
      message: "401 Unauthorized again",
    });
    expect(result.notAttempted).toEqual(["beta"]);
  });

  it("F2: the refresh budget is one per RUN, not one per table", async () => {
    // A revoked credential against a 400-table plan must not produce 400 refresh
    // attempts; the first 401 after a failed refresh has already proved the point.
    const authError = (): MirrorHttpError => new MirrorHttpError("auth", "401", { httpStatus: 401 });
    const source = new ScriptedSource({
      alpha: [{ error: authError() }, { error: authError() }],
      beta: [{ error: authError() }],
    });
    const refreshAuth = jest.fn(() => Promise.resolve(true));

    // `alpha` burns the budget and stops the run, so `beta` is never reached; the
    // assertion that matters is that the second 401 on `alpha` did not buy a refresh.
    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta")],
      onRow: () => undefined,
      refreshAuth,
    });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(source.calls.map((call) => call.table)).toEqual(["alpha", "alpha"]);
    expect(result.notAttempted).toEqual(["beta"]);
  });

  it("F2: with no refresh hook a 401 is immediately fatal", async () => {
    // Basic auth has nothing to refresh, and INV-2 forbids this package performing
    // the OAuth token exchange itself. Pretending to retry would be theatre.
    const source = new ScriptedSource({
      alpha: [{ error: new MirrorHttpError("auth", "401 Unauthorized", { httpStatus: 401 }) }],
    });

    const result = await fetchSweep({ client: source, plan: [sweep("alpha")], onRow: () => undefined });

    expect(source.calls).toHaveLength(1);
    expect(result.fatal?.failureClass).toBe("auth");
  });

  it("F2: a refresh that reports failure does not buy another request", async () => {
    const source = new ScriptedSource({
      alpha: [{ error: new MirrorHttpError("auth", "401 Unauthorized", { httpStatus: 401 }) }],
    });
    const refreshAuth = jest.fn(() => Promise.resolve(false));

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha")],
      onRow: () => undefined,
      refreshAuth,
    });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(source.calls).toHaveLength(1);
    expect(result.fatal?.diagnosis).toBe("auth failed");
  });

  it("F3: a 403 marks the table partial and the sweep continues", async () => {
    const source = new ScriptedSource({
      alpha: [{ error: new MirrorHttpError("acl", "403 Forbidden", { httpStatus: 403 }) }],
      beta: [{ rows: [wireRow(7)] }],
    });

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta")],
      onRow: () => undefined,
    });

    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "partial",
      reason: "acl-403",
      failureClass: "acl",
      rowsFetched: 0,
      lastSysId: null,
    });
    expect(outcomeFor(result, "beta").status).toBe("complete");
    expect(result.fatal).toBeNull();
  });

  it("F3: a full sweep that returns fewer rows than the count is partial/not-visible", async () => {
    // §2's second F3 detector — "row-count mismatch vs Aggregate count". A row
    // filtered out by a read ACL produces no 403 at all; without this the mirror
    // would report a silently truncated table as complete, which is R3's exact
    // prohibition.
    const source = new ScriptedSource({ alpha: [{ rows: [wireRow(1), wireRow(2)] }] });

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha", { rowCount: 5 })],
      onRow: () => undefined,
    });

    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "partial",
      reason: "not-visible",
      failureClass: "acl",
      expectedRows: 5,
      rowsFetched: 2,
    });
  });

  it("F3: a watermark read is never partial for returning fewer rows than the table holds", async () => {
    // An incremental read is SUPPOSED to return a fraction of the table. Applying
    // the shortfall detector here would mark every incremental run partial and make
    // exit code 2 meaningless.
    const source = new ScriptedSource({ alpha: [{ rows: [wireRow(1)] }] });

    const result = await fetchSweep({
      client: source,
      plan: [watermarked("alpha", "2026-01-15T08:00:00.000Z", { rowCount: 5000 })],
      onRow: () => undefined,
    });

    expect(outcomeFor(result, "alpha").status).toBe("complete");
  });

  it.each([
    ["unreachable" as const, "instance unreachable"],
    ["hibernating" as const, "instance hibernating (wake it at developer.servicenow.com)"],
  ])(
    "F4: %s checkpoints, stops the run, and keeps its own D4 diagnosis",
    async (failureClass, diagnosis) => {
      // D4: three reachability failures, three remedies, three sentences. Collapsing
      // them into one "could not reach the instance" sends the user to debug the
      // wrong thing — and `auth` above proves the third sentence is distinct too.
      const source = new ScriptedSource({
        alpha: [
          { rows: [wireRow(1), wireRow(2)], done: false },
          { error: new MirrorHttpError(failureClass, `${failureClass} detail`) },
        ],
        beta: [{ rows: [wireRow(7)] }],
      });

      const result = await fetchSweep({
        client: source,
        plan: [sweep("alpha"), sweep("beta"), sweep("gamma")],
        onRow: () => undefined,
      });

      expect(outcomeFor(result, "alpha")).toMatchObject({
        status: "failed",
        reason: "instance-unreachable",
        failureClass,
        // The checkpoint half of "checkpoint and stop": the resume point survives.
        lastSysId: sysId(2),
        rowsFetched: 2,
      });
      expect(result.fatal).toEqual({
        table: "alpha",
        failureClass,
        diagnosis,
        message: `${failureClass} detail`,
      });
      expect(result.notAttempted).toEqual(["beta", "gamma"]);
      // Stopped, not merely marked: `beta` was never requested.
      expect(source.calls.map((call) => call.table)).toEqual(["alpha", "alpha"]);
    }
  );

  it("F5: a column no row carries is recorded, and the table still finishes", async () => {
    // "omit the file, keep the record" (§2 F5). The table is partial, not failed —
    // one vanished column must not cost the mirror the other 40 000 rows.
    const source = new ScriptedSource({
      alpha: [
        { rows: [{ sys_id: sysId(1), name: "one" }], done: false },
        { rows: [{ sys_id: sysId(2), name: "two", sys_updated_on: "" }], done: true },
      ],
    });

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha", { fields: [...defaultFields(), field("hint")] })],
      onRow: () => undefined,
    });

    // `sys_updated_on` arrived empty on the second page, and M8 says an empty value
    // is still a key — so it is present, and only the genuinely absent column counts.
    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "partial",
      reason: "column-missing",
      failureClass: "schema-drift",
      missingColumns: ["hint"],
      rowsFetched: 2,
    });
  });

  it("F5: a schema-drift throw marks the table partial and the sweep continues", async () => {
    const source = new ScriptedSource({
      alpha: [
        {
          error: new MirrorHttpError("schema-drift", "No such column hint on table alpha", {
            httpStatus: 400,
          }),
        },
      ],
      beta: [{ rows: [wireRow(7)] }],
    });

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta")],
      onRow: () => undefined,
    });

    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "partial",
      reason: "column-missing",
    });
    expect(outcomeFor(result, "beta").status).toBe("complete");
    expect(result.fatal).toBeNull();
  });

  it("ranks a row shortfall above a missing column", async () => {
    // `TableCoverage` has room for one reason, and a row nobody saw is a strictly
    // larger hole than a field nobody saw.
    const source = new ScriptedSource({ alpha: [{ rows: [{ sys_id: sysId(1) }] }] });

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha", { rowCount: 9 })],
      onRow: () => undefined,
    });

    const outcome = outcomeFor(result, "alpha");
    expect(outcome.reason).toBe("not-visible");
    // Still reported, so the run report can say both things even though the coverage
    // entry can only carry one.
    expect(outcome.missingColumns).toEqual(["name", "sys_updated_on"]);
  });

  it("F8: a throw out of the row sink is local-io and stops the run", async () => {
    // In production this is the writer: a full disk, a held git lock. Continuing to
    // fetch against a disk that cannot be written to would produce coverage claims
    // for rows that never landed.
    const source = new ScriptedSource({
      alpha: [{ rows: [wireRow(1), wireRow(2)] }],
      beta: [{ rows: [wireRow(7)] }],
    });

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha"), sweep("beta")],
      onRow: (row) => {
        if (row.sys_id === sysId(2)) {
          throw new Error("ENOSPC: no space left on device");
        }
      },
    });

    expect(result.tables).toEqual([]);
    expect(result.fatal).toEqual({
      table: "alpha",
      failureClass: "local-io",
      diagnosis: "sweep stopped (local-io)",
      message: "ENOSPC: no space left on device",
    });
    expect(result.notAttempted).toEqual(["beta"]);
  });

  it("F8: a non-Error thrown by the progress reporter is still classified", async () => {
    // The checkpoint writer is the other disk-touching callback, and a rejection
    // that is not an `Error` must not become an unclassified crash.
    const source = new ScriptedSource({ alpha: [{ rows: [wireRow(1)] }] });

    const result = await fetchSweep({
      client: source,
      plan: [sweep("alpha")],
      onRow: () => undefined,
      onProgress: () => Promise.reject("checkpoint rename failed"),
    });

    expect(result.fatal).toEqual({
      table: "alpha",
      failureClass: "local-io",
      diagnosis: "sweep stopped (local-io)",
      message: "checkpoint rename failed",
    });
  });

  it.each([
    ["a repeated final row", sysId(2)],
    ["a page with no rows at all", null],
  ])("refuses a non-final page that does not advance the cursor (%s)", async (_label, lastSysId) => {
    // `getPage` already refuses a last row whose sys_id is not a sys_id, for the same
    // reason. This is the other half: without it a broken `>` operator or a pageSize
    // of zero turns into an infinite loop that re-emits the same rows into the
    // writer forever, which no timeout would ever surface as a diagnosis.
    const source = new ScriptedSource({
      alpha: [
        { rows: [wireRow(1), wireRow(2)], done: false },
        { rows: lastSysId === null ? [] : [wireRow(2)], done: false, lastSysId },
      ],
    });

    const result = await fetchSweep({ client: source, plan: [sweep("alpha")], onRow: () => undefined });

    expect(outcomeFor(result, "alpha")).toMatchObject({
      status: "partial",
      reason: "column-missing",
      failureClass: "schema-drift",
    });
    expect(outcomeFor(result, "alpha").detail).toMatch(/does not advance the keyset cursor/);
    expect(source.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integration — the shipped client against the fake instance
// ---------------------------------------------------------------------------

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

/**
 * A real client pointed at a fake instance.
 *
 * Only the rate limiter's WAIT is stubbed. The limiter, the retry schedule and the
 * whole request-building path are the shipped ones; what the injected `sleep`
 * removes is the quarter second per request that would otherwise make this file
 * spend a minute proving something unrelated to timing.
 */
const clientFor = (server: FakeInstanceServer, pageSize: number): MirrorHttpClient =>
  new MirrorHttpClient({
    instance: server.baseUrl,
    headers: { Authorization: basicAuth() },
    pageSize,
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0.5,
  });

/** A catalog entry whose fields are exactly what the corpus puts on the wire. */
const entryFromCorpus = (
  corpus: FixtureCorpus,
  name: string,
  extraColumns: readonly FixtureColumn[] = []
): TableCatalogEntry => {
  const columns = wireColumnsByTable(corpus).get(name);
  if (columns === undefined) {
    throw new Error(`corpus has no table ${name}`);
  }
  return catalogEntry(name, {
    fields: [...columns, ...extraColumns].map((column) =>
      field(column.element, {
        internalType: column.internalType,
        maxLength: column.maxLength,
        reference: column.reference,
        isDenied: column.internalType === "password" || column.internalType === "password2",
      })
    ),
  });
};

describe("fetchSweep against the fake instance", () => {
  const corpus = loadCommittedCorpus();
  let server: FakeInstanceServer;

  beforeAll(async () => {
    server = await FakeInstanceServer.start({ corpus });
  });

  afterAll(async () => {
    await server.close();
  });

  it("walks a real table by keyset across many pages and reads every row once", async () => {
    const table = "sys_script";
    const expected = server.rowsOf(table).map((row) => row.sys_id);
    expect(expected.length).toBeGreaterThan(2);

    const seen: Array<{ table: string; sysId: string }> = [];
    const progress: FetchProgress[] = [];
    const result = await fetchSweep({
      client: clientFor(server, 2),
      plan: [
        {
          entry: { ...entryFromCorpus(corpus, table), rowCount: expected.length },
          strategy: "sweep",
        },
      ],
      onRow: collector(seen),
      onProgress: (update) => {
        progress.push(update);
      },
    });

    expect(seen.map((entry) => entry.sysId)).toEqual([...expected].sort());
    expect(outcomeFor(result, table)).toMatchObject({
      status: "complete",
      rowsFetched: expected.length,
      expectedRows: expected.length,
    });
    expect(progress[progress.length - 1].lastSysId).toBe([...expected].sort()[expected.length - 1]);
    // GET only (INV-2) and no `sysparm_offset` — both are recorded as violations.
    server.assertNoViolations();
  });

  it("F5: the corpus's phantom column comes back as column-missing", async () => {
    // `sys_ui_action.hint` is declared in the fixture dictionary and never delivered,
    // which is exactly what a column-level ACL or a dropped physical column looks
    // like from the outside.
    const table = "sys_ui_action";
    const phantom: FixtureColumn = {
      element: "hint",
      internalType: "string",
      maxLength: 40,
      reference: null,
      phantom: true,
    };

    const result = await fetchSweep({
      client: clientFor(server, 100),
      plan: [{ entry: entryFromCorpus(corpus, table, [phantom]), strategy: "sweep" }],
      onRow: () => undefined,
    });

    expect(outcomeFor(result, table)).toMatchObject({
      status: "partial",
      reason: "column-missing",
      missingColumns: ["hint"],
    });
    expect(outcomeFor(result, table).rowsFetched).toBeGreaterThan(0);
    server.assertNoViolations();
  });

  it("applies the watermark bound to the instance's own query engine", async () => {
    const table = "sys_script";
    const rows = server.rowsOf(table);
    const bound = [...rows]
      .map((row) => row.sys_updated_on)
      .sort()
      .slice(-2)[0];
    const expected = rows.filter((row) => row.sys_updated_on >= bound).length;
    expect(expected).toBeLessThan(rows.length);

    const seen: Array<{ table: string; sysId: string }> = [];
    await fetchSweep({
      client: clientFor(server, 2),
      plan: [{ entry: entryFromCorpus(corpus, table), strategy: "watermark", watermark: bound }],
      onRow: collector(seen),
    });

    expect(seen).toHaveLength(expected);
    server.assertNoViolations();
  });

  it("resumes mid-table from a cursor and re-reads nothing before it", async () => {
    const table = "sys_script";
    const all = server.rowsOf(table).map((row) => row.sys_id).sort();
    const resumeAfter = all[1];

    const seen: Array<{ table: string; sysId: string }> = [];
    await fetchSweep({
      client: clientFor(server, 2),
      plan: [{ entry: entryFromCorpus(corpus, table), strategy: "sweep" }],
      onRow: collector(seen),
      resumeCursors: { [table]: resumeAfter },
    });

    expect(seen.map((entry) => entry.sysId)).toEqual(all.slice(2));
    server.assertNoViolations();
  });
});

describe("fetchSweep fault injection", () => {
  const corpus = loadCommittedCorpus();

  it("F1: a 5xx burst inside the client's budget is invisible to the sweep", async () => {
    // The retry belongs to the client. What this asserts is the fetcher's half — that
    // a recovered transient produces no coverage entry at all, because nothing was
    // actually degraded.
    const server = await FakeInstanceServer.start({
      corpus,
      faults: [{ route: "table-page", table: "sys_script", skip: 1, times: 2, status: 503 }],
    });
    try {
      const result = await fetchSweep({
        client: clientFor(server, 2),
        plan: [{ entry: entryFromCorpus(corpus, "sys_script"), strategy: "sweep" }],
        onRow: () => undefined,
      });

      expect(outcomeFor(result, "sys_script").status).toBe("complete");
      expect(result.fatal).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("F1: a 429 burst that outlasts the budget fails that table only", async () => {
    // D6: a real PDI's 429 carries no `Retry-After`, so the headerless rule is the
    // realistic one. Six failures against a four-attempt budget exhausts it.
    const server = await FakeInstanceServer.start({
      corpus,
      faults: [{ route: "table-page", table: "sys_script", times: 6, status: 429 }],
    });
    try {
      const result = await fetchSweep({
        client: clientFor(server, 2),
        plan: [
          { entry: entryFromCorpus(corpus, "sys_script"), strategy: "sweep" },
          { entry: entryFromCorpus(corpus, "sys_ui_action"), strategy: "sweep" },
        ],
        onRow: () => undefined,
      });

      expect(outcomeFor(result, "sys_script")).toMatchObject({
        status: "failed",
        reason: "transient-exhausted",
        failureClass: "transient",
      });
      expect(outcomeFor(result, "sys_ui_action").status).toBe("complete");
      expect(result.fatal).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("F3: an ACL-denied table is partial and the next table still sweeps", async () => {
    const server = await FakeInstanceServer.start({
      corpus,
      aclDeniedTables: ["sys_script"],
    });
    try {
      const result = await fetchSweep({
        client: clientFor(server, 2),
        plan: [
          { entry: entryFromCorpus(corpus, "sys_script"), strategy: "sweep" },
          { entry: entryFromCorpus(corpus, "sys_ui_action"), strategy: "sweep" },
        ],
        onRow: () => undefined,
      });

      expect(outcomeFor(result, "sys_script")).toMatchObject({
        status: "partial",
        reason: "acl-403",
        failureClass: "acl",
      });
      expect(outcomeFor(result, "sys_ui_action").status).toBe("complete");
      expect(result.fatal).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("F4: an instance that hibernates mid-sweep stops the run with its own diagnosis", async () => {
    // Hibernation answers HTTP 200 with an HTML body on every path, so the only
    // detector is the body — and the message must not read "unreachable", because the
    // remedy is a browser visit, not a network fix.
    const server = await FakeInstanceServer.start({ corpus });
    try {
      const seen: Array<{ table: string; sysId: string }> = [];
      const result = await fetchSweep({
        client: clientFor(server, 2),
        plan: [
          { entry: entryFromCorpus(corpus, "sys_script"), strategy: "sweep" },
          { entry: entryFromCorpus(corpus, "sys_ui_action"), strategy: "sweep" },
        ],
        onRow: (row, table) => {
          seen.push({ table, sysId: row.sys_id });
          if (seen.length === 2) {
            server.setHibernating(true);
          }
        },
      });

      expect(result.fatal?.failureClass).toBe("hibernating");
      expect(result.fatal?.diagnosis).toBe(
        "instance hibernating (wake it at developer.servicenow.com)"
      );
      expect(outcomeFor(result, "sys_script")).toMatchObject({
        status: "failed",
        reason: "instance-unreachable",
        lastSysId: seen[1].sysId,
      });
      expect(result.notAttempted).toEqual(["sys_ui_action"]);
    } finally {
      await server.close();
    }
  });

  it("F2: a 401 with no refresh hook stops the run and says 'auth failed'", async () => {
    const server = await FakeInstanceServer.start({ corpus });
    try {
      const client = new MirrorHttpClient({
        instance: server.baseUrl,
        headers: { Authorization: "Basic bm9wZTpub3Bl" },
        sleep: () => Promise.resolve(),
      });
      const result = await fetchSweep({
        client,
        plan: [{ entry: entryFromCorpus(corpus, "sys_script"), strategy: "sweep" }],
        onRow: () => undefined,
      });

      expect(result.tables).toEqual([]);
      expect(result.fatal?.failureClass).toBe("auth");
      expect(result.fatal?.diagnosis).toBe("auth failed");
    } finally {
      await server.close();
    }
  });
});
