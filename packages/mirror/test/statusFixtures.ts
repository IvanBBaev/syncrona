// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared fixtures for the `mirror status` and `mirror verify` suites (WP-M11).
 *
 * Both suites judge a tree that some sweep supposedly wrote, so the fixtures
 * here build that tree the way the sweep would: shard sets go through the real
 * `writeShardSet` (never hand-rendered JSON, except where a test is explicitly
 * planting damage), record directories carry a real `record.json` whose
 * `contentHash` is the sha-256 of its actual bytes, and attachments land at the
 * §8.4 layout the verifier checks. A fixture assembled any other way would let
 * a test pass by agreeing with its own shortcut instead of with the writer.
 *
 * The in-memory filesystem is a copy of `shardStore.test.ts`'s deliberately
 * unhelpful fake, kept behaviour-for-behaviour: `writeFile` refuses a file
 * whose parent directory was never made, and `readDir` answers in DESCENDING
 * order so that every sorted result asserted downstream was sorted by the
 * production code, not by the fake. The call log is what turns "verify performs
 * zero writes" (§12's fs-spy acceptance) from an inference into an assertion —
 * {@link mutatingCalls} filters it down to the four mutators, and a clean run
 * must leave that filter empty.
 *
 * The client helpers restate `fetcher.test.ts`'s conventions under `status*`
 * names (this work package may not edit that file): a real `MirrorHttpClient`
 * against the fake instance with only the rate limiter's WAIT stubbed, and a
 * catalog entry derived from the corpus wire columns with password-typed
 * columns marked denied, exactly as the catalog service would mark them (D19).
 *
 * {@link realEntriesFromInstance} is the deep-sampling fixture: it derives
 * `RecordEntry` rows whose `contentHash` is minted from the SAME projection and
 * the SAME `serializeAndRedact` canonical bytes the sweep would produce, by
 * walking the live table once before the test mutates it. That is what makes
 * "--deep finds a silent edit" a real detection rather than a comparison of a
 * fixture with itself: the disk claim is honest, the instance then moves.
 */
import { createHash } from "node:crypto";
import { sep } from "node:path";

import type {
  MirrorConfig,
  RecordEntry,
  TableCatalogEntry,
  FieldDescriptor,
} from "../src/contracts";
import { MirrorHttpClient } from "../src/http/client";
import { serializeAndRedact } from "../src/pipeline";
import type { ShardFanout } from "../src/shards/shardLayout";
import { writeShardSet } from "../src/shards/shardStore";
import { toNativePath, type WriterDirEntry, type WriterFs } from "../src/write/fs";
import {
  DEFAULT_CREDENTIALS,
  wireColumnsByTable,
  type FakeInstanceServer,
  type FixtureCorpus,
  type FixtureRow,
} from "./fakeInstance";

/** Virtual repository root; every fixture path in both suites hangs off it. */
export const ROOT = `${sep}mirror-root`;

/** A repo-relative path as the native path the in-memory fs stores it under. */
export const relToNative = (relPath: string): string => toNativePath(ROOT, relPath);

export function parentOf(nativePath: string): string {
  const index = nativePath.lastIndexOf(sep);
  return index <= 0 ? sep : nativePath.slice(0, index);
}

class MemoryFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryFsError";
  }
}

/**
 * The recording in-memory filesystem, copied from `shardStore.test.ts` (that
 * file is outside this work package's write set, so the copy lives here under
 * the suite's namespace). See the module docblock for why it is unhelpful on
 * purpose.
 */
export class MemoryFs implements WriterFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly calls: string[] = [];

  async makeDir(dir: string): Promise<void> {
    this.calls.push(`makeDir ${dir}`);
    this.addDir(dir);
  }

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`writeFile ${filePath}`);
    if (!this.dirs.has(parentOf(filePath))) {
      throw new MemoryFsError(`ENOENT: no directory holds ${filePath}`);
    }
    this.files.set(filePath, new Uint8Array(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} -> ${to}`);
    const bytes = this.files.get(from);
    if (bytes === undefined) {
      throw new MemoryFsError(`ENOENT: nothing to rename at ${from}`);
    }
    if (!this.dirs.has(parentOf(to))) {
      throw new MemoryFsError(`ENOENT: no directory holds ${to}`);
    }
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    this.calls.push(`readFile ${filePath}`);
    const bytes = this.files.get(filePath);
    return bytes === undefined ? null : new Uint8Array(bytes);
  }

  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    this.calls.push(`readDir ${dir}`);
    if (!this.dirs.has(dir)) {
      return null;
    }
    const entries: WriterDirEntry[] = [];
    for (const filePath of this.files.keys()) {
      if (parentOf(filePath) === dir) {
        entries.push({ name: filePath.slice(dir.length + sep.length), isDirectory: false });
      }
    }
    for (const child of this.dirs) {
      if (child !== dir && parentOf(child) === dir) {
        entries.push({ name: child.slice(dir.length + sep.length), isDirectory: true });
      }
    }
    // Descending, on purpose — see the module docblock.
    return entries.sort((left, right) => (left.name < right.name ? 1 : -1));
  }

  async removeRecursive(target: string): Promise<void> {
    this.calls.push(`removeRecursive ${target}`);
    this.files.delete(target);
    const prefix = `${target}${sep}`;
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === target || dir.startsWith(prefix)) {
        this.dirs.delete(dir);
      }
    }
  }

  private addDir(dir: string): void {
    const parts = dir.split(sep);
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const candidate = parts.slice(0, depth).join(sep);
      if (candidate !== "") {
        this.dirs.add(candidate);
      }
    }
  }
}

/**
 * The call-log lines a read-only stage must never produce. §12's acceptance
 * for verify is "provably performs zero writes (fs spy)" — this filter is the
 * proof's predicate.
 */
export function mutatingCalls(fs: MemoryFs): string[] {
  return fs.calls.filter((line) =>
    /^(makeDir|writeFile|rename|removeRecursive) /.test(line)
  );
}

/** Forget the log so far, so an assertion covers only the run under test. */
export function resetCalls(fs: MemoryFs): void {
  fs.calls.length = 0;
}

/** The `contentHash` rule, restated for fixture minting: sha-256 hex. */
export const sha256HexOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** A sys_id (INV-6: 32 lowercase hex) from a small integer, sortable as it reads. */
export const testSysId = (index: number): string =>
  index.toString(16).padStart(32, "0");

/** Write one file, creating its parent chain — bypasses nothing, records all. */
export async function seedFile(
  fs: WriterFs,
  relPath: string,
  bytes: Uint8Array
): Promise<void> {
  const native = relToNative(relPath);
  await fs.makeDir(parentOf(native));
  await fs.writeFile(native, bytes);
}

/** Create a directory (with ancestors) at a repo-relative path. */
export async function seedDir(fs: WriterFs, relPath: string): Promise<void> {
  await fs.makeDir(relToNative(relPath));
}

/**
 * A shallow-status disk entry for one live row. The status comparison reads
 * only counts and `sysUpdatedOn` watermarks off the manifests, so the
 * `contentHash` here is minted from a nonce — honest for shallow tests, and
 * deliberately unusable for `--deep` ones, which must go through
 * {@link realEntriesFromInstance} instead.
 */
export function fakeEntryForRow(
  scope: string,
  table: string,
  row: FixtureRow
): RecordEntry {
  const name = row.sys_id;
  return {
    path: `instance/${scope}/${table}/${name}`,
    name,
    sysUpdatedOn: row.sys_updated_on ?? "",
    sysUpdatedBy: row.sys_updated_by ?? "",
    sysModCount: Number(row.sys_mod_count ?? "0") || 0,
    contentHash: sha256HexOf(Buffer.from(`shallow-fixture:${row.sys_id}`, "utf8")),
    files: [],
  };
}

/** {@link fakeEntryForRow} over a row list, keyed by sys_id. */
export function entriesByName(
  rows: readonly FixtureRow[],
  scope: string,
  table: string
): Map<string, RecordEntry> {
  const entries = new Map<string, RecordEntry>();
  for (const row of rows) {
    entries.set(row.sys_id, fakeEntryForRow(scope, table, row));
  }
  return entries;
}

/**
 * Write a shard set through the real store. Defaults are the common case —
 * single shard, complete, a fixed sweep id — precisely so the tests that care
 * (fan-out, checkpoints, mixed sweep ids) have to say so.
 */
export async function writeShardFixture(
  fs: WriterFs,
  options: {
    scope: string;
    table: string;
    entries: ReadonlyMap<string, RecordEntry>;
    fanout?: ShardFanout;
    complete?: boolean;
    sweepId?: string;
  }
): Promise<void> {
  await writeShardSet(fs, {
    root: ROOT,
    scope: options.scope,
    table: options.table,
    fanout: options.fanout ?? 0,
    complete: options.complete ?? true,
    sweepId: options.sweepId ?? "sweep-fixture-a",
    entries: options.entries,
  });
}

/** One attachment a {@link plantRecord} spec asks for. */
export interface PlantedAttachment {
  sysId: string;
  fileName: string;
  /** Bytes written to disk (UTF-8 of this text). Ignored when `absent`. */
  body: string;
  /** Recorded sha256; defaults to the sha-256 of `body`. */
  sha256?: string;
  lfs?: boolean;
  /** List the attachment in the manifest but write nothing to disk. */
  absent?: boolean;
}

export interface PlantSpec {
  scope: string;
  table: string;
  sysId: string;
  /** Record directory name; defaults to the sys_id (always a safe component). */
  name?: string;
  /** `record.json` text; the entry's `contentHash` is minted from these bytes. */
  recordText?: string;
  /** Extracted files to write, name → content. Names land in `entry.files`. */
  files?: Record<string, string>;
  /** Names listed in `entry.files` with nothing written — the missing-file case. */
  filesListedButAbsent?: readonly string[];
  attachments?: readonly PlantedAttachment[];
}

/**
 * Materialize one record the way the writer lays it out: a record directory
 * holding `record.json` (hashed for real) plus extracted files, attachments at
 * `attachments/<table>/<record sys_id>/<attachment sys_id>_<file name>`
 * (design §8.4), and the `RecordEntry` a manifest would claim for it.
 */
export async function plantRecord(
  fs: WriterFs,
  spec: PlantSpec
): Promise<[string, RecordEntry]> {
  const name = spec.name ?? spec.sysId;
  const recordDirRel = `instance/${spec.scope}/${spec.table}/${name}`;
  const recordBytes = Buffer.from(
    spec.recordText ?? `{"sys_id":"${spec.sysId}","fixture":true}\n`,
    "utf8"
  );
  await seedFile(fs, `${recordDirRel}/record.json`, recordBytes);
  const writtenFiles = spec.files ?? {};
  for (const fileName of Object.keys(writtenFiles)) {
    await seedFile(
      fs,
      `${recordDirRel}/${fileName}`,
      Buffer.from(writtenFiles[fileName], "utf8")
    );
  }
  const attachments = [...(spec.attachments ?? [])].sort((left, right) =>
    left.sysId < right.sysId ? -1 : left.sysId > right.sysId ? 1 : 0
  );
  const attachmentRefs: NonNullable<RecordEntry["attachments"]> = [];
  for (const attachment of attachments) {
    const bytes = Buffer.from(attachment.body, "utf8");
    if (attachment.absent !== true) {
      await seedFile(
        fs,
        `attachments/${spec.table}/${spec.sysId}/${attachment.sysId}_${attachment.fileName}`,
        bytes
      );
    }
    attachmentRefs.push({
      sysId: attachment.sysId,
      fileName: attachment.fileName,
      sizeBytes: bytes.byteLength,
      sha256: attachment.sha256 ?? sha256HexOf(bytes),
      lfs: attachment.lfs ?? false,
    });
  }
  const files = [
    ...Object.keys(writtenFiles),
    ...(spec.filesListedButAbsent ?? []),
  ].sort();
  const entry: RecordEntry = {
    path: recordDirRel,
    name,
    sysUpdatedOn: "2026-01-02 03:04:05",
    sysUpdatedBy: "fixture.admin",
    sysModCount: 3,
    contentHash: sha256HexOf(recordBytes),
    files,
    ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
  };
  return [spec.sysId, entry];
}

// ---------------------------------------------------------------------------
// Live-instance helpers (status suite)
// ---------------------------------------------------------------------------

export const basicAuth = (): string =>
  `Basic ${Buffer.from(
    `${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`,
    "utf8"
  ).toString("base64")}`;

/**
 * A real client pointed at a fake instance, retry WAITs stubbed — the same
 * convention `fetcher.test.ts` established and for the same reason: everything
 * on the request path is shipped code, only the quarter-second-per-request
 * politeness delay is removed.
 */
export const statusClientFor = (
  server: FakeInstanceServer,
  pageSize = 100
): MirrorHttpClient =>
  new MirrorHttpClient({
    instance: server.baseUrl,
    headers: { Authorization: basicAuth() },
    pageSize,
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0.5,
  });

export const statusField = (
  element: string,
  overrides: Partial<FieldDescriptor> = {}
): FieldDescriptor => ({
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

export const statusCatalogEntry = (
  name: string,
  overrides: Partial<TableCatalogEntry> = {}
): TableCatalogEntry => ({
  name,
  sysId: testSysId(0xfff),
  superClass: null,
  isMetadata: true,
  tier: 1,
  rowCount: null,
  maxUpdatedOn: null,
  fields: [
    statusField("sys_id", { internalType: "GUID", maxLength: 32 }),
    statusField("name"),
    statusField("sys_updated_on", { internalType: "glide_date_time", isNoise: true }),
  ],
  status: "included",
  ...overrides,
});

/**
 * A catalog entry whose fields are exactly what the corpus puts on the wire,
 * with password-typed columns marked denied — the same denial the catalog
 * service derives (D19), so the deep projection drops them the way the sweep's
 * own projection did.
 */
export const statusEntryFromCorpus = (
  corpus: FixtureCorpus,
  name: string
): TableCatalogEntry => {
  const columns = wireColumnsByTable(corpus).get(name);
  if (columns === undefined) {
    throw new Error(`corpus has no table ${name}`);
  }
  return statusCatalogEntry(name, {
    fields: columns.map((column) =>
      statusField(column.element, {
        internalType: column.internalType,
        maxLength: column.maxLength,
        reference: column.reference,
        isDenied:
          column.internalType === "password" || column.internalType === "password2",
      })
    ),
  });
};

/**
 * The sweep's page projection for a catalog entry — `sys_id` always, denied
 * columns never, sorted. Restated here for fixture minting; the detector keeps
 * its own restatement (`deepPageFields`) with the deviation called out there.
 */
export function deepProjection(entry: TableCatalogEntry): string[] {
  const names = new Set<string>(["sys_id"]);
  for (const field of entry.fields) {
    if (!field.isDenied) {
      names.add(field.element);
    }
  }
  return [...names].sort();
}

/**
 * Walk a live table once and mint the `RecordEntry` rows a faithful sweep
 * would have written for it: same projection, same `serializeAndRedact`
 * canonical bytes, `contentHash` = sha-256 of those bytes. Call it BEFORE the
 * test mutates the instance, so the disk claim describes a state the instance
 * is then moved away from.
 */
export async function realEntriesFromInstance(
  client: MirrorHttpClient,
  entry: TableCatalogEntry,
  scope: string,
  redaction?: MirrorConfig["redaction"]
): Promise<Map<string, RecordEntry>> {
  const fields = deepProjection(entry);
  const redactionOptions =
    redaction === undefined ? { table: entry } : { table: entry, redaction };
  const entries = new Map<string, RecordEntry>();
  let cursor: string | null = null;
  for (;;) {
    const page = await client.getPage(entry.name, cursor, { fields });
    for (const row of page.rows) {
      const { record } = serializeAndRedact(row, redactionOptions);
      const sysId = row.sys_id;
      entries.set(sysId, {
        path: `instance/${scope}/${entry.name}/${sysId}`,
        name: sysId,
        sysUpdatedOn: row.sys_updated_on ?? "",
        sysUpdatedBy: row.sys_updated_by ?? "",
        sysModCount: Number(row.sys_mod_count ?? "0") || 0,
        contentHash: sha256HexOf(record.recordJsonBytes),
        files: [],
      });
    }
    if (page.done || page.lastSysId === null) {
      return entries;
    }
    cursor = page.lastSysId;
  }
}
