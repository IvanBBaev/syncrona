// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The derived layer's ONLY window onto the world — the canonical tree (INV-9, §5.12).
 *
 * INV-9: "`_derived/` is regenerated from the canonical tree alone." Every byte a
 * derived view emits must be a function of what is on disk under `instance/` —
 * never of the network, never of the clock, never of the order a filesystem
 * happens to enumerate directory entries in. This module is where that promise is
 * enforced structurally rather than by discipline: the view builders receive a
 * {@link CanonicalTreeReader} and nothing else, so the only inputs they CAN
 * consume are shard manifests and `record.json` envelopes, and every list this
 * reader hands out is already sorted with {@link compareBytewise}. A view builder
 * that iterates what it is given cannot accidentally depend on enumeration order,
 * because enumeration order never reaches it.
 *
 * Why shard manifests and not a directory walk? The `.shards` manifests are the
 * writer's own statement of which records the tree claims (INV-4), including each
 * record's sys_id, folded display name (§7.4) and repo-relative path. Walking
 * record directories instead would re-derive all of that from file names —
 * lossily, because the folded name is not invertible — and would happily pick up
 * a half-deleted record whose shard no longer claims it. The manifests are the
 * canonical index of the canonical layer; the derived layer reads the index.
 *
 * Error stance, matching `shardStore`'s own:
 *
 *  - A shard manifest that exists but does not parse is corruption of the
 *    mirror's own index and THROWS (`ShardManifestCorrupt`, propagated from
 *    `loadShardSet`). Rendering derived views over an index known to be broken
 *    would launder the corruption into committed, plausible-looking Markdown.
 *  - A `record.json` that is missing or does not parse is a per-record wound,
 *    not an index failure: the record still participates through its shard entry
 *    (name, path), its envelope is `null`, and the wound is named in
 *    {@link CanonicalTreeReader.anomalies} (R3: no silent skips). Throwing here
 *    would let one hand-mangled record veto every derived view of the instance.
 *
 * D2 lives downstream of this file but is shaped by it: the reader reports what
 * the tree contains and never "fixes" it — a sys_id claimed by two scopes, an
 * unreadable envelope, a hostile directory name are all surfaced as anomalies
 * and left exactly as found.
 */
import type { RecordEntry } from "../contracts";
import { compareBytewise } from "../order";
import {
  INSTANCE_DIR_NAME,
  RECORD_FILE_NAME,
  SHARD_DIR_NAME,
  repoPath,
} from "../shards/shardLayout";
import { listScopesWithShards, loadShardSet } from "../shards/shardStore";
import { isStagingName } from "../write/atomicWrite";
import type { WriterFs } from "../write/fs";
import { toNativePath } from "../write/fs";
import { isSafePathComponent } from "@syncrona/sn-transport";

/**
 * One record as the canonical tree claims it: the scope whose shard set lists
 * it, the shard's {@link RecordEntry} (folded name, repo-relative record
 * directory, content hash), and the sys_id it is filed under.
 */
export interface CanonicalRecordRef {
  scope: string;
  table: string;
  sysId: string;
  entry: RecordEntry;
}

/**
 * Everything the tree knows about one table, pre-sorted so consumers stay
 * deterministic by construction.
 *
 * `refs` vs `records` is a deliberate split. `refs` is every on-disk row,
 * ordered by (scope, sys_id) — the per-scope reference indexes need rows AS
 * FILED, including a sys_id that two scopes both claim (a tree defect the
 * reader reports but must not hide). `records` is the deduplicated view — one
 * ref per sys_id, the bytewise-first scope winning, sorted by sys_id — which is
 * what the graph-flattening views want, because a form rendered twice for the
 * same sys_id would be repair-by-duplication of a defect D2 says to report.
 */
export interface TableData {
  table: string;
  /** Scopes holding a shard set for this table, sorted. Empty ⇒ table not mirrored. */
  scopes: string[];
  /**
   * True only when the table is mirrored AND every scope's shard set is marked
   * complete (INV-4). Dangling-reference detection keys off this: absence of a
   * sys_id from an INCOMPLETE set is not evidence of anything.
   */
  complete: boolean;
  /** Every on-disk row, sorted by (scope, sys_id). */
  refs: CanonicalRecordRef[];
  /** One ref per sys_id (bytewise-first scope wins), sorted by sys_id. */
  records: CanonicalRecordRef[];
  /** sys_id → winning ref; same contents as `records`. */
  bySysId: Map<string, CanonicalRecordRef>;
}

/**
 * A named defect or named skip observed while generating derived views (R3).
 *
 * `source` says which part of the generation noticed it — "tree" for the reader
 * itself, otherwise the view. The final summary sorts these bytewise, so their
 * order is as reproducible as the views themselves.
 */
export interface DerivedAnomaly {
  source: "tree" | "forms" | "workflows" | "refs" | "aclMatrix";
  detail: string;
}

/**
 * Envelope field access that survives hostile field names.
 *
 * Returns the field's value only when the envelope is readable, the field is
 * present, its value is a string and the string is non-empty. The serializer
 * drops empty values (§7.2), so an empty string can only mean a hand-edited
 * envelope — treating it as absent keeps the views' output identical to what a
 * faithful envelope would have produced. The `Map` (not the parsed object)
 * is what makes a column named `constructor` an ordinary column instead of a
 * walk up `Object.prototype`.
 */
export function envelopeField(
  fields: ReadonlyMap<string, string> | null,
  name: string
): string | null {
  if (fields === null) {
    return null;
  }
  const value = fields.get(name);
  return value === undefined || value === "" ? null : value;
}

/**
 * Memoizing reader over one mirror repo's canonical tree.
 *
 * Memoization is not an optimisation nicety here: several views read the same
 * tables (`refs` reads everything), and reading a table twice must not report
 * its wounds twice — an anomaly list that grew with the number of enabled views
 * would make the summary a function of configuration in a way nobody asked for.
 * Caching by table (and by record path for envelopes) pins each observation to
 * exactly one report.
 */
export class CanonicalTreeReader {
  private readonly tableCache = new Map<string, Promise<TableData>>();
  private readonly envelopeCache = new Map<string, Map<string, string> | null>();

  constructor(
    private readonly fs: WriterFs,
    private readonly root: string,
    /** Shared collector; the entry point owns and finally sorts it. */
    readonly anomalies: DerivedAnomaly[]
  ) {}

  /**
   * Every table name that has at least one shard set anywhere under
   * `instance/`, sorted bytewise.
   *
   * This is the one place the derived layer enumerates directories itself —
   * `listScopesWithShards` answers "which scopes hold table T" but nothing in
   * the shard store answers "which tables exist", so the reader inverts the same
   * walk: list `instance/`, list each scope, and accept a child directory as a
   * table exactly when its `.shards` listing is non-null. The same exclusions
   * apply as in the store (staging names are a crashed run's garbage), plus one
   * of its own: a directory name that fails `isSafePathComponent` (dots-only,
   * for instance) cannot be re-joined into a path without tripping the layout
   * layer's assertions, so it is skipped — by name, into the anomaly list, never
   * silently (R3).
   */
  async discoverTables(): Promise<string[]> {
    const scopeListing = await this.fs.readDir(
      toNativePath(this.root, INSTANCE_DIR_NAME)
    );
    if (scopeListing === null) {
      return [];
    }
    const tables = new Set<string>();
    for (const scopeEntry of scopeListing) {
      if (!scopeEntry.isDirectory || isStagingName(scopeEntry.name)) {
        continue;
      }
      if (!isSafePathComponent(scopeEntry.name)) {
        this.anomalies.push({
          source: "tree",
          detail: `instance/ contains a directory whose name is not a safe path component: ${JSON.stringify(scopeEntry.name)}; not treated as a scope`,
        });
        continue;
      }
      const children = await this.fs.readDir(
        toNativePath(this.root, repoPath(INSTANCE_DIR_NAME, scopeEntry.name))
      );
      /* istanbul ignore if -- @preserve: the entry was listed as a directory one
         call earlier; readDir returning null here requires the tree to mutate
         between the two calls, and nothing mutates the tree while derived views
         generate. */
      if (children === null) {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory || isStagingName(child.name)) {
          continue;
        }
        if (!isSafePathComponent(child.name)) {
          this.anomalies.push({
            source: "tree",
            detail: `scope ${scopeEntry.name} contains a directory whose name is not a safe path component: ${JSON.stringify(child.name)}; not treated as a table`,
          });
          continue;
        }
        const shardListing = await this.fs.readDir(
          toNativePath(
            this.root,
            repoPath(INSTANCE_DIR_NAME, scopeEntry.name, child.name, SHARD_DIR_NAME)
          )
        );
        if (shardListing !== null) {
          tables.add(child.name);
        }
      }
    }
    return [...tables].sort(compareBytewise);
  }

  /**
   * The tree's claim for one table, loaded once per generation run.
   *
   * The promise (not its result) is cached so concurrent callers share one
   * load. `ShardManifestCorrupt` from `loadShardSet` propagates — see the
   * module docblock for why corruption of the index is fatal while corruption
   * of a record is a report.
   */
  table(name: string): Promise<TableData> {
    const cached = this.tableCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const loading = this.loadTable(name);
    this.tableCache.set(name, loading);
    return loading;
  }

  private async loadTable(table: string): Promise<TableData> {
    const scopes = await listScopesWithShards(this.fs, this.root, table);
    const refs: CanonicalRecordRef[] = [];
    const records: CanonicalRecordRef[] = [];
    const bySysId = new Map<string, CanonicalRecordRef>();
    let complete = scopes.length > 0;
    // `scopes` is sorted, and within a scope the sys_ids are sorted below, so
    // `refs` comes out ordered by (scope, sys_id) without a final sort — and,
    // because the FIRST scope claiming a sys_id wins `bySysId`, "bytewise-first
    // scope wins" is the same statement as "first writer wins" here.
    for (const scope of scopes) {
      const set = await loadShardSet(this.fs, this.root, scope, table);
      if (!set.complete) {
        complete = false;
      }
      const sorted = [...set.entries.entries()].sort(([a], [b]) =>
        compareBytewise(a, b)
      );
      for (const [sysId, entry] of sorted) {
        const ref: CanonicalRecordRef = { scope, table, sysId, entry };
        refs.push(ref);
        const existing = bySysId.get(sysId);
        if (existing === undefined) {
          bySysId.set(sysId, ref);
          records.push(ref);
        } else {
          // A sys_id filed by two scopes is a tree defect (each record lives in
          // exactly one scope on the instance). Reported, never repaired (D2's
          // stance, applied to the tree's own graph).
          this.anomalies.push({
            source: "tree",
            detail: `${table}/${sysId}: claimed by shard sets of both ${existing.scope} and ${scope}; derived lookups use ${existing.scope}`,
          });
        }
      }
    }
    return { table, scopes, complete, refs, records, bySysId };
  }

  /**
   * The record's `record.json` envelope as a string-field map, or `null` when
   * the file is missing or not a JSON object.
   *
   * Only string-valued fields are kept. Per the serializer, that is every flat
   * column value; the non-string values an envelope can hold are parsed
   * JSON-blob columns, which no derived view consumes — a view that one day
   * needs them should extend THIS accessor rather than reach past it, because
   * this is where prototype safety lives (`Object.entries`, own enumerable
   * properties only).
   *
   * Cached by record path so one wound is reported once, however many views
   * look at the record.
   */
  async envelope(
    ref: CanonicalRecordRef
  ): Promise<ReadonlyMap<string, string> | null> {
    const cacheKey = ref.entry.path;
    const cached = this.envelopeCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const fields = await this.readEnvelope(ref);
    this.envelopeCache.set(cacheKey, fields);
    return fields;
  }

  private async readEnvelope(
    ref: CanonicalRecordRef
  ): Promise<Map<string, string> | null> {
    const bytes = await this.fs.readFile(
      toNativePath(this.root, repoPath(ref.entry.path, RECORD_FILE_NAME))
    );
    if (bytes === null) {
      this.anomalies.push({
        source: "tree",
        detail: `${ref.table}/${ref.sysId} (${ref.scope}): ${RECORD_FILE_NAME} missing under ${ref.entry.path}`,
      });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      this.anomalies.push({
        source: "tree",
        detail: `${ref.table}/${ref.sysId} (${ref.scope}): ${RECORD_FILE_NAME} does not parse: ${String(error)}`,
      });
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.anomalies.push({
        source: "tree",
        detail: `${ref.table}/${ref.sysId} (${ref.scope}): ${RECORD_FILE_NAME} is not a JSON object envelope`,
      });
      return null;
    }
    const fields = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        fields.set(key, value);
      }
    }
    return fields;
  }
}
