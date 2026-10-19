// SPDX-License-Identifier: GPL-3.0-or-later
//
// Workspace file I/O: where a record field lives on disk, how it is written
// there, and how a path on disk is mapped back to the field it represents.
import { SN, Sync } from "@syncrona/types";
import { PATH_DELIMITER } from "./constants.js";
import { promises as fsp, type PathLike } from "fs";
import path from "path";
import * as ConfigManager from "./config.js";
import { FLAT_FIELD_SEPARATOR, isFlatEncoded } from "./flatLayout.js";
import { isSafePathComponent, unsafePathComponentReason } from "./genericUtils.js";
import { META_FILE_NAME, META_FILE_TYPE, isMetaSidecarPath } from "./metaFields.js";
import { findSecretJsonPaths, formatJsonFieldForDisk } from "./jsonFieldFiles.js";
import { logger } from "./Logger.js";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Runs `task`, retrying a failed attempt up to `retries` more times with a
 * `waitMs` pause in between. The error of the final attempt is rethrown.
 */
export const withRetry = async <T>(
  task: () => Promise<T>,
  retries = 2,
  waitMs = 50,
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (failure) {
      if (attempt >= retries) throw failure;
      if (waitMs > 0) await pause(waitMs);
    }
  }
};

/** Path segments split on either separator, empty segments dropped. */
const segmentsOf = (anyPath: string): string[] =>
  anyPath.split(/[/\\]/).filter((segment) => segment !== "");

/** The last segment of a path, whichever separator it was written with. */
const lastSegmentOf = (anyPath: string): string => segmentsOf(anyPath).pop() || "";

/** `path.extname`, answering "" instead of throwing on unusable input. */
const extensionOf = (filePath: string): string => {
  try {
    return path.extname(filePath);
  } catch {
    return "";
  }
};

/** The on-disk name the writer gives a field: `<name>.<type>`. */
const fieldFileName = (field: Pick<SN.File, "name" | "type">): string =>
  `${field.name}.${field.type}`;

// ATF steps keep their script in a dot-walked column, and every file in an ATF
// step's folder maps onto it regardless of the file's own stem.
const ATF_STEP_TABLE = "sys_atf_step";
const ATF_SCRIPT_FIELD = "inputs.script";
const fieldForTable = (table: string | undefined, stem: string): string =>
  table === ATF_STEP_TABLE ? ATF_SCRIPT_FIELD : stem;

// Files editors and the OS drop next to the real ones: dotfiles (.DS_Store, a
// vim swap file), backups (`script.js~`, `.bak`, `.orig`) and Windows folder
// metadata. The field is the file STEM — `script.js~` has stem `script` — and
// every file of an ATF step folder maps to `inputs.script`, so without this a
// swap file or `.DS_Store` resolved to a real field and was pushed into it.
const EDITOR_ARTIFACT_NAME = /(?:~|\.(?:swp|swo|swx|bak|orig|tmp))$/i;
const OS_METADATA_NAMES = new Set(["thumbs.db", "desktop.ini"]);
const isEditorArtifactPath = (filePath: string): boolean => {
  if (isMetaSidecarPath(filePath)) return false;
  const base = lastSegmentOf(filePath);
  return (
    base.startsWith(".") ||
    EDITOR_ARTIFACT_NAME.test(base) ||
    OS_METADATA_NAMES.has(base.toLowerCase())
  );
};

// ---------------------------------------------------------------------------
// Is a field already on disk?
// ---------------------------------------------------------------------------

// The extension a field wears locally is NOT fixed to the manifest's `type`.
// The push side is the proof: getFileContextFromPath resolves a local path to a
// field by stripping WHATEVER extension it carries and reading the stem, and
// getBuildExt then compiles that source back to the manifest type on the way
// out. So a TypeScript workspace legitimately keeps `script.ts` for a field the
// instance stores as `js`, and that file IS the field's local representation.
//
// Comparison is in the same canonical form repairCommand uses for record names.
// The exact-path probe in isFieldOnDisk is an fsp.stat, which is
// case-insensitive on APFS and NTFS and normalization-insensitive on HFS+ — a
// listing scan that folded differently would make the two halves of one
// predicate disagree about when two names are "the same name". `toLowerCase`,
// never `toLocaleLowerCase`: the latter is locale-dependent (Turkish dotless ı).
const canonicalStem = (name: string): string => name.normalize("NFC").toLowerCase();

// The file already representing `fieldName` in `parentDirPath`, whatever
// extension it carries, or undefined when the field has no local file at all.
//
// Matching is on the STEM and nothing looser. A prefix regex like /^name\..*$/
// was tried once and wrongly claimed files that merely share the start of the
// stem (field `foo` matching `foo.min.js`), reporting them as present and
// skipping a real download. Stem equality rejects those (`foo.min` !== `foo`)
// while still accepting dot-walked field names (`inputs.script.js` ->
// `inputs.script`) and the DX17 flat stem (`<record>~<field>`). Entries with no
// extension are skipped outright: the writer always produces `<name>.<type>`
// with a non-empty type, so a bare directory named like a field is not a
// representation of it.
export const findFieldRepresentation = async (
  parentDirPath: string,
  fieldName: string,
): Promise<string | undefined> => {
  const listing = await fsp.readdir(parentDirPath).catch(() => undefined);
  if (listing === undefined) return undefined;
  const wanted = canonicalStem(fieldName);
  // Editor and OS leftovers (`script.js~`, `script.bak`) share the stem, but
  // push ignores them (getFileContextFromPath), so they cannot represent the
  // field here either: counting one as present hid a deleted `script.js` from
  // refresh and repair, and made a force download keep the backup instead.
  const representsField = (entry: string): boolean => {
    const ext = path.extname(entry);
    if (ext === "" || isEditorArtifactPath(entry)) return false;
    return canonicalStem(path.basename(entry, ext)) === wanted;
  };
  return listing.find(representsField);
};

const statSucceeds = (target: string): Promise<boolean> =>
  fsp.stat(target).then(
    () => true,
    () => false,
  );

const isFieldOnDisk = async (dir: string, field: SN.File): Promise<boolean> => {
  // The exact file the writer produces (`<name>.<type>`) is checked first: one
  // stat, and the overwhelmingly common answer.
  //
  // Existence is the whole answer. This used to be `size > 0` so that the
  // skeleton phase's zero-byte placeholders were re-fetched on refresh — but a
  // field whose value on the instance is legitimately "" writes exactly zero
  // bytes too, so that rule could not tell "not downloaded yet" from
  // "downloaded, and it really is empty". It always guessed the former, so an
  // empty tracked field was reported missing and re-downloaded on every run,
  // forever, while the command still printed "Download complete".
  //
  // The ambiguity is fixed at its SOURCE instead: writeSNFileCurry does not
  // create a file for a request that carries no content (see the note there),
  // so a placeholder is an absent file rather than an empty one, and the only
  // zero-byte file a pull can produce is a converged empty field.
  //
  // Legacy note: a workspace initialised by an older version may still hold
  // placeholders written under the old rule. Those now read as present.
  // `syncrona download` force-writes every tracked field and heals them.
  if (await statSucceeds(path.join(dir, fieldFileName(field)))) return true;
  // Not under the manifest's own extension — but the field may still be on
  // disk under the one the workspace actually edits it in.
  //
  // Answering "missing" here is what made `syncrona refresh` download
  // `script.js` next to an existing `script.ts`: the probe could not see the
  // TypeScript source, the refresh fetched the field, and the writer created a
  // second file claiming it. The workspace then held two claimants for one
  // field and the next `syncrona push` failed outright — groupAppFiles rejects
  // that pair as an "Ambiguous push" — so the damage outlived the stray file.
  return (await findFieldRepresentation(dir, field.name)) !== undefined;
};

/** Curried probe: does `file` already have a local representation in the directory? */
export const SNFileExists =
  (parentDirPath: string) =>
  (file: SN.File): Promise<boolean> =>
    isFieldOnDisk(parentDirPath, file);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Persists the manifest. The JSON goes to a sibling temp file which is then
 * renamed over the real one; rename is atomic on one filesystem, so a crash
 * mid-write leaves the previous manifest intact instead of a truncated one.
 */
export const writeManifestFile = async (appManifest: SN.AppManifest): Promise<void> => {
  const destination = ConfigManager.getManifestPath();
  const staging = `${destination}.${process.pid}.tmp`;
  const serialized = JSON.stringify(appManifest, null, 2);
  await withRetry(async () => {
    await fsp.writeFile(staging, serialized);
    await fsp.rename(staging, destination);
  });
};

// INJ-1, writer half. `name` and `type` are both interpolated into the file name
// (`<name>.<type>`) and joined onto the parent directory, so either one can
// carry a path separator or a ".." and relocate the write. The containment
// guard (resolveContainedTarget) only anchors at the workspace SOURCE ROOT,
// which means a traversal that stays inside the source tree — the
// sibling-record case: a field named "../Bar/script" written from record Foo's
// folder — sails straight through it. Rejecting the components here, before
// path.join ever sees them, makes the writer a true chokepoint: no caller can
// produce a write outside the directory it named as the parent.
//
// The rule is isSafePathComponent, shared with the download seam and getBuildExt
// so the three cannot drift. It deliberately accepts dots INSIDE a component,
// because dot-walked field names ("inputs.script" on sys_atf_step) and the DX17
// flat stem ("<record>~<field>") are both legitimate single components.
const assertSafeWriteComponent = (
  value: string,
  kind: "file name" | "file type" | "record name",
): void => {
  const verdict = unsafePathComponentReason(value);
  if (verdict === undefined) return;
  const escape = verdict.traversal ? " and would escape its target directory" : "";
  throw new Error(
    `Refusing to write: unsafe ${kind} ${JSON.stringify(value)}: ${verdict.reason}${escape}.`,
  );
};

/** Field content as the text that lands on disk; content can arrive as null. */
const toDiskText = (content: unknown): string => {
  if (!content) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
};

/**
 * WP3. A credential inside a JSON column (an AI tool's attributes, an external
 * agent's configuration) must not land in the working tree, where the next
 * commit carries it off. The field is withheld, not redacted: a redacted file
 * would push the placeholder back over the real value. Answers the text to
 * write, or undefined when the field is withheld.
 */
const vetJsonFieldText = (text: string, file: SN.File, parentPath: string): string | undefined => {
  const leaks = findSecretJsonPaths(text);
  if (leaks.length === 0) return formatJsonFieldForDisk(text);
  logger.warn(
    `Withholding "${fieldFileName(file)}" under ${parentPath}: it holds a credential ` +
      `at ${leaks.join(", ")}. Move the value to a credential record ` +
      `or a system property, then download again.`,
  );
  return undefined;
};

// INJ-1 containment guard. Anchor to the workspace source ROOT whenever one is
// loaded, not merely to the caller-supplied parent directory. If the parent
// were itself already escaped (e.g. built from an unsanitized "../evil" table
// name or a scoped "../../.zshrc" record name), a guard anchored to it would
// pass every write that stayed under that escaped parent. The download/refresh
// path — the only one that consumes server- or manifest-supplied names — always
// has a source root loaded, so the stronger anchor applies exactly when a
// tampered manifest is a risk. With no project loaded (isolated writes with no
// source root) the write is contained to its parent directory instead.
const containmentAnchor = (parentPath: string): string => {
  let sourceRoot: unknown;
  try {
    sourceRoot = ConfigManager.getSourcePath();
  } catch {
    sourceRoot = undefined;
  }
  const usable = typeof sourceRoot === "string" && sourceRoot.length > 0;
  return path.resolve(usable ? (sourceRoot as string) : parentPath);
};

const resolveContainedTarget = (parentPath: string, fileName: string): string => {
  const target = path.join(parentPath, fileName);
  const anchor = containmentAnchor(parentPath);
  const absolute = path.resolve(target);
  if (absolute !== anchor && !absolute.startsWith(anchor + path.sep)) {
    throw new Error(`Refusing to write "${fileName}" outside the workspace source root.`);
  }
  return target;
};

type WriteMode = "if-absent" | "force";

// Force write (`syncrona download`, and the wizard's first pull). Overwriting
// the field's OWN file is the whole point — that is how a half-written or
// legacy-placeholder workspace heals. Bringing a SECOND file for the same field
// into existence is not: `<field>.ts` and `<field>.js` side by side are two
// claimants for one field, which is exactly the state that makes the next push
// fail. Force therefore overwrites whenever `<name>.<type>` is the file on
// disk, and declines only when it would create the duplicate.
const forceWouldDuplicate = async (file: SN.File, parentPath: string): Promise<boolean> => {
  if (await pathExists(path.join(parentPath, fieldFileName(file)))) return false;
  const other = await findFieldRepresentation(parentPath, file.name);
  if (other === undefined) return false;
  // Name the kept file by its full path. A scope-wide download hits this once
  // per affected record, and every record spells the field the same way
  // ("script"), so a message built from the field name alone repeats verbatim
  // N times and tells the user nothing about WHICH records to look at.
  const kept = path.join(parentPath, other);
  logger.warn(
    `Keeping local "${kept}" for field "${file.name}" — not writing ` +
      `"${fieldFileName(file)}" beside it, because two files claiming one field make ` +
      `the next push ambiguous. Delete "${kept}" first if you want ` +
      `the downloaded ${file.type} version instead.`,
  );
  return true;
};

const mayWrite = async (mode: WriteMode, file: SN.File, parentPath: string): Promise<boolean> =>
  mode === "if-absent"
    ? !(await isFieldOnDisk(parentPath, file))
    : !(await forceWouldDuplicate(file, parentPath));

const writeFieldFile = async (mode: WriteMode, file: SN.File, parentPath: string): Promise<void> => {
  assertSafeWriteComponent(file.name, "file name");
  assertSafeWriteComponent(file.type, "file type");
  // A manifest ENTRY and a fetched EMPTY VALUE are different things, and the old
  // skeleton phase collapsed them into the same artifact. `{ name, type }` with
  // no `content` key means "this record has this field, its value has not been
  // fetched"; `{ name, type, content: "" }` means "fetched, and the value is
  // empty". Writing the first produced a zero-byte file byte-identical to the
  // second, which is why SNFileExists had to guess (see the note there).
  //
  // So the entry writes nothing at all. The manifest pass still creates every
  // record DIRECTORY, so `init` still materialises the layout; the field is then
  // absent rather than empty, the missing-file scan still reports it, and the
  // follow-up refresh/download still fetches it.
  if (!("content" in file)) return;
  let text: string | undefined = toDiskText(file.content);
  if (file.type === "json" && !isMetaSidecarPath(fieldFileName(file))) {
    text = vetJsonFieldText(text, file, parentPath);
    if (text === undefined) return;
  }
  if (!(await mayWrite(mode, file, parentPath))) return;
  const target = resolveContainedTarget(parentPath, fieldFileName(file));
  const body = text;
  await withRetry(() => fsp.writeFile(target, body));
};

/**
 * Writer for a field file in the folder layout (`<parentPath>/<name>.<type>`).
 * `checkExists` true writes only a field with no local representation yet;
 * false overwrites the field's own file (see forceWouldDuplicate).
 */
export const writeSNFileCurry =
  (checkExists: boolean) =>
  (file: SN.File, parentPath: string): Promise<void> =>
    writeFieldFile(checkExists ? "if-absent" : "force", file, parentPath);

// DX17: write a record's field file in the flat layout — a single file named
// `<record>~<field>.<ext>` directly under the table directory, instead of a
// per-record folder. The flat stem is composed here and handed to the folder
// writer, so both layouts share one writer (its containment guard, its
// entry-vs-empty-value rule and its already-exists check) and stay byte-for-byte
// identical apart from the path.
export const writeFlatSNFileCurry =
  (checkExists: boolean) =>
  async (file: SN.File, tableDirPath: string, recordName: string): Promise<void> => {
    // INJ-1: validate the two halves BEFORE composing them. The composed stem is
    // checked again by the folder writer, but an empty or all-dots half
    // disappears into an innocuous-looking composed name — and an error that
    // names the offending half is what a maintainer can act on.
    assertSafeWriteComponent(recordName, "record name");
    assertSafeWriteComponent(file.name, "file name");
    const flatStem = `${recordName}${FLAT_FIELD_SEPARATOR}${file.name}`;
    return writeSNFileCurry(checkExists)({ ...file, name: flatStem }, tableDirPath);
  };

/** `mkdir -p`: creates the directory and any missing ancestors. */
export const createDirRecursively = async (dirPath: string): Promise<void> => {
  await fsp.mkdir(dirPath, { recursive: true });
};

/** True when anything (file, directory, link target) is reachable at `target`. */
export const pathExists = (target: string): Promise<boolean> =>
  fsp.access(target).then(
    () => true,
    () => false,
  );

/** Curried `path.join`: fixes a base directory, then joins one entry onto it. */
export const appendToPath =
  (base: string) =>
  (entry: string): string =>
    path.join(base, entry);

const DRIVE_SEGMENT = /^[A-Za-z]:$/;

// Windows drive letters are case-insensitive device designators — "C:" and
// "c:" name the same volume, and mismatched casing between two absolute paths
// is routine there (VS Code's integrated terminal and Git Bash yield a
// lowercase drive in process.cwd() while configs carry uppercase). A strict
// compare made getPathsInPath refuse a legitimately in-tree path and return [],
// so push/build silently saw "no files". Only the LEADING segment is folded,
// and only when both sides are pure drive designators: directory names keep
// byte equality — node:path never case-folds names either, and NTFS case
// handling is a filesystem property, not a path-semantics one.
const segmentsMatch = (outer: string, inner: string | undefined, index: number): boolean =>
  index === 0 && DRIVE_SEGMENT.test(outer) && inner !== undefined && DRIVE_SEGMENT.test(inner)
    ? outer.toLowerCase() === inner.toLowerCase()
    : outer === inner;

/**
 * Whether `potentialChildPath` lies at or below `parentPath`, compared segment
 * by segment. Either separator is accepted on both sides — on Windows a mix of
 * "\\" (Node) and "/" (git, globs, config) is routine — and empty segments from
 * a trailing or doubled separator are ignored.
 */
export const isUnderPath = (parentPath: string, potentialChildPath: string): boolean => {
  const inner = segmentsOf(potentialChildPath);
  return segmentsOf(parentPath).every((outer, index) => segmentsMatch(outer, inner[index], index));
};

// ---------------------------------------------------------------------------
// Mapping manifest entries and local paths onto each other
// ---------------------------------------------------------------------------

/**
 * The extension a local field file is built to: the manifest `type` of the
 * field. Throws when no manifest is loaded or the field is unknown.
 */
export const getBuildExt = (table: string, recordName: string, field: string): string => {
  const loaded = ConfigManager.getManifest();
  if (!loaded) throw new Error("Failed to retrieve manifest");
  const { files } = loaded.tables[table].records[recordName];
  const entry = files.find((candidate) => candidate.name === field);
  // DX22: the sidecar's extension is a constant of the format, not a property of
  // the record — `.meta.json` is `.meta.json` on every table. A manifest that
  // lost its metadata layer (a refresh whose dictionary read failed) has no
  // `.meta` entry to look it up in, and throwing would mean the file on disk
  // cannot be built and therefore cannot be pushed, which is exactly the
  // silent-loss shape this feature exists to remove. Answer from the format
  // instead, and let the push report what it could not resolve.
  if (entry === undefined && field === META_FILE_NAME) return META_FILE_TYPE;
  if (entry === undefined) throw new Error("Unable to find file");
  // REV-209: this value is interpolated into a filename and joined onto the build
  // root by pushPipeline (`${relPathNoExt}.${buildExt}` → path.join(buildPath, ...)
  // → writeFileForce), and writeFileForce is a bare write with no containment
  // check of any kind. Manifest-supplied names are untrusted on the source-tree
  // writer (INJ-1), so they are untrusted here too: a manifest `type` of
  // "js/../../../../evil" would escape the build directory AND the workspace.
  //
  // Validating here rather than at the write site covers both build layouts and
  // any future caller with one check, and isSafePathComponent is the same rule
  // the download side uses, so the two cannot drift.
  const verdict = unsafePathComponentReason(entry.type);
  if (verdict !== undefined) {
    throw new Error(
      `Refusing to build "${recordName}" in table "${table}": the manifest records ` +
        `an unusable file type for field "${field}" (${verdict.reason}). A file ` +
        `type must be a single path component. Re-run ` +
        `\`syncrona refresh\` to rebuild the manifest from the instance.`,
    );
  }
  return entry.type;
};

/**
 * A manifest map entry, own properties only.
 *
 * The keys here are table and record names derived from a path on disk, so they
 * are entirely outside this process's control. See `ownLookup` in fieldMap for
 * the same guard on the same class of key.
 */
const ownEntry = <T>(
  map: Record<string, T> | undefined,
  key: string | undefined,
): T | undefined => {
  if (map === undefined || key === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
};

/** What a local path says about itself, before the manifest is consulted. */
interface DecodedFieldPath {
  tableName: string;
  recordName: string;
  targetField: string;
  isSidecar: boolean;
}

// DX17: a flat-encoded path (`<table>/<record>~<field>.<ext>`) is self
// describing — keyed off the file stem, never the config — so build/deploy
// re-reads work even though the build tree mirrors the flat source layout.
const decodeFlatPath = (filePath: string, ext: string): Omit<DecodedFieldPath, "isSidecar"> => {
  const tableName = path.basename(path.dirname(filePath));
  const stem = path.basename(filePath, ext);
  const cut = stem.lastIndexOf(FLAT_FIELD_SEPARATOR);
  return {
    tableName,
    recordName: stem.slice(0, cut),
    targetField: fieldForTable(tableName, stem.slice(cut + 1)),
  };
};

// Folder layout: `.../<table>/<record>/<field>.<ext>`. The segments are split on
// EITHER separator so the pair is recovered even when the path arrives with the
// foreign one (git output or globs on Windows produce "/" while path.sep is
// "\\"); the field is the file stem, taken the same separator-agnostic way.
const decodeFolderPath = (filePath: string, ext: string): Omit<DecodedFieldPath, "isSidecar"> => {
  const [tableName, recordName] = segmentsOf(filePath).slice(-3, -1);
  const fileName = lastSegmentOf(filePath);
  const stem = ext && fileName.endsWith(ext) ? fileName.slice(0, -ext.length) : fileName;
  return { tableName, recordName, targetField: fieldForTable(tableName, stem) };
};

// DX22: the sidecar is identified by its FILE NAME, overriding whatever the
// layout decoders derived. Both of them happen to reach ".meta" on an ordinary
// table, but `sys_atf_step` forces every field to the dot-walked
// "inputs.script" — so on that table a sidecar would otherwise resolve to the
// ATF step's script and a push would overwrite it with the sidecar's JSON.
// Keying on the path keeps the sidecar independent of both layouts and of every
// per-table special case. Nothing ever PATCHes a column literally named
// ".meta": pushPipeline expands that context into the record's actual columns
// (see expandMetaSidecar).
const decodeFieldPath = (filePath: string, ext: string): DecodedFieldPath => {
  const decoded = isFlatEncoded(filePath)
    ? decodeFlatPath(filePath, ext)
    : decodeFolderPath(filePath, ext);
  const isSidecar = isMetaSidecarPath(filePath);
  return isSidecar
    ? { ...decoded, targetField: META_FILE_NAME, isSidecar }
    : { ...decoded, isSidecar };
};

/**
 * Resolves a local file to the manifest record and field it represents, or
 * undefined when the path is an editor artifact or names nothing the manifest
 * tracks. Throws when no manifest is loaded.
 */
export const getFileContextFromPath = (filePath: string): Sync.FileContext | undefined => {
  if (isEditorArtifactPath(filePath)) return undefined;
  const ext = extensionOf(filePath);
  const { tableName, recordName, targetField, isSidecar } = decodeFieldPath(filePath, ext);
  const loaded = ConfigManager.getManifest();
  if (!loaded) throw new Error("No manifest has been loaded!");
  try {
    // Own properties only. Both keys come off a filesystem path, so a stray
    // directory named `constructor` or `__proto__` resolved to the inherited
    // Object.prototype member instead of answering "not in the manifest" — and
    // for the sidecar, which is resolved from the record alone, that context
    // survived and push sent it at `/api/now/table/<table>/undefined`.
    const record = ownEntry(ownEntry(loaded.tables, tableName)?.records, recordName);
    if (!record) return undefined;
    // DX22: the sidecar is resolved from the RECORD, not from the record's file
    // list. A `.meta.json` on disk belongs to the record whose directory it sits
    // in — that is the whole of its identity — and requiring a matching `.meta`
    // entry made a manifest written without a metadata layer disown a file the
    // very same tool had written: the context came back undefined, the file was
    // dropped with the invalid paths, and `push` reported success over a sidecar
    // it never sent. Scripts are resolved from the record and its field.
    const tracked = record.files?.some((candidate) => candidate.name === targetField);
    if (!tracked && !isSidecar) return undefined;
    const { sys_id } = record;
    return {
      filePath,
      ext,
      sys_id,
      name: recordName,
      scope: loaded.scope,
      tableName,
      targetField,
    };
  } catch {
    return undefined;
  }
};

/** A local file that names a record the manifest does not know yet. */
export interface UnmappedPathInfo {
  table: string;
  recordName: string;
  /** Target column: `inputs.script` on sys_atf_step, `.meta` for a sidecar. */
  field: string;
  /** Extension including the dot, as path.extname returns it. */
  ext: string;
  isSidecar: boolean;
}

// Table names are taken from a directory name, then interpolated into a Table
// API URL. ServiceNow table names are lower-case snake_case, so anything else
// is refused here rather than sent.
const TABLE_NAME_PATTERN = /^[a-z0-9_]+$/;

// A name shadowing an Object.prototype member (`__proto__`, `constructor`)
// would become a manifest map key; such names are refused rather than written.
const isPrototypeKey = (key: string): boolean =>
  Object.prototype.hasOwnProperty.call(Object.prototype, key);

/**
 * R1 (`push --create`): decompose a source-tree path that getFileContextFromPath
 * could not resolve into the record it would describe.
 *
 * Only the two layouts the tool itself writes are accepted, relative to the
 * source directory: `<table>/<record>~<field>.<ext>` (flat, exactly two
 * segments) and `<table>/<record>/<field>.<ext>` (folder, exactly three).
 * Anything deeper, shallower, extensionless or outside the source tree returns
 * undefined, as does a path whose record already exists in the manifest — that
 * file is either an ordinary update or a field the record does not map, and
 * neither is a creation.
 */
export const parseUnmappedPath = (filePath: string): UnmappedPathInfo | undefined => {
  let sourceRoot: string;
  try {
    sourceRoot = ConfigManager.getSourcePath();
  } catch {
    return undefined;
  }
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  if (isEditorArtifactPath(filePath)) return undefined;
  const ext = extensionOf(filePath);
  if (!ext) return undefined;
  const segments = segmentsOf(relative);
  const stem = segments[segments.length - 1].slice(0, -ext.length);
  let shape: { table: string; recordName: string; field: string };
  if (segments.length === 3) {
    shape = { table: segments[0], recordName: segments[1], field: stem };
  } else if (segments.length === 2 && isFlatEncoded(segments[1])) {
    const cut = stem.lastIndexOf(FLAT_FIELD_SEPARATOR);
    shape = {
      table: segments[0],
      recordName: stem.slice(0, cut),
      field: stem.slice(cut + 1),
    };
  } else {
    return undefined;
  }
  const isSidecar = isMetaSidecarPath(filePath);
  const field = isSidecar ? META_FILE_NAME : fieldForTable(shape.table, shape.field);
  const { table, recordName } = shape;
  const acceptable =
    TABLE_NAME_PATTERN.test(table) &&
    isSafePathComponent(recordName) &&
    isSafePathComponent(field) &&
    !isPrototypeKey(table) &&
    !isPrototypeKey(recordName);
  if (!acceptable) return undefined;
  const known = ownEntry(ownEntry(ConfigManager.getManifest()?.tables, table)?.records, recordName);
  return known ? undefined : { table, recordName, field, ext, isSidecar };
};

// ---------------------------------------------------------------------------
// Walking the source and build trees
// ---------------------------------------------------------------------------

/** `p` itself when absolute, otherwise `p` relative to the working directory. */
export const toAbsolutePath = (p: string): string =>
  path.isAbsolute(p) ? p : path.join(process.cwd(), p);

/** Whether `p` is a directory (following links); rejects when nothing is there. */
export const isDirectory = (p: string): Promise<boolean> =>
  fsp.stat(p).then((info) => info.isDirectory());

const MAX_SCAN_DEPTH = 20;

/**
 * The roots a scan of `target` may follow when they are links, or undefined
 * (with a warning) when `target` is outside both the source and the build tree.
 */
const permittedScanRoots = (target: string): Set<string> | undefined => {
  const sourceRoot = path.resolve(ConfigManager.getSourcePath());
  if (isUnderPath(sourceRoot, target)) return new Set([sourceRoot]);
  // The build root is only consulted for a path outside the source tree.
  const buildRoot = path.resolve(ConfigManager.getBuildPath());
  if (isUnderPath(buildRoot, target)) return new Set([sourceRoot, buildRoot]);
  logger.warn(
    `Refusing to scan "${target}": it is outside the configured source and build directories.`,
  );
  return undefined;
};

type EntryKind = "file" | "directory" | "skip";

// Symlinks are skipped outright. The containment check only vetted the scan's
// starting point; following a link could escape the source/build tree or spin
// in a cycle, and collecting links as plain paths would push the same bytes
// twice (link + target). The one exception is the starting point itself when
// it IS a configured root: a source or build root may be a link (a shared
// checkout linked into the project), the user chose it, and skipping it reads
// as "no files" so a plain push reports nothing to do.
const classifyEntry = async (entry: string, followLink: boolean): Promise<EntryKind> => {
  try {
    const info = followLink ? await fsp.stat(entry) : await fsp.lstat(entry);
    if (info.isSymbolicLink()) return "skip";
    return info.isDirectory() ? "directory" : "file";
  } catch {
    return "skip";
  }
};

const listDirectory = async (dir: string): Promise<string[]> => {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
};

/**
 * Every regular file under `p` (or `p` itself when it is a file), as absolute
 * paths. Scans only inside the configured source or build tree and at most
 * MAX_SCAN_DEPTH levels deep, warning instead of truncating silently.
 */
export const getPathsInPath = async (p: string): Promise<string[]> => {
  // INJ-1: the containment check runs on the SAME string the walk starts from.
  // Comparing the raw argument while walking its resolved form let a relative
  // ("src/../../etc") or ".."-bearing path pass the check and then resolve
  // outside the source/build trees. The rejection is logged rather than silent,
  // because an empty list reads as "no files", which callers like
  // repair --prune treat as a meaningful, actionable result.
  const start = path.resolve(p);
  const followableRoots = permittedScanRoots(start);
  if (followableRoots === undefined) return [];
  const collected: string[] = [];
  // Depth-first with an explicit LIFO work list; each item is [path, depth].
  const work: Array<[string, number]> = [[start, 0]];
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    const [entry, depth] = item;
    const kind = await classifyEntry(entry, depth === 0 && followableRoots.has(entry));
    if (kind === "file") collected.push(entry);
    if (kind !== "directory") continue;
    if (depth === MAX_SCAN_DEPTH) {
      logger.warn(
        `Directory tree deeper than ${MAX_SCAN_DEPTH} levels at ${entry}; not descending further.`,
      );
      continue;
    }
    for (const child of await listDirectory(entry)) {
      work.push([path.resolve(entry, child), depth + 1]);
    }
  }
  return collected;
};

/** The non-empty paths packed into a PATH_DELIMITER-joined string. */
export const splitEncodedPaths = (encoded: string): string[] =>
  encoded.split(PATH_DELIMITER).filter((piece) => piece.length > 0);

/** Whether `candidate` exists on disk. */
export const isValidPath = (candidate: string): Promise<boolean> => pathExists(candidate);

/**
 * Expands a PATH_DELIMITER-joined list of files and directories into the
 * distinct files they cover, in first-seen order. Entries that do not exist are
 * dropped.
 */
export const encodedPathsToFilePaths = async (encoded: string): Promise<string[]> => {
  const candidates = splitEncodedPaths(encoded);
  const present = await Promise.all(candidates.map((candidate) => isValidPath(candidate)));
  const existing = candidates.filter((_, index) => present[index]);
  const perEntry = await Promise.all(existing.map((entry) => getPathsInPath(entry)));
  return [...new Set(perEntry.flat())];
};

/** `<table>/<record>/<sys_id>`: a short human label for a resolved file. */
export const summarizeFile = (ctx: Sync.FileContext): string =>
  `${ctx.tableName}/${ctx.name}/${ctx.sys_id}`;

/** Writes a build artifact, creating its folder first when it is missing. */
export const writeBuildFile = async (folder: string, target: string, text: string): Promise<void> => {
  if (!(await pathExists(folder))) await createDirRecursively(folder);
  await writeFileForce(target, text);
};

type FieldWriter = ReturnType<typeof writeSNFileCurry>;
export const writeSNFileIfNotExists: FieldWriter = writeSNFileCurry(true);
export const writeSNFileForce: FieldWriter = writeSNFileCurry(false);

/** Plain overwrite with retry; no containment check (callers vet the path). */
export const writeFileForce = (
  filePath: PathLike,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> => withRetry(() => fsp.writeFile(filePath, data));
