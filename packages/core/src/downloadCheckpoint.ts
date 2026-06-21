// G3: download progress / resume. A large scoped-app download can fail partway
// (a flaky network, a throttled instance); without state, the next run starts
// over. This checkpoint records which tables have already been downloaded AND
// written so a re-run skips them — mirroring the push checkpoint
// (sync.push.checkpoint.json).

import { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config";

export const DOWNLOAD_CHECKPOINT_FILE = "sync.download.checkpoint.json";

export interface DownloadCheckpoint {
  /** Scope the checkpoint belongs to — a mismatch means it is stale. */
  scope: string;
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
  scope: string
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
