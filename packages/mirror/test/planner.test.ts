// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Planner tests — WP-M8, §5.4, §4.5, T6, D1, D20.
 *
 * The planner produces no bytes and touches no network, so nothing about it fails
 * loudly. Every mistake it can make is a mistake of BELIEF: a table quietly not
 * fetched, a watermark quietly too high, a query quietly matching everything. So
 * these tests are organised by the wrong belief rather than by the function:
 *
 *  - *Order.* §4.5's ordering is a contract because committed files are rendered
 *    from it, and a sort that depends on catalog input order or on a locale would
 *    produce a different diff for the same instance on a different machine.
 *  - *Gating.* R3 forbids a silent skip, so every non-fetched table must come back
 *    with a named outcome and a coverage reason the report can print.
 *  - *T6.* `rowCount === 0` and `rowCount === null` mean opposite things, and the
 *    test that distinguishes them is the one standing between an Aggregate outage
 *    and INV-5 authorising a mass deletion.
 *  - *D20.* Measured on a real instance: an unknown `sysparm_query` field is
 *    silently dropped and the surviving query matches every row. The tests below
 *    assert both halves — that a query naming an uncataloged field is refused, and
 *    that the planner never produces one in the first place.
 *  - *D1.* `preQuiescence` absent, present-and-empty, and populated are three
 *    different claims about what was measured, and none may be turned into another.
 *
 * Time and identity arrive through injected seams, so every assertion below is
 * about a value the test chose. A planner that read the clock itself could not be
 * tested for the watermark arithmetic that is its most error-prone part.
 */
import { sep } from "node:path";

import { loadMirrorConfig } from "../src/config/loadConfig";
import { WATERMARK_OVERLAP_MS } from "../src/constants";
import type {
  CheckpointState,
  FieldDescriptor,
  MirrorConfig,
  PlannedTable,
  QuiescenceReading,
  RecordEntry,
  TableCatalogEntry,
} from "../src/contracts";
import {
  assertQueryFieldsCataloged,
  buildWatermarkQuery,
  effectiveFieldSet,
  loadShardStates,
  parseInstantMs,
  planSync,
  plannedQueryFor,
  PlannerQueryError,
  type PlannerInput,
  type TablePlanDecision,
  type TableShardState,
} from "../src/sync/planner";
import { writeShardSet } from "../src/shards/shardStore";
import { toNativePath, type WriterDirEntry, type WriterFs } from "../src/write/fs";

const ROOT = `${sep}mirror-root`;
const NOW_MS = Date.UTC(2026, 7, 18, 9, 0, 0);
const SWEEP_ID = "sweep-planned";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function field(element: string): FieldDescriptor {
  return {
    element,
    internalType: "string",
    extractAs: null,
    isJsonBlob: false,
    isNoise: false,
    isDenied: false,
    reference: null,
    maxLength: 40,
  };
}

/**
 * A catalog entry with the shape the planner actually reads.
 *
 * `sys_updated_on` is in the default field list because the real catalog puts it
 * there — `fieldPolicy` flags it as noise (it is not mirrored as a value) but it
 * remains a column of the table, and D20's check is about what the DICTIONARY has,
 * not about what the serializer keeps.
 */
function entryFor(
  name: string,
  overrides: Partial<TableCatalogEntry> = {}
): TableCatalogEntry {
  return {
    name,
    sysId: "0".repeat(32),
    superClass: null,
    isMetadata: true,
    tier: 1,
    rowCount: 10,
    maxUpdatedOn: null,
    fields: [field("sys_updated_on"), field("name")],
    status: "included",
    ...overrides,
  };
}

function configWith(overrides: Partial<MirrorConfig> = {}): MirrorConfig {
  return { ...loadMirrorConfig({}), ...overrides };
}

function inputFor(
  catalog: readonly TableCatalogEntry[],
  overrides: Partial<PlannerInput> = {}
): PlannerInput {
  return {
    catalog,
    config: configWith(),
    now: () => NOW_MS,
    newSweepId: () => SWEEP_ID,
    ...overrides,
  };
}

function decisionFor(decisions: readonly TablePlanDecision[], table: string): TablePlanDecision {
  const found = decisions.find((decision) => decision.table === table);
  if (found === undefined) {
    throw new Error(`no decision for ${table}`);
  }
  return found;
}

function shardStates(entries: Record<string, TableShardState>): Map<string, TableShardState> {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// In-memory filesystem, directory-aware
// ---------------------------------------------------------------------------

function parentOf(nativePath: string): string {
  const index = nativePath.lastIndexOf(sep);
  return index <= 0 ? sep : nativePath.slice(0, index);
}

/**
 * Directory-aware because `listScopesWithShards` walks `instance/` and branches on
 * `isDirectory`. A fake that reported only files would make every scope invisible
 * and every watermark test pass for the wrong reason.
 */
class MemoryFs implements WriterFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();

  async makeDir(dir: string): Promise<void> {
    const parts = dir.split(sep);
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const candidate = parts.slice(0, depth).join(sep);
      if (candidate !== "") {
        this.dirs.add(candidate);
      }
    }
  }

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    if (!this.dirs.has(parentOf(filePath))) {
      throw new Error(`ENOENT: no directory holds ${filePath}`);
    }
    this.files.set(filePath, new Uint8Array(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (bytes === undefined) {
      throw new Error(`ENOENT: nothing to rename at ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(filePath);
    return bytes === undefined ? null : new Uint8Array(bytes);
  }

  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    if (!this.dirs.has(dir)) {
      return null;
    }
    const names = new Map<string, boolean>();
    for (const filePath of this.files.keys()) {
      if (parentOf(filePath) === dir) {
        names.set(filePath.slice(dir.length + sep.length), false);
      }
    }
    for (const known of this.dirs) {
      if (parentOf(known) === dir) {
        names.set(known.slice(dir.length + sep.length), true);
      }
    }
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  async removeRecursive(target: string): Promise<void> {
    this.files.delete(target);
    this.dirs.delete(target);
  }
}

function recordEntry(sysId: string, sysUpdatedOn: string): RecordEntry {
  return {
    path: `instance/global/incident/${sysId}`,
    name: sysId,
    sysUpdatedOn,
    sysUpdatedBy: "admin",
    sysModCount: 1,
    contentHash: "a".repeat(64),
    files: [],
  };
}

async function layShards(
  fs: MemoryFs,
  scope: string,
  table: string,
  complete: boolean,
  records: ReadonlyArray<[string, string]>
): Promise<void> {
  await fs.makeDir(toNativePath(ROOT, `instance/${scope}`));
  await writeShardSet(fs, {
    root: ROOT,
    scope,
    table,
    fanout: 0,
    complete,
    sweepId: SWEEP_ID,
    entries: new Map(records.map(([sysId, when]) => [sysId, recordEntry(sysId, when)])),
  });
}

// ---------------------------------------------------------------------------
// §4.5 — ordering is a contract
// ---------------------------------------------------------------------------

describe("plan ordering (§4.5)", () => {
  it("orders by tier ascending, then table name ascending, regardless of catalog order", () => {
    const catalog = [
      entryFor("sys_user", { tier: 3 }),
      entryFor("sys_script", { tier: 1 }),
      entryFor("sys_dictionary", { tier: 2 }),
      entryFor("sys_atf_test", { tier: 1 }),
    ];
    const result = planSync(
      inputFor(catalog, { config: configWith({ tiers: { referenceData: true } }) })
    );
    expect(result.plan.tables.map((table) => table.entry.name)).toEqual([
      "sys_atf_test",
      "sys_script",
      "sys_dictionary",
      "sys_user",
    ]);
    // The decision list carries every table in the same order, so the coverage
    // report never has to re-derive it and cannot disagree with the plan.
    expect(result.decisions.map((decision) => decision.table)).toEqual([
      "sys_atf_test",
      "sys_script",
      "sys_dictionary",
      "sys_user",
    ]);
  });

  it("orders bytewise, so an underscore sorts after uppercase the way a byte comparison does", () => {
    // `localeCompare` would put these in dictionary order and produce a different
    // committed file on a machine with a different locale — INV-1's quiet failure.
    const catalog = [entryFor("sys_Z"), entryFor("sys_a"), entryFor("sys_A")];
    const result = planSync(inputFor(catalog));
    expect(result.plan.tables.map((table) => table.entry.name)).toEqual([
      "sys_A",
      "sys_Z",
      "sys_a",
    ]);
  });

  it("keeps the first of a duplicated catalog name and reports the rest", () => {
    const catalog = [
      entryFor("incident", { rowCount: 5 }),
      entryFor("incident", { rowCount: 900 }),
    ];
    const result = planSync(inputFor(catalog));
    expect(result.plan.tables).toHaveLength(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.duplicateTables).toEqual(["incident"]);
  });
});

// ---------------------------------------------------------------------------
// Gating — R3 forbids a silent skip
// ---------------------------------------------------------------------------

describe("table gating (§5.4, R3)", () => {
  it("excludes a config-excluded table and names the coverage reason", () => {
    const result = planSync(
      inputFor([entryFor("incident")], {
        config: configWith({
          tables: { include: [], exclude: ["incident"], perTable: {} },
        }),
      })
    );
    expect(result.plan.tables).toEqual([]);
    expect(decisionFor(result.decisions, "incident")).toMatchObject({
      outcome: "excluded-config",
      reason: "excluded-config",
      strategy: null,
      extraQuery: null,
    });
  });

  it("honours the catalog's own excluded-config status even when the config list is empty", () => {
    const result = planSync(inputFor([entryFor("incident", { status: "excluded-config" })]));
    expect(decisionFor(result.decisions, "incident").outcome).toBe("excluded-config");
  });

  it("reports an ACL denial as acl-403 rather than as an exclusion", () => {
    // A table the instance refused is a materially different report line from one
    // the operator declined; collapsing them would hide a permissions problem.
    const result = planSync(inputFor([entryFor("sys_user", { status: "acl-denied" })]));
    expect(decisionFor(result.decisions, "sys_user")).toMatchObject({
      outcome: "acl-denied",
      reason: "acl-403",
    });
    expect(result.plan.tables).toEqual([]);
  });

  it("gates tier 3 when reference data is off, and admits it when it is on", () => {
    const catalog = [entryFor("cmn_location", { tier: 3 })];
    const gated = planSync(inputFor(catalog));
    expect(decisionFor(gated.decisions, "cmn_location")).toMatchObject({
      outcome: "excluded-tier",
      reason: "excluded-tier",
    });

    const admitted = planSync(
      inputFor(catalog, { config: configWith({ tiers: { referenceData: true } }) })
    );
    expect(decisionFor(admitted.decisions, "cmn_location").outcome).toBe("planned");
  });

  it("honours the catalog's excluded-tier status independently of the tier number", () => {
    const result = planSync(inputFor([entryFor("cmn_location", { status: "excluded-tier" })]));
    expect(decisionFor(result.decisions, "cmn_location").outcome).toBe("excluded-tier");
  });

  it("lets tables.include override the tier gate", () => {
    const result = planSync(
      inputFor([entryFor("cmn_location", { tier: 3, status: "excluded-tier" })], {
        config: configWith({
          tables: { include: ["cmn_location"], exclude: [], perTable: {} },
        }),
      })
    );
    expect(decisionFor(result.decisions, "cmn_location").outcome).toBe("planned");
  });

  it("does not let tables.include override an explicit exclusion or an ACL denial", () => {
    // Both directions of "the operator said no" and "the instance said no" outrank
    // the tier override, which exists only to widen the tier rules.
    const config = configWith({
      tables: { include: ["incident", "sys_user"], exclude: ["incident"], perTable: {} },
    });
    const result = planSync(
      inputFor([entryFor("incident"), entryFor("sys_user", { status: "acl-denied" })], {
        config,
      })
    );
    expect(decisionFor(result.decisions, "incident").outcome).toBe("excluded-config");
    expect(decisionFor(result.decisions, "sys_user").outcome).toBe("acl-denied");
  });
});

// ---------------------------------------------------------------------------
// T6 — aggregate-first, and the zero/null distinction
// ---------------------------------------------------------------------------

describe("aggregate-first (T6)", () => {
  it("plans no request for a table measured at zero rows", () => {
    const result = planSync(inputFor([entryFor("sys_ui_policy", { rowCount: 0 })]));
    expect(result.plan.tables).toEqual([]);
    expect(decisionFor(result.decisions, "sys_ui_policy")).toMatchObject({
      outcome: "skipped-empty",
      // Zero rows is full coverage, not a gap: there is nothing missing to explain.
      reason: null,
      expectedRows: 0,
    });
  });

  it("honours the catalog's own skipped-empty status", () => {
    const result = planSync(
      inputFor([entryFor("sys_ui_policy", { rowCount: 3, status: "skipped-empty" })])
    );
    expect(decisionFor(result.decisions, "sys_ui_policy").outcome).toBe("skipped-empty");
  });

  it("sweeps a table whose row count is null, because unmeasured is not empty", () => {
    // The load-bearing case: an Aggregate outage returns null, and reading that as
    // zero would skip every table on the instance while reporting full coverage —
    // handing INV-5 permission to delete a mirror it never actually checked.
    const result = planSync(inputFor([entryFor("incident", { rowCount: null })]));
    expect(result.plan.tables).toHaveLength(1);
    expect(decisionFor(result.decisions, "incident")).toMatchObject({
      outcome: "planned",
      strategy: "sweep",
      expectedRows: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

describe("mode selection (§5.4)", () => {
  it("full sweeps every included table and plans no watermark", () => {
    const result = planSync(
      inputFor([entryFor("incident")], {
        full: true,
        shardState: shardStates({
          incident: { complete: true, maxSysUpdatedOn: "2026-08-01 00:00:00" },
        }),
      })
    );
    expect(result.plan.mode).toBe("full");
    expect(result.plan.tables[0]).toEqual({ entry: expect.anything(), strategy: "sweep" });
    expect(decisionFor(result.decisions, "incident").watermark).toBeNull();
  });

  it("promotes every Nth sync to a reconcile, which also sweeps", () => {
    const config = configWith({
      sync: { reconcileEveryNSyncs: 5, requestsPerSecond: 4, pageSize: 1000 },
    });
    const result = planSync(inputFor([entryFor("incident")], { config, syncOrdinal: 10 }));
    expect(result.plan.mode).toBe("reconcile");
    // A reconcile that used a watermark would compare a filtered slice against the
    // whole mirror and conclude that every unfetched row had been deleted.
    expect(result.plan.tables[0].strategy).toBe("sweep");
  });

  it("stays incremental on the syncs between reconciles", () => {
    const config = configWith({
      sync: { reconcileEveryNSyncs: 5, requestsPerSecond: 4, pageSize: 1000 },
    });
    expect(planSync(inputFor([entryFor("incident")], { config, syncOrdinal: 9 })).plan.mode).toBe(
      "incremental"
    );
  });

  it("defaults the ordinal to 1, so a first sync is a reconcile only when N is 1", () => {
    const everyOne = configWith({
      sync: { reconcileEveryNSyncs: 1, requestsPerSecond: 4, pageSize: 1000 },
    });
    expect(planSync(inputFor([entryFor("incident")], { config: everyOne })).plan.mode).toBe(
      "reconcile"
    );
    expect(planSync(inputFor([entryFor("incident")])).plan.mode).toBe("incremental");
  });

  it("disables promotion for a nonsensical cadence or ordinal rather than maximising it", () => {
    // Every guard, because "every sync is a reconcile" is the most expensive mirror
    // there is and must never be reachable by a mistyped setting.
    const cadences = [0, -3, 2.5];
    for (const reconcileEveryNSyncs of cadences) {
      const config = configWith({
        sync: { reconcileEveryNSyncs, requestsPerSecond: 4, pageSize: 1000 },
      });
      expect(planSync(inputFor([entryFor("incident")], { config, syncOrdinal: 4 })).plan.mode).toBe(
        "incremental"
      );
    }
    const config = configWith({
      sync: { reconcileEveryNSyncs: 2, requestsPerSecond: 4, pageSize: 1000 },
    });
    for (const syncOrdinal of [0, -2, 4.5]) {
      expect(planSync(inputFor([entryFor("incident")], { config, syncOrdinal })).plan.mode).toBe(
        "incremental"
      );
    }
  });

  it("mints the sweep id and start instant from the injected seams", () => {
    const result = planSync(
      inputFor([entryFor("incident")], { newSweepId: () => "sweep-abc", now: () => NOW_MS })
    );
    expect(result.plan.sweepId).toBe("sweep-abc");
    expect(result.startedAt).toBe("2026-08-18T09:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

describe("watermark derivation (§5.4, §9.2)", () => {
  const catalog = [entryFor("incident")];

  it("rewinds the watermark by the overlap window and renders it ISO-8601", () => {
    const result = planSync(
      inputFor(catalog, {
        shardState: shardStates({
          incident: { complete: true, maxSysUpdatedOn: "2026-08-18 08:30:00" },
        }),
      })
    );
    const expected = new Date(Date.UTC(2026, 7, 18, 8, 30, 0) - WATERMARK_OVERLAP_MS).toISOString();
    expect(result.plan.tables[0]).toEqual({
      entry: expect.anything(),
      strategy: "watermark",
      watermark: expected,
    });
    expect(decisionFor(result.decisions, "incident").watermark).toBe(expected);
  });

  it("sweeps when there is no shard state at all for the table", () => {
    const result = planSync(inputFor(catalog, { shardState: shardStates({}) }));
    expect(result.plan.tables[0].strategy).toBe("sweep");
  });

  it("sweeps when the shard state is absent entirely", () => {
    expect(planSync(inputFor(catalog)).plan.tables[0].strategy).toBe("sweep");
  });

  it("sweeps when the existing shards came from an interrupted sweep (INV-4)", () => {
    // An incomplete baseline's highest timestamp is wherever the crash happened, so
    // a watermark from it would skip every row after that point permanently.
    const result = planSync(
      inputFor(catalog, {
        shardState: shardStates({
          incident: { complete: false, maxSysUpdatedOn: "2026-08-18 08:30:00" },
        }),
      })
    );
    expect(result.plan.tables[0].strategy).toBe("sweep");
  });

  it("sweeps when a complete shard set holds no timestamp", () => {
    const result = planSync(
      inputFor(catalog, {
        shardState: shardStates({ incident: { complete: true, maxSysUpdatedOn: null } }),
      })
    );
    expect(result.plan.tables[0].strategy).toBe("sweep");
  });

  it("sweeps when the stored timestamp cannot be read as a fixed-width instant", () => {
    const result = planSync(
      inputFor(catalog, {
        shardState: shardStates({ incident: { complete: true, maxSysUpdatedOn: "yesterday" } }),
      })
    );
    expect(result.plan.tables[0].strategy).toBe("sweep");
  });

  it("accepts both the instance form and the ISO form, and rejects rolled-over dates", () => {
    expect(parseInstantMs("2026-08-18 08:30:00")).toBe(Date.UTC(2026, 7, 18, 8, 30, 0));
    expect(parseInstantMs("2026-08-18T08:30:00.250Z")).toBe(
      Date.UTC(2026, 7, 18, 8, 30, 0, 250)
    );
    expect(parseInstantMs("2026-08-18T08:30:00.2Z")).toBe(Date.UTC(2026, 7, 18, 8, 30, 0, 200));
    // `Date.UTC` rolls month 13 into the next January and maps year 26 into 1926.
    // Either would silently move an incremental boundary, so both are refused.
    expect(parseInstantMs("2026-13-01 00:00:00")).toBeNull();
    expect(parseInstantMs("2026-02-30 00:00:00")).toBeNull();
    expect(parseInstantMs("0026-08-18 08:30:00")).toBeNull();
    expect(parseInstantMs("not a date")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D20 — the silently ignored query field
// ---------------------------------------------------------------------------

describe("D20 query-field validation", () => {
  it("refuses a query naming a field the catalog does not have", () => {
    const entry = entryFor("incident", { fields: [field("name")] });
    expect(() => assertQueryFieldsCataloged(entry, "sys_updated_on>=2026-08-18 08:30:00")).toThrow(
      PlannerQueryError
    );
    try {
      assertQueryFieldsCataloged(entry, "sys_updated_on>=2026-08-18 08:30:00");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerQueryError);
      expect((error as PlannerQueryError).fault).toBe("uncataloged-query-field");
      expect((error as PlannerQueryError).table).toBe("incident");
    }
  });

  it("accepts every clause form the planner can emit, including ORDERBY", () => {
    const entry = entryFor("incident");
    for (const query of [
      "sys_updated_on>=2026-08-18 08:30:00",
      "sys_updated_on<=2026-08-18 08:30:00",
      "sys_updated_on!=x^name=y",
      "name>a^name<z",
      "ORDERBYname",
      "ORDERBYDESCname",
    ]) {
      expect(() => assertQueryFieldsCataloged(entry, query)).not.toThrow();
    }
  });

  it("refuses a query shape it cannot parse rather than approving it by default", () => {
    // A validator that cannot find a field name in a clause must fail closed:
    // approving a query by failing to read it is the same outcome as not checking.
    const entry = entryFor("incident");
    for (const query of ["name", "=value", "", "name=a^^name=b"]) {
      try {
        assertQueryFieldsCataloged(entry, query);
        throw new Error(`expected a refusal for ${JSON.stringify(query)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(PlannerQueryError);
        expect((error as PlannerQueryError).fault).toBe("unparseable-query");
      }
    }
  });

  it("refuses an ORDERBY of an uncataloged field", () => {
    const entry = entryFor("incident", { fields: [field("name")] });
    expect(() => assertQueryFieldsCataloged(entry, "ORDERBYsys_created_on")).toThrow(
      PlannerQueryError
    );
  });

  it("builds the watermark clause in the instance's datetime form", () => {
    expect(buildWatermarkQuery(entryFor("incident"), "2026-08-18T08:25:00.000Z")).toBe(
      "sys_updated_on>=2026-08-18 08:25:00"
    );
  });

  it("refuses to build a clause around an unreadable watermark", () => {
    try {
      buildWatermarkQuery(entryFor("incident"), "soon");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as PlannerQueryError).fault).toBe("unparseable-watermark");
    }
  });

  it("downgrades a table with no sys_updated_on column to a sweep instead of emitting a query", () => {
    // The whole point of D20: the planner never reaches the invalid query, because
    // a query ServiceNow would silently strip would fetch the entire table while
    // the report called the run incremental.
    const result = planSync(
      inputFor([entryFor("u_legacy", { fields: [field("name")] })], {
        shardState: shardStates({
          u_legacy: { complete: true, maxSysUpdatedOn: "2026-08-18 08:30:00" },
        }),
      })
    );
    expect(result.plan.tables[0].strategy).toBe("sweep");
    expect(decisionFor(result.decisions, "u_legacy").extraQuery).toBeNull();
  });

  it("records the validated query on the decision for a watermark table", () => {
    const result = planSync(
      inputFor([entryFor("incident")], {
        shardState: shardStates({
          incident: { complete: true, maxSysUpdatedOn: "2026-08-18 08:30:00" },
        }),
      })
    );
    expect(decisionFor(result.decisions, "incident").extraQuery).toBe(
      "sys_updated_on>=2026-08-18 08:25:00"
    );
  });

  it("plannedQueryFor returns null for a sweep and refuses a watermark with no value", () => {
    const entry = entryFor("incident");
    expect(plannedQueryFor({ entry, strategy: "sweep" })).toBeNull();
    // Returning null here would be D20 wearing a different hat: an unfiltered
    // full-table fetch reported to the operator as an incremental one.
    const broken: PlannedTable = { entry, strategy: "watermark" };
    try {
      plannedQueryFor(broken);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as PlannerQueryError).fault).toBe("unparseable-watermark");
    }
  });

  it("exposes the effective field set the check is made against", () => {
    expect([...effectiveFieldSet(entryFor("incident"))]).toEqual(["sys_updated_on", "name"]);
  });
});

// ---------------------------------------------------------------------------
// D1 — quiescence readings
// ---------------------------------------------------------------------------

describe("quiescence readings (D1)", () => {
  const reading: QuiescenceReading = { count: 42, maxUpdatedOn: "2026-08-18 08:30:00" };

  it("omits preQuiescence entirely when the run did not ask for it", () => {
    // "Not asked" and "asked and measured nothing" are different claims, and §4.7's
    // tri-state `quiescent` depends on being able to tell them apart.
    const result = planSync(inputFor([entryFor("incident")]));
    expect("preQuiescence" in result.plan).toBe(false);
  });

  it("emits an empty map when asked but nothing could be read", () => {
    const result = planSync(inputFor([entryFor("incident")], { verifyQuiescent: true }));
    expect(result.plan.preQuiescence).toEqual({});
  });

  it("records a reading per planned table and never invents one", () => {
    const result = planSync(
      inputFor([entryFor("incident"), entryFor("problem")], {
        verifyQuiescent: true,
        quiescenceReadings: new Map([
          ["incident", reading],
          // A reading for a table that is not planned must not leak into the plan.
          ["sys_user", { count: 1, maxUpdatedOn: null }],
        ]),
      })
    );
    expect(result.plan.preQuiescence).toEqual({ incident: reading });
  });

  it("prefers the checkpoint's readings over fresh ones on a resume", () => {
    // The proof is about the instant the sweep began. Re-reading after an outage
    // would move the baseline forward and excuse every change made during it.
    const resume: CheckpointState = {
      formatVersion: 1,
      sweepId: "sweep-earlier",
      mode: "incremental",
      startedAt: "2026-08-18T07:00:00.000Z",
      completedTables: [],
      preQuiescence: { incident: reading },
    };
    const result = planSync(
      inputFor([entryFor("incident")], {
        verifyQuiescent: true,
        resume,
        quiescenceReadings: new Map([["incident", { count: 99, maxUpdatedOn: null }]]),
      })
    );
    expect(result.plan.preQuiescence).toEqual({ incident: reading });
  });
});

// ---------------------------------------------------------------------------
// Resume identity
// ---------------------------------------------------------------------------

describe("resumed sweep identity", () => {
  const resume: CheckpointState = {
    formatVersion: 1,
    sweepId: "sweep-earlier",
    mode: "incremental",
    startedAt: "2026-08-18T07:00:00.000Z",
    completedTables: ["incident"],
  };

  it("adopts the checkpoint's sweep id and start instant when the mode still matches", () => {
    const result = planSync(inputFor([entryFor("incident")], { resume }));
    expect(result.plan.sweepId).toBe("sweep-earlier");
    expect(result.startedAt).toBe("2026-08-18T07:00:00.000Z");
  });

  it("mints a fresh identity when the mode changed, so the resume is refused later", () => {
    // INV-5: a full sweep's completed-table list carries deletion authority that an
    // incremental run's does not. The fresh id is what makes `decideResume` say so.
    const result = planSync(inputFor([entryFor("incident")], { resume, full: true }));
    expect(result.plan.sweepId).toBe(SWEEP_ID);
    expect(result.startedAt).toBe("2026-08-18T09:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Shard state, read off a tree
// ---------------------------------------------------------------------------

describe("loadShardStates", () => {
  it("reports no baseline for a table with no shards anywhere", async () => {
    const fs = new MemoryFs();
    await fs.makeDir(toNativePath(ROOT, "instance"));
    expect(await loadShardStates(fs, ROOT, ["incident"])).toEqual(
      new Map([["incident", { complete: false, maxSysUpdatedOn: null }]])
    );
  });

  it("takes the highest timestamp across every scope holding the table", async () => {
    const fs = new MemoryFs();
    // The first record in shard order carries the LATER timestamp, so the scan has
    // to reject a candidate as well as accept one — a max that only ever climbed
    // would pass a test whose records happen to be in ascending order.
    await layShards(fs, "global", "incident", true, [
      ["a".repeat(32), "2026-08-17 23:59:59"],
      ["b".repeat(32), "2026-08-01 10:00:00"],
    ]);
    await layShards(fs, "x_acme_app", "incident", true, [
      ["c".repeat(32), "2026-08-18 08:30:00"],
    ]);
    const states = await loadShardStates(fs, ROOT, ["incident"]);
    expect(states.get("incident")).toEqual({
      complete: true,
      maxSysUpdatedOn: "2026-08-18 08:30:00",
    });
  });

  it("reports the table incomplete when any one scope's sweep did not finish", async () => {
    // INV-4 is per shard set, but a watermark is a claim about the whole table, so
    // one unfinished scope disqualifies the baseline for all of them.
    const fs = new MemoryFs();
    await layShards(fs, "global", "incident", true, [["a".repeat(32), "2026-08-18 08:00:00"]]);
    await layShards(fs, "x_acme_app", "incident", false, [
      ["c".repeat(32), "2026-08-18 08:30:00"],
    ]);
    expect(await loadShardStates(fs, ROOT, ["incident"])).toEqual(
      new Map([["incident", { complete: false, maxSysUpdatedOn: "2026-08-18 08:30:00" }]])
    );
  });

  it("feeds straight into the planner, producing a rewound watermark", async () => {
    const fs = new MemoryFs();
    await layShards(fs, "global", "incident", true, [["a".repeat(32), "2026-08-18 08:30:00"]]);
    const result = planSync(
      inputFor([entryFor("incident")], {
        shardState: await loadShardStates(fs, ROOT, ["incident"]),
      })
    );
    expect(result.plan.tables[0].watermark).toBe(
      new Date(Date.UTC(2026, 7, 18, 8, 25, 0)).toISOString()
    );
  });
});
