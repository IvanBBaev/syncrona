// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mirror pipeline contracts (architecture §4).
 *
 * The mirror engine is a chain of stages — Catalog → Planner → Fetcher →
 * Serializer → Redactor → Writer → ReportGenerator — that are developed as
 * separate work packages. These interfaces are the seams between them, so they
 * are declared once, here, and never re-declared locally by a stage.
 *
 * This file is deliberately PARTIAL and grows one work package at a time. WP-M5
 * (the serializer) declared {@link TableCatalogEntry}/{@link FieldDescriptor} and
 * {@link SerializedRecord}; WP-M3 (config loader + HTTP client) appended §4.1's
 * {@link MirrorConfig} and the transport shapes its client produces; WP-M6 (the
 * redactor) appended {@link RedactedRecord}. The remaining §4 contracts
 * (`SyncPlan`, `PlannedTable`, `FetchPage`, `CheckpointState`, `RunReport`, …)
 * belong to their own work packages and are expected to be ADDED here rather
 * than to replace what exists.
 */

/**
 * One column of one table, as the catalog resolved it (§4.2).
 *
 * Everything the serializer is allowed to know about a column arrives through
 * this descriptor. That is the point: the serializer decides *how* to render a
 * value but never *which* columns are suppressed, because a suppression rule
 * that lived in the serializer would be invisible to the run report, and D7
 * requires every active suppression to be enumerable.
 */
export interface FieldDescriptor {
  /** Column name as it appears in `sys_dictionary.element` and on the wire. */
  element: string;
  /** `sys_dictionary.internal_type` — the platform field type. */
  internalType: string;
  /**
   * File extension for a field that is extracted to its own sibling file
   * (`script` → `"js"`, `css` → `"css"`, …), or `null` to keep the value inside
   * the record envelope. Orthogonal to {@link isJsonBlob}: this decides WHERE
   * the value goes, `isJsonBlob` decides HOW it is interpreted.
   */
  extractAs: string | null;
  /**
   * Whether the column holds a JSON document as a string, so the serializer can
   * parse it and re-emit it canonically. Without this a one-character change
   * inside a minified blob shows up in git as a single unreadable multi-kilobyte
   * line.
   */
  isJsonBlob: boolean;
  /**
   * Whether the column is churn with no informational value (per-row counters,
   * cache timestamps). Noise columns are omitted from the mirror entirely; the
   * catalog owns the list so the report can name it.
   */
  isNoise: boolean;
  /**
   * Whether the column must never be written, by field TYPE (D19). This is
   * load-bearing rather than cosmetic: a `password2` column is returned by the
   * Table API as ciphertext, not as a mask, so a serializer that treated it as
   * an ordinary string would commit recoverable secrets to git.
   */
  isDenied: boolean;
  /** Referenced table for a reference column, else `null`. */
  reference: string | null;
  /** `sys_dictionary.max_length`, when the dictionary declares one. */
  maxLength: number | null;
}

/**
 * One table, as the catalog resolved it (§4.2).
 *
 * `fields` is the union of the table's own dictionary rows and every inherited
 * row along the `super_class` chain (D21) — a table that inherits most of its
 * columns would otherwise be serialized as if those columns were uncataloged.
 */
export interface TableCatalogEntry {
  /** Table name (`sys_db_object.name`). */
  name: string;
  /** `sys_db_object.sys_id`. */
  sysId: string;
  /** Parent table name for an extended table, else `null`. */
  superClass: string | null;
  /** Whether the table is application metadata rather than operational data. */
  isMetadata: boolean;
  /** Mirror tier the table was assigned to. */
  tier: 1 | 2 | 3;
  /** Row count as measured by the catalog, or `null` when not measured. */
  rowCount: number | null;
  /** Highest `sys_updated_on` seen, or `null` when not measured. */
  maxUpdatedOn: string | null;
  /** Column descriptors, including inherited ones (D21). */
  fields: FieldDescriptor[];
  /** Why the table is (or is not) part of this run. */
  status:
    | "included"
    | "excluded-config"
    | "excluded-tier"
    | "skipped-empty"
    | "acl-denied";
}

/**
 * One record, canonicalized but NOT yet redacted (§4.6).
 *
 * PRE-REDACTION. This value may still contain secrets that only a value scan can
 * find, so it must never reach the Writer: INV-3 gives the Writer a
 * `RedactedRecord` (a branded type only the Redactor can mint), which makes
 * "wrote un-redacted bytes to disk" a compile error rather than a review item.
 * The type is exported because the Redactor has to name its own input; the
 * invariant is enforced by the brand on the Writer's side, not by hiding this
 * declaration.
 *
 * "Canonical" here means the VALUE set is final: empty values dropped, noise and
 * denied columns absent, JSON blobs parsed, unparseable blobs marked. It does not
 * mean the key ORDER of `recordJsonValue` is the on-disk order — a JavaScript
 * object cannot carry §8's ordering (integer-like keys are re-ordered by the
 * language itself). Ordering is a property of the bytes and belongs to
 * `canonicalJsonText`, which is the only supported way to render this value.
 */
export interface SerializedRecord {
  /** `sys_id` of the record, as it arrived on the wire. */
  sysId: string;
  /** Table the record belongs to. */
  table: string;
  /** The record envelope, as a value; render with `canonicalJsonText`. */
  recordJsonValue: Record<string, unknown>;
  /**
   * Fields extracted to sibling files, sorted by file name. `contents` is text,
   * not bytes: the Redactor still has to scan and possibly rewrite it, and the
   * Writer encodes the final result (§8: UTF-8, LF, one trailing newline).
   */
  extractedFiles: Array<{ fileName: string; contents: string }>;
  /**
   * Names of JSON-blob columns that could not be canonicalized and were stored
   * behind the `raw:` marker instead (F6). Sorted, so it is itself stable.
   */
  parseFailures: string[];
}

/**
 * One record, redacted and rendered to its final bytes (§4.6) — the ONLY type the
 * Writer accepts (INV-3).
 *
 * `__redacted` is a BRAND: a compile-time witness that this value came out of
 * `serialize/redactor.ts`. It has no runtime existence whatsoever — nothing ever
 * assigns it, it is absent from `Object.keys`, and it survives no serialization —
 * so what it buys is a typing guarantee, and it is worth being exact about how far
 * that guarantee reaches.
 *
 * A property typed `unique symbol` is nominal in a way no structural type is.
 * TypeScript 6.0.3 (measured, not assumed) rejects every cross-module attempt to
 * supply one: a plain `symbol` is "not assignable to type 'unique symbol'", and so
 * is a `unique symbol` the forger declares themselves ("Type 'typeof MINE' is not
 * assignable to …"). No expression in the language denotes this type. The only
 * remaining way to obtain a value of this interface is therefore a type ASSERTION
 * — one greppable construct, in one place: `redactor.ts` holds the single `as
 * RedactedRecord` in this package, and `test/redactedRecordBrand.test.ts` fails if
 * a second one appears anywhere under `src/` or `test/`. §9 states the same rule
 * for human reviewers.
 *
 * Two obvious alternatives are weaker, both checked against the same compiler:
 *
 *  - **A witness class** — `declare class Witness { private constructor(); private
 *    readonly x: never }` with `__redacted: Witness`. `new Witness()` is correctly
 *    rejected, but the private member types as `never` and `never` is assignable to
 *    everything, so the literal `{ …, __redacted: undefined as never }` compiles.
 *    The forge still needs a cast, but it is a cast to `never` — a token no
 *    reviewer reads as "I am bypassing redaction", which defeats the point of
 *    making the bypass greppable.
 *  - **An exported brand key** — `declare const BRAND: unique symbol` plus
 *    `readonly [BRAND]: true`. Anything that can import the key can write the
 *    property, and `{ [BRAND]: true, … }` compiles with NO cast at all. The
 *    enforcement point disappears entirely.
 *
 * What the brand honestly does NOT prove: that a value of this type still holds the
 * bytes the redactor produced. `{ ...redacted, recordJsonBytes: other }` type-checks
 * with no cast, because a spread copies the brand along with everything else. No
 * type system prevents that; like the cast, it is a deliberate act and a
 * review-rejection offense (§9).
 */
export interface RedactedRecord {
  /** Brand — see above. Constructible only inside `serialize/redactor.ts`. */
  readonly __redacted: unique symbol;
  /** `sys_id` of the record, carried through from the pre-redaction form. */
  sysId: string;
  /** Table the record belongs to. */
  table: string;
  /** Final canonical bytes of `record.json` (§8): UTF-8, sorted keys, one trailing newline. */
  recordJsonBytes: Uint8Array;
  /**
   * Extracted sibling files, sorted by file name, as final bytes. Bytes rather
   * than text because every §8 decision (encoding, trailing newline) has already
   * been made here: the Writer's job is to put these on disk unchanged, and a
   * `string` would leave it one `TextEncoder` call away from being able to change
   * them.
   */
  extractedFiles: Array<{ fileName: string; contents: Uint8Array }>;
  /**
   * What was redacted and why, in document order. This is the input the run report
   * aggregates: `scan-overflow` is failure class F7 (`redaction-overflow`, exit 2),
   * while the other three are normal operation. `field` is the column name, or a
   * dotted path into a JSON blob (`variables.password`), or the extracted file's
   * name — whatever names the thing a reader would go looking for.
   */
  redactions: Array<{
    field: string;
    reason: "field-type" | "key-pattern" | "value-scan" | "scan-overflow";
  }>;
}

/**
 * Per-table overrides from `mirror.config.js` (§4.1, D7).
 *
 * Both members are optional in the file the operator writes; the loader fills
 * neither in, because "absent" and "explicitly default" have to stay
 * distinguishable here: D7 requires `coverage.json` to enumerate every ACTIVE
 * suppression, and a table whose entry the loader had helpfully populated with
 * defaults would report suppressions the operator never asked for.
 */
export interface PerTableConfig {
  /**
   * Columns the operator declared as churn, dropped from `record.json` (D7).
   * These are USER suppressions and are reported separately from the built-in
   * noise list, so a reader of the coverage report can tell a project decision
   * apart from an engine decision.
   */
  ignoreFields?: string[];
  /**
   * Redaction strength for this table. `"none"` is deliberately spellable —
   * some tables are known-safe and scanning them is wasted budget — but it is a
   * per-table opt-out that the coverage report names, never a global default.
   */
  redact?: "sensitive-keys" | "all" | "none";
}

/**
 * Resolved shape of `mirror.config.js` after loader validation and defaulting (§4.1).
 *
 * This is the POST-validation type, which is why nothing except {@link instance}
 * is optional: every consumer downstream reads `config.sync.pageSize` and
 * `config.attachments.lfsThresholdBytes` directly, without a `??` fallback of its
 * own. Defaults applied in more than one place are defaults that disagree
 * eventually, so `loadMirrorConfig` is the only thing allowed to apply them and
 * this type is the proof that it did.
 *
 * `instance` stays optional because "unset" is meaningful rather than missing: it
 * means "whichever instance the credential store currently marks active", which
 * is a decision that can only be made at connection time.
 */
export interface MirrorConfig {
  /**
   * On-disk format the config was written against (INV-8). Pinned to 1 — a
   * future format bump ships with a migration, and a config claiming a version
   * this build does not know is a hard error rather than a best-effort read.
   */
  formatVersion: 1;
  /** Credential-store instance alias; unset means "the active instance". */
  instance?: string;
  /** `"all"`, or an explicit list of application scopes to mirror. */
  scopes: "all" | string[];
  /** Tier switches. T1/T2 are always mirrored, T4 never; only T3 is a choice. */
  tiers: { referenceData: boolean };
  tables: {
    /** Force-included beyond the tier rules. */
    include: string[];
    /** Never fetched — and named in the coverage report, because R3 forbids a silent skip. */
    exclude: string[];
    /** Overrides keyed by table name; see {@link PerTableConfig}. */
    perTable: Record<string, PerTableConfig>;
  };
  /**
   * Attachment policy. `lfsThresholdBytes` applies to binaries only — see
   * `LFS_THRESHOLD_BYTES` for why pointing text at LFS is a measured loss.
   */
  attachments: { enabled: boolean; lfsThresholdBytes: number };
  /** `sys_properties` keys that may be committed verbatim instead of redacted. */
  redaction: { propertyAllowlist: string[] };
  /** Which regenerable derived views to build (D9). */
  derived: { forms: boolean; workflows: boolean; refs: boolean; aclMatrix: boolean };
  sync: {
    /** Every Nth sync is promoted to a full reconcile. */
    reconcileEveryNSyncs: number;
    /** Sustained request rate; bounded by `RPS_MAX`. */
    requestsPerSecond: number;
    /** Rows per Table API page. */
    pageSize: number;
  };
  /**
   * Expected-drift rules for the cross-instance diff REPORT only (D13). They
   * never suppress anything in the mirror itself: a rule here changes what a
   * comparison highlights, not what the tree contains.
   */
  diffIgnore: Array<{ table: string; field?: string; sysId?: string }>;
}

/**
 * The failure taxonomy F1–F9, as a type (§4.7, analyses §2).
 *
 * Declared here rather than inside the transport because it is what the run
 * report ultimately aggregates: the classes are the vocabulary the coverage file
 * and the 0/1/2 exit-code contract (R1) are written in. The transport is simply
 * the first stage that can produce one.
 */
export type MirrorFailureClass =
  | "transient"
  | "auth"
  | "acl"
  | "unreachable"
  | "hibernating"
  | "schema-drift"
  | "parse"
  | "redaction-overflow"
  | "local-io"
  | "name-collision";

/**
 * One page of rows as the transport read them off the wire.
 *
 * Values are strings, not `unknown`: the mirror always requests
 * `sysparm_display_value=false` and `sysparm_exclude_reference_link=true`, which
 * M7 measured turns a reference column into a plain sys_id string rather than a
 * `{value, link}` object, and M8 measured that an empty value arrives as `""`
 * rather than as null. Typing the row as `Record<string, string>` records those
 * measurements in the type system instead of in a comment nobody reads.
 *
 * §4.5's `FetchPage` is the FETCHER's contract (WP-M8) and is deliberately not
 * declared yet. This is the CLIENT's page result and is structurally the same
 * shape today; when WP-M8 lands it should alias `FetchPage` to this type rather
 * than declare a second one, for the same single-source-of-truth reason §11
 * gives for its re-exports.
 */
export interface TablePage {
  /** Rows in `sys_id` order — the order the keyset cursor depends on. */
  rows: Array<Record<string, string>>;
  /** Cursor for the next page: the last row's `sys_id`, or null on an empty page. */
  lastSysId: string | null;
  /**
   * Whether the walk is finished. True when the page came back short of the
   * requested limit, which is the only end-of-table signal the mirror trusts:
   * the pagination header it would otherwise read is explicitly suppressed
   * (`sysparm_suppress_pagination_header=true`) because computing it costs the
   * instance a COUNT on every page.
   */
  done: boolean;
}

/**
 * Aggregate API result for one table (§5.2).
 *
 * `count` is a number here even though M3 measured that the Aggregate API sends
 * it as a STRING — the conversion happens once, at the client boundary, so that
 * no downstream stage can accidentally compare `"1000" > 999` lexically. That
 * bug is silent, plausible, and would corrupt exactly the completeness check
 * this value exists to feed.
 */
export interface TableAggregate {
  /** `COUNT` of rows visible to the mirroring account. */
  count: number;
  /** `MAX(sys_updated_on)`, or null when the table is empty or the field was not returned. */
  maxUpdatedOn: string | null;
}

/** One `sys_attachment` row, as the transport read it (§5.2). */
export interface AttachmentMeta {
  /** `sys_attachment.sys_id` — the handle {@link AttachmentBinary} is fetched by. */
  sysId: string;
  /** Table the attachment hangs off. */
  tableName: string;
  /** `sys_id` of the record the attachment hangs off. */
  tableSysId: string;
  /** File name as stored on the instance, unfolded — path safety is the writer's job. */
  fileName: string;
  /** `content_type` as reported by the instance, or null when it sent none. */
  contentType: string | null;
  /**
   * Size in bytes, or null when the instance reported none. Compared against
   * `LFS_THRESHOLD_BYTES` to decide LFS storage, which is why null is preserved
   * rather than defaulted to 0: a missing size must not be silently read as
   * "small enough to commit inline".
   */
  sizeBytes: number | null;
}

/** One attachment's bytes (§5.2, Δ1 — the mirror owns its own binary GET). */
export interface AttachmentBinary {
  /** The raw file content. Never decoded, never re-encoded. */
  bytes: Uint8Array;
  /** `content-type` response header, or null when absent. */
  contentType: string | null;
}

/**
 * The response half of the transport seam.
 *
 * A deliberately minimal structural subset of the platform's `Response` so that
 * the platform value satisfies it without an adapter, while a test can satisfy it
 * with an object literal. Only what the client actually consumes appears here:
 * a status, a case-insensitive header lookup, and the two body readers (text for
 * JSON payloads, bytes for attachments).
 */
export interface MirrorHttpResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Case-insensitive header lookup; null when the header was not sent. */
  readonly headers: { get(name: string): string | null };
  /** The body as text. The client parses JSON itself so it can report bad JSON. */
  text(): Promise<string>;
  /** The body as bytes — the attachment path (Δ1). */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The request half of the transport seam.
 *
 * `method` is the literal `"GET"`, not `string`. That is INV-2 expressed in the
 * type system: the seam has no way to SPELL a state-changing verb, so a future
 * edit that tried to add one would fail to compile long before the built-output
 * scan in the test suite caught it. The scan stays anyway, because a type is
 * erased at runtime and the invariant is about the shipped artifact.
 */
export interface MirrorHttpRequestInit {
  method: "GET";
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * The transport seam itself — everything the mirror's HTTP client needs from the
 * outside world, in one injectable function.
 *
 * The seam exists so the client is testable without a network and without a
 * server: a fake is a function, not a process. It is also what keeps Δ1 honest —
 * the mirror owns its own client rather than reaching into the core CLI's, and
 * the only thing it borrows from the platform is a single call shape.
 */
export type MirrorFetch = (
  url: string,
  init: MirrorHttpRequestInit
) => Promise<MirrorHttpResponse>;

/**
 * One shard manifest — the mirror's index of what it wrote for a slice of one
 * table (§4.3, WP-M7).
 *
 * A shard file lives at `instance/<scope>/<table>/.shards/<prefix>.json` and
 * indexes exactly the records whose `sys_id` starts with {@link shard}. There is
 * deliberately NO monolithic per-table manifest (D15): the v1 `.sincronia.json`
 * is a single file every sync rewrites whole, which makes two developers syncing
 * the same instance a guaranteed merge conflict on a file neither of them can
 * read. Splitting by sys_id prefix means an edit to one record touches one shard,
 * and the entries below are rendered one field per line so that when two people
 * do land in the same shard, git's line-level merge resolves it.
 *
 * Every shard on disk carries the R2/INV-4 promise: it was written only after its
 * table's sweep finished. A half-swept table has no shard at all — its progress
 * lives in `.mirror/state/checkpoint.json`, which is gitignored precisely because
 * it is the one file allowed to describe an unfinished state.
 */
export interface ShardManifest {
  /** On-disk format version (§11, INV-8) — bumped only with a migration. */
  formatVersion: 1;
  /** Table these records belong to, e.g. `sys_script_include`. */
  table: string;
  /** sys_id hex prefix ("" when fanout 0); length === fanout. */
  shard: string;
  /** Hex-prefix fan-out depth for this table: 0 = single file, 1 = 16 shards,
   *  2 = 256. Chosen at the table's first complete sweep per SHARD_FANOUT (§11)
   *  and STICKY thereafter — changed only via `mirror migrate` (D16). */
  fanout: 0 | 1 | 2;
  /** INV-4: the set is a complete index — established by a finished full sweep,
   *  preserved when an incremental flush overlays a complete baseline (§5.4
   *  watermark eligibility reads this). Never deletion evidence (INV-5). */
  complete: boolean;
  /** Identifier of the sweep that last wrote this shard. */
  sweepId: string;
  records: Record<string, RecordEntry>; // key = sys_id, validated INV-6
}

/**
 * One record's entry in a shard manifest (§4.3).
 *
 * This is the mirror's claim about a directory under `instance/`: where it is,
 * what the instance's own change-tracking columns said when it was written, and a
 * content hash that lets `mirror verify` detect a tree edited behind the mirror's
 * back without re-fetching anything. The instance columns are carried rather than
 * derived because an incremental sweep decides what to re-fetch by comparing them
 * — a hash alone would require reading every record back off disk to answer
 * "is this stale?".
 */
export interface RecordEntry {
  path: string;                        // repo-relative record directory
  name: string;                        // folded record name (design §7.4)
  /** `sys_updated_on` as the instance reported it. */
  sysUpdatedOn: string;
  /** `sys_updated_by` as the instance reported it. */
  sysUpdatedBy: string;
  /** `sys_mod_count` as the instance reported it. */
  sysModCount: number;
  contentHash: string;                 // sha256 hex of canonical record.json bytes
  files: string[];                     // extracted field files, sorted
  attachments?: Array<{ sysId: string; fileName: string; sizeBytes: number; sha256: string; lfs: boolean }>;
}

/**
 * The Fetcher's page contract (§4.5, WP-M8).
 *
 * An alias rather than a second declaration, exactly as the note on
 * {@link TablePage} asked for. §4.5 names this type and §5.2 names that one, and
 * they describe the same bytes at two stages of the same walk; declaring both
 * would create a pair that starts identical and drifts the first time one of them
 * gains a field. The alias keeps both spec names usable in prose while there is
 * only ever one shape to keep true.
 */
export type FetchPage = TablePage;

/**
 * One table, and how the Planner decided to read it (§4.5).
 *
 * `strategy` is not a preference — it is a claim about what the resulting shard
 * will mean. A `sweep` reads the whole table and therefore produces evidence that
 * a record is ABSENT, which is the only thing INV-5 accepts as authority to
 * delete. A `watermark` read sees only rows changed since a lower bound, so its
 * silence about a record means nothing at all. Everything downstream of this
 * field branches on that difference, which is why it is a discriminated string
 * and not, say, an optional `watermark` alone: an absent watermark and a sweep
 * are the same value in that encoding, and "we swept" would become inferable from
 * a missing field rather than stated.
 */
export interface PlannedTable {
  /** The catalog's description of the table, carried whole so the Fetcher needs no second lookup. */
  entry: TableCatalogEntry;
  /** `sweep` = read every row; `watermark` = read only rows changed since {@link watermark}. */
  strategy: "sweep" | "watermark";
  /**
   * ISO-8601 `sys_updated_on` lower bound, already reduced by
   * `WATERMARK_OVERLAP_MS`. Present if and only if `strategy === "watermark"`.
   *
   * The overlap is not paranoia about clocks: design §9.2 records that a record's
   * `sys_updated_on` is stamped when the transaction's business rules run, while
   * it becomes VISIBLE to a query when the transaction commits, so a row can
   * appear with a timestamp already behind a watermark taken moments earlier.
   * Re-reading five minutes of overlap costs a few rows; missing that window
   * loses a record silently until the next reconcile.
   */
  watermark?: string;
}

/**
 * The Planner's output: what this sync will read, in the order it will read it
 * (§4.5).
 *
 * The order is part of the contract, not an implementation detail. Coverage rows,
 * the report, and the failure list are all rendered from this sequence, and all
 * three are committed files — an unstable order turns "nothing changed" into a
 * diff. Tier ascending then name ascending gives it a definition that does not
 * depend on the order the instance returned tables in.
 */
export interface SyncPlan {
  /** Identifier stamped into every shard and the coverage report this sync writes. */
  sweepId: string;
  /** What kind of read this is — the same vocabulary the checkpoint and coverage use. */
  mode: SyncMode;
  /** Tables to read, ordered tier ascending then name ascending. */
  tables: PlannedTable[];
  /**
   * Aggregate readings taken BEFORE the sweep, per table, when
   * `--verify-quiescent` was requested (D1); absent otherwise.
   *
   * The pair (count, maxUpdatedOn) re-read after the sweep is the only evidence
   * the mirror will ever have that the instance held still while it read. Absent
   * here means the question was not asked — which is why coverage's `quiescent`
   * is a THREE-valued `boolean | null` and not a boolean defaulting to false:
   * "we did not check" and "we checked and it moved" are different claims, and
   * collapsing them would let an unchecked run read as a disproven one.
   */
  preQuiescence?: Record<string, QuiescenceReading>;
}

/** One Aggregate reading of a table, used as quiescence evidence (D1). */
export interface QuiescenceReading {
  /** `COUNT` of rows visible to the mirroring account. */
  count: number;
  /** `MAX(sys_updated_on)`, or null when the table is empty. */
  maxUpdatedOn: string | null;
}

/**
 * What kind of read a sync performs (§4.5, §4.7, §4.4).
 *
 * One type, used by the plan, the checkpoint and the coverage report alike. They
 * are three files that must agree about a single run, and three independently
 * declared string unions would let a fourth value be added to one of them.
 */
export type SyncMode = "full" | "incremental" | "reconcile";

/**
 * Why a table is less than fully mirrored (§4.4).
 *
 * R3 makes this list total: every degradation the mirror can produce has to land
 * on one of these strings, and adding a failure mode without adding a reason is
 * defined as incomplete work. That is what keeps the coverage file answerable —
 * a table marked `partial` with no reason is a report that says "something went
 * wrong somewhere", which is indistinguishable from no report at all.
 */
export type CoverageReason =
  | "transient-exhausted"
  | "acl-403"
  | "not-visible"
  | "instance-unreachable"
  | "column-missing"
  | "parse-failure"
  | "redacted-overflow"
  | "excluded-config"
  | "excluded-tier"
  | "not-exportable";

/**
 * What the sync achieved for one table (§4.4).
 *
 * `expectedRows` is nullable because the Aggregate API is the source of the
 * number and it is not always available — an ACL can deny the aggregate while
 * allowing the rows, and analyses §5 measured an instance returning a null
 * aggregate for a table it happily paged. A null here means "no independent
 * count exists", and a completeness claim must not be manufactured from
 * `mirroredRows` alone: that would compare the sweep against itself.
 */
export interface TableCoverage {
  /** `complete` = every expected row mirrored; `partial` = some rows are missing and {@link reason} says why. */
  status: "complete" | "partial" | "skipped" | "failed";
  /** Required for `partial`, `skipped` and `failed`; absent for `complete` (R3). */
  reason?: CoverageReason;
  /** Aggregate COUNT taken during planning, or null when the Aggregate API gave none. */
  expectedRows: number | null;
  /** Records actually written to the tree for this table. */
  mirroredRows: number;
  /** D8: fields stored as opaque blobs rather than decomposed, e.g. a workflow definition. */
  notDecomposed?: string[];
  /** D2: reference values naming a record this mirror does not hold. Reported, never repaired. */
  danglingRefs?: number;
}

/**
 * One suppressed field, and who suppressed it (D7).
 *
 * The mirror drops fields for three unrelated reasons and a reader of the tree
 * cannot tell them apart from the tree: a field the instance never sent, a field
 * the user's config excluded, and a field redaction refused all look identical —
 * absent. D7's answer is to enumerate every active suppression in the coverage
 * report, so "this field is not in the mirror" always has a stated cause.
 */
export interface CoverageSuppression {
  /** Table the rule applies to, or `*` for a rule that applies to all of them. */
  table: string | "*";
  /** Field name as it appears on the instance. */
  field: string;
  /** Which of the three mechanisms dropped it. */
  source: "builtin-noise" | "config-ignore" | "redaction-deny";
}

/**
 * `coverage.json` — the committed, machine-readable account of one sync (§4.4).
 *
 * This file is the mirror's answer to the only question that matters about a
 * backup: not "did it succeed" but "what is in it, and what is knowably not".
 * It is written on every outcome including a fatal one, because a sync that died
 * halfway has a coverage story too, and a missing report is the one result a
 * reader cannot interpret.
 */
export interface CoverageReport {
  /** On-disk format version (§11, INV-8). */
  formatVersion: 1;
  /** The sweep this report describes — matches the shards it was written beside. */
  sweepId: string;
  /** What kind of read produced it. */
  mode: SyncMode;
  /** ISO-8601 start, taken once at plan time. */
  startedAt: string;
  /** ISO-8601 finish. */
  finishedAt: string;
  /** D1: true = proven quiescent, false = the instance moved, null = not checked. */
  quiescent: boolean | null;
  /** R1: 0 complete / 1 fatal-incomplete / 2 completed-with-partials. */
  exitCode: 0 | 1 | 2;
  /** Run-level counts, each derivable from {@link tables} but rendered once for a reader. */
  totals: {
    /** Tables the catalog discovered, before config and tier filtering. */
    tablesDiscovered: number;
    /** Tables with at least one record written. */
    tablesMirrored: number;
    /** Records written across all tables. */
    recordsMirrored: number;
    /** Field values the Redactor replaced or dropped. */
    redactions: number;
    /** D2: reference values pointing outside the mirror. */
    danglingRefs: number;
  };
  /** D7: every active suppression, sorted for a stable diff. */
  suppressions: CoverageSuppression[];
  /** Per-table outcome, keyed by table name. */
  tables: Record<string, TableCoverage>;
}

/**
 * The resume file — the ONLY artifact allowed to describe an unfinished sweep
 * (§4.7).
 *
 * It lives under `.mirror/state/` and is gitignored, which is not an accident of
 * tidiness: INV-4 says a shard on disk means a finished table sweep, so the
 * partial progress has to live somewhere that is definitionally not the tree.
 * Committing this file would make the repository claim a state the mirror has
 * explicitly promised it never claims.
 *
 * `completedTables` is a list rather than a count because resume must skip
 * exactly the tables already done, and a plan re-derived on the second run can
 * legitimately differ from the first — the catalog is re-read, and a table can
 * appear or vanish between runs. Matching by name survives that; matching by
 * index would silently resume into the wrong table.
 */
export interface CheckpointState {
  /** On-disk format version (§11, INV-8). */
  formatVersion: 1;
  /** The sweep being resumed. A different id means a different run — start over. */
  sweepId: string;
  /** Mode of the interrupted run; a resume must not change it. */
  mode: SyncMode;
  /** ISO-8601 start of the interrupted run. */
  startedAt: string;
  /** Tables whose sweep finished and whose shards are therefore on disk. */
  completedTables: string[];
  /** The table that was mid-sweep, and the keyset cursor to resume it from. */
  inProgress?: { table: string; lastSysId: string };
  /** Carried across the interruption so a resumed run can still prove quiescence (D1). */
  preQuiescence?: SyncPlan["preQuiescence"];
}
