// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22, the cost and the noise of building the metadata layer.
//
// Two things measured against a live 5-table scope motivated this suite:
//
//  1. Enrichment issued 15 Table-API requests, of which 10 were `sys_db_object`
//     and only 5 were the dictionary reads it wanted. Every table in a scope
//     hangs off `sys_metadata`, and that one row was fetched once per table.
//     `dev` re-runs the whole thing on an interval, so the waste repeats.
//  2. A table whose dictionary could not be read lost its metadata silently —
//     the failure was logged at `debug`, invisible at the default level, and the
//     result was a workspace of scripts with no metadata and a cheerful
//     "Download complete". That is the exact state this feature exists to end.
import { jest } from "@jest/globals";
import { SN, Sync } from "@syncrona/types";

const warn = jest.fn();
const info = jest.fn();
const debug = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    getLogLevel: () => "info",
    info: (...args: unknown[]) => info(...args),
    warn: (...args: unknown[]) => warn(...args),
    error: jest.fn(),
    debug: (...args: unknown[]) => debug(...args),
  },
}));

let attachMetaFieldsToManifest: typeof import("../manifestBuilder.js").attachMetaFieldsToManifest;

beforeAll(async () => {
  ({ attachMetaFieldsToManifest } = await import("../manifestBuilder.js"));
});

type TableApiGet = jest.Mock<
  Promise<{ data: { result: Record<string, unknown>[] } }>,
  [string, string, string, number?, number?]
>;

/**
 * The shape a real scope has: several tables, one shared ancestor. `alpha` and
 * `beta` both extend `sys_metadata`, which extends nothing.
 */
const PARENTS: Record<string, string | undefined> = {
  x_demo_alpha: "sys_metadata",
  x_demo_beta: "sys_metadata",
  sys_metadata: undefined,
};

const client = (
  onDictionary: (query: string) => Record<string, unknown>[] | never = () => [
    { element: "short_description", internal_type: "string" },
  ]
) => {
  const tableAPIGet: TableApiGet = jest.fn();
  tableAPIGet.mockImplementation(async (table: string, query: string) => {
    if (table === "sys_db_object") {
      const name = query.replace("name=", "");
      const parent = PARENTS[name];
      return {
        data: { result: [{ name, ...(parent ? { "super_class.name": parent } : {}) }] },
      };
    }
    if (table === "sys_dictionary") {
      return { data: { result: onDictionary(query) } };
    }
    return { data: { result: [] } };
  });
  return { tableAPIGet };
};

const twoTableManifest = (): SN.AppManifest => ({
  scope: "x_demo",
  tables: {
    x_demo_alpha: {
      records: {
        A: { name: "A", sys_id: "a-1", files: [{ name: "script", type: "js" }] },
      },
    },
    x_demo_beta: {
      records: {
        B: { name: "B", sys_id: "b-1", files: [{ name: "script", type: "js" }] },
      },
    },
  },
});

const config = (): Pick<Sync.Config, "tableOptions" | "meta"> => ({ tableOptions: {} });

const callsTo = (c: { tableAPIGet: TableApiGet }, table: string) =>
  c.tableAPIGet.mock.calls.filter(([t]) => t === table);

describe("the cost of attachMetaFieldsToManifest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches a shared ancestor's row once for the whole run", async () => {
    const c = client();

    await attachMetaFieldsToManifest(twoTableManifest(), c as never, config());

    const hierarchyQueries = callsTo(c, "sys_db_object").map(([, query]) => query);
    // alpha, beta, and their one shared parent — three rows, not four.
    expect(hierarchyQueries.sort()).toEqual([
      "name=sys_metadata",
      "name=x_demo_alpha",
      "name=x_demo_beta",
    ]);
    expect(
      hierarchyQueries.filter((q) => q === "name=sys_metadata")
    ).toHaveLength(1);
  });

  it("still queries the dictionary once per table", async () => {
    const c = client();

    await attachMetaFieldsToManifest(twoTableManifest(), c as never, config());

    expect(callsTo(c, "sys_dictionary")).toHaveLength(2);
  });

  // The memo is per run, not per process: a `dev` session that refreshes every
  // few seconds must pick up a hierarchy change rather than pin the first answer
  // it ever saw.
  it("re-reads the hierarchy on the next enrichment", async () => {
    const c = client();

    await attachMetaFieldsToManifest(twoTableManifest(), c as never, config());
    const afterFirst = callsTo(c, "sys_db_object").length;
    await attachMetaFieldsToManifest(twoTableManifest(), c as never, config());

    expect(callsTo(c, "sys_db_object").length).toBe(afterFirst * 2);
  });

  it("queries the dictionary over the whole hierarchy, parents included", async () => {
    const c = client();

    await attachMetaFieldsToManifest(twoTableManifest(), c as never, config());

    for (const [, query] of callsTo(c, "sys_dictionary")) {
      expect(query).toMatch(/name=sys_metadata/);
    }
  });
});

describe("a table whose dictionary cannot be read", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("says so at warn, names the table, and names the way out", async () => {
    const c = client(() => {
      throw new Error("ACL: sys_dictionary is not readable");
    });
    const manifest = twoTableManifest();

    await attachMetaFieldsToManifest(manifest, c as never, config());

    // One line per affected table: which records lost their metadata is the
    // whole of what the user needs to decide what to do.
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes("x_demo_alpha"))).toBe(true);
    expect(messages.some((m) => m.includes("x_demo_beta"))).toBe(true);
    for (const message of messages) {
      // The cause, so it is not a mystery...
      expect(message).toMatch(/not readable/);
      // ...and both ways out, so it is not an investigation.
      expect(message).toMatch(/metaFields/);
      expect(message).toMatch(/syncrona refresh/);
    }
  });

  it("keeps the scripts — a missing metadata layer is not a failed refresh", async () => {
    const c = client(() => {
      throw new Error("boom");
    });
    const manifest = twoTableManifest();

    await expect(
      attachMetaFieldsToManifest(manifest, c as never, config())
    ).resolves.toBe(manifest);
    for (const table of Object.values(manifest.tables)) {
      expect(table.metaFields).toBeUndefined();
      for (const record of Object.values(table.records)) {
        expect(record.files.map((f) => f.name)).toEqual(["script"]);
      }
    }
  });

  it("stays quiet when the dictionary simply has nothing to add", async () => {
    // A table whose only column is the file field it already publishes is not a
    // problem and must not be reported as one.
    const c = client(() => [{ element: "script", internal_type: "script" }]);

    await attachMetaFieldsToManifest(twoTableManifest(), c as never, config());

    expect(warn).not.toHaveBeenCalled();
  });
});
