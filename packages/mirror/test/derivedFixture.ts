// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared fixtures for the derived-views tests (WP-M12, §5.12, INV-9).
 *
 * Two things live here and both exist to keep the tests honest:
 *
 *  - **A fuller in-memory `WriterFs`.** The checkpoint tests' MemoryFs only
 *    models files, because the checkpoint is one file. The derived layer
 *    renames and removes whole DIRECTORIES (`atomicRemoveDir` renames the
 *    target aside before deleting it), and its reader walks directory
 *    listings, so this one models directories as first-class entries: a
 *    directory rename moves its subtree, `readDir` lists child directories
 *    with `isDirectory: true`, and `removeRecursive` takes descendants with
 *    it. `writeFile` still refuses a parent that was never made, the way
 *    `open(2)` does, so a builder that forgot its `makeDir` fails here too.
 *
 *  - **A canonical-tree builder that uses the PRODUCTION writers.** Shard sets
 *    go through `writeShardSet` and envelopes through `atomicWriteFile` +
 *    `canonicalJsonBytes`, not through hand-rolled JSON, because INV-9 is a
 *    claim about reading what the real writer wrote — a fixture that spelled
 *    its own manifests could pass while the real formats drifted.
 *
 * The enumeration-permuting wrapper is the determinism test's whole lever: it
 * reverses every `readDir` listing, so any derived byte that depends on
 * enumeration order (instead of `compareBytewise` sorting) shows up as a diff
 * between two otherwise identical trees.
 */
import { sep } from "node:path";

import type { MirrorConfig, RecordEntry } from "../src/contracts";
import { loadMirrorConfig } from "../src/config/loadConfig";
import { RECORD_FILE_NAME, recordDirRelPath } from "../src/shards/shardLayout";
import { writeShardSet } from "../src/shards/shardStore";
import { canonicalJsonBytes, encodeUtf8 } from "../src/serialize/serializer";
import { atomicWriteFile } from "../src/write/atomicWrite";
import type { WriterDirEntry, WriterFs } from "../src/write/fs";
import { toNativePath } from "../src/write/fs";

export const ROOT = `${sep}mirror-root`;

/**
 * A full `MirrorConfig` with the derived flags overridden. Built through the
 * production loader so the tests exercise the exact defaults (`derived.*` all
 * true) the orchestrator will hand `generateDerivedViews`.
 */
export function derivedConfig(
  overrides: Partial<MirrorConfig["derived"]> = {}
): MirrorConfig {
  const base = loadMirrorConfig({});
  return { ...base, derived: { ...base.derived, ...overrides } };
}

/** A sys_id-shaped value, distinct per index (INV-6). */
export function sysIdFor(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function parentOf(nativePath: string): string {
  const index = nativePath.lastIndexOf(sep);
  return index <= 0 ? sep : nativePath.slice(0, index);
}

export class DerivedMemoryFs implements WriterFs {
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
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from) as Uint8Array);
      this.files.delete(from);
      return;
    }
    if (this.dirs.has(from)) {
      const fromPrefix = `${from}${sep}`;
      const toPrefix = `${to}${sep}`;
      for (const dir of [...this.dirs]) {
        if (dir === from || dir.startsWith(fromPrefix)) {
          this.dirs.delete(dir);
          this.dirs.add(dir === from ? to : `${toPrefix}${dir.slice(fromPrefix.length)}`);
        }
      }
      for (const [filePath, bytes] of [...this.files]) {
        if (filePath.startsWith(fromPrefix)) {
          this.files.delete(filePath);
          this.files.set(`${toPrefix}${filePath.slice(fromPrefix.length)}`, bytes);
        }
      }
      return;
    }
    throw new Error(`ENOENT: nothing to rename at ${from}`);
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(filePath);
    return bytes === undefined ? null : new Uint8Array(bytes);
  }

  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    if (!this.dirs.has(dir)) {
      return null;
    }
    const entries: WriterDirEntry[] = [];
    for (const candidate of this.dirs) {
      if (parentOf(candidate) === dir) {
        entries.push({ name: candidate.slice(dir.length + sep.length), isDirectory: true });
      }
    }
    for (const filePath of this.files.keys()) {
      if (parentOf(filePath) === dir) {
        entries.push({ name: filePath.slice(dir.length + sep.length), isDirectory: false });
      }
    }
    return entries;
  }

  async removeRecursive(target: string): Promise<void> {
    this.files.delete(target);
    const prefix = `${target}${sep}`;
    for (const dir of [...this.dirs]) {
      if (dir === target || dir.startsWith(prefix)) {
        this.dirs.delete(dir);
      }
    }
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
      }
    }
  }

  /** Every file under `_derived/`, path → decoded text, for byte-identity checks. */
  derivedFiles(): Map<string, string> {
    const result = new Map<string, string>();
    const prefix = `${ROOT}${sep}_derived${sep}`;
    for (const [filePath, bytes] of this.files) {
      if (filePath.startsWith(prefix)) {
        result.set(filePath, new TextDecoder("utf-8").decode(bytes));
      }
    }
    return result;
  }
}

/**
 * A `WriterFs` whose every directory listing comes back reversed.
 *
 * Everything else delegates, so the only difference between a run over this
 * and a run over the inner fs is enumeration order — exactly the input INV-9
 * says the derived bytes must not depend on.
 */
export function reversedListingFs(inner: WriterFs): WriterFs {
  return {
    makeDir: (dir) => inner.makeDir(dir),
    writeFile: (filePath, bytes) => inner.writeFile(filePath, bytes),
    rename: (from, to) => inner.rename(from, to),
    readFile: (filePath) => inner.readFile(filePath),
    removeRecursive: (target) => inner.removeRecursive(target),
    readDir: async (dir) => {
      const listing = await inner.readDir(dir);
      return listing === null ? null : [...listing].reverse();
    },
  };
}

/** One record to place into the fixture tree. */
export interface FixtureRecord {
  /** Defaults to `global`. */
  scope?: string;
  table: string;
  sysId: string;
  /** Folded display name for the shard entry; defaults to the sys_id. */
  name?: string;
  /** Envelope fields beyond `sys_id`. */
  fields?: Record<string, string>;
  /** Raw `record.json` text instead of a canonical envelope (malformed cases). */
  envelopeText?: string;
  /** Write no `record.json` at all — the missing-envelope case. */
  omitEnvelope?: boolean;
}

/**
 * Build a canonical tree through the production shard and envelope writers.
 *
 * `incompleteTables` marks tables whose shard sets get `complete: false`
 * (INV-4) — the input the dangling-reference detector must refuse to treat
 * as evidence of absence.
 */
export async function buildCanonicalTree(
  fs: WriterFs,
  records: readonly FixtureRecord[],
  options: { incompleteTables?: readonly string[] } = {}
): Promise<void> {
  const incomplete = new Set(options.incompleteTables ?? []);
  const groups = new Map<string, { scope: string; table: string; entries: Map<string, RecordEntry> }>();
  for (const record of records) {
    const scope = record.scope ?? "global";
    const name = record.name ?? record.sysId;
    const recordDir = recordDirRelPath({
      scope,
      table: record.table,
      sysId: record.sysId,
      name,
    });
    const entry: RecordEntry = {
      path: recordDir,
      name,
      sysUpdatedOn: "2026-01-01 00:00:00",
      sysUpdatedBy: "fixture",
      sysModCount: 1,
      contentHash: "0".repeat(64),
      files: [RECORD_FILE_NAME],
    };
    // NUL joins the pair for the same reason `reconciler.ts` uses one: it cannot
    // occur in a scope or a table name, so no two distinct (scope, table) pairs
    // can collide on one key the way a `.` or `^` joiner would let them.
    const key = `${scope}\u0000${record.table}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { scope, table: record.table, entries: new Map() };
      groups.set(key, group);
    }
    group.entries.set(record.sysId, entry);

    if (record.omitEnvelope === true) {
      continue;
    }
    const recordDirNative = toNativePath(ROOT, recordDir);
    await fs.makeDir(recordDirNative);
    const envelopeNative = [recordDirNative, RECORD_FILE_NAME].join(sep);
    const bytes =
      record.envelopeText !== undefined
        ? encodeUtf8(record.envelopeText)
        : canonicalJsonBytes({ sys_id: record.sysId, ...(record.fields ?? {}) });
    await atomicWriteFile(fs, envelopeNative, bytes);
  }
  for (const group of groups.values()) {
    await writeShardSet(fs, {
      root: ROOT,
      scope: group.scope,
      table: group.table,
      fanout: 0,
      complete: !incomplete.has(group.table),
      sweepId: "sweep-fixture",
      entries: group.entries,
    });
  }
}
