// SPDX-License-Identifier: GPL-3.0-or-later
import { promises as fsp } from "node:fs";
import path from "node:path";
import { logger } from "../Logger.js";
import { sanitizeRecordFolderName } from "../recordFolderNames.js";
import type { FlowReadClient } from "./flowReader.js";
import { serializePlaybookDocument } from "./playbookDocument.js";
import { isPlaybookDocumentPath, PLAYBOOK_DOCUMENT_DIR, PLAYBOOK_DOCUMENT_SUFFIX } from "./playbookPaths.js";
import { listScopePlaybooks, readPlaybookDocument, type PlaybookListing } from "./playbookReader.js";

export { isPlaybookDocumentPath, PLAYBOOK_DOCUMENT_DIR, PLAYBOOK_DOCUMENT_SUFFIX };

/**
 * WP2c: writes every playbook of a scope as one decoded document,
 * `<source>/sys_pd_process_definition/<name>.playbook.json`, the way the `flow`
 * preset writes flows (see flowFiles.ts). Read-only: nothing reads the
 * documents back. No command calls this yet.
 */

// The same file-name rules as flow documents: path separators, the characters
// Windows refuses and the flat layout's `~` become `_`.
const baseNameOf = (playbook: PlaybookListing): string =>
  sanitizeRecordFolderName((playbook.name || playbook.label).replace(/[\\/:*?"<>|~]/g, "_")) || playbook.sys_id;

/**
 * The file name of each playbook, keyed by sys_id. A name two playbooks share
 * (case-insensitively) gets the sys_id appended on every one of them.
 */
export function playbookFileNames(playbooks: readonly PlaybookListing[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const playbook of playbooks) {
    const key = baseNameOf(playbook).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const playbook of playbooks) {
    const base = baseNameOf(playbook);
    const unique = counts.get(base.toLowerCase()) === 1 || base === playbook.sys_id;
    names.set(playbook.sys_id, `${unique ? base : `${base}_${playbook.sys_id}`}${PLAYBOOK_DOCUMENT_SUFFIX}`);
  }
  return names;
}

export type PlaybookSyncResult = {
  written: string[];
  unchanged: string[];
  failed: { sys_id: string; reason: string }[];
  /** Playbook documents on disk that no listed playbook wrote; left in place. */
  stale: string[];
  /** Set when the scope's playbooks could not be listed at all. */
  listError?: string;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function writeAtomic(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, filePath);
}

async function existingDocuments(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((name) => isPlaybookDocumentPath(path.join(dir, name)));
  } catch {
    return [];
  }
}

/**
 * Write the document of every playbook in `scope` under `sourcePath`. A
 * playbook that cannot be read is reported and skipped; the others are still
 * written. Files are rewritten only when their bytes change.
 */
export async function writePlaybookDocuments(
  client: FlowReadClient,
  scope: string,
  sourcePath: string
): Promise<PlaybookSyncResult> {
  const result: PlaybookSyncResult = { written: [], unchanged: [], failed: [], stale: [] };
  let playbooks: PlaybookListing[];
  try {
    playbooks = await listScopePlaybooks(client, scope);
  } catch (error) {
    result.listError = errorText(error);
    return result;
  }
  const dir = path.join(sourcePath, PLAYBOOK_DOCUMENT_DIR);
  const names = playbookFileNames(playbooks);
  const claimed = new Set(names.values());
  // Sequential: each playbook is a dozen paged reads, and bursts trip rate limits.
  for (const playbook of playbooks) {
    const name = names.get(playbook.sys_id) as string;
    const filePath = path.join(dir, name);
    try {
      // Inside the try: a folder that cannot be made fails these documents, not the run.
      await fsp.mkdir(dir, { recursive: true });
      // The assembler already withholds secret-typed values.
      const text = serializePlaybookDocument(await readPlaybookDocument(client, playbook.sys_id));
      if ((await readText(filePath)) === text) {
        result.unchanged.push(name);
        continue;
      }
      await writeAtomic(filePath, text);
      result.written.push(name);
    } catch (error) {
      result.failed.push({ sys_id: playbook.sys_id, reason: errorText(error) });
    }
  }
  result.stale = (await existingDocuments(dir)).filter((name) => !claimed.has(name)).sort();
  return result;
}

/**
 * Run writePlaybookDocuments and log the outcome. Returns false when a
 * playbook, or the listing itself, could not be read.
 */
export async function syncPlaybookDocuments(client: FlowReadClient, scope: string, sourcePath: string): Promise<boolean> {
  logger.info("Writing playbook documents...");
  const result = await writePlaybookDocuments(client, scope, sourcePath);
  if (result.listError !== undefined) {
    logger.error(
      `Could not list the playbooks of scope "${scope}" (${result.listError}). ` +
        "Playbook documents need read access to sys_pd_process_definition and the sys_pd_* tables."
    );
    return false;
  }
  const total = result.written.length + result.unchanged.length;
  logger.info(
    `Playbook documents: ${result.written.length} written, ${result.unchanged.length} unchanged (${total} in scope).`
  );
  if (result.stale.length > 0) {
    logger.warn(
      `${result.stale.length} playbook document(s) belong to no playbook of this scope any more and were left in place:\n` +
        result.stale.map((name) => `  ${path.join(PLAYBOOK_DOCUMENT_DIR, name)}`).join("\n")
    );
  }
  if (result.failed.length > 0) {
    logger.error(
      `${result.failed.length} playbook(s) could not be read:\n` +
        result.failed.map((f) => `  ${f.sys_id}: ${f.reason}`).join("\n")
    );
    return false;
  }
  return true;
}
