// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import * as cp from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import inquirer from "inquirer";
import * as ConfigManager from "./config.js";
import * as AppUtils from "./appUtils.js";
import * as FileUtils from "./FileUtils.js";
import { isFlatEncoded, FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import {
  META_SIDECAR_FILE_NAME,
  isMetaSidecarPath,
  withoutSecretRuleColumns,
} from "./metaFields.js";
import { inspectCompositeLayout } from "./dataModelComposite.js";
import { logger } from "./Logger.js";
import { formatTable } from "./genericUtils.js";
import { setLogLevel, logErrorHint } from "./commandHelpers.js";

export type RepairCmdArgs = Sync.SharedCmdArgs & {
  apply?: boolean;
  prune?: boolean;
  ci?: boolean;
};

const countMissing = (missing: SN.MissingFileTableMap): number =>
  Object.values(missing).reduce(
    (sum, records) => sum + Object.keys(records).length,
    0
  );

// A path is only a candidate orphan when it has the manifest's own on-disk
// shape: `<table>/<record>/<field>.<ext>` (folder mode) or
// `<table>/<record>~<field>.<ext>` (DX17 flat mode), relative to the source
// directory. Anything else under `src` — helper modules, tests, READMEs,
// tsconfig, a stray node_modules — can never be produced by a download, so it
// can never be an orphan of one. Dot-prefixed segments (.git, .vscode,
// .eslintrc) are excluded outright.
function isManifestShapedPath(sourcePath: string, filePath: string): boolean {
  const rel = path.relative(sourcePath, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  const segments = rel.split(/[/\\]/).filter((seg) => seg.length > 0);
  if (segments.some((seg) => seg.startsWith("."))) {
    return false;
  }
  const fileName = segments[segments.length - 1];
  if (!path.extname(fileName)) {
    return false;
  }
  if (segments.length === 3) {
    return true;
  }
  return segments.length === 2 && isFlatEncoded(fileName);
}

// REV-140: the manifest key and the name the filesystem hands back are not
// always the same byte sequence. getFileContextFromPath resolves a path with an
// exact-string lookup (`records[recordName]`), so a live, tracked file looked
// unclaimed whenever the two encodings differed: a record name written as NFC
// but stored/returned as NFD on a normalizing volume (HFS+, many SMB/NAS
// mounts), or a Windows record name whose trailing dot/space the OS strips at
// creation. `SNFileExists` is normalization-insensitive, so such a file is not
// reported missing and never re-downloaded either — `repair --apply --prune`
// simply deleted it, along with any local edits not yet pushed. Compare the two
// names in a canonical form before calling a shape-matching path an orphan.
// Case folds too, because the third way the two names diverge is case and it is
// the most common of the three: `SNFileExists` decides "already present" with
// `fsp.stat`, which is case-insensitive on APFS and NTFS — the default on both
// macOS and Windows. So a manifest record "Foo" whose folder is on disk as "foo"
// is not reported missing (stat finds it) while the orphan lookup, which is a
// byte-exact `records[recordName]`, does not claim it — and `repair --apply
// --prune` deleted a file the manifest does claim. Folding here is also what
// manifestBuilder already does when it decides two record names collide
// (`normalize("NFC").toLowerCase()`), so the two modules agree on when two names
// are "the same name". `toLowerCase`, never `toLocaleLowerCase`: the latter is
// locale-dependent (Turkish dotless ı) and would make pruning depend on the
// operator's locale. Merging two records that differ only in case is the safe
// direction — it can only ever make this predicate refuse to delete.
const canonicalName = (name: string): string =>
  name.normalize("NFC").toLowerCase().replace(/[.\s]+$/u, "");

// Own keys only. Table and record names come off a directory listing, and a
// plain `tables[name]` answers an inherited Object.prototype member for a
// directory named `constructor`, `toString` or `hasOwnProperty`: a truthy value
// with no records, so the files under it read as the orphans of a listed table
// (and were pruned) instead of as files of a table the manifest does not list.
const hasOwn = (map: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

// The manifest table a directory name denotes, under any encoding of the name.
function findTable(
  manifest: SN.AppManifest,
  name: string
): SN.TableConfig | undefined {
  const tables = manifest.tables ?? {};
  if (hasOwn(tables, name)) {
    return tables[name];
  }
  const canonical = canonicalName(name);
  return Object.entries(tables).find(([key]) => canonicalName(key) === canonical)?.[1];
}

// True when `records` holds `name` under any encoding of it.
const hasRecordNamed = (records: object, name: string): boolean => {
  const canonical = canonicalName(name);
  return Object.keys(records).some((key) => canonicalName(key) === canonical);
};

// The <table>/<record> pair a manifest-shaped path encodes (folder mode keeps
// them as their own segments; flat mode packs the record into the file stem
// ahead of the LAST separator, exactly as getFileContextFromPath reads it).
function recordKeyFromPath(
  sourcePath: string,
  filePath: string
): { table: string; record: string } | undefined {
  const segments = path
    .relative(sourcePath, filePath)
    .split(/[/\\]/)
    .filter((seg) => seg.length > 0);
  if (segments.length === 3) {
    return { table: segments[0], record: segments[1] };
  }
  if (segments.length === 2) {
    const stem = path.basename(segments[1], path.extname(segments[1]));
    return {
      table: segments[0],
      record: stem.slice(0, stem.lastIndexOf(FLAT_FIELD_SEPARATOR)),
    };
  }
  return undefined;
}

// True when the manifest holds a record for this path under a different
// encoding of the same name. A byte-exact record hit deliberately returns false:
// there the strict lookup failed on the FIELD, not on the name, so the file is
// a genuine orphan and stays prunable.
function isClaimedUnderAnotherEncoding(
  manifest: SN.AppManifest,
  sourcePath: string,
  filePath: string
): boolean {
  const key = recordKeyFromPath(sourcePath, filePath);
  if (!key) {
    return false;
  }
  const records = findTable(manifest, key.table)?.records;
  if (!records || hasOwn(records, key.record)) {
    return false;
  }
  return hasRecordNamed(records, key.record);
}

// Batch 4b R3: what a `.meta.json` sidecar is to repair. A sidecar is kept when
// the manifest holds its record (under any encoding of the name: the sidecar
// belongs to the record, even when the manifest lost its metadata layer). It is
// an orphan when the manifest lists its table but no record of that name, which
// is what a record deleted on the instance leaves behind after a refresh; left
// in place, a later `push --create` would POST it back. A sidecar of a table
// the manifest does not list at all is neither: it may be a new record for
// `push --create` on a table never pulled, or a table a refused read left out,
// so it is reported and never pruned.
type SidecarVerdict = "tracked" | "orphan" | "untracked-table";

function classifySidecar(
  manifest: SN.AppManifest,
  sourcePath: string,
  filePath: string
): SidecarVerdict {
  const rel = path.relative(sourcePath, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return "tracked";
  }
  const segments = rel.split(/[/\\]/).filter((seg) => seg.length > 0);
  // The two shapes a download writes: `<table>/<record>/.meta.json` and the
  // flat `<table>/<record>~.meta.json`. Anything else is not repair's to judge.
  const shaped =
    (segments.length === 3 && segments[2] === META_SIDECAR_FILE_NAME) ||
    (segments.length === 2 && isFlatEncoded(segments[1]));
  if (!shaped || segments.slice(0, 2).some((seg) => seg.startsWith("."))) {
    return "tracked";
  }
  const key = recordKeyFromPath(sourcePath, filePath);
  if (!key || key.record === "") {
    return "tracked";
  }
  const table = findTable(manifest, key.table);
  if (!table) {
    return "untracked-table";
  }
  const records = table.records ?? {};
  return hasOwn(records, key.record) || hasRecordNamed(records, key.record)
    ? "tracked"
    : "orphan";
}

// Files present on disk under the source directory that do not map back to a
// manifest record/field. Best-effort: getFileContextFromPath returns undefined
// for a path that no manifest record claims, which is exactly an orphan.
//
// The shape filter is the safety net for `--prune`: getFileContextFromPath
// returns undefined for ANY unmapped path (and swallows every lookup error),
// so without it every hand-written file under the source directory — sources,
// docs, config, node_modules — was reported as an orphan and deleted.
async function findOrphanFiles(manifest: SN.AppManifest): Promise<string[]> {
  const sourcePath = path.resolve(ConfigManager.getSourcePath());
  const allFiles = await FileUtils.getPathsInPath(sourcePath);
  const orphans: string[] = [];
  const encodingMismatches: string[] = [];
  const untrackedSidecars: string[] = [];
  const untrackedTableFiles: string[] = [];
  for (const file of allFiles) {
    // DX22: a `.meta.json` sidecar is never an orphan. Against a healthy
    // manifest getFileContextFromPath resolves it and the check below would let
    // it through anyway — but a manifest that lost its metadata layer is exactly
    // the case that matters here, and `repair --apply --prune` would then delete
    // every sidecar in the workspace on the strength of a failed dictionary
    // read. The sidecar belongs to its record, and the record is in the
    // manifest; that is enough to keep it. (In the nested layout the shape
    // filter also hides it — a dot-prefixed segment — but in the flat layout
    // `<record>~.meta.json` is an ordinary file name and this is the only guard.)
    //
    // R3: "belongs to its record" holds only while the manifest has that
    // record. See classifySidecar for the sidecar whose record is gone.
    if (isMetaSidecarPath(file)) {
      const verdict = classifySidecar(manifest, sourcePath, file);
      if (verdict === "orphan") {
        orphans.push(file);
      } else if (verdict === "untracked-table") {
        untrackedSidecars.push(file);
      }
      continue;
    }
    if (
      !isManifestShapedPath(sourcePath, file) ||
      FileUtils.getFileContextFromPath(file) !== undefined
    ) {
      continue;
    }
    if (isClaimedUnderAnotherEncoding(manifest, sourcePath, file)) {
      encodingMismatches.push(file);
      continue;
    }
    // The same rule as for a sidecar (see classifySidecar): a field file is the
    // leftover of a record only when the manifest lists its table. A table the
    // manifest does not list was never pulled or could not be read, so its files
    // are new work for `push --create` or simply outside this manifest's view.
    const key = recordKeyFromPath(sourcePath, file);
    if (key && !findTable(manifest, key.table)) {
      untrackedTableFiles.push(file);
      continue;
    }
    orphans.push(file);
  }
  if (untrackedSidecars.length > 0) {
    logger.warn(
      `Kept ${untrackedSidecars.length} metadata sidecar(s) of table(s) the manifest does not list ` +
        "(new records for `push --create`, or a table the last refresh could not read). " +
        "They are never pruned:\n" +
        untrackedSidecars.map((f) => `  ${f}`).join("\n")
    );
  }
  if (untrackedTableFiles.length > 0) {
    logger.warn(
      `Kept ${untrackedTableFiles.length} file(s) of table(s) the manifest does not list ` +
        "(new records for `push --create`, or a table the last refresh could not read). " +
        "They are never pruned:\n" +
        untrackedTableFiles.map((f) => `  ${f}`).join("\n")
    );
  }
  if (encodingMismatches.length > 0) {
    logger.warn(
      `Kept ${encodingMismatches.length} tracked file(s) whose on-disk name differs from the manifest only in encoding (Unicode normalization or trailing dots/spaces):\n` +
        encodingMismatches.map((f) => `  ${f}`).join("\n")
    );
  }
  return orphans;
}

// Git is run straight from here rather than through gitUtils: those helpers
// answer "what changed against a ref" for push, while prune needs the opposite
// question — which files are byte-identical to a committed blob — and a cwd of
// the source directory rather than the process's.
const runGit = (cwd: string, args: string[]): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });

// `hash-object` takes its paths on the command line; chunking keeps one call
// well under every platform's argument-length limit.
const HASH_CHUNK = 200;

/**
 * The orphans git can give back: files whose content is exactly a blob of the
 * HEAD commit at the same path. That is the whole rule `--prune` deletes by.
 *
 * "No manifest record claims it" describes two very different files: the
 * leftover of a record deleted on the instance, and local work not pushed yet —
 * a new script, a new column's `.meta.json` — that `push --create` would
 * create. The manifest cannot tell them apart; git can. A file committed and
 * unchanged since HEAD is recoverable with `git checkout HEAD -- <file>`, so
 * deleting it loses nothing. Everything else — untracked, ignored, staged but
 * never committed, or edited since HEAD (staged or not) — is kept.
 *
 * Content is compared by hash (`hash-object` applies the same clean/eol filters
 * a commit does) rather than read from `git status`, so neither an index flag
 * (assume-unchanged, skip-worktree) nor a stale stat cache can make an edited
 * file look clean. Throws when git cannot answer: git missing, the source
 * directory outside a repository, or a repository with no commit yet.
 */
async function restorableFromGit(sourcePath: string, files: string[]): Promise<Set<string>> {
  const committed = new Map<string, string>();
  // From a subdirectory ls-tree lists that subtree only, with paths relative to
  // it — the same relativization the orphan paths get below, so a source
  // directory reached through a symlink still lines up. `-z` turns quoting off.
  const listing = await runGit(sourcePath, ["ls-tree", "-r", "-z", "HEAD"]);
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const [mode, type, blob] = entry.slice(0, tab).split(" ");
    // Regular files only: a symlink or a submodule is not something a download
    // writes, and its "content" is not what hash-object would read.
    if (type === "blob" && (mode === "100644" || mode === "100755")) {
      committed.set(entry.slice(tab + 1), blob);
    }
  }
  const candidates = files
    .map((file) => ({
      file,
      rel: path.relative(sourcePath, file).split(path.sep).join("/"),
    }))
    .filter(({ rel }) => committed.has(rel));
  const restorable = new Set<string>();
  for (let i = 0; i < candidates.length; i += HASH_CHUNK) {
    const chunk = candidates.slice(i, i + HASH_CHUNK);
    const hashes = (
      await runGit(sourcePath, ["hash-object", "--", ...chunk.map(({ rel }) => rel)])
    )
      .trim()
      .split(/\r?\n/);
    chunk.forEach(({ file, rel }, index) => {
      if (hashes[index] === committed.get(rel)) {
        restorable.add(file);
      }
    });
  }
  return restorable;
}

/**
 * DX18: reconcile the manifest against the files on disk and (optionally) repair.
 * Reports files the manifest expects but are missing locally, and local files
 * no manifest record claims (orphans). Dry-run by default — only `--apply`
 * re-downloads missing files, and only `--prune` deletes orphans, and of those
 * only the ones git holds committed and unchanged (see restorableFromGit).
 */
export async function repairCommand(args: RepairCmdArgs): Promise<void> {
  setLogLevel(args);

  let manifest: SN.AppManifest | undefined;
  try {
    manifest = ConfigManager.getManifest();
  } catch (_) {
    manifest = undefined;
  }
  if (!manifest) {
    logger.error(
      "No manifest found. Run `syncrona refresh` or `syncrona download <scope>` first."
    );
    process.exitCode = 1;
    return;
  }

  try {
    // SDK-F2: a workspace holding both data-model layouts (or the one its
    // config does not use) has no single answer to "what is missing", and a
    // re-download would only add to the mix — so it is reported and nothing
    // else runs. The documents themselves are never deleted here.
    let config: Sync.Config;
    try {
      config = ConfigManager.getConfig() as Sync.Config;
    } catch (_e) {
      // No loaded config means the defaults, and the default layout is "records".
      config = {} as Sync.Config;
    }
    const layout = await inspectCompositeLayout(manifest, config, ConfigManager.getSourcePath());
    if (layout.conflicts.length > 0) {
      logger.error(
        `Data-model layout conflict (dataModelLayout "${layout.layout}"):\n` +
          layout.conflicts.map((c) => `  ${c}`).join("\n") +
          "\nResolve it before repairing: keep one layout per record."
      );
      process.exitCode = 1;
      return;
    }
    if (layout.untracked.length > 0) {
      logger.warn(
        `${layout.untracked.length} data-model document entr${layout.untracked.length === 1 ? "y" : "ies"} ` +
          "no manifest record claims (new records for `push --create`, or leftovers):\n" +
          layout.untracked.map((u) => `  ${u}`).join("\n")
      );
    }

    // A column a record-level secret rule governs (`sys_properties.value`) is
    // absent on disk by design for a password property, so it is not counted —
    // otherwise the report never reaches zero, whatever `--apply` does. Nothing
    // local says which absent values are secret, so `--apply` still re-fetches
    // them all: the Table API path writes a non-secret record's value and keeps
    // withholding a password one.
    const { missing, exempt } = withoutSecretRuleColumns(
      await AppUtils.findMissingFiles(manifest)
    );
    const missingCount = countMissing(missing);
    const orphans = await findOrphanFiles(manifest);
    if (exempt > 0) {
      logger.info(
        `Not counted: ${exempt} field file(s) a record secret rule governs (e.g. sys_properties.value) ` +
          "are absent — a password-typed record's value is withheld by design. `--apply` (and " +
          "`syncrona refresh`) re-fetches them, restoring the value of every non-secret record."
      );
    }

    logger.info(
      `Repair report for scope "${manifest.scope}": ${missingCount} missing file(s), ${orphans.length} orphan file(s).`
    );

    if (missingCount > 0) {
      const rows: string[][] = [];
      for (const [table, records] of Object.entries(missing)) {
        for (const [sysId, files] of Object.entries(records)) {
          rows.push([table, sysId, String((files as unknown[]).length)]);
        }
      }
      logger.info(
        "Missing (in manifest, not on disk):\n" +
          formatTable(["Table", "sys_id", "Files"], rows)
      );
    }

    if (orphans.length > 0) {
      logger.info(
        "Orphans (on disk, not in manifest):\n" + orphans.map((o) => `  ${o}`).join("\n")
      );
    }

    // --dry-run forces report-only even if --apply is passed; repair is
    // report-only by default anyway (the safe stance for a destructive verb).
    const apply = args.apply === true && args.dryRun !== true;
    const consistent = missingCount === 0 && orphans.length === 0;
    // An uncounted governed value may be a non-secret one the user deleted:
    // `--apply` must still fetch it, or "Nothing to repair" would hide the gap.
    if (consistent && !(apply && exempt > 0)) {
      logger.success("Workspace is consistent with the manifest. Nothing to repair. ✅");
      return;
    }

    if (!apply) {
      const hints: string[] = [];
      if (missingCount > 0) hints.push("`--apply` re-downloads missing files");
      if (orphans.length > 0) hints.push("`--apply --prune` also deletes orphans");
      logger.info(`Report only (default). ${hints.join("; ")}.`);
      return;
    }

    let incompleteTables: string[] = [];
    if (missingCount > 0 || exempt > 0) {
      logger.info(
        missingCount > 0
          ? "Re-downloading missing files..."
          : `Re-fetching ${exempt} field file(s) a record secret rule governs (a password-typed record's value stays withheld)...`
      );
      // `?? []` because processMissingFiles is module-mocked in tests; a mock
      // that resolves to undefined must not crash the command. It recomputes the
      // full missing map, so the governed columns are fetched on either branch.
      incompleteTables = (await AppUtils.processMissingFiles(manifest)) ?? [];
    }

    if (orphans.length > 0 && args.prune === true) {
      // Refuse to prune when the source directory IS the project root (a
      // `sourceDirectory` of "." or ""): the shape filter alone would still put
      // every top-level `<dir>/<dir>/<file.ext>` in the repo — including the
      // manifest's sibling packages — within deletion range.
      if (path.resolve(ConfigManager.getSourcePath()) === path.resolve(ConfigManager.getRootDir())) {
        logger.error(
          "Refusing to prune: the source directory is the project root. Set a dedicated `sourceDirectory` in sync.config.js first."
        );
        process.exitCode = 1;
        return;
      }
      let restorable: Set<string>;
      try {
        restorable = await restorableFromGit(path.resolve(ConfigManager.getSourcePath()), orphans);
      } catch (e) {
        const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
        logger.error(
          `Refusing to prune: git cannot show which orphans are committed and unchanged (${reason}). ` +
            "`--prune` deletes only files git can restore, so an orphan that is new local work " +
            "(a script or column not pushed yet) is never lost. Commit the source directory to a " +
            "git repository first, or delete the orphans listed above by hand."
        );
        process.exitCode = 1;
        return;
      }
      const prunable = orphans.filter((orphan) => restorable.has(orphan));
      const keptLocal = orphans.filter((orphan) => !restorable.has(orphan));
      if (keptLocal.length > 0) {
        logger.warn(
          `Kept ${keptLocal.length} orphan file(s) git does not show as committed and unchanged ` +
            "(new or edited locally — e.g. records awaiting `push --create`). " +
            "Commit them first, or delete them by hand:\n" +
            keptLocal.map((f) => `  ${f}`).join("\n")
        );
      }
      const confirmed =
        prunable.length > 0 &&
        (args.ci === true ||
          (
            await inquirer.prompt<{ confirmed: boolean }>([
              {
                type: "confirm",
                name: "confirmed",
                message: `Delete ${prunable.length} orphan file(s)? This cannot be undone.`,
                default: false,
              },
            ])
          ).confirmed);
      if (prunable.length === 0) {
        logger.info("Nothing to prune: no orphan is committed and unchanged in git.");
      } else if (confirmed) {
        // Deletions are irreversible, so failures must be reported, not
        // swallowed: `.catch(() => undefined)` reported "Pruned N file(s)" even
        // when every unlink failed (permissions, read-only mount, EBUSY), so a
        // repair that changed nothing looked like a success.
        let pruned = 0;
        const failures: string[] = [];
        for (const orphan of prunable) {
          try {
            await fsp.unlink(orphan);
            pruned += 1;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            failures.push(`  ${orphan}: ${message}`);
          }
        }
        logger.info(`Pruned ${pruned} orphan file(s).`);
        if (failures.length > 0) {
          logger.error(
            `Failed to delete ${failures.length} orphan file(s):\n${failures.join("\n")}`
          );
          process.exitCode = 1;
        }
      } else {
        logger.info("Skipped pruning orphans.");
      }
    } else if (orphans.length > 0) {
      logger.info("Left orphans in place (re-run with `--prune` to delete them).");
    }

    // A re-download that could not fetch every field left those files exactly as
    // they were, so the next `repair` reports the same records missing. Reporting
    // "complete ✅" over that made the loop invisible.
    if (incompleteTables.length > 0) {
      logger.error(
        `Repair incomplete: ${incompleteTables.length} table(s) could not be fully fetched: ${incompleteTables.join(
          ", "
        )}. Check read access for the named field(s) and re-run.`
      );
      process.exitCode = 1;
      return;
    }

    // Every table answered and the files were still not all written (a record
    // the instance no longer returns, a manifest name the writer refused): the
    // report would list them again, so this run did not repair the workspace.
    let restoredExempt = 0;
    if (missingCount > 0 || exempt > 0) {
      const after = withoutSecretRuleColumns(await AppUtils.findMissingFiles(manifest));
      const remaining = countMissing(after.missing);
      restoredExempt = Math.max(0, exempt - after.exempt);
      if (restoredExempt > 0) {
        logger.info(
          `Restored ${restoredExempt} of ${exempt} field file(s) a record secret rule governs (non-secret values).`
        );
      }
      if (missingCount > 0 && remaining > 0) {
        logger.error(
          `Repair incomplete: ${remaining} of ${missingCount} missing file(s) are still missing after the re-download. ` +
            "Run `syncrona repair` to list them."
        );
        process.exitCode = 1;
        return;
      }
    }

    if (consistent && restoredExempt === 0) {
      // Every absent governed value was a withheld secret: nothing changed.
      logger.success("Workspace is consistent with the manifest. Nothing to repair. ✅");
      return;
    }
    logger.success("Repair complete. ✅");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(message || "Repair failed with an unknown error.");
    logErrorHint(e); // DX19: actionable next step based on error category
    process.exitCode = 1;
  }
}
