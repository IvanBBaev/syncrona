// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { buildManifestFromTableAPI } from "../manifestBuilder.js";

// REV-100 (PERF-7): buildManifestFromTableAPI used to enumerate every scope
// table with a single Promise.all, firing one Table-API request chain per table
// at once — a wide scope (hundreds of tables) opened hundreds of concurrent
// socket/handle chains, risking EMFILE / socket exhaustion and hammering the
// instance. The fix routes the table enumeration through a bounded worker pool
// whose width is `config.tableConcurrency` (default 20, clamped 1–50).
//
// Because each table worker holds exactly one Table-API request in flight at a
// time (its hierarchy → dictionary → records calls are sequential), the number
// of concurrent tableAPIGet calls equals the number of active table workers. So
// tracking peak in-flight tableAPIGet directly measures the pool width. These
// tests inject a small cap and assert the peak never exceeds it — the old
// unbounded code peaks at the table count (NUM_TABLES), failing both assertions.

type TableApiGet = jest.Mock<
  Promise<{ data: { result: Record<string, string>[] } }>,
  [string, string, string, number?, number?]
>;

function createClient(tableAPIGet: TableApiGet) {
  return { tableAPIGet } as unknown as import("../snClient").SNClient;
}

const NUM_TABLES = 9;
const CAP = 3;

const tableNames = Array.from({ length: NUM_TABLES }, (_, i) => `x_t${i}`);

let inFlight = 0;
let peak = 0;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A tableAPIGet whose every call records its own concurrency so the pool's peak
// width is observable. Scope discovery (sys_app, sys_metadata) runs serially
// BEFORE the pool, so it never lifts the peak above 1; only the pooled per-table
// chains do.
function makeTrackingClient(): TableApiGet {
  const impl = async (
    table: string,
    query: string,
    fields: string
  ): Promise<{ data: { result: Record<string, string>[] } }> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(3);
    try {
      if (table === "sys_app") {
        return { data: { result: [{ sys_id: "scope-1" }] } };
      }
      if (table === "sys_metadata") {
        // Table discovery: one sys_class_name row per scoped table.
        return {
          data: {
            result: tableNames.map((name) => ({ sys_class_name: name })),
          },
        };
      }
      if (table === "sys_db_object") {
        // Hierarchy lookup for `name=x_tN` — no super_class → single-node chain.
        const name = query.replace(/^name=/, "");
        return { data: { result: [{ name }] } };
      }
      if (table === "sys_dictionary" && fields === "element,internal_type") {
        return {
          data: { result: [{ element: "script", internal_type: "script_plain" }] },
        };
      }
      if (tableNames.includes(table)) {
        // Record fetch for the table itself.
        const idx = tableNames.indexOf(table);
        return {
          data: {
            result: [
              { sys_id: `rec-${idx}`, name: `Rec ${idx}`, script: "gs.info('x');" },
            ],
          },
        };
      }
      return { data: { result: [] } };
    } finally {
      inFlight -= 1;
    }
  };
  return jest.fn(impl) as unknown as TableApiGet;
}

// buildManifestFromTableAPI's config param type does not name `tableConcurrency`
// (the fix reads it via a loose structural cast), so build the literal untyped
// and widen it back to the parameter type to dodge the excess-property check.
function configWithCap(
  tableConcurrency: number
): Parameters<typeof buildManifestFromTableAPI>[2] {
  return {
    includes: {},
    excludes: {},
    tableOptions: {},
    tableConcurrency,
  } as unknown as Parameters<typeof buildManifestFromTableAPI>[2];
}

beforeEach(() => {
  jest.clearAllMocks();
  inFlight = 0;
  peak = 0;
});

describe("manifest table enumeration fan-out cap (REV-100)", () => {
  it("never enumerates more than the configured number of tables at once", async () => {
    const client = createClient(makeTrackingClient());

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      client,
      configWithCap(CAP)
    );

    // Every table still made it into the manifest — bounding concurrency must
    // not drop tables.
    expect(Object.keys(manifest.tables)).toHaveLength(NUM_TABLES);
    // The pool ran in parallel (peak > 1) but never above the cap. The old
    // Promise.all peaked at NUM_TABLES (9), which exceeds CAP (3).
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(CAP);
  });

  it("serializes table enumeration when the cap is 1", async () => {
    const client = createClient(makeTrackingClient());

    const manifest = await buildManifestFromTableAPI(
      "x_demo",
      client,
      configWithCap(1)
    );

    // A cap of 1 forces strictly one in-flight table chain at a time, proving
    // the cap actually drives the concurrency (the old code ignored it and
    // still peaked at NUM_TABLES).
    expect(Object.keys(manifest.tables)).toHaveLength(NUM_TABLES);
    expect(peak).toBe(1);
  });
});
