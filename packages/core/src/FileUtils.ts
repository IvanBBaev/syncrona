// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { PATH_DELIMITER } from "./constants.js";
import fs, { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config.js";
import { FLAT_FIELD_SEPARATOR, isFlatEncoded } from "./flatLayout.js";
import { isSafePathComponent } from "./genericUtils.js";
import { META_FILE_NAME, isMetaSidecarPath } from "./metaFields.js";
import { logger } from "./Logger.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(
  task: () => Promise<T>,
  retries = 2,
  waitMs = 50
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < retries && waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
};

// The extension a field wears locally is NOT fixed to the manifest's `type`.
// The push side is the proof: getFileContextFromPath resolves a local path to a
// field by stripping WHATEVER extension it carries and reading the stem, and
// getBuildExt then compiles that source back to the manifest type on the way
// out. So a TypeScript workspace legitimately keeps `script.ts` for a field the
// instance stores as `js`, and that file IS the field's local representation.
//
// Comparison is in the same canonical form repairCommand uses for record names.
// The exact-path probe below is an fsp.stat, which is case-insensitive on APFS
// and NTFS and normalization-insensitive on HFS+ — a listing scan that folded
// differently would make the two halves of one predicate disagree about when two
// names are "the same name". `toLowerCase`, never `toLocaleLowerCase`: the
// latter is locale-dependent (Turkish dotless ı).
const canonicalStem = (name: string): string =>
  name.normalize("NFC").toLowerCase();

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
  fieldName: string
): Promise<string | undefined> => {
  let entries: string[];
  try {
    entries = await fsp.readdir(parentDirPath);
  } catch (_) {
    return undefined;
  }
  const wanted = canonicalStem(fieldName);
  return entries.find((entry) => {
    const ext = path.extname(entry);
    return ext !== "" && canonicalStem(path.basename(entry, ext)) === wanted;
  });
};

export const SNFileExists = (parentDirPath: string) => async (
  file: SN.File
): Promise<boolean> => {
  // Check for the exact file the writer produces (`<name>.<type>`) first: it is
  // one stat, it is the overwhelmingly common answer, and it costs nothing.
  const expected = path.join(parentDirPath, `${file.name}.${file.type}`);
  try {
    await fsp.stat(expected);
    // Existence is the whole answer. This used to be `stats.size > 0` so that
    // the skeleton phase's zero-byte placeholders were re-fetched on refresh —
    // but a field whose value on the instance is legitimately "" writes exactly
    // zero bytes too, so that rule could not tell "not downloaded yet" from
    // "downloaded, and it really is empty". It always guessed the former, so an
    // empty tracked field was reported missing and re-downloaded on every run,
    // forever, while the command still printed "Download complete".
    //
    // The ambiguity is fixed at its SOURCE instead of here: writeSNFileCurry no
    // longer creates a file for a request that carries no content (see the note
    // there), so a placeholder is now an absent file rather than an empty one,
    // and the only zero-byte file a pull can produce is a converged empty field.
    //
    // Legacy note: a workspace initialised by an older version may still hold
    // placeholders written under the old rule. Those now read as present.
    // `syncrona download` force-writes every tracked field and heals them.
    return true;
  } catch (_) {
    // Not under the manifest's own extension — but the field may still be on
    // disk under the one the workspace actually edits it in.
    //
    // Answering "missing" here is what made `syncrona refresh` download
    // `script.js` next to an existing `script.ts`: the probe could not see the
    // TypeScript source, the refresh fetched the field, and the writer created a
    // second file claiming it. The workspace then held two claimants for one
    // field and the next `syncrona push` failed outright — groupAppFiles rejects
    // that pair as an "Ambiguous push" — so the damage outlived the stray file.
    return (await findFieldRepresentation(parentDirPath, file.name)) !== undefined;
  }
};

export const writeManifestFile = async (man: SN.AppManifest) => {
  const manifestPath = ConfigManager.getManifestPath();
  // Write to a sibling temp file then rename — rename is atomic on the same
  // filesystem, so a crash mid-write can never leave a truncated/corrupt
  // manifest (the previous version stays intact until the rename completes).
  const tmpPath = `${manifestPath}.${process.pid}.tmp`;
  return withRetry(async () => {
    await fsp.writeFile(tmpPath, JSON.stringify(man, null, 2));
    await fsp.rename(tmpPath, manifestPath);
  });
};

// INJ-1, writer half. `name` and `type` are both interpolated into the file name
// (`<name>.<type>`) and joined onto parentPath below, so either one can carry a
// path separator or a ".." and relocate the write. The containment guard further
// down only anchors at the workspace SOURCE ROOT, which means a traversal that
// stays inside the source tree — the sibling-record case: a field named
// "../Bar/script" written from record Foo's folder — sails straight through it.
// Rejecting the components here, before path.join ever sees them, makes this
// function a true chokepoint: no caller can produce a write outside the
// directory it named as the parent.
//
// The rule is isSafePathComponent, shared with the download seam and getBuildExt
// so the three cannot drift. It deliberately accepts dots INSIDE a component,
// because dot-walked field names ("inputs.script" on sys_atf_step) and the DX17
// flat stem ("<record>~<field>") are both legitimate single components.
const assertSafeWriteComponent = (
  value: string,
  kind: "file name" | "file type" | "record name"
): void => {
  if (!isSafePathComponent(value)) {
    throw new Error(
      `Refusing to write: unsafe ${kind} ${JSON.stringify(value)} would escape ` +
        `its target directory.`
    );
  }
};

export const writeSNFileCurry = (checkExists: boolean) => async (
  file: SN.File,
  parentPath: string
): Promise<void> => {
  const { name, type } = file;
  assertSafeWriteComponent(name, "file name");
  assertSafeWriteComponent(type, "file type");
  // A manifest ENTRY and a fetched EMPTY VALUE are different things, and the old
  // skeleton phase collapsed them into the same artifact. `{ name, type }` with
  // no `content` key means "this record has this field, its value has not been
  // fetched"; `{ name, type, content: "" }` means "fetched, and the value is
  // empty". Writing the first produced a zero-byte file byte-identical to the
  // second, which is why SNFileExists had to guess (see the note there).
  //
  // So the entry writes nothing at all. processTablesInManifest still creates
  // every record DIRECTORY, so `init` still materialises the layout; the field
  // is then absent rather than empty, checkFilesForMissing still reports it
  // missing, and the follow-up refresh/download still fetches it — the same end
  // state as before, minus the artifact nobody downstream could interpret.
  if (!("content" in file)) {
    return;
  }
  let { content = "" } = file;
  // content can sometimes be null
  if (!content) {
    content = "";
  } else if (typeof content !== "string") {
    try {
      content = JSON.stringify(content, null, 2);
    } catch (_) {
      content = String(content);
    }
  }
  const write = async () => {
      const fullPath = path.join(parentPath, `${name}.${type}`);
      const resolvedFull = path.resolve(fullPath);
      // INJ-1 containment guard. Anchor to the workspace source ROOT whenever one
      // is loaded, not merely to the caller-supplied parentPath. If parentPath
      // were itself already escaped (e.g. built from an unsanitized "../evil"
      // table name or a scoped "../../.zshrc" record name), a guard anchored to
      // parentPath would pass every write that stayed under that escaped parent.
      // The download/refresh path — the only one that consumes server- or
      // manifest-supplied names — always has a source root loaded, so the
      // stronger anchor applies exactly when a tampered manifest is a risk. When
      // no project is loaded (isolated writes with no source root) fall back to
      // containing the write to its parentPath.
      let anchor: string;
      try {
        const sourceRoot = ConfigManager.getSourcePath();
        anchor =
          typeof sourceRoot === "string" && sourceRoot.length > 0
            ? path.resolve(sourceRoot)
            : path.resolve(parentPath);
      } catch {
        anchor = path.resolve(parentPath);
      }
      if (
        resolvedFull !== anchor &&
        !resolvedFull.startsWith(anchor + path.sep)
      ) {
        throw new Error(
          `Refusing to write "${name}.${type}" outside the workspace source root.`
        );
      }
      return await withRetry(() => fsp.writeFile(fullPath, content));
    };
  if (checkExists) {
    const exists = await SNFileExists(parentPath)(file);
    if (!exists) {
      await write();
    }
    return;
  }
  // Force write (`syncrona download`, and the wizard's first pull). Overwriting
  // the field's OWN file is the whole point — that is how a half-written or
  // legacy-placeholder workspace heals. Bringing a SECOND file for the same
  // field into existence is not: `<field>.ts` and `<field>.js` side by side are
  // two claimants for one field, which is exactly the state that makes the next
  // push fail. Force therefore overwrites whenever `<name>.<type>` is the file
  // on disk, and declines only when it would create the duplicate.
  const target = path.join(parentPath, `${name}.${type}`);
  if (!(await pathExists(target))) {
    const representation = await findFieldRepresentation(parentPath, name);
    if (representation !== undefined) {
      // Name the kept file by its full path. A scope-wide download hits this
      // branch once per affected record, and every record spells the field the
      // same way ("script"), so a message built from `name` alone repeats
      // verbatim N times and tells the user nothing about WHICH records to look
      // at. The path is the only part that differs.
      const kept = path.join(parentPath, representation);
      logger.warn(
        `Keeping local "${kept}" for field "${name}" — not writing ` +
          `"${name}.${type}" beside it, because two files claiming one field make ` +
          `the next push ambiguous. Delete "${kept}" first if you want ` +
          `the downloaded ${type} version instead.`
      );
      return;
    }
  }
  await write();
};

// DX17: write a record's field file in the flat layout — a single file named
// `<record>~<field>.<ext>` directly under the table directory, instead of a
// per-record folder. Reuses writeSNFileCurry (and its containment guard, its
// entry-vs-empty-value rule and its already-exists check) by composing the flat
// base name, so flat and folder layouts share one writer and stay byte-for-byte
// identical apart from the path.
export const writeFlatSNFileCurry = (checkExists: boolean) => async (
  file: SN.File,
  tableDirPath: string,
  recordName: string
): Promise<void> => {
  // INJ-1: validate the two halves BEFORE composing them. The composed stem is
  // checked again by writeSNFileCurry (a separator or a lone ".." in either half
  // survives concatenation, so the composed check alone would also catch it), but
  // an empty or all-dots half disappears into an innocuous-looking composed name
  // — and, more practically, an error that names the offending half is what a
  // maintainer can act on.
  assertSafeWriteComponent(recordName, "record name");
  assertSafeWriteComponent(file.name, "file name");
  const flatFile: SN.File = {
    ...file,
    name: `${recordName}${FLAT_FIELD_SEPARATOR}${file.name}`,
  };
  return writeSNFileCurry(checkExists)(flatFile, tableDirPath);
};

export const createDirRecursively = async (path: string): Promise<void> => {
  await fsp.mkdir(path, { recursive: true });
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fsp.access(path, fs.constants.F_OK);
    return true;
  } catch (_e) {
    return false;
  }
};

export const appendToPath = (prefix: string) => (suffix: string): string =>
  path.join(prefix, suffix);

/**
 * Detects if a path is under a parent directory
 * @param parentPath full path to parent directory
 * @param potentialChildPath full path to child directory
 */
export const isUnderPath = (
  parentPath: string,
  potentialChildPath: string
): boolean => {
  // Split on EITHER separator: on Windows a mix of "\\" (Node) and "/" (git,
  // globs, config) is routine, and keying solely off path.sep would fail to
  // tokenize the foreign separator and misjudge containment. Drop empty
  // segments so a trailing/doubled separator (".../src/") does not introduce a
  // phantom "" token that never matches the child.
  const splitSegments = (p: string): string[] =>
    p.split(/[/\\]/).filter((token) => token !== "");
  const parentTokens = splitSegments(parentPath);
  const childTokens = splitSegments(potentialChildPath);
  // Windows drive letters are case-insensitive device designators — "C:" and
  // "c:" name the same volume, and mismatched casing between two absolute
  // paths is routine there (VS Code's integrated terminal and Git Bash yield a
  // lowercase drive in process.cwd() while configs carry uppercase). A strict
  // compare made getPathsInPath refuse a legitimately in-tree path and return
  // [], so push/build silently saw "no files". Fold ONLY the leading token and
  // ONLY when both sides are pure drive designators (^[A-Za-z]:$): directory
  // names keep byte equality — node:path never case-folds names either, and
  // NTFS case handling is a filesystem property, not a path-semantics one.
  const isDriveToken = (token: string | undefined): token is string =>
    typeof token === "string" && /^[A-Za-z]:$/.test(token);
  return parentTokens.every((token, index) => {
    const childToken = childTokens[index];
    if (index === 0 && isDriveToken(token) && isDriveToken(childToken)) {
      return token.toLowerCase() === childToken.toLowerCase();
    }
    return token === childToken;
  });
};

const getFileExtension = (filePath: string): string => {
  try {
    return path.extname(filePath);
  } catch (_e) {
    return "";
  }
};

export const getBuildExt = (
  table: string,
  recordName: string,
  field: string
): string => {
  const manifest = ConfigManager.getManifest();
  if (!manifest) {
    throw new Error("Failed to retrieve manifest");
  }
  const files = manifest.tables[table].records[recordName].files;
  const file = files.find((f) => f.name === field);
  if (!file) {
    throw new Error("Unable to find file");
  }
  // REV-209: this value is interpolated into a filename and joined onto the build
  // root by pushPipeline (`${relPathNoExt}.${buildExt}` → path.join(buildPath, ...)
  // → writeFileForce), and writeFileForce is a bare fsp.writeFile with no
  // containment check of any kind. The source-tree writer received the INJ-1
  // containment guard (writeSNFileCurry above) exactly because manifest-supplied
  // names are treated as untrusted there — but the build-tree writer was left
  // unguarded, so the same threat model was only half enforced. A manifest `type`
  // of "js/../../../../evil" escapes the build directory AND the workspace.
  //
  // Validate here rather than at the write site: this is the single point where the
  // untrusted value leaves the manifest, so both build layouts and any other future
  // caller are covered by one check. isSafePathComponent is the same rule the
  // download side uses, so the two cannot drift.
  if (!isSafePathComponent(file.type)) {
    throw new Error(
      `Refusing to build "${recordName}" in table "${table}": the manifest records ` +
        `an unusable file type for field "${field}". A file type must be a single ` +
        `path component (no "/" or "\\", not empty, not only dots). Re-run ` +
        `\`syncrona refresh\` to rebuild the manifest from the instance.`
    );
  }
  return file.type;
};

// Basename that tolerates EITHER separator. path.basename() only recognizes the
// current platform's separator, so a Windows-shaped path fed to a POSIX runtime
// (git output on Windows, or the reverse in tests) would not be trimmed and the
// whole path would leak into the field name. Splitting on /[/\\]/ makes it robust.
const basenameAnySep = (filePath: string, ext: string): string => {
  const last = filePath.split(/[/\\]/).filter((token) => token !== "").pop() || "";
  return ext && last.endsWith(ext) ? last.slice(0, -ext.length) : last;
};

const getTargetFieldFromPath = (
  filePath: string,
  table: string,
  ext: string
): string => {
  return table === "sys_atf_step"
    ? "inputs.script"
    : basenameAnySep(filePath, ext);
};

export const getFileContextFromPath = (
  filePath: string
): Sync.FileContext | undefined => {
  const ext = getFileExtension(filePath);
  let tableName: string;
  let recordName: string;
  let targetField: string;
  // DX17: a flat-encoded path (`<table>/<record>~<field>.<ext>`) is self
  // describing — keyed off the file stem, never the config — so build/deploy
  // re-reads work even though the build tree mirrors the flat source layout.
  if (isFlatEncoded(filePath)) {
    tableName = path.basename(path.dirname(filePath));
    const stem = path.basename(filePath, ext);
    const sepIndex = stem.lastIndexOf(FLAT_FIELD_SEPARATOR);
    recordName = stem.slice(0, sepIndex);
    targetField =
      tableName === "sys_atf_step"
        ? "inputs.script"
        : stem.slice(sepIndex + 1);
  } else {
    // Split on EITHER separator and drop empty/basename segments so the
    // <table>/<record> pair is recovered even when the path arrives with the
    // foreign separator (git output or globs on Windows produce "/" while
    // path.sep is "\\") — keying on path.sep alone would fail to tokenize it.
    const segments = filePath.split(/[/\\]/).filter((token) => token !== "");
    [tableName, recordName] = segments.slice(-3, -1);
    targetField = getTargetFieldFromPath(filePath, tableName, ext);
  }
  // DX22: the sidecar is identified by its FILE NAME, overriding whatever the
  // branches above derived. Both of them happen to reach ".meta" on an ordinary
  // table, but `sys_atf_step` forces every field to the dot-walked "inputs.script"
  // — so on that table a sidecar would otherwise resolve to the ATF step's script
  // and a push would overwrite it with the sidecar's JSON. Keying on the path
  // instead of on the derived name keeps the sidecar independent of both layouts
  // and of every per-table special case.
  //
  // ".meta" is a real entry in `record.files`, so the lookup below finds it and
  // hands push and build a context for the pseudo-field. Nothing ever PATCHes a
  // column literally named ".meta": pushPipeline expands that context into the
  // record's actual columns (see expandMetaSidecar).
  if (isMetaSidecarPath(filePath)) {
    targetField = META_FILE_NAME;
  }
  const manifest = ConfigManager.getManifest();
  if (!manifest) {
    throw new Error("No manifest has been loaded!");
  }
  const { tables, scope } = manifest;
  try {
    const { records } = tables[tableName];
    const record = records[recordName];
    const { files, sys_id } = record;
    const field = files.find((file) => file.name === targetField);
    if (!field) {
      return undefined;
    }
    return {
      filePath,
      ext,
      sys_id,
      name: recordName,
      scope,
      tableName,
      targetField,
    };
  } catch (_e) {
    return undefined;
  }
};

export const toAbsolutePath = (p: string): string =>
  path.isAbsolute(p) ? p : path.join(process.cwd(), p);

export const isDirectory = async (p: string): Promise<boolean> => {
  const stats = await fsp.stat(p);
  return stats.isDirectory();
};

export const getPathsInPath = async (p: string): Promise<string[]> => {
  // INJ-1: the containment check must run on the SAME string the walk starts
  // from. Previously the guard compared the raw argument while the walk seeded
  // path.resolve(p), so a relative ("src/../../etc") or ".."-bearing path could
  // pass the token comparison and then resolve outside the source/build trees.
  // Resolve first, compare second — and log the rejection instead of returning
  // an empty list silently (an empty list reads as "no files", which callers
  // like repair --prune interpret as a meaningful, actionable result).
  const resolved = path.resolve(p);
  if (
    !isUnderPath(path.resolve(ConfigManager.getSourcePath()), resolved) &&
    !isUnderPath(path.resolve(ConfigManager.getBuildPath()), resolved)
  ) {
    logger.warn(
      `Refusing to scan "${resolved}": it is outside the configured source and build directories.`
    );
    return [];
  }
  const maxDepth = 20;
  const files: string[] = [];
  const stack: Array<{ filePath: string; depth: number }> = [
    { filePath: resolved, depth: 0 },
  ];

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) {
      continue;
    }

    if (next.depth > maxDepth) {
      continue;
    }

    let stat;
    try {
      stat = await fsp.lstat(next.filePath);
    } catch (_) {
      continue;
    }

    // Skip symlinks outright. The isUnderPath guard above only vetted the
    // requested root; following a link could escape the source/build tree or
    // spin in a cycle. Collecting links as plain paths would also push the same
    // bytes twice (link + target).
    if (stat.isSymbolicLink()) {
      continue;
    }

    if (!stat.isDirectory()) {
      files.push(next.filePath);
      continue;
    }

    if (next.depth === maxDepth) {
      // The tree is deeper than we walk. Warn rather than truncate silently so a
      // partial push/build is not mistaken for having covered every file.
      logger.warn(
        `Directory tree deeper than ${maxDepth} levels at ${next.filePath}; not descending further.`
      );
      continue;
    }

    let children: string[] = [];
    try {
      children = await fsp.readdir(next.filePath);
    } catch (_) {
      continue;
    }

    for (const child of children) {
      stack.push({
        filePath: path.resolve(next.filePath, child),
        depth: next.depth + 1,
      });
    }
  }

  return files;
};

export const splitEncodedPaths = (encodedPaths: string): string[] =>
  encodedPaths.split(PATH_DELIMITER).filter((p) => p && p !== "");

export const isValidPath = async (path: string): Promise<boolean> => {
  return pathExists(path);
};

export const encodedPathsToFilePaths = async (
  encodedPaths: string
): Promise<string[]> => {
  const pathSplits = splitEncodedPaths(encodedPaths);
  const validChecks = await Promise.all(pathSplits.map(isValidPath));
  const validSplits = pathSplits.filter((_, index) => validChecks[index]);
  const splitPaths = await Promise.all(validSplits.map(getPathsInPath));
  const deDupedPaths = splitPaths.flat().reduce((acc, cur) => {
    acc.add(cur);
    return acc;
  }, new Set<string>());
  return Array.from(deDupedPaths);
};

export const summarizeFile = (ctx: Sync.FileContext): string => {
  const { tableName, name: recordName, sys_id } = ctx;
  return `${tableName}/${recordName}/${sys_id}`;
};

export const writeBuildFile = async (
  folderPath: string,
  newPath: string,
  fileContents: string
) => {
  try {
    await fsp.access(folderPath, fs.constants.F_OK);
  } catch (_e) {
    await fsp.mkdir(folderPath, { recursive: true });
  }
  await writeFileForce(newPath, fileContents);
};

export const writeSNFileIfNotExists = writeSNFileCurry(true);
export const writeSNFileForce = writeSNFileCurry(false);

export const writeFileForce = (
  filePath: fs.PathLike,
  data: string | NodeJS.ArrayBufferView
) => withRetry(() => fsp.writeFile(filePath, data));
