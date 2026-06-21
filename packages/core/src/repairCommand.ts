import { SN, Sync } from "@syncro-now-ai/types";
import { promises as fsp } from "fs";
import inquirer from "inquirer";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import * as FileUtils from "./FileUtils";
import { logger } from "./Logger";
import { formatTable } from "./genericUtils";
import { setLogLevel } from "./commandHelpers";
import { classifyError } from "./errorTaxonomy";

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

// Files present on disk under the source directory that do not map back to a
// manifest record/field. Best-effort: getFileContextFromPath returns undefined
// for a path that no manifest record claims, which is exactly an orphan.
async function findOrphanFiles(): Promise<string[]> {
  const sourcePath = ConfigManager.getSourcePath();
  const allFiles = await FileUtils.getPathsInPath(sourcePath);
  return allFiles.filter((file) => FileUtils.getFileContextFromPath(file) === undefined);
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
      "No manifest found. Run `syncro-now-ai refresh` or `syncro-now-ai download <scope>` first."
    );
    process.exitCode = 1;
    return;
  }

  try {
    const missing = await AppUtils.findMissingFiles(manifest);
    const missingCount = countMissing(missing);
    const orphans = await findOrphanFiles();

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

    if (missingCount > 0) {
      logger.info("Re-downloading missing files...");
      await AppUtils.processMissingFiles(manifest);
    }

    if (orphans.length > 0 && args.prune === true) {
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
        for (const orphan of orphans) {
          await fsp.unlink(orphan).catch(() => undefined);
        }
        logger.info(`Pruned ${orphans.length} orphan file(s).`);
      } else {
        logger.info("Skipped pruning orphans.");
      }
    } else if (orphans.length > 0) {
      logger.info("Left orphans in place (re-run with `--prune` to delete them).");
    }

    logger.success("Repair complete. ✅");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(message || "Repair failed with an unknown error.");
    logger.info(`→ ${classifyError(e).hint}`);
    process.exitCode = 1;
  }
}
