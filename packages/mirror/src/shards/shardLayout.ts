// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shard layout — the pure half of §4.3 / §5.8 (WP-M7).
 *
 * Everything in this module is a total function of its arguments: which shard a
 * sys_id belongs to, what that shard's file is called, how many shards a record
 * count deserves, and how a manifest turns into bytes and back. No filesystem, no
 * clock, no configuration. The I/O half lives in `shardStore.ts`, and the split is
 * load-bearing for two reasons.
 *
 * First, INV-6. "Validate every shard key against `/^[0-9a-f]{32}$/` **before any
 * path derivation**" is only a meaningful guarantee if there is exactly one place
 * a path can be derived. {@link shardKeyFor} and {@link recordDirRelPath} are that
 * place, and both assert before they slice. A caller that forgets is not merely
 * impolite — it is the bug INV-6 exists to prevent, so the assertion lives at the
 * derivation site rather than at the call site.
 *
 * Second, INV-1 (an unchanged instance re-runs to a byte-identical tree). Byte
 * stability is a property of these functions, so it can be tested without touching
 * a disk: two identical inputs produce two identical `Uint8Array`s, and that is the
 * whole of the "shard bytes stable across two identical runs" acceptance criterion
 * once the store is shown to write what this module renders.
 */
import {
  isSafePathComponent,
  type UnsafeComponentKind,
} from "@syncrona/sn-transport";

import {
  FORMAT_VERSION,
  SHARD_FANOUT_THRESHOLD_1,
  SHARD_FANOUT_THRESHOLD_2,
  SYS_ID_RE,
} from "../constants";
import type { RecordEntry, ShardManifest } from "../contracts";
import { compareBytewise } from "../order";
import { canonicalJsonBytes } from "../serialize/serializer";

/** Fan-out depth of a shard set: 0 = one file, 1 = 16 files, 2 = 256 files (D16). */
export type ShardFanout = ShardManifest["fanout"];

/** Directory that holds a shard set, relative to `instance/<scope>/<table>/`. */
export const SHARD_DIR_NAME = ".shards";

/**
 * File name of the single shard when fan-out is 0.
 *
 * `all.json`, not `.json` or `0.json`. It has to be a name that no fan-out level
 * can also produce, because a `mirror migrate` between levels leaves the old files
 * behind for one moment and the store deletes exactly the files the new level does
 * not claim. A one-hex level claims `0.json` … `f.json` and a two-hex level claims
 * `00.json` … `ff.json`; `all` is neither, and it reads as what it is to a human
 * who opens the directory.
 */
export const SINGLE_SHARD_FILE = "all.json";

/** Suffix of every shard file. */
export const SHARD_FILE_SUFFIX = ".json";

/** File name of the record envelope inside a record directory (§3). */
export const RECORD_FILE_NAME = "record.json";

/** Top-level directory of the mirrored instance inside the repo (§3). */
export const INSTANCE_DIR_NAME = "instance";

/**
 * A value that was about to become part of a filesystem path and must not.
 *
 * Its own class rather than a bare `Error` so a caller can tell "this input is
 * hostile or corrupt" apart from "the disk is full" (F8) without string matching,
 * and so the fuzz test can assert the *shape* of the rejection instead of a
 * message it would then have to keep in sync.
 */
export class MirrorPathRejection extends Error {
  /** What the rejected value was supposed to be. */
  readonly what: string;
  /** The offending value, truncated and escaped — see the constructor. */
  readonly sample: string;

  constructor(what: string, offending: unknown) {
    const sample = describeOffendingValue(offending);
    super(`Refusing to derive a mirror path: ${what} is not usable (${sample})`);
    this.name = "MirrorPathRejection";
    this.what = what;
    this.sample = sample;
  }
}

/**
 * Render a rejected value for a message without letting it write the message.
 *
 * The values this module rejects are, by construction, values an instance (or an
 * attacker with write access to one) chose. Interpolating one raw into an error
 * string that ends up in `MIRROR-REPORT.md` or a CI log hands it a newline, an
 * ANSI escape, or a few kilobytes of padding to push the real error off screen.
 * `JSON.stringify` escapes control characters and quotes, and the 60-character cap
 * bounds the rest; a sys_id is 32 characters, so nothing legitimate is ever cut.
 */
function describeOffendingValue(value: unknown): string {
  if (typeof value !== "string") {
    return `${typeof value}`;
  }
  const escaped = JSON.stringify(value.slice(0, 60));
  return value.length > 60 ? `${escaped}…` : escaped;
}

/**
 * INV-6 — is this the only shape a sys_id is allowed to have?
 *
 * `SYS_ID_RE` is imported, not re-declared: it is `@syncrona/sn-transport`'s, the
 * same object the keyset cursor validator uses, so the mirror and the transport can
 * never disagree about what a sys_id is (§11). The regex carries no `g`/`y` flag,
 * so `test` holds no `lastIndex` state and this predicate is safe to call from
 * anywhere in any order — a detail worth stating because a shared mutable regex is
 * exactly the kind of thing that makes a validator pass every other call.
 */
export function isMirrorSysId(value: unknown): value is string {
  return typeof value === "string" && SYS_ID_RE.test(value);
}

/**
 * INV-6 gate. Throws {@link MirrorPathRejection} unless `value` is a sys_id.
 *
 * Declared as an assertion function so that the compiler narrows `unknown` to
 * `string` afterwards. That is deliberate: the alternative — a `boolean` check the
 * caller may ignore — leaves the narrowing to a cast, and a cast is exactly the
 * construct INV-6 is trying to make unnecessary.
 */
export function assertMirrorSysId(
  value: unknown,
  what = "sys_id"
): asserts value is string {
  if (!isMirrorSysId(value)) {
    throw new MirrorPathRejection(what, value);
  }
}

/**
 * What a rejected component was supposed to be.
 *
 * sn-transport's `UnsafeComponentKind` plus `"scope name"`. The mirror needs the
 * extra member because its tree is `instance/<scope>/<table>/…` while the download
 * pipeline's is not, and a scope arriving here with no word of its own was being
 * reported as a table name — an error message that sends a reader to the wrong
 * half of their configuration.
 *
 * Widened here rather than in sn-transport because that union is not just a label
 * there: it keys `CONTAINMENT_BOUNDARY`, which decides what a component is checked
 * for containment *against*. Adding a member would oblige that package to answer a
 * question about scopes it has no reason to have an opinion on. The label is the
 * only thing the mirror borrows — {@link assertMirrorPathComponent} passes it to
 * {@link MirrorPathRejection}, never back into sn-transport.
 */
export type MirrorComponentKind = UnsafeComponentKind | "scope name";

/**
 * Gate for a path component that is not a sys_id (a scope, a table, a file name).
 *
 * `assertSafePathComponent` from sn-transport would do, and it is what the download
 * pipeline uses; this wrapper exists only so that every rejection raised on the
 * mirror's write path is one class, which is what lets the writer's callers
 * distinguish "hostile input" from "disk failure" in one `instanceof`. The
 * containment predicate itself is still sn-transport's — nothing about `..`,
 * separators or reserved names is re-decided here (§11: never re-implement a rule
 * another package owns).
 */
export function assertMirrorPathComponent(
  value: unknown,
  kind: MirrorComponentKind
): asserts value is string {
  if (typeof value !== "string" || !isSafePathComponent(value)) {
    throw new MirrorPathRejection(kind, value);
  }
}

/**
 * Fan-out a shard set of this size deserves (§11 thresholds, D16).
 *
 * Strictly greater, matching §11's wording ("record count **above which**"): a
 * table sitting exactly on 16 000 stays at one file. The boundary has to be
 * decided one way and written down, because the sticky rule below means whichever
 * way it falls is permanent for that table until someone runs `mirror migrate`.
 *
 * This function answers "what fan-out would a fresh table pick?" and NOTHING else.
 * It must never be consulted for a shard set that already exists on disk — that is
 * what makes D16 sticky, and {@link stickyFanout} is the function that enforces it.
 */
export function chooseShardFanout(recordCount: number): ShardFanout {
  if (!Number.isFinite(recordCount) || recordCount < 0) {
    throw new MirrorPathRejection("record count", recordCount);
  }
  if (recordCount > SHARD_FANOUT_THRESHOLD_2) {
    return 2;
  }
  if (recordCount > SHARD_FANOUT_THRESHOLD_1) {
    return 1;
  }
  return 0;
}

/**
 * D16 — the fan-out a shard set must actually use.
 *
 * `existing` is whatever was read back off disk (`null` when the directory has no
 * shards yet). If a shard set exists, its own fan-out wins, full stop: the record
 * count is not consulted, so a table oscillating around 16 000 records cannot
 * flip-flop its layout and rewrite every path in the table twice a day. Changing
 * the level is a migration, not a side effect of a sync.
 *
 * The rule is expressed as a function rather than as an `if` inside the store so
 * that "sticky" is testable without a filesystem and so that there is one place to
 * point at when someone asks why a 900 000-row table still has one shard file.
 */
export function stickyFanout(
  existing: ShardFanout | null,
  recordCount: number
): ShardFanout {
  return existing === null ? chooseShardFanout(recordCount) : existing;
}

/**
 * The shard key (hex prefix) a record belongs to — INV-6 asserted first.
 *
 * The assertion is not defensive politeness. The return value of this function is
 * interpolated into a file name by {@link shardFileName}, so a `sys_id` of
 * `../../../etc/pass` would, at fan-out 2, produce the key `..` and a shard file
 * one directory up. Validating here rather than at the writer's entry point means
 * the guarantee holds for every caller, including future ones.
 */
export function shardKeyFor(sysId: unknown, fanout: ShardFanout): string {
  assertMirrorSysId(sysId);
  return sysId.slice(0, fanout);
}

/** Every shard key a set at this fan-out contains, in ascending order. */
export function enumerateShardKeys(fanout: ShardFanout): string[] {
  if (fanout === 0) {
    return [""];
  }
  const digits = "0123456789abcdef";
  const keys: string[] = [];
  for (const first of digits) {
    if (fanout === 1) {
      keys.push(first);
      continue;
    }
    for (const second of digits) {
      keys.push(`${first}${second}`);
    }
  }
  return keys;
}

/**
 * Is this a well-formed shard key at this fan-out — right length AND lowercase hex?
 *
 * Both halves matter, and the length half alone is the tempting mistake: a shard key
 * is a sys_id prefix, so INV-6's alphabet applies to it in full, and `..` is exactly
 * two characters. Length-only validation would accept it at fan-out 2 and
 * {@link shardFileName} would produce `../.json` — a write one directory above the
 * shard set. This predicate is the single place that decision is made, so
 * {@link buildShardManifest} and {@link parseShardManifest} cannot drift into being
 * laxer than the path derivation they feed.
 *
 * Fan-out 0 has exactly one key, the empty string, which the pattern accepts.
 */
export function isShardKey(value: unknown, fanout: ShardFanout): value is string {
  return (
    typeof value === "string" &&
    value.length === fanout &&
    /^[0-9a-f]*$/.test(value)
  );
}

/**
 * File name for a shard key at a given fan-out.
 *
 * Re-validates the key against the fan-out instead of trusting the caller: a key
 * of the wrong length means the caller mixed two fan-outs, which would silently
 * write a fan-out-1 shard into a fan-out-2 set and lose every record in it on the
 * next flush. Cheap check, unrecoverable bug.
 */
export function shardFileName(shardKey: string, fanout: ShardFanout): string {
  if (!isShardKey(shardKey, fanout)) {
    throw new MirrorPathRejection(`shard key for fanout ${fanout}`, shardKey);
  }
  return fanout === 0 ? SINGLE_SHARD_FILE : `${shardKey}${SHARD_FILE_SUFFIX}`;
}

/** Every file name a shard set at this fan-out is allowed to contain. */
export function shardFileNamesFor(fanout: ShardFanout): string[] {
  return enumerateShardKeys(fanout).map((key) => shardFileName(key, fanout));
}

/**
 * Join repo-relative path segments with `/`, always.
 *
 * `path.join` is platform-native, and on Windows it produces `instance\global\…`.
 * `RecordEntry.path` is committed to git and compared across machines, so a
 * backslash there would make every shard in a mirror written on Windows differ
 * from the same mirror written on Linux — an INV-1 violation with no visible
 * cause. Filesystem access converts back to native separators at the boundary
 * (`write/fs.ts`); repo-relative paths never do.
 */
export function repoPath(...segments: string[]): string {
  return segments.join("/");
}

/** Directory that holds one scope's shard set for one table, repo-relative. */
export function shardDirRelPath(scope: string, table: string): string {
  assertMirrorPathComponent(scope, "scope name");
  assertMirrorPathComponent(table, "table name");
  return repoPath(INSTANCE_DIR_NAME, scope, table, SHARD_DIR_NAME);
}

/**
 * Repo-relative directory of one record — the single path-derivation site (§5.8).
 *
 * Every component is validated before it is joined, and the sys_id is validated
 * even though it does not appear in the result. That looks redundant and is not:
 * the sys_id is what the folded name falls back to when a record has no usable
 * display name (`buildSafeRecordName`), and it is the key the shard will file this
 * path under, so a sys_id that fails INV-6 must stop the record here rather than
 * one frame later.
 *
 * `.shards` is refused outright. It is a legal ServiceNow display name and it
 * survives the whole naming pipeline unchanged — `buildSafeRecordName` returns it
 * and `isSafePathComponent` accepts it — so without this check the result would be
 * byte-identical to {@link shardDirRelPath} for the same scope and table. The
 * record would be written *into* the table's shard index, and a later
 * `applyAuthorizedDeletion`, re-deriving the same path, would remove the index for
 * the whole table.
 *
 * The refusal is belt to `RecordNameResolver`'s braces: the resolver reserves the
 * name and hands such a record the `_<sysId>` suffix D18 already uses for
 * collisions, so nothing in the writer can reach this throw. It is here anyway
 * because this is the single site where a record name becomes a path, and an
 * invariant that only holds as long as every caller remembers to route through one
 * other class is not an invariant.
 */
export function recordDirRelPath(args: {
  scope: string;
  table: string;
  sysId: string;
  name: string;
}): string {
  assertMirrorSysId(args.sysId);
  assertMirrorPathComponent(args.scope, "scope name");
  assertMirrorPathComponent(args.table, "table name");
  assertMirrorPathComponent(args.name, "record name");
  if (args.name === SHARD_DIR_NAME) {
    throw new MirrorPathRejection("record name", args.name);
  }
  return repoPath(INSTANCE_DIR_NAME, args.scope, args.table, args.name);
}

/**
 * Render a shard manifest to its final bytes (§8, D15).
 *
 * `canonicalJsonBytes` is the serializer's, not a second implementation: §8's rules
 * (UTF-8, LF, one trailing newline, two-space indent, keys sorted by UTF-16 code
 * unit at every level) are one decision, and a shard rendered by a private copy
 * would drift from `record.json` the first time either side changed. Reusing it is
 * also what satisfies D15 for free — two-space indentation puts every field of
 * every {@link RecordEntry} on its own line, which is the measured precondition for
 * git resolving two people's edits inside one shard instead of conflicting on a
 * single minified line.
 */
export function renderShardManifest(manifest: ShardManifest): Uint8Array {
  return canonicalJsonBytes(manifest);
}

/**
 * Build a manifest value from parts, with the fan-out/shard-key agreement checked.
 *
 * The check is here because the three fields are redundant with each other by
 * design — `shard.length === fanout` is stated normatively in §4.3 — and redundant
 * fields that are not checked are redundant fields that eventually disagree.
 *
 * It checks the alphabet as well as the length, via {@link isShardKey}. §4.3 states
 * only the length, but a manifest is what {@link shardFileName} is later asked to
 * name a file for, and `shard: ".."` has the length §4.3 demands.
 */
export function buildShardManifest(args: {
  table: string;
  shardKey: string;
  fanout: ShardFanout;
  complete: boolean;
  sweepId: string;
  records: Record<string, RecordEntry>;
}): ShardManifest {
  if (!isShardKey(args.shardKey, args.fanout)) {
    throw new MirrorPathRejection(
      `shard key for fanout ${args.fanout}`,
      args.shardKey
    );
  }
  return {
    formatVersion: FORMAT_VERSION,
    table: args.table,
    shard: args.shardKey,
    fanout: args.fanout,
    complete: args.complete,
    sweepId: args.sweepId,
    records: args.records,
  };
}

/** Structural failure of a shard file on disk. */
export class ShardManifestCorrupt extends Error {
  /** Repo-relative path of the file that failed to parse or validate. */
  readonly shardPath: string;

  constructor(shardPath: string, detail: string) {
    super(`Shard manifest ${shardPath} is unusable: ${detail}`);
    this.name = "ShardManifestCorrupt";
    this.shardPath = shardPath;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate a shard file that came off disk.
 *
 * This is a trust boundary, not a convenience. A shard file is committed to git,
 * so it is edited by humans, merged by git, and pulled from remotes — the mirror
 * reads back a document that other people have had their hands on. It is then used
 * to decide which directories exist (paths) and, through
 * {@link stickyFanout}, which layout the next flush writes. So every field is
 * checked, every record key is put through INV-6 before it can reach a path, and
 * every `path`/`name` is checked for containment.
 *
 * Rejecting is the right response rather than repairing: a shard that cannot be
 * trusted cannot be used as a deletion baseline either, and silently treating a
 * corrupt shard as empty would authorise deleting every record it described.
 */
export function parseShardManifest(
  text: string,
  shardPath: string
): ShardManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    /* istanbul ignore next -- @preserve: `JSON.parse` rejects with a `SyntaxError`
       and nothing else, so the fallback string is unreachable today. It stays
       because the alternative is an unchecked cast, and because the one thing this
       catch must guarantee is that every failure leaves as a ShardManifestCorrupt
       naming the file — a caller that has to handle a second error type here is a
       caller that will handle it by not handling it. */
    const detail = error instanceof Error ? error.message : "not JSON";
    throw new ShardManifestCorrupt(shardPath, detail);
  }
  if (!isPlainObject(parsed)) {
    throw new ShardManifestCorrupt(shardPath, "top level is not an object");
  }
  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw new ShardManifestCorrupt(
      shardPath,
      `formatVersion ${String(parsed.formatVersion)} is not ${FORMAT_VERSION}`
    );
  }
  const fanout = parsed.fanout;
  if (fanout !== 0 && fanout !== 1 && fanout !== 2) {
    throw new ShardManifestCorrupt(shardPath, `fanout ${String(fanout)} is not 0, 1 or 2`);
  }
  if (typeof parsed.table !== "string" || typeof parsed.sweepId !== "string") {
    throw new ShardManifestCorrupt(shardPath, "table and sweepId must be strings");
  }
  // Alphabet as well as length. The per-record check below (`sysId.slice(0, fanout)
  // === parsed.shard`) rejects a non-hex shard key for any shard that holds at least
  // one record, which is why length-only validation survived review — but an EMPTY
  // shard has no record to disagree with it, and an empty shard is exactly what a
  // completed sweep writes for a key with no records. `shard: ".."` would then reach
  // `shardFileName` on the next flush.
  if (!isShardKey(parsed.shard, fanout)) {
    throw new ShardManifestCorrupt(
      shardPath,
      `shard ${String(parsed.shard)} does not match fanout ${fanout}`
    );
  }
  if (typeof parsed.complete !== "boolean") {
    throw new ShardManifestCorrupt(shardPath, "complete must be a boolean");
  }
  if (!isPlainObject(parsed.records)) {
    throw new ShardManifestCorrupt(shardPath, "records must be an object");
  }

  const records: Record<string, RecordEntry> = {};
  for (const [sysId, raw] of Object.entries(parsed.records)) {
    if (!isMirrorSysId(sysId)) {
      throw new ShardManifestCorrupt(
        shardPath,
        `record key ${describeOffendingValue(sysId)} is not a sys_id (INV-6)`
      );
    }
    if (sysId.slice(0, fanout) !== parsed.shard) {
      throw new ShardManifestCorrupt(
        shardPath,
        `record ${sysId} does not belong in shard "${parsed.shard}"`
      );
    }
    records[sysId] = parseRecordEntry(raw, shardPath, sysId);
  }

  return {
    formatVersion: FORMAT_VERSION,
    table: parsed.table,
    shard: parsed.shard,
    fanout,
    complete: parsed.complete,
    sweepId: parsed.sweepId,
    records,
  };
}

/**
 * Validate one entry read off disk.
 *
 * `name` goes through the containment predicate because it is a directory
 * component; `path` goes through a segment walk because it is a repo-relative
 * multi-segment path and `isSafePathComponent` would reject the separators. The
 * walk rejects absolute paths, backslashes (a Windows-authored path that would
 * escape on Linux), empty segments and `.`/`..` — i.e. every way a committed shard
 * could point the reconciler at a directory outside the mirror and have it deleted.
 *
 * `attachments` (§4.3, optional) is carried through and validated on the same terms
 * as everything else: absent stays absent, present is checked field by field, and a
 * malformed one corrupts the shard. It would have been defensible to leave the field
 * to WP-M9, which is the work package that first writes it — but the parser is what
 * decides whether a shard round-trips, and a field that renders on the way out and
 * vanishes on the way back in makes an entry compare unequal to itself, so every
 * sweep would rewrite every shard that had an attachment and INV-1 would be lost for
 * exactly the records with the most bytes behind them. `fileName` goes through the
 * component predicate for the same reason `name` does — it becomes a file inside the
 * record directory, so a committed `../../id_rsa` is a write outside the mirror.
 */
function parseRecordEntry(
  raw: unknown,
  shardPath: string,
  sysId: string
): RecordEntry {
  if (!isPlainObject(raw)) {
    throw new ShardManifestCorrupt(shardPath, `record ${sysId} is not an object`);
  }
  const {
    path,
    name,
    sysUpdatedOn,
    sysUpdatedBy,
    sysModCount,
    contentHash,
    files,
    attachments,
  } = raw;
  if (typeof name !== "string" || !isSafePathComponent(name)) {
    throw new ShardManifestCorrupt(
      shardPath,
      `record ${sysId} has an unusable name ${describeOffendingValue(name)}`
    );
  }
  if (typeof path !== "string" || !isContainedRepoPath(path)) {
    throw new ShardManifestCorrupt(
      shardPath,
      `record ${sysId} has an unusable path ${describeOffendingValue(path)}`
    );
  }
  if (
    typeof sysUpdatedOn !== "string" ||
    typeof sysUpdatedBy !== "string" ||
    typeof contentHash !== "string"
  ) {
    throw new ShardManifestCorrupt(
      shardPath,
      `record ${sysId} has non-string tracking columns`
    );
  }
  if (typeof sysModCount !== "number" || !Number.isFinite(sysModCount)) {
    throw new ShardManifestCorrupt(
      shardPath,
      `record ${sysId} has a non-numeric sysModCount`
    );
  }
  if (!Array.isArray(files)) {
    throw new ShardManifestCorrupt(
      shardPath,
      `record ${sysId} has a non-array file list`
    );
  }
  for (const file of files) {
    // Each member is a file name INSIDE the record directory, so it earns the same
    // component check as `name` and an attachment's `fileName` rather than a mere
    // typeof. Shard files are committed to git, which makes every string in them
    // attacker-influenced input: `files: ["../../../.ssh/authorized_keys"]` is a
    // read the verifier performs and a name the writer's prune logic honours, both
    // outside the record directory the entry claims.
    if (typeof file !== "string" || !isSafePathComponent(file)) {
      throw new ShardManifestCorrupt(
        shardPath,
        `record ${sysId} lists an unusable file name ${describeOffendingValue(file)}`
      );
    }
  }
  const entry: RecordEntry = {
    path,
    name,
    sysUpdatedOn,
    sysUpdatedBy,
    sysModCount,
    contentHash,
    files: [...(files as string[])].sort(compareBytewise),
  };
  // `undefined` is not assigned: the entry is rendered by `canonicalJsonBytes`, and
  // an explicitly-present `attachments: undefined` key would serialize differently
  // from an absent one on some paths. Absent in, absent out.
  if (attachments !== undefined) {
    entry.attachments = parseAttachments(attachments, shardPath, sysId);
  }
  return entry;
}

/** One attachment's shape as §4.3 declares it. */
type AttachmentEntry = NonNullable<RecordEntry["attachments"]>[number];

/**
 * Validate a record's attachment list off disk, sorted for INV-1.
 *
 * Sorting by sys_id rather than trusting the stored order is the same decision
 * `files` makes one field above: the order the instance happens to return
 * attachments in is not stable across sweeps, and an unstable order inside a shard
 * is a diff on every run for a record nobody touched.
 */
function parseAttachments(
  raw: unknown,
  shardPath: string,
  sysId: string
): AttachmentEntry[] {
  if (!Array.isArray(raw)) {
    throw new ShardManifestCorrupt(
      shardPath,
      `record ${sysId} has a non-array attachments list`
    );
  }
  const parsed = raw.map((item): AttachmentEntry => {
    if (!isPlainObject(item)) {
      throw new ShardManifestCorrupt(
        shardPath,
        `record ${sysId} has an attachment that is not an object`
      );
    }
    const { sysId: attachmentSysId, fileName, sizeBytes, sha256, lfs } = item;
    if (!isMirrorSysId(attachmentSysId)) {
      throw new ShardManifestCorrupt(
        shardPath,
        `record ${sysId} has an attachment whose sys_id ${describeOffendingValue(
          attachmentSysId
        )} fails INV-6`
      );
    }
    if (typeof fileName !== "string" || !isSafePathComponent(fileName)) {
      throw new ShardManifestCorrupt(
        shardPath,
        `record ${sysId} has an attachment with an unusable fileName ${describeOffendingValue(
          fileName
        )}`
      );
    }
    if (
      typeof sizeBytes !== "number" ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      throw new ShardManifestCorrupt(
        shardPath,
        `record ${sysId} has an attachment with a non-integer sizeBytes`
      );
    }
    if (typeof sha256 !== "string" || typeof lfs !== "boolean") {
      throw new ShardManifestCorrupt(
        shardPath,
        `record ${sysId} has an attachment with a malformed sha256 or lfs flag`
      );
    }
    return { sysId: attachmentSysId, fileName, sizeBytes, sha256, lfs };
  });
  return parsed.sort((left, right) => compareBytewise(left.sysId, right.sysId));
}

/**
 * Whether a repo-relative path stays inside the repo.
 *
 * Deliberately not `path.normalize` + a prefix check: normalization resolves `..`
 * and then the check passes for `a/../../b` only if the prefix logic is exactly
 * right, and "exactly right" is where these checks historically go wrong. Rejecting
 * the dangerous segments outright is a smaller thing to be sure about.
 */
export function isContainedRepoPath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".."
  );
}
