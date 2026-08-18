// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * DriftDetector — the engine behind `mirror status` (architecture §5.10).
 *
 * One comparison, stated once: for every table, the live instance's Aggregate
 * view (`COUNT` plus `MAX(sys_updated_on)`) against what the shard manifests on
 * disk claim. Cheap enough for a CI cron — two aggregate numbers per table, no
 * row reads — and honest about what cheapness cannot see: a row edited without
 * its `sys_updated_on` moving leaves both aggregates unchanged, which is what
 * `--deep` (keyset row-hash sampling, {@link DeepSampleOptions}) exists to
 * catch.
 *
 * The verdict discipline is R3's: every table examined gets exactly one verdict,
 * stated in the result, INCLUDING the tables the detector cannot judge. A `null`
 * from `getAggregate` — ACL denial, schema drift, a transient the client already
 * retried — is returned as a `cannot-tell` verdict with a named reason, never
 * manufactured into a drift claim and never silently skipped. The same goes for
 * a shard set this run cannot read (corrupt, fan-out conflict): unreadable
 * baseline, honest `cannot-tell`; damage on disk is `mirror verify`'s charge,
 * not evidence about the instance. The three run-stopping failure classes —
 * `auth`, `unreachable`, `hibernating` — are the exception and propagate as the
 * `MirrorHttpError` the client threw: a run that cannot talk to the
 * instance at all has no per-table verdicts to give, and R1 routes it to exit 1
 * at the CLI boundary, not to exit 2 here.
 *
 * Exit contract (§5.10, R1): 0 when no verdict is a drift kind, 2 when at least
 * one is. Exit 0 therefore means "no drift DETECTED", not "proven in sync" —
 * a result carrying `cannot-tell` verdicts still exits 0, because R3 forbids
 * promoting ignorance to a claim in either direction. The code is derived from
 * the verdicts by {@link detectDrift} itself and never accepted from a caller.
 *
 * Table universe: the union of the caller's live-table list (the catalog's
 * answer for the instance) and the shard-bearing tables the tree actually holds
 * ({@link listMirroredTablePairs}). The union is what makes both asymmetries
 * visible — a live table with no shards is `table-not-mirrored` (drift, unless
 * the live table is empty, in which case there is nothing to mirror and the
 * verdict is `in-sync`), and a shard-bearing table absent from the live list is
 * `table-vanished` (drift: the mirror holds what the instance no longer has).
 * No aggregate is spent on a vanished table — the caller's list is authoritative
 * for what the instance has, and asking the instance about a table the catalog
 * already denied would only convert a firm answer into a `schema-drift` null.
 *
 * Read-only twice over: the tree through {@link MirrorReadFs} (no write method
 * exists to call) and the instance through GET-only client methods (INV-2 —
 * `getAggregate` and `getPage` are both GETs by construction).
 *
 * The word "deep" earns its cost bound: sampling runs only for a table the
 * aggregate comparison already judged `in-sync`. A table whose counts disagree
 * has its verdict; re-fetching rows to say the same thing louder would spend
 * the CI budget §5.10 promises to protect without changing any exit code.
 */

import type {
  MirrorConfig,
  RecordEntry,
  TableCatalogEntry,
} from "../contracts";
import type { PageRequest } from "../http/client";
import type { TableAggregate, TablePage } from "../contracts";
import { compareBytewise } from "../order";
import { serializeAndRedact } from "../pipeline";
import {
  ShardManifestCorrupt,
} from "../shards/shardLayout";
import { ShardFanoutConflict, loadShardSet } from "../shards/shardStore";
import { pageFields } from "../sync/fetcher";
import { sha256Hex } from "../write/contentHash";
import { listMirroredTablePairs } from "./mirrorTree";
import { readOnlyWriterFs } from "./readOnlyFs";
import type { MirrorReadFs } from "./readOnlyFs";

/**
 * The one client method shallow status needs — a structural subset of
 * `MirrorHttpClient`, so the real client satisfies it unchanged while a test
 * can stand a recorder in front of it.
 */
export interface DriftAggregateSource {
  getAggregate(table: string, extraQuery?: string): Promise<TableAggregate | null>;
}

/** The one client method `--deep` adds. Also satisfied by `MirrorHttpClient`. */
export interface DriftPageSource {
  getPage(
    table: string,
    cursor: string | null,
    request: PageRequest
  ): Promise<TablePage>;
}

/**
 * What `--deep` needs beyond the shallow comparison.
 *
 * The catalog entries and redaction config MUST be the ones the sweep ran with:
 * `contentHash` is the sha-256 of the canonical bytes `serializeAndRedact`
 * produced from the sweep's projection, so re-deriving the same bytes requires
 * the same field set (denied columns dropped, exactly as the fetcher projects)
 * and the same redaction allowlist. An absent `redaction` means the empty
 * allowlist — the most-redacting reading, same as the redactor's own default.
 */
export interface DeepSampleOptions {
  client: DriftPageSource;
  /** Catalog entry per table name; a sampled table missing here is `cannot-tell`. */
  catalog: ReadonlyMap<string, TableCatalogEntry>;
  redaction?: MirrorConfig["redaction"];
  /**
   * Every Kth mirrored sys_id (bytewise order, starting from the first) is
   * re-fetched and re-hashed. Must be an integer >= 1; 1 samples every record.
   */
  sampleEvery: number;
}

export interface DriftDetectorOptions {
  fs: MirrorReadFs;
  /** Repo root, native absolute path. */
  root: string;
  client: DriftAggregateSource;
  /** The live instance's table list — the catalog's answer, caller-supplied. */
  tables: readonly string[];
  /** Present iff `--deep` was requested. */
  deep?: DeepSampleOptions;
}

/** One sampled record `--deep` could not match to the live instance. */
export interface DeepSampleMismatch {
  sysId: string;
  reason: "row-missing" | "content-hash-mismatch";
}

/** Why a table's verdict is `cannot-tell` — every reason named, none silent (R3). */
export type DriftUnknownReason =
  | "aggregate-unavailable"
  | "watermark-unavailable"
  | "shard-corrupt"
  | "shard-fanout-conflict"
  | "deep-catalog-missing";

/**
 * One table, one verdict. Discriminated on `kind`; the drift kinds are exactly
 * {@link DRIFT_VERDICT_KINDS}, everything else leaves the exit code alone.
 */
export type DriftVerdict =
  | {
      kind: "in-sync";
      table: string;
      liveCount: number;
      mirroredCount: number;
      /** Records `--deep` re-hashed for this table; 0 without `--deep`. */
      sampledRecords: number;
    }
  | { kind: "count-drift"; table: string; liveCount: number; mirroredCount: number }
  | {
      kind: "watermark-drift";
      table: string;
      liveCount: number;
      liveMaxUpdatedOn: string | null;
      mirroredMaxUpdatedOn: string | null;
    }
  | { kind: "table-not-mirrored"; table: string; liveCount: number }
  | { kind: "table-vanished"; table: string; mirroredCount: number }
  | {
      kind: "deep-drift";
      table: string;
      sampledRecords: number;
      mismatches: DeepSampleMismatch[];
    }
  | { kind: "cannot-tell"; table: string; reason: DriftUnknownReason; detail: string };

/** The verdict kinds that constitute detected drift (exit 2). */
export const DRIFT_VERDICT_KINDS: ReadonlySet<DriftVerdict["kind"]> = new Set([
  "count-drift",
  "watermark-drift",
  "table-not-mirrored",
  "table-vanished",
  "deep-drift",
]);

/** JSON-ready result of one `mirror status` run. */
export interface MirrorStatusResult {
  /** One verdict per table in the examined universe, sorted bytewise by table. */
  verdicts: DriftVerdict[];
  driftDetected: boolean;
  /** Derived from the verdicts, never accepted: 0 = no drift detected, 2 = drift. */
  exitCode: 0 | 2;
}

/**
 * Run the comparison. Rejects with the client's {@link MirrorHttpError} when the
 * failure class is run-stopping (`auth` / `unreachable` / `hibernating`) — the
 * caller maps that to exit 1 (R1); everything else becomes a verdict.
 */
export async function detectDrift(
  options: DriftDetectorOptions
): Promise<MirrorStatusResult> {
  if (options.deep !== undefined) {
    const every = options.deep.sampleEvery;
    // A caller bug, not a tree or instance state: no verdict vocabulary applies.
    if (!Number.isInteger(every) || every < 1) {
      throw new Error(
        `deep sampling interval must be an integer >= 1, got ${String(every)}`
      );
    }
  }
  const pairs = await listMirroredTablePairs(options.fs, options.root);
  const scopesByTable = new Map<string, string[]>();
  for (const pair of pairs) {
    const scopes = scopesByTable.get(pair.table);
    if (scopes === undefined) {
      scopesByTable.set(pair.table, [pair.scope]);
    } else {
      scopes.push(pair.scope);
    }
  }
  const liveTables = new Set(options.tables);
  const universe = [...new Set([...options.tables, ...scopesByTable.keys()])].sort(
    compareBytewise
  );
  const verdicts: DriftVerdict[] = [];
  for (const table of universe) {
    verdicts.push(
      await judgeTable(
        options,
        table,
        scopesByTable.get(table) ?? [],
        liveTables.has(table)
      )
    );
  }
  const driftDetected = verdicts.some((verdict) =>
    DRIFT_VERDICT_KINDS.has(verdict.kind)
  );
  return { verdicts, driftDetected, exitCode: driftDetected ? 2 : 0 };
}

/** The disk half of one table's comparison, merged across scopes. */
interface DiskTableView {
  /** Distinct mirrored records; a sys_id claimed in two scopes counts once. */
  entries: Map<string, RecordEntry>;
  /**
   * Bytewise max of the entries' non-empty `sysUpdatedOn` values, null when no
   * entry carries one. Empty strings are excluded to mirror the wire's own
   * convention — the Aggregate API answers `""` for "no timestamp" and the
   * client maps that to null, so a mirrored row whose `sys_updated_on` came off
   * the wire empty must not turn "both sides have no watermark" into drift.
   */
  maxUpdatedOn: string | null;
}

async function loadDiskView(
  fs: MirrorReadFs,
  root: string,
  table: string,
  scopes: readonly string[]
): Promise<DiskTableView> {
  const reader = readOnlyWriterFs(fs);
  const entries = new Map<string, RecordEntry>();
  let maxUpdatedOn: string | null = null;
  for (const scope of scopes) {
    const set = await loadShardSet(reader, root, scope, table);
    for (const [sysId, entry] of set.entries) {
      entries.set(sysId, entry);
      if (
        entry.sysUpdatedOn !== "" &&
        (maxUpdatedOn === null || compareBytewise(entry.sysUpdatedOn, maxUpdatedOn) > 0)
      ) {
        maxUpdatedOn = entry.sysUpdatedOn;
      }
    }
  }
  return { entries, maxUpdatedOn };
}

async function judgeTable(
  options: DriftDetectorOptions,
  table: string,
  scopes: readonly string[],
  live: boolean
): Promise<DriftVerdict> {
  // Disk first: a baseline this run cannot read cannot be compared, so no
  // aggregate request is spent on it — and the verdict names the reading
  // failure instead of an instance state, because that is all we know.
  let disk: DiskTableView;
  try {
    disk = await loadDiskView(options.fs, options.root, table, scopes);
  } catch (error) {
    if (error instanceof ShardManifestCorrupt) {
      return { kind: "cannot-tell", table, reason: "shard-corrupt", detail: error.message };
    }
    if (error instanceof ShardFanoutConflict) {
      return {
        kind: "cannot-tell",
        table,
        reason: "shard-fanout-conflict",
        detail: error.message,
      };
    }
    throw error;
  }
  if (!live) {
    return { kind: "table-vanished", table, mirroredCount: disk.entries.size };
  }
  const aggregate = await options.client.getAggregate(table);
  if (aggregate === null) {
    return {
      kind: "cannot-tell",
      table,
      reason: "aggregate-unavailable",
      detail:
        `the Aggregate API gave no usable answer for ${table} ` +
        `(ACL denial, schema drift or a retried transient); ` +
        `the mirror holds ${disk.entries.size} record(s) but nothing can be compared`,
    };
  }
  const mirrored = scopes.length > 0;
  if (!mirrored) {
    return aggregate.count === 0
      ? { kind: "in-sync", table, liveCount: 0, mirroredCount: 0, sampledRecords: 0 }
      : { kind: "table-not-mirrored", table, liveCount: aggregate.count };
  }
  if (aggregate.count !== disk.entries.size) {
    return {
      kind: "count-drift",
      table,
      liveCount: aggregate.count,
      mirroredCount: disk.entries.size,
    };
  }
  if (aggregate.maxUpdatedOn === null && aggregate.count > 0) {
    // Counts agree but the instance answered no watermark for a non-empty
    // table (field not returned). Comparing null against the mirrored max
    // would fabricate a watermark-drift claim out of an absent answer — the
    // exact move R3 exists to forbid.
    return {
      kind: "cannot-tell",
      table,
      reason: "watermark-unavailable",
      detail:
        `counts agree at ${aggregate.count} but the Aggregate API returned no ` +
        `MAX(sys_updated_on) for ${table}, so the watermark cannot be compared`,
    };
  }
  if (aggregate.maxUpdatedOn !== disk.maxUpdatedOn) {
    return {
      kind: "watermark-drift",
      table,
      liveCount: aggregate.count,
      liveMaxUpdatedOn: aggregate.maxUpdatedOn,
      mirroredMaxUpdatedOn: disk.maxUpdatedOn,
    };
  }
  if (options.deep === undefined) {
    return {
      kind: "in-sync",
      table,
      liveCount: aggregate.count,
      mirroredCount: disk.entries.size,
      sampledRecords: 0,
    };
  }
  return deepSample(table, disk, options.deep, aggregate.count);
}

async function deepSample(
  table: string,
  disk: DiskTableView,
  deep: DeepSampleOptions,
  liveCount: number
): Promise<DriftVerdict> {
  const entry = deep.catalog.get(table);
  if (entry === undefined) {
    // Sampling was requested and cannot run; saying nothing would be a silent
    // downgrade of `--deep` to shallow for this one table (R3).
    return {
      kind: "cannot-tell",
      table,
      reason: "deep-catalog-missing",
      detail: `--deep needs the catalog entry for ${table} to re-derive canonical bytes, and none was supplied`,
    };
  }
  // The sweep's own projection rule, imported rather than restated: `--deep`
  // re-derives canonical bytes and compares their hash with the one the sweep
  // wrote, so a projection that differed by one field would report drift on
  // every sampled record of a tree that is perfectly correct.
  const fields = pageFields(entry);
  const redactionOptions =
    deep.redaction === undefined
      ? { table: entry }
      : { table: entry, redaction: deep.redaction };
  const sysIds = [...disk.entries.keys()].sort(compareBytewise);
  const mismatches: DeepSampleMismatch[] = [];
  let sampledRecords = 0;
  for (let index = 0; index < sysIds.length; index += deep.sampleEvery) {
    const sysId = sysIds[index];
    sampledRecords += 1;
    const page = await deep.client.getPage(table, null, {
      fields,
      extraQuery: `sys_id=${sysId}`,
      pageSize: 1,
    });
    const row = page.rows[0];
    if (row === undefined) {
      mismatches.push({ sysId, reason: "row-missing" });
      continue;
    }
    // `parseFailures` from the pipeline are a reporting concern, not a hash
    // concern: the sweep that wrote this entry hashed the same bytes under the
    // same parse outcome, so only the digests are compared here.
    const { record } = serializeAndRedact(row, redactionOptions);
    const mirroredEntry = disk.entries.get(sysId) as RecordEntry;
    if (sha256Hex(record.recordJsonBytes) !== mirroredEntry.contentHash) {
      mismatches.push({ sysId, reason: "content-hash-mismatch" });
    }
  }
  if (mismatches.length > 0) {
    return { kind: "deep-drift", table, sampledRecords, mismatches };
  }
  return {
    kind: "in-sync",
    table,
    liveCount,
    mirroredCount: disk.entries.size,
    sampledRecords,
  };
}
