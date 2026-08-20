// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { promises as fsp } from "fs";
import path from "path";
import inquirer from "inquirer";
import * as ConfigManager from "./config.js";
import * as AppUtils from "./appUtils.js";
import * as FileUtils from "./FileUtils.js";
import { isFlatEncoded, FLAT_FIELD_SEPARATOR } from "./flatLayout.js";
import { isMetaSidecarPath } from "./metaFields.js";
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
  const tables = manifest.tables ?? {};
  const table =
    tables[key.table] ??
    Object.entries(tables).find(
      ([name]) => canonicalName(name) === canonicalName(key.table)
    )?.[1];
  const records = table?.records;
  if (!records || Object.prototype.hasOwnProperty.call(records, key.record)) {
    return false;
  }
  const canonical = canonicalName(key.record);
  return Object.keys(records).some((name) => canonicalName(name) === canonical);
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
    if (isMetaSidecarPath(file)) {
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
    orphans.push(file);
  }
  if (encodingMismatches.length > 0) {
    logger.warn(
      `Kept ${encodingMismatches.length} tracked file(s) whose on-disk name differs from the manifest only in encoding (Unicode normalization or trailing dots/spaces):\n` +
        encodingMismatches.map((f) => `  ${f}`).join("\n")
    );
  }
  return orphans;
}

/**
 * DX18: reconcile the manifest against the files on disk and (optionally) repair.
 * Reports files the manifest expects but are missing locally, and local files
 * no manifest record claims (orphans). Dry-run by default — only `--apply`
 * re-downloads missing files, and only `--prune` deletes orphans.
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
    const missing = await AppUtils.findMissingFiles(manifest);
    const missingCount = countMissing(missing);
    const orphans = await findOrphanFiles(manifest);

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

    if (missingCount === 0 && orphans.length === 0) {
      logger.success("Workspace is consistent with the manifest. Nothing to repair. ✅");
      return;
    }

    // --dry-run forces report-only even if --apply is passed; repair is
    // report-only by default anyway (the safe stance for a destructive verb).
    const apply = args.apply === true && args.dryRun !== true;
    if (!apply) {
      const hints: string[] = [];
      if (missingCount > 0) hints.push("`--apply` re-downloads missing files");
      if (orphans.length > 0) hints.push("`--apply --prune` also deletes orphans");
      logger.info(`Report only (default). ${hints.join("; ")}.`);
      return;
    }

    let incompleteTables: string[] = [];
    if (missingCount > 0) {
      logger.info("Re-downloading missing files...");
      // `?? []` because processMissingFiles is module-mocked in tests; a mock
      // that resolves to undefined must not crash the command.
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
      const confirmed =
        args.ci === true
          ? true
          : (
              await inquirer.prompt<{ confirmed: boolean }>([
                {
                  type: "confirm",
                  name: "confirmed",
                  message: `Delete ${orphans.length} orphan file(s)? This cannot be undone.`,
                  default: false,
                },
              ])
            ).confirmed;
      if (confirmed) {
        // Deletions are irreversible, so failures must be reported, not
        // swallowed: `.catch(() => undefined)` reported "Pruned N file(s)" even
        // when every unlink failed (permissions, read-only mount, EBUSY), so a
        // repair that changed nothing looked like a success.
        let pruned = 0;
        const failures: string[] = [];
        for (const orphan of orphans) {
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

    logger.success("Repair complete. ✅");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(message || "Repair failed with an unknown error.");
    logErrorHint(e); // DX19: actionable next step based on error category
    process.exitCode = 1;
  }
}
