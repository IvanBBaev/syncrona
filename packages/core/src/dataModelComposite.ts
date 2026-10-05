// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { promises as fsp } from "fs";
import path from "path";
import { FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import { META_SIDECAR_FILE_NAME, isMetaSidecarPath, stripBOM } from "./metaFields.js";
import { getDataModelTables, isValidDataModelTableName } from "./dataModel.js";
import { isSafePathComponent } from "./genericUtils.js";

/**
 * SDK-F2 — composite data-model documents.
 *
 * Under R4 every data-model record is its own `.meta.json` sidecar, so one
 * table with forty columns and a few choice lists is a hundred-odd one-file
 * folders spread over three table directories. With `dataModelLayout:
 * "composite"` the table definition, its dictionary entries and their choices
 * are held in ONE document per table instead:
 *
 *   <sourceDirectory>/data-model/<table>.json
 *
 * The document is a deterministic container of exactly the sidecars it
 * replaces: every entry is the sidecar object of one record, keyed by the
 * record's manifest name, under the section of its table. Nothing about the
 * records changes — the manifest, the record names, the metadata columns, the
 * push rules — only where the sidecar text lives. That is what keeps push,
 * create, adopt, prune and repair on their existing rules: a document is
 * expanded into "virtual" sidecars at the per-record paths and handed to the
 * same pipeline. See docs/DATA_MODEL.md.
 *
 * The layout is opt-in; `records` (the R4 layout) stays the default. Holding
 * both representations of the same record is refused everywhere, because
 * which one a push sends would otherwise depend on the order the files were
 * listed in.
 */

export type DataModelLayout = "records" | "composite";

/** The accepted values of `dataModelLayout`, default first. */
export const DATA_MODEL_LAYOUTS: readonly DataModelLayout[] = Object.freeze([
  "records",
  "composite",
]);

export const isValidDataModelLayout = (value: unknown): value is DataModelLayout =>
  typeof value === "string" && (DATA_MODEL_LAYOUTS as readonly string[]).includes(value);

/** The configured layout; anything but an exact `"composite"` is the default. */
export const getDataModelLayout = (
  config: Pick<Sync.Config, "dataModelLayout"> | undefined
): DataModelLayout => (config?.dataModelLayout === "composite" ? "composite" : "records");

/**
 * The tables a composite document holds, in document order. The order is also
 * the push order: a column cannot be created before its table, nor a choice
 * before its column.
 */
export const COMPOSITE_TABLES: readonly string[] = Object.freeze([
  "sys_db_object",
  "sys_dictionary",
  "sys_choice",
]);

/**
 * The tables this workspace keeps in composite documents: the composite tables
 * it also opts in through `dataModelTables`, and none at all in the `records`
 * layout.
 */
export const getCompositeTables = (
  config: Pick<Sync.Config, "dataModelLayout" | "dataModelTables"> | undefined
): string[] => {
  if (getDataModelLayout(config) !== "composite") return [];
  const tracked = getDataModelTables(config);
  return COMPOSITE_TABLES.filter((table) => tracked.includes(table));
};

/** Position of `table` in the push order; non-composite tables go last. */
export const compositeTier = (table: string): number => {
  const index = COMPOSITE_TABLES.indexOf(table);
  return index === -1 ? COMPOSITE_TABLES.length : index;
};

/**
 * The directory the documents live in, directly under the source directory. A
 * hyphen never occurs in a ServiceNow table name, so no table directory can
 * collide with it, and every path parser that expects `<table>/...` (the push
 * path lookup, `push --create`, the repair orphan scan) already ignores it.
 */
export const DATA_MODEL_DIRECTORY = "data-model";

/** The `format` marker every document carries; a different one is refused. */
export const COMPOSITE_FORMAT = "syncrona.data-model/1";

const DOCUMENT_EXT = ".json";

export const compositeDocumentDir = (sourcePath: string): string =>
  path.join(sourcePath, DATA_MODEL_DIRECTORY);

export const compositeDocumentPath = (sourcePath: string, group: string): string =>
  path.join(compositeDocumentDir(sourcePath), `${group}${DOCUMENT_EXT}`);

/** True for `<sourcePath>/data-model/<name>.json`, and nothing deeper. */
export const isCompositeDocumentPath = (filePath: string, sourcePath: string): boolean => {
  const rel = path.relative(path.resolve(sourcePath), path.resolve(filePath));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const segments = rel.split(/[/\\]/).filter((token) => token !== "");
  return (
    segments.length === 2 &&
    segments[0] === DATA_MODEL_DIRECTORY &&
    segments[1].endsWith(DOCUMENT_EXT) &&
    segments[1].length > DOCUMENT_EXT.length
  );
};

/** Where the record's R4 sidecar lives in the `records` layout. */
export const perRecordSidecarPath = (
  sourcePath: string,
  table: string,
  recordName: string,
  flat: boolean
): string =>
  flat
    ? path.join(sourcePath, table, `${recordName}${FLAT_FIELD_SEPARATOR}${META_SIDECAR_FILE_NAME}`)
    : path.join(sourcePath, table, recordName, META_SIDECAR_FILE_NAME);

/**
 * Why `recordName` cannot name a document entry, or undefined when it can.
 *
 * An entry's key is joined onto `<sourcePath>/<table>/` to form the virtual
 * sidecar path push resolves against the manifest, and that resolution reads
 * only the LAST path segments. A key such as `../sys_script/foo` (or anything
 * holding a separator) therefore normalizes into another table's directory and
 * names an unrelated record — so a document edit would PATCH, or with `--create`
 * create, a record of a table the composite layout does not cover. A key must
 * be exactly one path segment, the same rule every instance-supplied name
 * clears before it reaches the disk (INJ-1). `__proto__` and friends stay
 * legal: they are real ServiceNow names, and every map here is null-prototype.
 */
export const unsafeCompositeRecordName = (recordName: string): string | undefined => {
  if (recordName === "") return "it is empty";
  if (recordName.includes("\u0000")) return "it contains a NUL character";
  if (/^\.+$/.test(recordName)) return "it is a relative directory name";
  if (!isSafePathComponent(recordName)) return "it contains a path separator";
  return undefined;
};

/**
 * The composite table `filePath` is a stray per-record sidecar of, or undefined.
 *
 * Under the `composite` layout the metadata of these tables lives only in the
 * data-model documents, so a `<table>/<record>/.meta.json` (or flat
 * `<table>/<record>~.meta.json`) of one of them is a second copy of a record
 * that must not be pushed: which copy reached the instance would depend on
 * which file the user happened to save last. `push` refuses it and `dev`
 * skips it, both through this one rule.
 */
export const strayCompositeSidecarTable = (
  filePath: string,
  sourcePath: string,
  config: Pick<Sync.Config, "dataModelLayout" | "dataModelTables"> | undefined
): string | undefined => {
  if (getDataModelLayout(config) !== "composite" || !isMetaSidecarPath(filePath)) return undefined;
  const rel = path.relative(path.resolve(sourcePath), path.resolve(filePath));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const table = rel.split(/[/\\]/).filter((token) => token !== "")[0];
  return getCompositeTables(config).includes(table) ? table : undefined;
};

/** The refusal `push` and `dev` share for a stray per-record sidecar. */
export const strayCompositeSidecarMessage = (filePath: string, table: string): string =>
  `${filePath} is a per-record sidecar, but dataModelLayout is "composite": ` +
  `${table} metadata lives in the data-model documents.`;

/** One record's sidecar object: column → value. */
export type CompositeEntry = Record<string, unknown>;

/** A parsed document: its table, and per composite table the entries by record name. */
export interface CompositeDocument {
  table: string;
  sections: Record<string, Record<string, CompositeEntry>>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

/** A null-prototype copy, so a column or record named `__proto__` stays a key. */
const ownCopy = <T>(source: Record<string, T>): Record<string, T> => {
  const copy: Record<string, T> = Object.create(null);
  for (const key of Object.keys(source)) copy[key] = source[key];
  return copy;
};

const sortedCopy = <T>(source: Record<string, T>): Record<string, T> => {
  const copy: Record<string, T> = Object.create(null);
  // Plain code-unit order, never locale order: the file must be the same bytes
  // on every machine.
  for (const key of Object.keys(source).sort()) copy[key] = source[key];
  return copy;
};

/** An empty document for `table`. */
export const emptyCompositeDocument = (table: string): CompositeDocument => ({
  table,
  sections: Object.create(null),
});

/**
 * Parse and validate one document. Every structural problem is an error that
 * names the file: a document is the only copy of the sidecars it holds, so
 * guessing past a malformed one would push (or drop) the wrong columns.
 */
export const parseCompositeDocument = (text: string, docPath: string): CompositeDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBOM(text));
  } catch (e) {
    throw new Error(
      `${docPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${docPath} must be a JSON object (a data-model document).`);
  }
  if (parsed.format !== COMPOSITE_FORMAT) {
    throw new Error(
      `${docPath} is not a data-model document: "format" must be "${COMPOSITE_FORMAT}".`
    );
  }
  const expected = path.basename(docPath, DOCUMENT_EXT);
  if (parsed.table !== expected) {
    throw new Error(
      `${docPath} must have "table": "${expected}" — a document is named after its table.`
    );
  }
  const unknown = Object.keys(parsed).filter(
    (key) => key !== "format" && key !== "table" && !COMPOSITE_TABLES.includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(
      `${docPath} has unknown key(s) ${unknown.sort().join(", ")}; a data-model ` +
        `document holds only "format", "table" and the sections ${COMPOSITE_TABLES.join(", ")}.`
    );
  }
  const doc = emptyCompositeDocument(expected);
  for (const table of COMPOSITE_TABLES) {
    if (!hasOwn(parsed, table)) continue;
    const section = parsed[table];
    if (!isPlainObject(section)) {
      throw new Error(`${docPath}: section "${table}" must be an object of records.`);
    }
    const entries: Record<string, CompositeEntry> = Object.create(null);
    for (const recordName of Object.keys(section)) {
      const unsafe = unsafeCompositeRecordName(recordName);
      if (unsafe !== undefined) {
        throw new Error(
          `${docPath}: ${table} entry ${JSON.stringify(recordName)} is not a valid record ` +
            `name: ${unsafe}. An entry is keyed by the record's manifest name, which is a ` +
            "single path segment."
        );
      }
      const entry = section[recordName];
      if (!isPlainObject(entry)) {
        throw new Error(
          `${docPath}: ${table} entry "${recordName}" must be a JSON object of ` +
            '"column": "value" pairs.'
        );
      }
      entries[recordName] = ownCopy(entry);
    }
    doc.sections[table] = entries;
  }
  return doc;
};

/**
 * The document's bytes. Fixed top-level order (format, table, then the
 * sections in COMPOSITE_TABLES order), empty sections left out, entries and
 * columns sorted — so the file is a function of its records and nothing else,
 * and a re-download of an unchanged table rewrites the same bytes.
 */
export const serializeCompositeDocument = (doc: CompositeDocument): string => {
  const out: Record<string, unknown> = { format: COMPOSITE_FORMAT, table: doc.table };
  for (const table of COMPOSITE_TABLES) {
    const section = hasOwn(doc.sections, table) ? doc.sections[table] : undefined;
    if (!section || Object.keys(section).length === 0) continue;
    const sorted: Record<string, CompositeEntry> = Object.create(null);
    for (const recordName of Object.keys(section).sort()) {
      sorted[recordName] = sortedCopy(section[recordName]);
    }
    out[table] = sorted;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
};

/**
 * One entry as the sidecar text it stands for: columns sorted, two-space
 * indent, trailing newline — the same bytes serializeMetaFields writes, so a
 * downloaded entry expands to exactly the sidecar the instance produced.
 */
export const serializeCompositeEntry = (entry: CompositeEntry): string =>
  `${JSON.stringify(sortedCopy(entry), null, 2)}\n`;

/**
 * The document a record belongs in: its `name` column (the table a table
 * definition, a dictionary entry and a choice all name), or else the first
 * segment of its record name. Undefined when neither is a table name.
 */
export const compositeGroupFor = (
  recordName: string,
  entry: CompositeEntry
): string | undefined => {
  const name = entry.name;
  if (isValidDataModelTableName(name)) return name;
  const head = recordName.split(".")[0];
  return isValidDataModelTableName(head) ? head : undefined;
};

/** Absolute paths of every document under the source directory, sorted. */
export const listCompositeDocuments = async (sourcePath: string): Promise<string[]> => {
  const dir = compositeDocumentDir(sourcePath);
  let names: string[];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(DOCUMENT_EXT))
      .map((entry) => entry.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  return names.sort().map((name) => path.join(dir, name));
};

export const readCompositeDocument = async (docPath: string): Promise<CompositeDocument> =>
  parseCompositeDocument(await fsp.readFile(docPath, "utf8"), docPath);

/** Where one record's entry lives. */
export interface CompositeIndexEntry {
  docPath: string;
  group: string;
  table: string;
  recordName: string;
  entry: CompositeEntry;
}

export const compositeIndexKey = (table: string, recordName: string): string =>
  `${table}\u0000${recordName}`;

/**
 * Every entry of every document, by table and record name. A record held by
 * two documents is refused: which copy a push sends would depend on the order
 * the documents were read in.
 */
export const loadCompositeIndex = async (
  sourcePath: string
): Promise<Map<string, CompositeIndexEntry>> => {
  const index = new Map<string, CompositeIndexEntry>();
  for (const docPath of await listCompositeDocuments(sourcePath)) {
    const doc = await readCompositeDocument(docPath);
    for (const table of Object.keys(doc.sections)) {
      for (const recordName of Object.keys(doc.sections[table])) {
        const key = compositeIndexKey(table, recordName);
        const prior = index.get(key);
        if (prior) {
          throw new Error(
            `${table} record "${recordName}" is held by two data-model documents ` +
              `(${prior.docPath}, ${docPath}). Keep it in one of them and retry.`
          );
        }
        index.set(key, {
          docPath,
          group: doc.table,
          table,
          recordName,
          entry: doc.sections[table][recordName],
        });
      }
    }
  }
  return index;
};

/** The migration hint shared by every "both layouts" error. */
export const LAYOUT_CONFLICT_HINT =
  'Keep one layout per record: with dataModelLayout "composite" delete the ' +
  "per-record .meta.json files of these records and run `syncrona refresh` to " +
  'write the documents; with "records" delete the data-model/ documents instead.';

const describePaths = (paths: string[]): string => {
  const shown = paths.slice(0, 10).map((p) => `  ${p}`);
  if (paths.length > shown.length) shown.push(`  … and ${paths.length - shown.length} more`);
  return shown.join("\n");
};

export const pathExistsPlain = async (target: string): Promise<boolean> => {
  try {
    await fsp.access(target);
    return true;
  } catch (_e) {
    return false;
  }
};

/**
 * Refuse a document entry the `composite` layout is about to write for a
 * record that still has a per-record sidecar on disk.
 */
export const assertNoPerRecordSidecars = async (
  sourcePath: string,
  records: Array<{ table: string; recordName: string }>,
  flat: boolean
): Promise<void> => {
  const conflicts: string[] = [];
  for (const record of records) {
    const sidecar = perRecordSidecarPath(sourcePath, record.table, record.recordName, flat);
    if (await pathExistsPlain(sidecar)) conflicts.push(sidecar);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `dataModelLayout is "composite", but ${conflicts.length} record(s) still have a ` +
        `per-record sidecar:\n${describePaths(conflicts)}\n${LAYOUT_CONFLICT_HINT}`
    );
  }
};

/** A sidecar the download produced for a record of a composite table. */
export interface CompositeWrite {
  table: string;
  recordName: string;
  /** The sidecar text (serializeMetaFields output). */
  content: string;
}

/**
 * Merge downloaded sidecars into their documents.
 *
 * - `force` (download): an entry is replaced by what the instance sent.
 * - otherwise (init, refresh, repair --apply): only entries the document lacks
 *   are added; an existing entry may hold a local edit and is kept.
 *
 * Entries the batch does not mention are always kept, a document none of whose
 * entries would change is not rewritten (whatever its formatting on disk), and
 * a record that also has a per-record sidecar on disk is refused before
 * anything is written.
 */
export const mergeCompositeWrites = async (
  sourcePath: string,
  writes: CompositeWrite[],
  options: { force: boolean; flat: boolean }
): Promise<string[]> => {
  if (writes.length === 0) return [];
  await assertNoPerRecordSidecars(sourcePath, writes, options.flat);
  const index = await loadCompositeIndex(sourcePath);
  const byGroup = new Map<string, Array<{ write: CompositeWrite; entry: CompositeEntry }>>();
  for (const write of writes) {
    const unsafe = unsafeCompositeRecordName(write.recordName);
    if (unsafe !== undefined) {
      throw new Error(
        `${write.table} record ${JSON.stringify(write.recordName)} cannot be placed in a ` +
          `data-model document: ${unsafe}.`
      );
    }
    let entry: unknown;
    try {
      entry = JSON.parse(stripBOM(write.content));
    } catch (e) {
      throw new Error(
        `${write.table} record "${write.recordName}": the downloaded metadata is not ` +
          `valid JSON: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (!isPlainObject(entry)) {
      throw new Error(
        `${write.table} record "${write.recordName}": the downloaded metadata is not a JSON object.`
      );
    }
    // A record already held by a document stays in it, whatever its columns
    // say now: moving it would leave the old document holding a stale copy.
    const known = index.get(compositeIndexKey(write.table, write.recordName));
    const group = known?.group ?? compositeGroupFor(write.recordName, entry);
    if (group === undefined) {
      throw new Error(
        `${write.table} record "${write.recordName}" names no table, so it cannot be ` +
          "placed in a data-model document."
      );
    }
    let list = byGroup.get(group);
    if (!list) {
      list = [];
      byGroup.set(group, list);
    }
    list.push({ write, entry: ownCopy(entry) });
  }
  const written: string[] = [];
  // Sequential and in a fixed order: two batches never touch one document at
  // once, and the order files change in does not depend on the instance.
  for (const group of [...byGroup.keys()].sort()) {
    const docPath = compositeDocumentPath(sourcePath, group);
    let before: string | undefined;
    try {
      before = await fsp.readFile(docPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    const doc =
      before === undefined ? emptyCompositeDocument(group) : parseCompositeDocument(before, docPath);
    // Change detection compares canonical entries, never the bytes on disk: a
    // hand-formatted (or CRLF) document whose records the batch leaves as they
    // are is the user's file, and rewriting it on every refresh would churn it.
    let changed = false;
    for (const { write, entry } of byGroup.get(group) as Array<{
      write: CompositeWrite;
      entry: CompositeEntry;
    }>) {
      let section = hasOwn(doc.sections, write.table) ? doc.sections[write.table] : undefined;
      if (!section) {
        section = Object.create(null) as Record<string, CompositeEntry>;
        doc.sections[write.table] = section;
      }
      const prior = hasOwn(section, write.recordName) ? section[write.recordName] : undefined;
      if (prior !== undefined) {
        if (!options.force) continue;
        if (serializeCompositeEntry(prior) === serializeCompositeEntry(entry)) continue;
      }
      section[write.recordName] = entry;
      changed = true;
    }
    if (!changed) continue;
    const after = serializeCompositeDocument(doc);
    await fsp.mkdir(path.dirname(docPath), { recursive: true });
    // Temp file + rename: a crash mid-write leaves the previous document whole.
    const tmpPath = `${docPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmpPath, after);
    await fsp.rename(tmpPath, docPath);
    written.push(docPath);
  }
  return written;
};

/**
 * Refuse a per-record sidecar the `records` layout is about to write for a
 * record a document already holds.
 */
export const assertNoCompositeEntries = async (
  sourcePath: string,
  records: Array<{ table: string; recordName: string }>
): Promise<void> => {
  if (records.length === 0) return;
  const documents = await listCompositeDocuments(sourcePath);
  if (documents.length === 0) return;
  const index = await loadCompositeIndex(sourcePath);
  const held = records
    .map((record) => index.get(compositeIndexKey(record.table, record.recordName)))
    .filter((entry): entry is CompositeIndexEntry => entry !== undefined)
    .map((entry) => `${entry.table} "${entry.recordName}" in ${entry.docPath}`);
  if (held.length > 0) {
    throw new Error(
      `dataModelLayout is "records", but ${held.length} record(s) are held by a ` +
        `data-model document:\n${describePaths(held)}\n${LAYOUT_CONFLICT_HINT}`
    );
  }
};

/** What `repair` and `status` report about the layout. */
export interface CompositeLayoutReport {
  layout: DataModelLayout;
  documents: string[];
  /** Records in both layouts, or files of the layout the config does not use. */
  conflicts: string[];
  /** Document entries no manifest record claims. */
  untracked: string[];
}

/**
 * Inspect the workspace for the data-model layout. Read-only. A malformed
 * document is reported as a conflict rather than thrown, so `status` and
 * `repair` can still describe everything else.
 */
export const inspectCompositeLayout = async (
  manifest: SN.AppManifest | undefined,
  config: Pick<Sync.Config, "dataModelLayout" | "dataModelTables" | "flat">,
  sourcePath: string
): Promise<CompositeLayoutReport> => {
  const layout = getDataModelLayout(config);
  const flat = config.flat === true;
  const documents = await listCompositeDocuments(sourcePath);
  const report: CompositeLayoutReport = { layout, documents, conflicts: [], untracked: [] };
  let index = new Map<string, CompositeIndexEntry>();
  try {
    index = await loadCompositeIndex(sourcePath);
  } catch (e) {
    report.conflicts.push(e instanceof Error ? e.message : String(e));
  }
  if (layout === "records") {
    if (documents.length > 0) {
      report.conflicts.push(
        `${documents.length} data-model document(s) exist under ` +
          `${compositeDocumentDir(sourcePath)}, but dataModelLayout is "records": ` +
          'they are not pushed. Set dataModelLayout: "composite" or delete them.'
      );
    }
    return report;
  }
  const compositeTables = getCompositeTables(config);
  const tables = manifest?.tables ?? {};
  const tracked = new Set<string>();
  for (const table of compositeTables) {
    const tableConfig = hasOwn(tables, table) ? tables[table] : undefined;
    for (const [recordKey, record] of Object.entries(tableConfig?.records ?? {})) {
      const recordName = record?.name || recordKey;
      tracked.add(compositeIndexKey(table, recordName));
      const sidecar = perRecordSidecarPath(sourcePath, table, recordName, flat);
      if (await pathExistsPlain(sidecar)) {
        report.conflicts.push(
          index.has(compositeIndexKey(table, recordName))
            ? `${table} "${recordName}" is in both layouts: ${sidecar} and ` +
                `${(index.get(compositeIndexKey(table, recordName)) as CompositeIndexEntry).docPath}.`
            : `${table} "${recordName}" has a per-record sidecar (${sidecar}) although ` +
                'dataModelLayout is "composite".'
        );
      }
    }
  }
  const foreignSections = new Set<string>();
  for (const [key, entry] of index) {
    if (!compositeTables.includes(entry.table)) {
      const sectionKey = `${entry.docPath}\u0000${entry.table}`;
      if (!foreignSections.has(sectionKey)) {
        foreignSections.add(sectionKey);
        report.conflicts.push(
          `${entry.docPath} holds a ${entry.table} section, but ${entry.table} is not in ` +
            "dataModelTables, so it is never pushed."
        );
      }
      continue;
    }
    if (!tracked.has(key)) {
      report.untracked.push(`${entry.table} "${entry.recordName}" in ${entry.docPath}`);
    }
  }
  return report;
};
