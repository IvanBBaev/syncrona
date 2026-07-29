// SPDX-License-Identifier: GPL-3.0-or-later
// G3: download progress / resume. A large scoped-app download can fail partway
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
  fingerprint?: string
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
    return parsed;
  } catch (_) {
    return null;
  }
}

export async function writeDownloadCheckpoint(
  checkpoint: DownloadCheckpoint
): Promise<void> {
  await fsp.writeFile(
    getDownloadCheckpointPath(),
    JSON.stringify(checkpoint, null, 2),
    "utf8"
  );
}

export async function deleteDownloadCheckpoint(): Promise<void> {
  try {
    await fsp.unlink(getDownloadCheckpointPath());
  } catch (_) {
    // already gone — nothing to clean up
  }
}
