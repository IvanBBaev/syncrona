// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic fixture corpus for the fake instance (architecture §5.14).
 *
 * This module is the fake instance's data half: a seeded generator plus the
 * committed rendering of its output under `corpus/`. It exists so that every
 * downstream work package tests against the same instance, and so that "the
 * mirror produced a different tree" can never be explained away by "the fixture
 * moved".
 *
 * Two rules govern everything below.
 *
 * 1. NOTHING here may read the clock, the filesystem, the environment or
 *    `Math.random`. Every value is a pure function of {@link DEFAULT_CORPUS_SEED}
 *    (or of an explicit seed argument). `fakeInstanceCorpus.test.ts` enforces
 *    this twice: by regenerating and comparing bytes, and by poisoning
 *    `Math.random`/`Date.now` before calling the generator.
 *
 * 2. The corpus models what a real instance was MEASURED to return
 *    (analyses §7, M1–M18), not what the API documentation implies. The
 *    consequences that show up in the shapes below:
 *      - M8: every field value is a string, and an empty field is `""` — never
 *        `null`, never absent. So `FixtureRow` is `Record<string, string>` and
 *        the default-value rule at the bottom of `materializeRow` emits `""`.
 *      - M9: date-times are `YYYY-MM-DD HH:MM:SS`, no `T`, no zone. That format
 *        is lexicographically ordered, which is why the watermark comparisons
 *        in `query.ts` can be plain string comparisons.
 *      - M10/D19: a `password2` column returns a 106-character ciphertext, not
 *        an empty string and not a mask, so a redaction test has something real
 *        to bite on.
 *      - M13/P3: a leaf table declares only a handful of dictionary rows while
 *        the wire returns dozens of fields. `sys_hub_flow_snapshot` reproduces
 *        that ratio exactly (2 own columns, ~13 wire fields), because a catalog
 *        that forgets D21's inheritance union looks correct against any fixture
 *        that does not.
 *
 * On the >16 000-row table: `x_syn_demo_bulk` reports 24 000 rows through the
 * Aggregate API and serves all 24 000 through the Table API, but the committed
 * corpus stores only `{ rowCount, seed }` for it — the keys are materialized
 * lazily in the server and each row body is a pure function of its own sys_id.
 * The alternative (report 24 000, serve fewer) was rejected: that is not a large
 * table, it is an F3 count-mismatch fixture wearing a large table's costume, and
 * baking a lie into the shared corpus would make every downstream reconciliation
 * test assert the wrong thing. Cost of the choice: ~1 MB of transient strings on
 * first access, versus ~10 MB of committed JSON.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SeededRandom, seedFromString } from "./prng";

/** Version of the rendered corpus layout. Bump when `renderCorpusFiles` changes shape. */
export const CORPUS_FORMAT_VERSION = 1;

/**
 * The seed the committed corpus was generated from — the date of the live-PDI
 * measurement session in analyses §7, so the corpus carries the provenance of
 * the reality it imitates.
 */
export const DEFAULT_CORPUS_SEED = 20260817;

/** Directory holding the committed rendering of {@link generateCorpus}. */
export const COMMITTED_CORPUS_DIR = join(__dirname, "corpus");

export const BULK_TABLE_NAME = "x_syn_demo_bulk";

/**
 * Above `SHARD_FANOUT_THRESHOLD_1` (16 000, §11) with headroom, so a sharding
 * test cannot pass by accident on an off-by-one at the threshold.
 */
export const BULK_TABLE_ROW_COUNT = 24_000;

/** Base instant for every generated timestamp. Constant, so no clock is read. */
const EPOCH_BASE_MS = Date.UTC(2026, 0, 15, 8, 0, 0);

/** Spread of `sys_created_on` values: ~180 days, in seconds. */
const CREATED_SPREAD_SECONDS = 180 * 24 * 3600;

/** Spread of `sys_updated_on` above `sys_created_on`: ~30 days, in seconds. */
const UPDATED_SPREAD_SECONDS = 30 * 24 * 3600;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** A dictionary column, in the terms `sys_dictionary` uses. */
export interface FixtureColumn {
  element: string;
  internalType: string;
  maxLength: number | null;
  /** Referenced table NAME (the wire carries a sys_id; the corpus carries the name). */
  reference: string | null;
  /**
   * Declared in `sys_dictionary` but never present on the wire.
   *
   * This is the F5 `column-missing` fixture. Real instances produce it through
   * column-level ACLs and through dictionary rows for columns that were dropped
   * from the physical table; either way the Fetcher must survive a projection
   * naming a field that never arrives, and no fixture where every declared
   * column is always present can prove that.
   */
  phantom: boolean;
}

export type FixtureRow = Record<string, string>;

export interface FixtureTable {
  name: string;
  /** `sys_db_object` row sys_id — also the value children carry in `super_class`. */
  sysId: string;
  /**
   * `sys_db_object.super_class`, a sys_id. For `x_syn_demo_orphan` this points
   * at a sys_id no `sys_db_object` row carries: the broken-chain fixture. A
   * catalog walker that assumes every parent resolves will either loop or throw
   * here, which is the whole reason the row exists.
   */
  superClass: string | null;
  label: string;
  scopeSysId: string;
  /** Columns declared ON THIS TABLE only. The inherited union is D21's problem, not the corpus's. */
  columns: FixtureColumn[];
  /** Materialized rows, sorted by sys_id. Empty for a synthetic table. */
  rows: FixtureRow[];
  /** Non-null for the >16 000-row table; see the module note. */
  synthetic: { rowCount: number; seed: number } | null;
}

export interface FixtureAttachment {
  sysId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  tableName: string;
  tableSysId: string;
  /** sha256 of the synthesized body, so a consumer can verify what it downloaded. */
  sha256: string;
  /** Seed the body is synthesized from — harness data, never on the wire. */
  contentSeed: number;
}

export interface FixtureCorpus {
  formatVersion: number;
  seed: number;
  /** Sorted by name. */
  tables: FixtureTable[];
  /** Sorted by sys_id. */
  attachments: FixtureAttachment[];
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

const MAX_LENGTH_BY_TYPE: Readonly<Record<string, number>> = {
  GUID: 32,
  string: 40,
  glide_date_time: 40,
  integer: 40,
  boolean: 40,
  script: 8000,
  script_plain: 8000,
  conditions: 254,
  table_name: 80,
  password2: 255,
  sys_class_name: 80,
};

interface ColumnOverrides {
  maxLength?: number;
  reference?: string;
  phantom?: boolean;
}

const col = (
  element: string,
  internalType = "string",
  overrides: ColumnOverrides = {}
): FixtureColumn => ({
  element,
  internalType,
  maxLength: overrides.maxLength ?? MAX_LENGTH_BY_TYPE[internalType] ?? 40,
  reference: overrides.reference ?? null,
  phantom: overrides.phantom ?? false,
});

/**
 * The eleven columns `sys_metadata` declares.
 *
 * Every metadata table inherits all of them and none redeclares them, which is
 * what makes the P3 ratio (few own columns, many wire fields) reproducible.
 */
const METADATA_COLUMNS: readonly FixtureColumn[] = [
  col("sys_id", "GUID"),
  col("sys_created_by"),
  col("sys_created_on", "glide_date_time"),
  col("sys_updated_by"),
  col("sys_updated_on", "glide_date_time"),
  col("sys_mod_count", "integer"),
  col("sys_name"),
  col("sys_class_name", "sys_class_name"),
  col("sys_scope", "reference", { reference: "sys_scope" }),
  col("sys_package", "reference", { reference: "sys_scope" }),
  col("sys_policy"),
];

/** The five audit columns every non-metadata table still carries. */
const AUDIT_COLUMNS: readonly FixtureColumn[] = [
  col("sys_id", "GUID"),
  col("sys_created_by"),
  col("sys_created_on", "glide_date_time"),
  col("sys_updated_by"),
  col("sys_updated_on", "glide_date_time"),
  col("sys_mod_count", "integer"),
];

// ---------------------------------------------------------------------------
// Row seeds
// ---------------------------------------------------------------------------

/**
 * The authored part of a row. Everything else — sys_id, timestamps, scope, the
 * inherited metadata columns — is filled in by {@link materializeRow} so a
 * fixture reads as "what this row is about".
 */
interface RowSeed {
  name: string;
  fields?: Record<string, string>;
  /** Scope key override; defaults to the table's scope. */
  scope?: string;
}

interface TableSpec {
  name: string;
  /** Parent table NAME, or null for a root. */
  parent: string | null;
  /**
   * Point `super_class` at a sys_id that no table owns. Mutually exclusive with
   * `parent`; produces the broken-chain fixture.
   */
  danglingSuper?: boolean;
  label: string;
  scope: string;
  columns: readonly FixtureColumn[];
  rows?: readonly RowSeed[];
  synthetic?: { rowCount: number };
  /** Rows are derived after generation (catalog tables describing the corpus itself). */
  derived?: boolean;
}

const SCOPES = [
  { key: "global", name: "Global", scope: "global", description: "Global scope" },
  {
    key: "x_syn_demo",
    name: "SyncroNow Demo",
    scope: "x_syn_demo",
    description: "Demo application used by the mirror fixtures",
  },
  {
    key: "x_syn_uni",
    name: "SyncroNow Unicode",
    scope: "x_syn_uni",
    description: "Scope carrying the name-hazard fixtures",
  },
] as const;

/**
 * A name longer than `MAX_NAME_BYTES` (200 UTF-8 bytes, §11/D18).
 *
 * Cyrillic costs two bytes per character, so this is roughly 240 bytes in ~120
 * characters — a name that is legal on APFS (which caps at 255 *characters*)
 * and illegal on ext4 (255 *bytes*). That asymmetry is exactly the portability
 * trap D18 exists to close, and it only reproduces with a non-ASCII name.
 */
const OVERLONG_NAME =
  "Проверка на приоритета при създаване на инцидент от портала за самообслужване на служителите и уведомяване на мениджъра";

/*
 * The NFC/NFD pair, written as escapes on purpose.
 *
 * "Café Menu Extract" composed (U+00E9) and decomposed (e + U+0301) are
 * visually identical in every editor and in the rendered corpus file. Written
 * as literals, a reviewer could not tell them apart and a normalizing editor
 * could silently collapse them into one — destroying the fixture without
 * touching a visible character. Written as escapes, the difference is in the
 * source where a human can see it.
 */
const NAME_NFC = "Café Menu Extract";
const NAME_NFD = "Café Menu Extract";

const TABLE_SPECS: readonly TableSpec[] = [
  // --- catalog tables (rows derived from the corpus itself) -----------------
  {
    name: "sys_db_object",
    parent: null,
    label: "Table",
    scope: "global",
    derived: true,
    columns: [
      ...AUDIT_COLUMNS,
      col("name", "table_name"),
      col("label"),
      col("super_class", "reference", { reference: "sys_db_object" }),
      col("sys_scope", "reference", { reference: "sys_scope" }),
      col("sys_class_name", "sys_class_name"),
      col("sys_name"),
      col("is_extendable", "boolean"),
    ],
  },
  {
    name: "sys_dictionary",
    parent: null,
    label: "Dictionary Entry",
    scope: "global",
    derived: true,
    columns: [
      ...AUDIT_COLUMNS,
      col("name", "table_name"),
      col("element"),
      col("internal_type"),
      col("max_length", "integer"),
      col("reference", "reference", { reference: "sys_db_object" }),
      col("active", "boolean"),
      col("read_only", "boolean"),
    ],
  },
  {
    name: "sys_scope",
    parent: null,
    label: "Application",
    scope: "global",
    derived: true,
    columns: [
      ...AUDIT_COLUMNS,
      col("name"),
      col("scope"),
      col("short_description"),
      col("version"),
      col("active", "boolean"),
    ],
  },
  {
    name: "sys_attachment",
    parent: null,
    label: "Attachment",
    scope: "global",
    derived: true,
    columns: [
      ...AUDIT_COLUMNS,
      col("file_name", "string", { maxLength: 255 }),
      col("content_type"),
      col("size_bytes", "integer"),
      col("size_compressed", "integer"),
      col("table_name", "table_name"),
      col("table_sys_id", "GUID"),
      col("hash"),
      col("compressed", "boolean"),
    ],
  },

  // --- the metadata tree ----------------------------------------------------
  {
    // Abstract root. Zero own rows on purpose: a real instance's sys_metadata is
    // the union of a million child rows, and modelling that here would double
    // the corpus for no new behaviour. Its emptiness doubles as the second
    // empty-table fixture, from a different cause than x_syn_demo_empty.
    name: "sys_metadata",
    parent: null,
    label: "Application File",
    scope: "global",
    columns: METADATA_COLUMNS,
    rows: [],
  },
  {
    name: "sys_script",
    parent: "sys_metadata",
    label: "Business Rule",
    scope: "global",
    columns: [
      col("name"),
      col("collection", "table_name"),
      col("script", "script"),
      col("condition", "conditions"),
      col("active", "boolean"),
      col("when"),
      col("order", "integer"),
      col("description", "string", { maxLength: 4000 }),
    ],
    rows: [
      { name: "Validate Assignment Group", fields: { collection: "incident", when: "before" } },
      // The case-insensitive collision (analyses §9.2). Two rows a
      // case-preserving-but-insensitive filesystem — macOS default, Windows —
      // cannot hold in one directory without a uniqueness suffix.
      { name: "Set Priority", fields: { collection: "incident", when: "before" } },
      { name: "set priority", fields: { collection: "incident", when: "after" } },
      // Same after NFC normalization; different bytes on the wire.
      { name: NAME_NFC, fields: { collection: "sc_cat_item", when: "before" }, scope: "x_syn_uni" },
      { name: NAME_NFD, fields: { collection: "sc_cat_item", when: "after" }, scope: "x_syn_uni" },
      // A path separator inside a record name. Unsanitized, this row would
      // write itself into a directory that does not belong to its table.
      { name: "Incident / Problem Link", fields: { collection: "incident", when: "async" } },
      { name: "Създай инцидент", fields: { collection: "incident", when: "before" }, scope: "x_syn_uni" },
      { name: "日本語スクリプト", fields: { collection: "incident", when: "after" }, scope: "x_syn_uni" },
      { name: OVERLONG_NAME, fields: { collection: "incident", when: "before" }, scope: "x_syn_uni" },
    ],
  },
  {
    name: "sys_ui_action",
    parent: "sys_metadata",
    label: "UI Action",
    scope: "global",
    columns: [
      col("name"),
      col("table", "table_name"),
      col("script", "script"),
      col("condition", "script_plain"),
      col("action_name"),
      col("active", "boolean"),
      // Declared, never delivered — the F5 fixture. See FixtureColumn.phantom.
      col("hint", "string", { phantom: true }),
    ],
    rows: [
      { name: "Resolve Incident", fields: { table: "incident", action_name: "resolve_incident" } },
      { name: "Reopen Incident", fields: { table: "incident", action_name: "reopen_incident" } },
      { name: "Escalate", fields: { table: "incident", action_name: "escalate" }, scope: "x_syn_demo" },
    ],
  },
  {
    name: "sys_hub_flow_base",
    parent: "sys_metadata",
    label: "Flow Base",
    scope: "global",
    columns: [
      col("name"),
      col("internal_name"),
      col("active", "boolean"),
      col("description", "string", { maxLength: 4000 }),
    ],
    rows: [{ name: "Incident Intake", fields: { internal_name: "incident_intake" } }],
  },
  {
    // Depth 3: sys_metadata -> sys_hub_flow_base -> here. Two own columns
    // against thirteen wire fields reproduces the P3 ratio that makes D21's
    // inheritance union mandatory rather than nice-to-have.
    name: "sys_hub_flow_snapshot",
    parent: "sys_hub_flow_base",
    label: "Flow Snapshot",
    scope: "global",
    columns: [col("snapshot", "string", { maxLength: 65_000 }), col("label_cache", "string", { maxLength: 65_000 })],
    rows: [
      {
        name: "Incident Intake v1",
        fields: {
          internal_name: "incident_intake_v1",
          snapshot:
            '{"version":1,"steps":[{"id":"trigger","type":"record_created","table":"incident"},{"id":"a1","type":"action","name":"Set Priority"}]}',
          label_cache: '{"trigger":"Record created","a1":"Set Priority"}',
        },
      },
      {
        name: "Incident Intake v2",
        fields: {
          internal_name: "incident_intake_v2",
          snapshot: '{"version":2,"steps":[],"outputs":{"incident":"","priority":""}}',
          label_cache: '{"outputs":"Incident, Priority"}',
        },
      },
      {
        // Truncated mid-token. Real instances store snapshots that were written
        // by a failed upgrade or clipped by a column limit; F6 says the mirror
        // must keep such a value verbatim behind `raw:` rather than drop it or
        // "repair" it, and only an actually-unparseable fixture proves it does.
        name: "Broken Snapshot",
        fields: {
          internal_name: "broken_snapshot",
          snapshot: '{"version":3,"steps":[{"id":"trigger",',
          label_cache: "{}",
        },
      },
    ],
  },
  {
    name: "sys_update_set_source",
    parent: "sys_metadata",
    label: "Update Source",
    scope: "global",
    columns: [
      col("name"),
      col("url"),
      col("username"),
      // M10/D19: this returns a 106-character ciphertext to an authorized
      // caller. It is not masked by the platform, so the mirror is the only
      // thing standing between it and a git history.
      col("password", "password2"),
      col("type"),
      col("active", "boolean"),
    ],
    rows: [
      {
        name: "DEV to TEST",
        fields: { url: "https://dev00001.service-now.com", username: "update.user", type: "dev" },
      },
      {
        name: "TEST to PROD",
        fields: { url: "https://test00001.service-now.com", username: "update.user", type: "test" },
      },
    ],
  },
  {
    name: "sys_properties",
    parent: "sys_metadata",
    label: "System Property",
    scope: "global",
    columns: [
      col("name"),
      col("value", "string", { maxLength: 4000 }),
      col("description", "string", { maxLength: 4000 }),
      col("type"),
      col("is_private", "boolean"),
    ],
    rows: [
      { name: "glide.ui.date_format", fields: { value: "yyyy-MM-dd", type: "string" } },
      // Secret-shaped values whose NAMES are the only signal. A redaction pass
      // that keys off column type alone (these are plain `string`, not
      // `password2`) will happily commit both.
      //
      // Both carry a self-identifying prefix for the reason
      // {@link PASSWORD2_FAKE_PREFIX} spells out: these values are rendered into
      // committed JSON, which cannot carry an inline `gitleaks:allow`. The second
      // one used to be a literal `sk_live_`-prefixed string, which is a real
      // vendor key shape and duly tripped the repository's own secret scan — the
      // realism bought nothing, because what the fixture exercises is the
      // property NAME and `is_private`, and no assertion anywhere reads the
      // value's shape.
      {
        name: "glide.email.smtp.password",
        fields: { value: "hunter2-smtp-N4h2f8", type: "string", is_private: "true" },
      },
      {
        name: "x_syn_demo.integration.api_key",
        fields: { value: "FAKE-sk-live-9f2b7c1e4a6d8035bb1147ce", type: "string", is_private: "true" },
      },
      { name: "glide.servlet.uri", fields: { value: "https://dev00001.service-now.com/", type: "string" } },
    ],
  },
  {
    name: "x_syn_demo_empty",
    parent: "sys_metadata",
    label: "Demo Empty",
    scope: "x_syn_demo",
    columns: [col("name"), col("note")],
    rows: [],
  },
  {
    name: BULK_TABLE_NAME,
    parent: "sys_metadata",
    label: "Demo Bulk",
    scope: "x_syn_demo",
    columns: [col("name"), col("sequence", "integer"), col("payload", "string", { maxLength: 4000 })],
    synthetic: { rowCount: BULK_TABLE_ROW_COUNT },
  },
  {
    name: "x_syn_demo_orphan",
    parent: null,
    danglingSuper: true,
    label: "Demo Orphan",
    scope: "x_syn_demo",
    columns: [...AUDIT_COLUMNS, col("name"), col("payload", "string", { maxLength: 4000 })],
    rows: [
      { name: "Orphan One", fields: { payload: "first" } },
      { name: "Orphan Two", fields: { payload: "second" } },
    ],
  },
  {
    // M11: sys_choice has no sys_scope and no sys_package. A catalog that
    // filters every table by scope silently returns nothing here, which is how
    // a whole table disappears from a mirror without a single error.
    name: "sys_choice",
    parent: null,
    label: "Choice",
    scope: "global",
    columns: [
      ...AUDIT_COLUMNS,
      col("name", "table_name"),
      col("element"),
      col("value"),
      col("label"),
      col("sequence", "integer"),
      col("inactive", "boolean"),
      col("language"),
    ],
    rows: [
      { name: "1 - High", fields: { name: "incident", element: "priority", value: "1", label: "1 - High", language: "en" } },
      { name: "2 - Medium", fields: { name: "incident", element: "priority", value: "2", label: "2 - Medium", language: "en" } },
      { name: "3 - Low", fields: { name: "incident", element: "priority", value: "3", label: "3 - Low", language: "en" } },
      { name: "Нов", fields: { name: "incident", element: "state", value: "1", label: "Нов", language: "bg" } },
    ],
  },
];

const ATTACHMENT_SPECS = [
  {
    fileName: "runbook-notes.txt",
    contentType: "text/plain",
    sizeBytes: 4_096,
    tableName: "sys_script",
    rowIndex: 0,
  },
  {
    // Above LFS_THRESHOLD_BYTES (262 144, §11) so the pointer path is
    // exercisable; kept just above rather than far above so the fixture costs
    // 300 KB of transient memory rather than megabytes.
    fileName: "flow-diagram.png",
    contentType: "image/png",
    sizeBytes: 300_000,
    tableName: "sys_hub_flow_snapshot",
    rowIndex: 0,
  },
] as const;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const USERS = ["admin", "system", "mirror.svc", "j.doe"] as const;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Format an epoch instant the way ServiceNow does (M9): `YYYY-MM-DD HH:MM:SS`,
 * UTC, no `T`, no zone suffix.
 *
 * `new Date(ms)` with an explicit argument reads no clock — the determinism
 * guard forbids `new Date()` and `Date.now()`, not the Date constructor. Hand
 * arithmetic was rejected: it would need its own leap-year handling for no gain.
 */
export function formatSnDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  );
}

const PASSWORD2_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The first five characters of every generated ciphertext, and the reason the
 * value is allowed to exist in a committed file.
 *
 * A 106-character base64 blob is indistinguishable — to a secret scanner and to
 * a human reviewer alike — from a real `password2` ciphertext someone leaked.
 * `.gitleaks.toml` deliberately stopped exempting test paths after exactly that
 * happened once, and it sanctions two narrow escapes: an inline `gitleaks:allow`
 * on the offending line, or a value that is self-evidently a placeholder. The
 * rendered corpus is JSON, and JSON cannot carry a comment, so the line-level
 * escape is unavailable here and the value itself has to say what it is. `FAKE-`
 * is matched by that config's placeholder regex, which means the scanner is
 * satisfied by the same evidence a reviewer reads rather than by a directory
 * exemption nobody would re-examine.
 *
 * It is spent from the 106, not added to it — see {@link password2Ciphertext}
 * for why the length may not move.
 */
const PASSWORD2_FAKE_PREFIX = "FAKE-";

/**
 * A 106-character ciphertext, the exact length M10 measured on a live instance.
 *
 * The length is the load-bearing part: a redaction test that asserts "the value
 * was replaced" proves nothing against a 4-character placeholder, because a
 * truncating bug would pass it.
 */
function password2Ciphertext(random: SeededRandom): string {
  let out = PASSWORD2_FAKE_PREFIX;
  for (let i = out.length; i < 106; i += 1) {
    out += PASSWORD2_ALPHABET[random.nextInt(PASSWORD2_ALPHABET.length)];
  }
  return out;
}

function scriptBody(random: SeededRandom, name: string): string {
  const variable = `record${random.nextInt(1000)}`;
  return [
    "(function executeRule(current, previous /*null when async*/) {",
    `  // ${name}`,
    `  var ${variable} = current.getValue('number');`,
    `  gs.info('${name.replace(/'/g, "\\'")}: ' + ${variable});`,
    "})(current, previous);",
  ].join("\n");
}

interface GenerationContext {
  random: SeededRandom;
  scopeSysIds: Map<string, string>;
  /** Wire column set per table (own + inherited), phantoms excluded. */
  wireColumns: Map<string, FixtureColumn[]>;
}

/**
 * Own columns unioned with every ancestor's, parent-first, phantoms excluded.
 *
 * This is D21's inheritance union, done once so the fake and its consumers
 * cannot disagree about what a table's wire shape is. Two hazards are handled
 * explicitly because the corpus contains both:
 *
 *   - A `super_class` that resolves to nothing (`x_syn_demo_orphan`). The walk
 *     stops; the table keeps only its own columns. It must not throw — a real
 *     instance serves such a table perfectly well.
 *   - A cycle. Impossible in the generated corpus, possible in a sanitized
 *     recording of a real instance (§5.14's swap-in point), and an unguarded
 *     walk would hang the whole test process rather than fail a test.
 */
export function resolveWireColumns(
  table: FixtureTable,
  tablesBySysId: ReadonlyMap<string, FixtureTable>
): FixtureColumn[] {
  const chain: FixtureTable[] = [];
  const seen = new Set<string>();
  let current: FixtureTable | undefined = table;
  while (current && !seen.has(current.sysId)) {
    seen.add(current.sysId);
    chain.unshift(current);
    current = current.superClass ? tablesBySysId.get(current.superClass) : undefined;
  }
  const byElement = new Map<string, FixtureColumn>();
  for (const link of chain) {
    for (const column of link.columns) {
      // A child redeclaring an inherited element wins, matching the platform:
      // the dictionary override is what the wire honours.
      byElement.set(column.element, column);
    }
  }
  return [...byElement.values()].filter((column) => !column.phantom);
}

function materializeRow(
  seed: RowSeed,
  spec: TableSpec,
  context: GenerationContext
): FixtureRow {
  const { random } = context;
  const columns = context.wireColumns.get(spec.name) ?? [];
  const scopeSysId = context.scopeSysIds.get(seed.scope ?? spec.scope) ?? "";

  // Draw every random value up front and in a fixed order, so adding a column
  // to a table does not renumber the sys_ids of every table after it.
  const sysId = random.sysId();
  const createdMs = EPOCH_BASE_MS + random.nextInt(CREATED_SPREAD_SECONDS) * 1000;
  const updatedMs = createdMs + random.nextInt(UPDATED_SPREAD_SECONDS) * 1000;
  const createdBy = random.pick(USERS);
  const updatedBy = random.pick(USERS);
  const modCount = random.nextInt(40);

  const row: FixtureRow = {};
  for (const column of columns) {
    const authored = seed.fields?.[column.element];
    if (authored !== undefined) {
      row[column.element] = authored;
      continue;
    }
    switch (column.element) {
      case "sys_id":
        row[column.element] = sysId;
        break;
      case "sys_created_on":
        row[column.element] = formatSnDateTime(createdMs);
        break;
      case "sys_updated_on":
        row[column.element] = formatSnDateTime(updatedMs);
        break;
      case "sys_created_by":
        row[column.element] = createdBy;
        break;
      case "sys_updated_by":
        row[column.element] = updatedBy;
        break;
      case "sys_mod_count":
        row[column.element] = String(modCount);
        break;
      case "sys_name":
      case "name":
      case "label":
        row[column.element] = seed.name;
        break;
      case "sys_class_name":
        row[column.element] = spec.name;
        break;
      case "sys_scope":
      case "sys_package":
        row[column.element] = scopeSysId;
        break;
      case "script":
        row[column.element] = scriptBody(random, seed.name);
        break;
      default:
        if (column.internalType === "password2") {
          row[column.element] = password2Ciphertext(random);
        } else if (column.internalType === "boolean") {
          row[column.element] = random.nextInt(2) === 0 ? "false" : "true";
        } else if (column.internalType === "integer") {
          row[column.element] = String(random.nextInt(500));
        } else {
          // M8: an unset field arrives as an empty string, never as null and
          // never absent. A fixture that omitted the key would let a consumer
          // get away with `row.foo === undefined` checks that fail on the wire.
          row[column.element] = "";
        }
    }
  }
  return row;
}

/**
 * The body of a synthetic (bulk-table) row.
 *
 * Pure in the sys_id: page 17 yields the same bytes whether it is fetched
 * first, last, or twice, and inserting a row mid-sweep does not perturb the
 * rows around it. A generator that derived bodies from a row index would break
 * both properties the moment a mutation script fired.
 */
export function synthesizeBulkRow(sysId: string, tableName: string, scopeSysId: string): FixtureRow {
  const random = new SeededRandom(seedFromString(sysId));
  const createdMs = EPOCH_BASE_MS + random.nextInt(CREATED_SPREAD_SECONDS) * 1000;
  const updatedMs = createdMs + random.nextInt(UPDATED_SPREAD_SECONDS) * 1000;
  const sequence = random.nextInt(BULK_TABLE_ROW_COUNT);
  return {
    sys_id: sysId,
    sys_created_by: random.pick(USERS),
    sys_created_on: formatSnDateTime(createdMs),
    sys_updated_by: random.pick(USERS),
    sys_updated_on: formatSnDateTime(updatedMs),
    sys_mod_count: String(random.nextInt(40)),
    sys_name: `Bulk Record ${sequence}`,
    sys_class_name: tableName,
    sys_scope: scopeSysId,
    sys_package: scopeSysId,
    sys_policy: "",
    name: `Bulk Record ${sequence}`,
    sequence: String(sequence),
    payload: `payload-${random.hex(16)}`,
  };
}

/** The sorted sys_id list of a synthetic table. Deterministic in `{seed, rowCount}`. */
export function synthesizeBulkSysIds(seed: number, rowCount: number): string[] {
  const random = new SeededRandom(seed);
  const ids = new Set<string>();
  // Draw until the set is full rather than drawing exactly rowCount times: a
  // duplicate would otherwise silently shrink the table below its reported
  // Aggregate count and manufacture a phantom F3.
  while (ids.size < rowCount) {
    ids.add(random.sysId());
  }
  return [...ids].sort();
}

/** Deterministic body of an attachment. Regenerated on demand rather than committed. */
export function synthesizeAttachmentBytes(contentSeed: number, sizeBytes: number): Uint8Array {
  return new SeededRandom(contentSeed).bytes(sizeBytes);
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const bySysId = (a: { sys_id?: string; sysId?: string }, b: { sys_id?: string; sysId?: string }): number => {
  const left = a.sys_id ?? a.sysId ?? "";
  const right = b.sys_id ?? b.sysId ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Build the corpus.
 *
 * Draw order is: scope sys_ids, table sys_ids, the dangling super_class, then
 * rows table-by-table in declaration order, then attachments, then the derived
 * catalog rows. Any change to that order changes every identifier after the
 * change point — which the committed-bytes test will report as a diff, by
 * design.
 */
export function generateCorpus(seed: number = DEFAULT_CORPUS_SEED): FixtureCorpus {
  const random = new SeededRandom(seed);

  const scopeSysIds = new Map<string, string>();
  for (const scope of SCOPES) {
    scopeSysIds.set(scope.key, random.sysId());
  }

  const tableSysIds = new Map<string, string>();
  for (const spec of TABLE_SPECS) {
    tableSysIds.set(spec.name, random.sysId());
  }
  // A sys_id that belongs to no sys_db_object row. Drawn from the same stream
  // so it stays stable, and deliberately never registered anywhere.
  const danglingSuperSysId = random.sysId();

  // Shells first, rows second: the inheritance walk is defined over
  // `super_class` sys_ids, so the tables have to exist (empty) before their
  // wire column sets can be resolved. Building shells consumes no randomness,
  // so the draw order below is unaffected.
  const tables: FixtureTable[] = TABLE_SPECS.map((spec) => ({
    name: spec.name,
    sysId: tableSysIds.get(spec.name) ?? "",
    superClass: spec.danglingSuper ? danglingSuperSysId : spec.parent ? tableSysIds.get(spec.parent) ?? null : null,
    label: spec.label,
    scopeSysId: scopeSysIds.get(spec.scope) ?? "",
    columns: [...spec.columns],
    rows: [],
    synthetic: spec.synthetic ? { rowCount: spec.synthetic.rowCount, seed: seedFromString(`${seed}:${spec.name}`) } : null,
  }));
  const tablesByName = new Map(tables.map((table) => [table.name, table] as const));
  const tablesBySysId = new Map(tables.map((table) => [table.sysId, table] as const));

  const wireColumns = new Map<string, FixtureColumn[]>();
  for (const table of tables) {
    wireColumns.set(table.name, resolveWireColumns(table, tablesBySysId));
  }

  const context: GenerationContext = { random, scopeSysIds, wireColumns };

  for (const spec of TABLE_SPECS) {
    const table = tablesByName.get(spec.name) as FixtureTable;
    table.rows = (spec.rows ?? []).map((rowSeed) => materializeRow(rowSeed, spec, context)).sort(bySysId);
  }

  const attachments: FixtureAttachment[] = ATTACHMENT_SPECS.map((spec) => {
    const host = tablesByName.get(spec.tableName);
    const hostRow = host?.rows[spec.rowIndex];
    const sysId = random.sysId();
    const contentSeed = seedFromString(`${seed}:attachment:${spec.fileName}`);
    const bytes = synthesizeAttachmentBytes(contentSeed, spec.sizeBytes);
    return {
      sysId,
      fileName: spec.fileName,
      contentType: spec.contentType,
      sizeBytes: spec.sizeBytes,
      tableName: spec.tableName,
      tableSysId: hostRow?.sys_id ?? "",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentSeed,
    };
  });
  attachments.sort((a, b) => (a.sysId < b.sysId ? -1 : a.sysId > b.sysId ? 1 : 0));

  fillDerivedTables(tables, tablesByName, attachments, scopeSysIds, context);

  tables.sort(byName);
  return { formatVersion: CORPUS_FORMAT_VERSION, seed, tables, attachments };
}

/**
 * Populate `sys_scope`, `sys_db_object`, `sys_dictionary` and `sys_attachment`
 * from the corpus itself.
 *
 * The catalog tables are not hand-authored because a hand-authored catalog can
 * disagree with the data it claims to describe, and every disagreement would
 * surface downstream as an unexplainable mirror bug. Deriving them means the
 * fake instance is self-consistent by construction: `sys_dictionary` lists
 * exactly the columns the corpus declares (including the phantom, which is the
 * point), and `sys_db_object.super_class` carries exactly the sys_ids the table
 * list assigned (including the dangling one).
 */
function fillDerivedTables(
  tables: FixtureTable[],
  tablesByName: Map<string, FixtureTable>,
  attachments: FixtureAttachment[],
  scopeSysIds: Map<string, string>,
  context: GenerationContext
): void {
  const { random } = context;
  const stamp = (): { created: string; updated: string; createdBy: string; updatedBy: string; modCount: string } => {
    const createdMs = EPOCH_BASE_MS + random.nextInt(CREATED_SPREAD_SECONDS) * 1000;
    const updatedMs = createdMs + random.nextInt(UPDATED_SPREAD_SECONDS) * 1000;
    return {
      created: formatSnDateTime(createdMs),
      updated: formatSnDateTime(updatedMs),
      createdBy: random.pick(USERS),
      updatedBy: random.pick(USERS),
      modCount: String(random.nextInt(40)),
    };
  };

  const scopeTable = tablesByName.get("sys_scope");
  if (scopeTable) {
    scopeTable.rows = SCOPES.map((scope) => {
      const marks = stamp();
      return {
        sys_id: scopeSysIds.get(scope.key) ?? "",
        sys_created_by: marks.createdBy,
        sys_created_on: marks.created,
        sys_updated_by: marks.updatedBy,
        sys_updated_on: marks.updated,
        sys_mod_count: marks.modCount,
        name: scope.name,
        scope: scope.scope,
        short_description: scope.description,
        version: "1.0.0",
        active: "true",
      };
    }).sort(bySysId);
  }

  const objectTable = tablesByName.get("sys_db_object");
  if (objectTable) {
    objectTable.rows = tables
      .map((table) => {
        const marks = stamp();
        return {
          sys_id: table.sysId,
          sys_created_by: marks.createdBy,
          sys_created_on: marks.created,
          sys_updated_by: marks.updatedBy,
          sys_updated_on: marks.updated,
          sys_mod_count: marks.modCount,
          name: table.name,
          label: table.label,
          super_class: table.superClass ?? "",
          sys_scope: table.scopeSysId,
          sys_class_name: "sys_db_object",
          sys_name: table.label,
          is_extendable: table.name === "sys_metadata" || table.name === "sys_hub_flow_base" ? "true" : "false",
        };
      })
      .sort(bySysId);
  }

  const dictionaryTable = tablesByName.get("sys_dictionary");
  if (dictionaryTable) {
    const rows: FixtureRow[] = [];
    for (const table of tables) {
      for (const column of table.columns) {
        const marks = stamp();
        rows.push({
          sys_id: random.sysId(),
          sys_created_by: marks.createdBy,
          sys_created_on: marks.created,
          sys_updated_by: marks.updatedBy,
          sys_updated_on: marks.updated,
          sys_mod_count: marks.modCount,
          name: table.name,
          element: column.element,
          internal_type: column.internalType,
          // M8 again: a null max_length arrives as "", not as "null".
          max_length: column.maxLength === null ? "" : String(column.maxLength),
          reference: column.reference ?? "",
          active: "true",
          read_only: "false",
        });
      }
    }
    dictionaryTable.rows = rows.sort(bySysId);
  }

  const attachmentTable = tablesByName.get("sys_attachment");
  if (attachmentTable) {
    attachmentTable.rows = attachments
      .map((attachment) => {
        const marks = stamp();
        return {
          sys_id: attachment.sysId,
          sys_created_by: marks.createdBy,
          sys_created_on: marks.created,
          sys_updated_by: marks.updatedBy,
          sys_updated_on: marks.updated,
          sys_mod_count: marks.modCount,
          file_name: attachment.fileName,
          content_type: attachment.contentType,
          size_bytes: String(attachment.sizeBytes),
          size_compressed: String(attachment.sizeBytes),
          table_name: attachment.tableName,
          table_sys_id: attachment.tableSysId,
          hash: attachment.sha256,
          compressed: "false",
        };
      })
      .sort(bySysId);
  }
}

// ---------------------------------------------------------------------------
// Rendering / loading
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON: sorted keys, two-space indent, LF, one trailing newline.
 *
 * The mirror's own `canonicalJsonBytes` does the same job and is deliberately
 * NOT reused: the fake instance must not import from `packages/mirror/src`, or
 * a serializer regression would silently rewrite the fixtures it is supposed to
 * be checked against. The duplication is the isolation.
 */
function stableStringify(value: JsonValue, indent = 0): string {
  const pad = " ".repeat(indent);
  const padInner = " ".repeat(indent + 2);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${padInner}${stableStringify(item, indent + 2)}`).join(",\n")}\n${pad}]`;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  const body = keys
    .map((key) => `${padInner}${JSON.stringify(key)}: ${stableStringify(value[key] as JsonValue, indent + 2)}`)
    .join(",\n");
  return `{\n${body}\n${pad}}`;
}

const toJson = (value: unknown): string => `${stableStringify(value as JsonValue)}\n`;

/**
 * Render the corpus as the files under `corpus/`: one file per table, one for
 * attachments, plus a manifest.
 *
 * One file per table rather than one monolith, for the same reason D15 shards
 * the mirror itself: a 200 KB single-file corpus produces a review diff nobody
 * reads, while a change confined to `tables/sys_script.json` is legible at a
 * glance.
 *
 * Non-ASCII is left unescaped, which means the NFC and NFD variants of
 * "Café Menu Extract" render as two visually identical lines. That is not an
 * oversight: it is precisely why D18 mandates normalization, and the self-test
 * asserts on code points rather than on what a reviewer can see.
 */
export function renderCorpusFiles(corpus: FixtureCorpus): Map<string, string> {
  const files = new Map<string, string>();
  for (const table of corpus.tables) {
    files.set(`tables/${table.name}.json`, toJson(table));
  }
  files.set("attachments.json", toJson(corpus.attachments));
  files.set(
    "MANIFEST.json",
    toJson({
      formatVersion: corpus.formatVersion,
      seed: corpus.seed,
      tables: corpus.tables.map((table) => ({
        name: table.name,
        rowCount: table.synthetic ? table.synthetic.rowCount : table.rows.length,
        materialized: table.synthetic === null,
        // A per-file digest so a truncated or partially-written corpus file is
        // a manifest mismatch rather than a mystery in some later test.
        sha256: createHash("sha256").update(toJson(table), "utf8").digest("hex"),
      })),
      attachmentCount: corpus.attachments.length,
    })
  );
  return files;
}

/**
 * Read a rendered corpus back.
 *
 * This is §5.14's swap-in point: the same reader accepts a generated corpus and
 * a hand-sanitized recording of a real instance, so a future capture can
 * replace the generator without touching the server.
 */
export function loadCorpusFromDirectory(directory: string): FixtureCorpus {
  const manifest = JSON.parse(readFileSync(join(directory, "MANIFEST.json"), "utf8")) as {
    formatVersion: number;
    seed: number;
  };
  const tableDir = join(directory, "tables");
  const tables = readdirSync(tableDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => JSON.parse(readFileSync(join(tableDir, entry), "utf8")) as FixtureTable);
  const attachments = JSON.parse(readFileSync(join(directory, "attachments.json"), "utf8")) as FixtureAttachment[];
  return { formatVersion: manifest.formatVersion, seed: manifest.seed, tables: tables.sort(byName), attachments };
}

/** The committed corpus, read from disk. */
export function loadCommittedCorpus(): FixtureCorpus {
  return loadCorpusFromDirectory(COMMITTED_CORPUS_DIR);
}

/** Wire column set (own + inherited, phantoms excluded) for every table in a corpus. */
export function wireColumnsByTable(corpus: FixtureCorpus): Map<string, FixtureColumn[]> {
  const tablesBySysId = new Map(corpus.tables.map((table) => [table.sysId, table] as const));
  return new Map(corpus.tables.map((table) => [table.name, resolveWireColumns(table, tablesBySysId)] as const));
}

/**
 * Write a rendered corpus to disk, pruning table files the render no longer
 * produces.
 *
 * The prune is the reason this is not three lines of `writeFileSync` at a call
 * site: dropping a table from `TABLE_SPECS` without deleting its committed file
 * would leave `loadCorpusFromDirectory` (which globs the directory) serving a
 * table the generator no longer knows about — a corpus that regenerates to
 * something different from what it loads, which is the one failure mode the
 * byte-comparison test cannot catch, because it only compares files that exist
 * on both sides.
 *
 * Regeneration is driven by the self-test rather than by an npm script, so that
 * refreshing fixtures needs no change to any manifest this work package does not
 * own. See `fakeInstanceCorpus.test.ts`.
 */
export function writeCorpusFiles(directory: string, files: ReadonlyMap<string, string>): void {
  mkdirSync(join(directory, "tables"), { recursive: true });
  const expected = new Set(files.keys());
  for (const entry of readdirSync(join(directory, "tables"))) {
    if (entry.endsWith(".json") && !expected.has(`tables/${entry}`)) {
      rmSync(join(directory, "tables", entry));
    }
  }
  for (const [relative, contents] of files) {
    writeFileSync(join(directory, relative), contents, "utf8");
  }
}
