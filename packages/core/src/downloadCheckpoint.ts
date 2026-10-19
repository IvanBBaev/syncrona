// SPDX-License-Identifier: GPL-3.0-or-later
// G3: download progress / resume. A large application download can fail partway
// (a flaky network, a throttled instance); without state, the next run starts
// over. This checkpoint records which tables have already been downloaded AND
// written so a re-run skips them — mirroring the push checkpoint
// (sync.push.checkpoint.json).

import { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config.js";

export const DOWNLOAD_CHECKPOINT_FILE = "sync.download.checkpoint.json";

export interface DownloadCheckpoint {
  /** Scope the checkpoint belongs to — a mismatch means it is stale. */
  scope: string;
  /**
   * Digest of the manifest slice this checkpoint was recorded against. The
   * scope alone does not identify the work: after a `refresh` adds records or
   * changes a record's file list, the completed tables no longer cover the same
   * files, so a mismatch means stale.
   */
  fingerprint?: string;
  /**
   * Instance the tables were downloaded from. The same scope and manifest slice
   * exist on dev and test alike, so without it a run against another instance
   * skipped the tables an earlier, interrupted run had fetched elsewhere.
   */
  instance?: string;
  /** Tables fully fetched and written so far. */
  completedTables: string[];
}

// The checkpoint lives in the project root so runs from a subdirectory share it;
// fall back to cwd when no config has been loaded yet.
function getStateBaseDir(): string {
  try {
    return ConfigManager.getRootDir();
  } catch (_) {
    return process.cwd();
  }
}

export function getDownloadCheckpointPath(): string {
  return path.join(getStateBaseDir(), DOWNLOAD_CHECKPOINT_FILE);
}

/**
 * Read the checkpoint for a scope, or null when absent, malformed, or left over
 * from a different scope (in which case it is treated as stale).
 */
export async function readDownloadCheckpoint(
  scope: string,
  fingerprint?: string,
  instance?: string
): Promise<DownloadCheckpoint | null> {
  try {
    const raw = await fsp.readFile(getDownloadCheckpointPath(), "utf8");
    const parsed = JSON.parse(raw) as DownloadCheckpoint;
    if (
      typeof parsed.scope !== "string" ||
      !Array.isArray(parsed.completedTables) ||
      parsed.scope !== scope
    ) {
      return null;
    }
    // The scope check alone accepted a checkpoint written against a DIFFERENT
    // manifest: after `refresh` added records to an already-completed table (or
    // changed a record's fields), the resume skipped that table and the new
    // files were never downloaded, yet the run reported "Download complete".
    // A digest mismatch — or a checkpoint written before fingerprints existed —
    // now invalidates the checkpoint and the scope is re-downloaded.
    if (fingerprint !== undefined && parsed.fingerprint !== fingerprint) {
      return null;
    }
    // Same rule for the instance: a checkpoint from another instance (or one
    // written before the instance was recorded) does not describe this run.
    if (
      instance !== undefined &&
      normalizeInstance(parsed.instance) !== normalizeInstance(instance)
    ) {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

// `ACME.service-now.com` and `https://acme.service-now.com/` name the same
// instance; compare them without the scheme, trailing slash or case.
function normalizeInstance(instance: string | undefined): string {
  return (instance ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

export async function writeDownloadCheckpoint(
  checkpoint: DownloadCheckpoint
): Promise<void> {
  // Temp file + rename, like writeManifestFile: an in-place write cut short by a
  // full disk or a kill left truncated JSON, the next run read it as "no
  // checkpoint", and the resume was lost without a word.
  const checkpointPath = getDownloadCheckpointPath();
  const tmpPath = `${checkpointPath}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), "utf8");
    await fsp.rename(tmpPath, checkpointPath);
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function deleteDownloadCheckpoint(): Promise<void> {
  const checkpointPath = getDownloadCheckpointPath();
  try {
    await fsp.unlink(checkpointPath);
  } catch (e) {
    // Only "already gone" is harmless. A checkpoint that survives a finished
    // download (a locked or read-only file) lists every table as completed, so
    // the next download skips them all and never fetches instance-side edits,
    // and `push --prune` keeps reporting an unfinished download.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `The download finished, but its checkpoint ${checkpointPath} could not be removed ` +
        `(${(e as Error).message}). Delete it by hand; until then the next download ` +
        `skips every table it lists.`
    );
  }
}
