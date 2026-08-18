// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * WP-M4 acceptance: the catalog is correct against a fixture instance, and
 * stays correct when the instance is wrong.
 *
 * Two kinds of test, deliberately not merged:
 *
 *   - Everything that CAN be proved against the fake instance is, through the
 *     real `MirrorHttpClient` and the real query builder. A catalog test that
 *     stubs the transport proves the catalog agrees with the stub; only the
 *     round trip proves it agrees with a wire shape analyses §7 measured.
 *     `pageSize: 5` forces both schema sweeps to span several pages, so the
 *     cursor loop is exercised rather than asserted about.
 *   - Everything the fake REFUSES to do — because it is a correct server — is
 *     driven by a scripted source: a cursor that does not advance, a dictionary
 *     row that came back despite `active=true`, a `super_class` cycle. These are
 *     the instances that produce a hang or a wrong answer, and a fixture that
 *     could produce them would be a fixture that lies about ServiceNow.
 */
import { createHash } from "node:crypto";
import { LFS_THRESHOLD_BYTES } from "../src/constants";
import type { MirrorConfig, TableAggregate, TableCatalogEntry, TablePage } from "../src/contracts";
import {
  CatalogService,
  type CatalogBuildResult,
  type CatalogSource,
} from "../src/catalog/catalogService";
import { compareBytewise } from "../src/order";
import { MirrorHttpClient, MirrorHttpError, type MirrorHttpClientOptions } from "../src/http/client";
import {
  BULK_TABLE_NAME,
  BULK_TABLE_ROW_COUNT,
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  fetchJson,
  loadCommittedCorpus,
  resolveWireColumns,
  SeededRandom,
  type FixtureCorpus,
  type FixtureRow,
} from "./fakeInstance";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

/**
 * A real client pointed at a fake instance.
 *
 * Only the rate limiter's WAIT is stubbed out. The limiter itself still runs, so
 * the client under test is the shipped one; what the injected `sleep` removes is
 * the quarter second per request that would otherwise make this file spend a
 * minute proving something that has nothing to do with timing (§1.4).
 */
const clientFor = (
  server: FakeInstanceServer,
  overrides: Partial<MirrorHttpClientOptions> = {}
): MirrorHttpClient =>
  new MirrorHttpClient({
    instance: server.baseUrl,
    headers: { Authorization: basicAuth() },
    sleep: () => Promise.resolve(),
    ...overrides,
  });

/** A config with every field present, since `MirrorConfig` has no partial shape. */
const configOf = (overrides: Partial<MirrorConfig> = {}): MirrorConfig => ({
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: false },
  tables: { include: [], exclude: [], perTable: {} },
  attachments: { enabled: false, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
  redaction: { propertyAllowlist: [] },
  derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
  sync: { reconcileEveryNSyncs: 10, requestsPerSecond: 4, pageSize: 1000 },
  diffIgnore: [],
  ...overrides,
});

/** A syntactically valid sys_id (INV-6) derived from a label, so fixtures read as prose. */
const sysIdOf = (label: string): string => createHash("sha256").update(label).digest("hex").slice(0, 32);

type WireRows = Array<Record<string, string>>;

const onePage = (rows: WireRows): TablePage => ({ rows, lastSysId: null, done: true });

/**
 * A source that serves whole tables in one page.
 *
 * The default aggregate is a non-zero count so that a test which says nothing
 * about counts does not accidentally travel the empty-table or the
 * denied-aggregate path.
 */
const scriptedSource = (
  byTable: Record<string, WireRows>,
  overrides: Partial<CatalogSource> = {}
): CatalogSource => ({
  getPage: (table) => Promise.resolve(onePage(byTable[table] ?? [])),
  getAggregate: () => Promise.resolve({ count: 3, maxUpdatedOn: "2026-02-01 09:00:00" }),
  ...overrides,
});

const buildFrom = async (
  source: CatalogSource,
  config: MirrorConfig = configOf()
): Promise<CatalogBuildResult> => new CatalogService({ source, config }).build();

const entryOf = (result: CatalogBuildResult, name: string): TableCatalogEntry => {
  const found = result.tables.find((table) => table.name === name);
  if (found === undefined) {
    throw new Error(
      `no catalog entry for ${name}: got ${result.tables.map((table) => table.name).join(", ")}`
    );
  }
  return found;
};

/** Run a build that must fail, and hand back the error it failed with. */
const buildFailure = async (source: CatalogSource, config: MirrorConfig = configOf()): Promise<unknown> => {
  try {
    await buildFrom(source, config);
  } catch (error) {
    return error;
  }
  throw new Error("expected the build to reject, but it resolved");
};

// ---------------------------------------------------------------------------
// Against the fixture instance
// ---------------------------------------------------------------------------

describe("catalog against the committed fixture", () => {
  let server: FakeInstanceServer;
  let corpus: FixtureCorpus;
  let result: CatalogBuildResult;

  beforeAll(async () => {
    corpus = loadCommittedCorpus();
    server = await FakeInstanceServer.start({ corpus });
    result = await buildFrom(clientFor(server, { pageSize: 5 }));
  });

  afterAll(async () => {
    server.assertNoViolations();
    await server.close();
  });

  it("accounts for every table the instance has, with no silent skips (R3)", () => {
    // The corpus is the ground truth for "every table", so this cannot pass by
    // agreeing with a list written next to it.
    expect(result.tables.map((table) => table.name).sort(compareBytewise)).toEqual(
      corpus.tables.map((table) => table.name).sort(compareBytewise)
    );
    for (const entry of result.tables) {
      expect(entry.status).toMatch(/^(included|excluded-config|excluded-tier|skipped-empty|acl-denied)$/);
    }
  });

  it("bands sys_metadata descendants as tier 1 through a transitive closure (design §4.2)", () => {
    // Depth 3 is the load-bearing case: sys_hub_flow_snapshot reaches
    // sys_metadata only through sys_hub_flow_base, so a walk that stopped at the
    // first parent would band it as a plain table and never mirror a flow.
    expect(entryOf(result, "sys_hub_flow_snapshot")).toMatchObject({
      isMetadata: true,
      tier: 1,
      superClass: "sys_hub_flow_base",
      status: "included",
    });
    expect(entryOf(result, "sys_hub_flow_base").superClass).toBe("sys_metadata");
    expect(entryOf(result, "sys_metadata")).toMatchObject({ isMetadata: true, superClass: null });

    const tier1 = result.tables.filter((table) => table.tier === 1).map((table) => table.name);
    expect(tier1).toEqual([
      "sys_hub_flow_base",
      "sys_hub_flow_snapshot",
      "sys_metadata",
      "sys_properties",
      "sys_script",
      "sys_ui_action",
      "sys_update_set_source",
      BULK_TABLE_NAME,
      "x_syn_demo_empty",
    ]);
    // The closure is what produced that list, not a curated one: sys_properties
    // is also a curated T2 name, and it lands in tier 1 because THIS instance
    // says it extends sys_metadata.
    expect(entryOf(result, "sys_properties").isMetadata).toBe(true);
  });

  it("resolves inherited fields along the whole chain (D21)", () => {
    const snapshot = entryOf(result, "sys_hub_flow_snapshot");
    const ownDictionaryRows = corpus.tables
      .find((table) => table.name === "sys_dictionary")
      ?.rows.filter((row) => row.name === "sys_hub_flow_snapshot");

    // The premise, asserted rather than assumed: the table owns two dictionary
    // rows. Without this line the field list below could pass on a fixture where
    // the rows had been copied onto the child, proving nothing about inheritance.
    expect(ownDictionaryRows).toHaveLength(2);
    expect(snapshot.fields).toHaveLength(17);
    expect(snapshot.fields.map((field) => field.element)).toEqual([
      "active", //         ┐
      "description", //    │ from sys_hub_flow_base, one level up
      "internal_name", //  │
      "label_cache", // ← own
      "name", //           ┘
      "snapshot", // ← own
      "sys_class_name", // ┐
      "sys_created_by", // │
      "sys_created_on", // │
      "sys_id", //         │
      "sys_mod_count", //  │ from sys_metadata, two levels up
      "sys_name", //       │
      "sys_package", //    │
      "sys_policy", //     │
      "sys_scope", //      │
      "sys_updated_by", // │
      "sys_updated_on", // ┘
    ]);
  });

  it("matches the fixture's own inheritance walk, plus the declared-but-undelivered column (F5)", () => {
    const bySysId = new Map(corpus.tables.map((table) => [table.sysId, table] as const));
    for (const table of corpus.tables) {
      const wire = resolveWireColumns(table, bySysId).map((column) => column.element);
      const cataloged = entryOf(result, table.name).fields.map((field) => field.element);
      // sys_ui_action.hint is in the dictionary and never on the wire (F5): the
      // catalog is dictionary-driven on purpose, because the planner has to know
      // a column was PROMISED in order to report that it never arrived.
      expect(cataloged.filter((element) => !wire.includes(element))).toEqual(
        table.name === "sys_ui_action" ? ["hint"] : []
      );
      expect(wire.filter((element) => !cataloged.includes(element))).toEqual([]);
    }
  });

  it("keeps a table whose super_class chain is broken, and says so", () => {
    const orphan = entryOf(result, "x_syn_demo_orphan");
    // The honest answer to "does this chain reach sys_metadata?" when the chain
    // ends at a pointer to nothing is no — the table is banded on the ancestry
    // that could be PROVED, and the unresolvable value is reported rather than
    // guessed at in either direction.
    expect(orphan).toMatchObject({ isMetadata: false, superClass: null, tier: 3, status: "excluded-tier" });
    expect(orphan.fields.map((field) => field.element)).toContain("payload");

    const anomaly = result.anomalies.find((item) => item.table === "x_syn_demo_orphan");
    const danglingSysId = corpus.tables.find((table) => table.name === "x_syn_demo_orphan")?.superClass;
    expect(typeof danglingSysId).toBe("string");
    expect(anomaly?.kind).toBe("dangling-super-class");
    expect(anomaly?.detail).toContain(danglingSysId as string);
  });

  it("applies the field policy to real dictionary rows", () => {
    const fieldOf = (table: string, element: string) => {
      const found = entryOf(result, table).fields.find((field) => field.element === element);
      expect(found).toBeDefined();
      return found as NonNullable<typeof found>;
    };

    // Extraction (design §7.1): the value leaves record.json for a sibling file.
    expect(fieldOf("sys_script", "script")).toMatchObject({ extractAs: "js", isJsonBlob: false });
    expect(fieldOf("sys_ui_action", "condition")).toMatchObject({ internalType: "script_plain", extractAs: "js" });
    // A type that is script-adjacent but absent from the map stays inline.
    expect(fieldOf("sys_script", "condition")).toMatchObject({ internalType: "conditions", extractAs: null });

    // D19/M10: a password2 column returns 106 characters of ciphertext to an
    // authorized caller, not a mask, so it never reaches the tree.
    expect(fieldOf("sys_update_set_source", "password")).toMatchObject({
      internalType: "password2",
      isDenied: true,
    });
    expect(fieldOf("sys_update_set_source", "username").isDenied).toBe(false);

    // Built-in churn, and a reference the dictionary already spells as a name.
    expect(fieldOf("sys_script", "sys_updated_on").isNoise).toBe(true);
    expect(fieldOf("sys_script", "sys_created_on").isNoise).toBe(false);
    expect(fieldOf("sys_script", "sys_scope").reference).toBe("sys_scope");
    expect(fieldOf("sys_db_object", "super_class").reference).toBe("sys_db_object");
    expect(fieldOf("sys_script", "name").reference).toBeNull();
    expect(fieldOf("sys_script", "description").maxLength).toBe(4000);
    expect(fieldOf("sys_script", "sys_id").maxLength).toBe(32);
  });

  it("parses aggregate counts as numbers, not as strings (M3/M5)", async () => {
    const { json } = await fetchJson<{ result: { stats: { count: unknown } } }>(
      `${server.baseUrl}/api/now/stats/${BULK_TABLE_NAME}?sysparm_count=true`,
      { auth: DEFAULT_CREDENTIALS }
    );
    // The premise: the wire really does carry a string here. If a future fixture
    // sent a number, the comparison below would stop proving anything and this
    // line would say so.
    expect(typeof json.result.stats.count).toBe("string");

    const bulk = entryOf(result, BULK_TABLE_NAME);
    const script = entryOf(result, "sys_script");
    expect(bulk.rowCount).toBe(BULK_TABLE_ROW_COUNT);
    expect(script.rowCount).toBe(9);
    expect(typeof bulk.rowCount).toBe("number");
    expect(bulk.rowCount as number).toBeGreaterThan(script.rowCount as number);
    // …and the same comparison done on the raw strings gets it backwards, which
    // is the defect the Number() boundary exists to prevent.
    expect(String(bulk.rowCount) < String(script.rowCount)).toBe(true);
  });

  it("marks empty tables skipped-empty from both causes (T6)", () => {
    // An abstract root nobody stores rows in, and a real table nobody has filled.
    expect(entryOf(result, "sys_metadata")).toMatchObject({
      rowCount: 0,
      maxUpdatedOn: null,
      status: "skipped-empty",
    });
    expect(entryOf(result, "x_syn_demo_empty")).toMatchObject({ rowCount: 0, status: "skipped-empty" });
    // M8/M9: a populated table carries a high-water mark in ServiceNow's format,
    // which is lexicographically ordered and therefore comparable as a string.
    expect(entryOf(result, "sys_script").maxUpdatedOn).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("keeps a table whose records carry no scope (M11)", () => {
    // sys_choice has no sys_scope column at all — it is a root table, so it
    // inherits none either. A catalog that filtered by RECORD scope would drop
    // the whole table without a single error.
    expect(entryOf(result, "sys_choice")).toMatchObject({ tier: 2, status: "included", isMetadata: false });
    expect(entryOf(result, "sys_choice").fields.map((field) => field.element)).not.toContain("sys_scope");
    // The scope the TABLE is defined in is a different question, is known for
    // every table, and is reported beside the catalog instead of filtering it.
    for (const table of corpus.tables) {
      expect(result.scopeSysIdByTable[table.name]).toBe(table.scopeSysId);
    }
    expect(Object.keys(result.scopeSysIdByTable)).toEqual(result.tables.map((table) => table.name));
  });

  it("orders output by tier then name, byte-wise (INV-1)", () => {
    expect(result.tables.map((table) => table.name)).toEqual([
      "sys_hub_flow_base",
      "sys_hub_flow_snapshot",
      "sys_metadata",
      "sys_properties",
      "sys_script",
      "sys_ui_action",
      "sys_update_set_source",
      BULK_TABLE_NAME,
      "x_syn_demo_empty",
      "sys_choice",
      "sys_attachment",
      "sys_db_object",
      "sys_dictionary",
      "sys_scope",
      "x_syn_demo_orphan",
    ]);
    for (const entry of result.tables) {
      const elements = entry.fields.map((field) => field.element);
      expect(elements).toEqual([...elements].sort(compareBytewise));
    }
  });

  it("bands binaries and the schema tables away from a row sweep", () => {
    // T5: sys_attachment rows do reach the tree, through the Attachment API.
    expect(entryOf(result, "sys_attachment")).toMatchObject({ tier: 3, status: "excluded-tier" });
    expect(entryOf(result, "sys_db_object")).toMatchObject({ tier: 3, status: "excluded-tier" });
    // Nothing is written for them, so nothing is suppressed for them either.
    expect(result.suppressions.map((item) => item.table)).not.toContain("sys_attachment");
    expect(result.suppressions.map((item) => item.table)).not.toContain("sys_metadata");
  });

  it("is satisfied by MirrorHttpClient without an adapter", () => {
    const source: CatalogSource = clientFor(server);
    expect(source).toBeInstanceOf(MirrorHttpClient);
  });
});

// ---------------------------------------------------------------------------
// Config precedence and suppression reporting
// ---------------------------------------------------------------------------

describe("config precedence against the fixture instance", () => {
  let server: FakeInstanceServer;
  let result: CatalogBuildResult;

  beforeAll(async () => {
    server = await FakeInstanceServer.start({ corpus: loadCommittedCorpus() });
    result = await buildFrom(
      clientFor(server, { pageSize: 200 }),
      configOf({
        tables: {
          // Force a schema table in, keep a T1 table out, and keep the
          // 24 000-row table out of a test that has nothing to say about it.
          include: ["sys_dictionary"],
          exclude: ["sys_script", BULK_TABLE_NAME],
          perTable: {
            sys_properties: { ignoreFields: ["description", "not_a_column"] },
            sys_ui_action: {},
          },
        },
      })
    );
  });

  afterAll(async () => {
    server.assertNoViolations();
    await server.close();
  });

  it("lets config override the tier in both directions", () => {
    expect(entryOf(result, "sys_dictionary")).toMatchObject({ tier: 3, status: "included" });
    expect(entryOf(result, "sys_script")).toMatchObject({ tier: 1, status: "excluded-config" });
    expect(entryOf(result, BULK_TABLE_NAME).status).toBe("excluded-config");
  });

  it("spends no aggregate request on a table it will not fetch", () => {
    // An excluded table keeps an unknown count rather than an expensive zero.
    expect(entryOf(result, "sys_script").rowCount).toBeNull();
    expect(entryOf(result, BULK_TABLE_NAME).rowCount).toBeNull();
    expect(entryOf(result, "sys_dictionary").rowCount).toBe(120);
  });

  it("decomposes suppressions into engine, user and denied (D7)", () => {
    expect(result.suppressions.find((item) => item.table === "sys_properties")).toEqual({
      table: "sys_properties",
      engineNoise: ["sys_mod_count", "sys_updated_by", "sys_updated_on"],
      // `not_a_column` is configured and does not exist on the table, so it is
      // not reported as a suppression: the breakdown describes what was dropped,
      // not what was asked for.
      userIgnored: ["description"],
      denied: [],
    });
    expect(
      entryOf(result, "sys_properties").fields.find((field) => field.element === "description")?.isNoise
    ).toBe(true);

    // The same element on another table is untouched — ignoreFields belongs to
    // the table being described, never to the table that owns the dictionary row.
    expect(
      entryOf(result, "sys_hub_flow_base").fields.find((field) => field.element === "description")?.isNoise
    ).toBe(false);

    expect(result.suppressions.find((item) => item.table === "sys_update_set_source")).toEqual({
      table: "sys_update_set_source",
      engineNoise: ["sys_mod_count", "sys_updated_by", "sys_updated_on"],
      userIgnored: [],
      denied: ["password"],
    });
    // A perTable entry with no ignoreFields suppresses nothing beyond the noise.
    expect(result.suppressions.find((item) => item.table === "sys_ui_action")?.userIgnored).toEqual([]);
    // Reported for included tables only, in `tables` order (INV-1).
    expect(result.suppressions.map((item) => item.table)).toEqual(
      result.tables.filter((table) => table.status === "included").map((table) => table.name)
    );
  });
});

// ---------------------------------------------------------------------------
// Aggregate availability
// ---------------------------------------------------------------------------

describe("aggregate availability", () => {
  /** Every test here counts rows; none of them wants to count 24 000 of them. */
  const withoutBulk = configOf({ tables: { include: [], exclude: [BULK_TABLE_NAME], perTable: {} } });

  it("falls back to an unknown count when only the aggregate is denied (§5.10)", async () => {
    const server = await FakeInstanceServer.start({
      corpus: loadCommittedCorpus(),
      aggregateDeniedTables: ["sys_script"],
    });
    try {
      const result = await buildFrom(clientFor(server, { pageSize: 200 }), withoutBulk);
      // A null aggregate is ambiguous, so the catalog asks for one row before
      // concluding anything. The rows come back, so the table stays mirrorable
      // with an unknown count rather than being reported as denied.
      expect(entryOf(result, "sys_script")).toMatchObject({
        status: "included",
        rowCount: null,
        maxUpdatedOn: null,
      });
      expect(entryOf(result, "sys_ui_action").rowCount).toBe(3);
    } finally {
      server.assertNoViolations();
      await server.close();
    }
  });

  it("reports acl-denied when the rows are denied too", async () => {
    const server = await FakeInstanceServer.start({
      corpus: loadCommittedCorpus(),
      aclDeniedTables: ["sys_properties"],
    });
    try {
      const result = await buildFrom(clientFor(server, { pageSize: 200 }), withoutBulk);
      expect(entryOf(result, "sys_properties")).toMatchObject({ status: "acl-denied", rowCount: null });
      // R3: the table stays in the catalog with its full field set, so the
      // coverage report can name what was not mirrored and why.
      expect(entryOf(result, "sys_properties").fields.length).toBeGreaterThan(0);
      expect(result.suppressions.map((item) => item.table)).not.toContain("sys_properties");
    } finally {
      server.assertNoViolations();
      await server.close();
    }
  });

  it("fails loudly when the instance hibernates mid-build", async () => {
    const server = await FakeInstanceServer.start({ corpus: loadCommittedCorpus() });
    try {
      const client = clientFor(server, { pageSize: 200, maxAttempts: 1 });
      const source: CatalogSource = {
        getPage: (table, cursor, request) => client.getPage(table, cursor, request),
        getAggregate: (table, extraQuery) => {
          // Both schema sweeps have already succeeded; the instance goes to sleep
          // just as the counts start. Swallowing this would produce a catalog of
          // real tables with no counts — and then a reconcile that treats every
          // local file as an orphan.
          server.setHibernating(true);
          return client.getAggregate(table, extraQuery);
        },
      };
      const error = await buildFailure(source, withoutBulk);
      expect(error).toBeInstanceOf(MirrorHttpError);
      expect((error as MirrorHttpError).failureClass).toBe("hibernating");
    } finally {
      server.assertNoViolations();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Schema hazards (scripted source)
// ---------------------------------------------------------------------------

describe("schema hazards", () => {
  const tableRow = (name: string, overrides: Partial<FixtureRow> = {}): FixtureRow => ({
    sys_id: sysIdOf(name),
    name,
    super_class: "",
    sys_scope: "",
    ...overrides,
  });

  const columnRow = (table: string, element: string, overrides: Partial<FixtureRow> = {}): FixtureRow => ({
    name: table,
    element,
    internal_type: "string",
    reference: "",
    max_length: "40",
    active: "true",
    ...overrides,
  });

  it("terminates on a super_class cycle and reports it", async () => {
    // Two tables that each claim the other as a parent. An unguarded walk here
    // is an infinite loop, which on a real run means a hung process with no
    // output — strictly worse than a wrong answer, because nothing reports it.
    const result = await buildFrom(
      scriptedSource({
        sys_db_object: [
          tableRow("x_loop_a", { super_class: sysIdOf("x_loop_b") }),
          tableRow("x_loop_b", { super_class: sysIdOf("x_loop_a") }),
        ],
        sys_dictionary: [columnRow("x_loop_a", "own_a"), columnRow("x_loop_b", "own_b")],
      })
    );

    expect(result.anomalies).toEqual([
      { kind: "cyclic-super-class", table: "x_loop_a", detail: expect.stringContaining("x_loop_a") },
      { kind: "cyclic-super-class", table: "x_loop_b", detail: expect.stringContaining("x_loop_b") },
    ]);
    // The visited prefix is still used: each table sees its own column and its
    // partner's, and neither is called metadata on the strength of a loop.
    expect(entryOf(result, "x_loop_a").fields.map((field) => field.element)).toEqual(["own_a", "own_b"]);
    expect(entryOf(result, "x_loop_a")).toMatchObject({ isMetadata: false, superClass: "x_loop_b" });
  });

  it("reports unusable and duplicate sys_db_object rows instead of trusting them", async () => {
    const result = await buildFrom(
      scriptedSource({
        sys_db_object: [
          {},
          { name: "x_bad_id", sys_id: "not-a-sys-id" },
          tableRow("x_twice"),
          { ...tableRow("x_twice"), sys_id: sysIdOf("x_twice:second") },
          // One table, two different findings: the anomaly sort key has to stay
          // total when the table name alone does not separate them.
          tableRow("x_two_faults", { super_class: sysIdOf("nowhere") }),
          { ...tableRow("x_two_faults"), sys_id: sysIdOf("x_two_faults:second") },
        ],
      })
    );

    // A row with no name, and a row whose sys_id is not a sys_id (INV-6), are
    // both dropped: an entry keyed by either would be unusable downstream, and
    // inventing a key would put a phantom table in the coverage report.
    expect(result.tables.map((table) => table.name)).toEqual(["x_twice", "x_two_faults"]);
    expect(result.anomalies).toEqual([
      { kind: "unusable-table-row", table: "", detail: expect.stringContaining("(no sys_id)") },
      { kind: "unusable-table-row", table: "x_bad_id", detail: expect.stringContaining("not-a-sys-id") },
      { kind: "duplicate-table", table: "x_twice", detail: expect.stringContaining(sysIdOf("x_twice:second")) },
      { kind: "dangling-super-class", table: "x_two_faults", detail: expect.stringContaining(sysIdOf("nowhere")) },
      {
        kind: "duplicate-table",
        table: "x_two_faults",
        detail: expect.stringContaining(sysIdOf("x_two_faults:second")),
      },
    ]);
    // The first row in the sweep's sys_id order wins the name, so which row
    // survives is a property of the data rather than of the paging schedule.
    expect(entryOf(result, "x_twice").sysId).toBe(sysIdOf("x_twice"));
  });

  it("produces byte-identical output from shuffled input (INV-1)", async () => {
    const corpus = loadCommittedCorpus();
    const rowsOf = (name: string): WireRows =>
      (corpus.tables.find((table) => table.name === name)?.rows ?? []).map((row) => ({ ...row }));

    const ordered = await buildFrom(
      scriptedSource({ sys_db_object: rowsOf("sys_db_object"), sys_dictionary: rowsOf("sys_dictionary") })
    );

    const random = new SeededRandom(20260812);
    const shuffle = (rows: WireRows): WireRows => {
      const copy = [...rows];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = random.nextInt(index + 1);
        [copy[index], copy[swap]] = [copy[swap] as FixtureRow, copy[index] as FixtureRow];
      }
      return copy;
    };
    const shuffledTables = shuffle(rowsOf("sys_db_object"));
    const shuffled = await buildFrom(
      scriptedSource({ sys_db_object: shuffledTables, sys_dictionary: shuffle(rowsOf("sys_dictionary")) })
    );

    // The premise: the shuffle actually changed the input. Without this the
    // comparison below would pass on an identity permutation.
    expect(shuffledTables.map((row) => row.sys_id)).not.toEqual(
      rowsOf("sys_db_object").map((row) => row.sys_id)
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(ordered));
  });

  it("tolerates a table row that carries neither a parent nor a scope", async () => {
    const result = await buildFrom(
      // Not `tableRow`: this row omits `super_class` and `sys_scope` entirely
      // rather than sending them empty. M8 says a SELECTED column arrives as
      // `""`, but a column the instance does not have does not arrive at all
      // (M11), and `undefined` reaching the hierarchy walk as a parent sys_id
      // would look up the table named "undefined".
      scriptedSource({ sys_db_object: [{ sys_id: sysIdOf("sys_user"), name: "sys_user" }] }),
      configOf({ tiers: { referenceData: true } })
    );
    // Zero fields is a legitimate answer too (an abstract table, or one whose
    // whole dictionary the mirroring account cannot read); it must not be a crash.
    expect(entryOf(result, "sys_user")).toMatchObject({
      tier: 3,
      status: "included",
      fields: [],
      superClass: null,
    });
    expect(result.scopeSysIdByTable.sys_user).toBe("");
  });

  it("keeps reference data out until it is asked for (T3)", async () => {
    const source = scriptedSource({ sys_db_object: [tableRow("sys_user"), tableRow("syslog")] });
    const off = await buildFrom(source);
    const on = await buildFrom(source, configOf({ tiers: { referenceData: true } }));

    expect(entryOf(off, "sys_user").status).toBe("excluded-tier");
    expect(entryOf(on, "sys_user").status).toBe("included");
    // The flag is about T3 and nothing else: an unclassified table stays out.
    expect(entryOf(on, "syslog").status).toBe("excluded-tier");
  });

  it("resolves exclude before include when a config names a table twice", async () => {
    // `loadMirrorConfig` rejects this config outright, so the only way to reach
    // this code is a config object assembled in process — which is exactly why
    // the precedence is pinned here rather than left implicit.
    const result = await buildFrom(
      scriptedSource({ sys_db_object: [tableRow("sys_choice")] }),
      configOf({ tables: { include: ["sys_choice"], exclude: ["sys_choice"], perTable: {} } })
    );
    expect(entryOf(result, "sys_choice").status).toBe("excluded-config");
  });

  it("re-checks the active filter the server may have dropped (M12/D20)", async () => {
    // The dictionary sweep asks for active=true. M12 measured that a condition
    // naming a column the table does not have is silently ignored and the query
    // then matches every row, so the server-side filter is an optimization and
    // the client is what enforces the rule.
    const result = await buildFrom(
      scriptedSource({
        sys_db_object: [tableRow("x_drop")],
        sys_dictionary: [
          columnRow("x_drop", "kept"),
          columnRow("x_drop", "retired", { active: "false" }),
          // The dictionary's row for the TABLE itself, which names no column.
          columnRow("x_drop", "", { internal_type: "collection", max_length: "" }),
          // A row whose `name` never arrived. It belongs to no table, and the
          // one thing it must not do is attach itself to the table being built.
          { element: "unowned", internal_type: "string", reference: "", max_length: "40", active: "true" },
        ],
      })
    );
    expect(entryOf(result, "x_drop").fields.map((field) => field.element)).toEqual(["kept"]);
  });

  it("lets a child dictionary row override the parent's (D21)", async () => {
    const result = await buildFrom(
      scriptedSource({
        sys_db_object: [tableRow("x_parent"), tableRow("x_child", { super_class: sysIdOf("x_parent") })],
        sys_dictionary: [
          columnRow("x_parent", "body"),
          columnRow("x_child", "body", { internal_type: "script", max_length: "8000" }),
        ],
      })
    );
    // The platform honours the child's dictionary override, so the union must
    // too — otherwise the mirror would keep a script column inline as a string.
    expect(entryOf(result, "x_child").fields).toEqual([
      expect.objectContaining({ element: "body", internalType: "script", extractAs: "js", maxLength: 8000 }),
    ]);
    expect(entryOf(result, "x_parent").fields[0]).toMatchObject({ internalType: "string", extractAs: null });
  });

  it("resolves a reference given as a sys_id through the sweep it already did", async () => {
    // `sysparm_exclude_reference_link=true` (the client sets it) returns the
    // stored value, and for `sys_dictionary.reference` that is a sys_db_object
    // sys_id. Resolving it needs no extra request — the table sweep that just
    // finished is the index — and the committed fixture spells references as
    // names, so this is the only place the sys_id form is exercised end to end.
    const result = await buildFrom(
      scriptedSource({
        sys_db_object: [tableRow("x_parent"), tableRow("x_child")],
        sys_dictionary: [
          columnRow("x_child", "parent_ref", { internal_type: "reference", reference: sysIdOf("x_parent") }),
          // The same shape pointing at a table an uninstalled plugin took with
          // it. Null, not 32 hex characters presented as a table name.
          columnRow("x_child", "ghost_ref", { internal_type: "reference", reference: sysIdOf("gone") }),
        ],
      })
    );
    const fields = entryOf(result, "x_child").fields;
    expect(fields.find((field) => field.element === "parent_ref")?.reference).toBe("x_parent");
    expect(fields.find((field) => field.element === "ghost_ref")?.reference).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transport hazards (scripted source)
// ---------------------------------------------------------------------------

describe("transport hazards", () => {
  const choiceRow: FixtureRow = {
    sys_id: sysIdOf("sys_choice"),
    name: "sys_choice",
    super_class: "",
    sys_scope: "",
  };

  /**
   * One included table (sys_choice is T2) whose aggregate is unavailable, so
   * every build here reaches the disambiguating 1-row probe and nothing else.
   */
  const probeSource = (probe: () => Promise<TablePage>): CatalogSource => ({
    getPage: (table) =>
      table === "sys_db_object" ? Promise.resolve(onePage([choiceRow])) : table === "sys_choice" ? probe() : Promise.resolve(onePage([])),
    getAggregate: () => Promise.resolve(null),
  });

  it("walks every page of a sweep and stops on the short one", async () => {
    const pages: TablePage[] = [
      {
        rows: [{ sys_id: sysIdOf("t1"), name: "x_one", super_class: "", sys_scope: "" }],
        lastSysId: sysIdOf("t1"),
        done: false,
      },
      {
        rows: [{ sys_id: sysIdOf("t2"), name: "x_two", super_class: "", sys_scope: "" }],
        lastSysId: sysIdOf("t2"),
        done: true,
      },
    ];
    const cursors: Array<string | null> = [];
    const result = await buildFrom({
      getPage: (table, cursor) => {
        if (table !== "sys_db_object") {
          return Promise.resolve(onePage([]));
        }
        cursors.push(cursor);
        return Promise.resolve(pages[cursors.length - 1] as TablePage);
      },
      getAggregate: () => Promise.resolve(null),
    });

    // The second request carries the first page's last sys_id: a sweep that
    // restarted from null would read page one forever.
    expect(cursors).toEqual([null, sysIdOf("t1")]);
    expect(result.tables.map((table) => table.name)).toEqual(["x_one", "x_two"]);
  });

  it("refuses to loop when the cursor stops advancing", async () => {
    const stuck = sysIdOf("stuck");
    const error = await buildFailure({
      getPage: () =>
        Promise.resolve({
          rows: [{ sys_id: stuck, name: "x_stuck", super_class: "", sys_scope: "" }],
          lastSysId: stuck,
          done: false,
        }),
      getAggregate: () => Promise.resolve(null),
    });
    expect(error).toBeInstanceOf(MirrorHttpError);
    expect((error as MirrorHttpError).failureClass).toBe("schema-drift");
    expect((error as Error).message).toContain(stuck);
  });

  it("refuses to loop when an unfinished page carries no cursor", async () => {
    const error = await buildFailure({
      getPage: () => Promise.resolve({ rows: [], lastSysId: null, done: false }),
      getAggregate: () => Promise.resolve(null),
    });
    expect((error as MirrorHttpError).failureClass).toBe("schema-drift");
    expect((error as Error).message).toContain("the first page");
  });

  it("rethrows every fatal class the ACL probe can raise", async () => {
    // One `it` per class would be three copies of one assertion; what matters is
    // that none of the three is swallowed into a catalog entry, because a
    // catalog built from a sleeping instance is an empty catalog and a `--prune`
    // reconcile against an empty catalog deletes the mirror.
    for (const failureClass of ["auth", "unreachable", "hibernating"] as const) {
      const error = await buildFailure(
        probeSource(() => Promise.reject(new MirrorHttpError(failureClass, `${failureClass} during probe`)))
      );
      expect((error as MirrorHttpError).failureClass).toBe(failureClass);
    }
  });

  it("does not turn an unexpected error into a catalog entry", async () => {
    // Not a MirrorHttpError at all — a programming fault has no failure class,
    // and classifying it as one would hide a bug behind a plausible status.
    const boom = new TypeError("fetch is not a function");
    expect(await buildFailure(probeSource(() => Promise.reject(boom)))).toBe(boom);
  });

  it("leaves a table included when the probe fails for a non-ACL reason", async () => {
    const result = await buildFrom(
      probeSource(() => Promise.reject(new MirrorHttpError("schema-drift", "no such table")))
    );
    // Unknown, not denied: the run finds out when it fetches, and the report
    // says "count unknown" rather than inventing an ACL denial.
    expect(entryOf(result, "sys_choice")).toMatchObject({ status: "included", rowCount: null });
  });

  it("takes a zero count from the aggregate as skipped-empty", async () => {
    const aggregate: TableAggregate = { count: 0, maxUpdatedOn: null };
    const result = await buildFrom(
      scriptedSource({ sys_db_object: [choiceRow] }, { getAggregate: () => Promise.resolve(aggregate) })
    );
    expect(entryOf(result, "sys_choice")).toMatchObject({ status: "skipped-empty", rowCount: 0 });
  });
});
