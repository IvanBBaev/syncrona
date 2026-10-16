// SPDX-License-Identifier: GPL-3.0-or-later
import { promises as fsp } from "node:fs";
import path from "node:path";
import { logger } from "../Logger.js";
import { sanitizeRecordFolderName } from "../recordFolderNames.js";
import { serializeFlowDocument } from "./flowDocument.js";
import { FLOW_DOCUMENT_DIR, FLOW_DOCUMENT_SUFFIX, isFlowDocumentPath } from "./flowPaths.js";
import { listScopeFlows, readFlowDocument, type FlowListing, type FlowReadClient } from "./flowReader.js";
import { redactFlowSecrets } from "./flowSecrets.js";

export { FLOW_DOCUMENT_DIR, FLOW_DOCUMENT_SUFFIX, isFlowDocumentPath };

/**
 * WP2: the `flow` table preset. Refresh and download write every flow and
 * subflow of the scope as one decoded document, `<source>/sys_hub_flow/<name>.flow.json`.
 *
 * Read-only: the documents show a flow's definition in git and nothing reads
 * them back — push skips them (see isFlowDocumentPath). They sit directly in
 * the table folder, two segments deep and without the flat `~`, which is a
 * shape no manifest record has, so `repair` never takes them for orphans and
 * `push --create` never takes them for new records.
 */

// Path separators and the characters Windows refuses become `_`, and so does
// `~`, the flat layout's field separator: a file name carrying it would read as
// `<record>~<field>` to push and repair.
const baseNameOf = (flow: FlowListing): string =>
  sanitizeRecordFolderName((flow.internal_name || flow.name).replace(/[\\/:*?"<>|~]/g, "_")) || flow.sys_id;

/**
 * The file name of each flow, keyed by sys_id. A name two flows share gets the
 * sys_id appended on every one of them, so neither name depends on which flow
 * the instance listed first. Names are compared case-insensitively: on macOS and
 * Windows `A.flow.json` and `a.flow.json` are one file.
 */
export function flowFileNames(flows: readonly FlowListing[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const flow of flows) {
    const key = baseNameOf(flow).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const flow of flows) {
    const base = baseNameOf(flow);
    const unique = counts.get(base.toLowerCase()) === 1 || base === flow.sys_id;
    names.set(flow.sys_id, `${unique ? base : `${base}_${flow.sys_id}`}${FLOW_DOCUMENT_SUFFIX}`);
  }
  return names;
}

export type FlowSyncResult = {
  written: string[];
  unchanged: string[];
  failed: { sys_id: string; reason: string }[];
  /** Flow documents on disk that no listed flow wrote; left in place. */
  stale: string[];
  /** Set when the scope's flows could not be listed at all. */
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
    return (await fsp.readdir(dir)).filter((name) => isFlowDocumentPath(path.join(dir, name)));
  } catch {
    return [];
  }
}

/**
 * Write the flow document of every flow in `scope` under `sourcePath`. A flow
 * that cannot be read is reported and skipped; the others are still written.
 * Files are rewritten only when their bytes change.
 */
export async function writeFlowDocuments(
  client: FlowReadClient,
  scope: string,
  sourcePath: string
): Promise<FlowSyncResult> {
  const result: FlowSyncResult = { written: [], unchanged: [], failed: [], stale: [] };
  let flows: FlowListing[];
  try {
    flows = await listScopeFlows(client, scope);
  } catch (error) {
    result.listError = errorText(error);
    return result;
  }
  const dir = path.join(sourcePath, FLOW_DOCUMENT_DIR);
  const names = flowFileNames(flows);
  const claimed = new Set(names.values());
  if (flows.length > 0) await fsp.mkdir(dir, { recursive: true });
  // Sequential: each flow is eight paged reads, and bursts trip rate limits.
  for (const flow of flows) {
    const name = names.get(flow.sys_id) as string;
    const filePath = path.join(dir, name);
    try {
      const text = serializeFlowDocument(redactFlowSecrets(await readFlowDocument(client, flow.sys_id)));
      if ((await readText(filePath)) === text) {
        result.unchanged.push(name);
        continue;
      }
      await writeAtomic(filePath, text);
      result.written.push(name);
    } catch (error) {
      result.failed.push({ sys_id: flow.sys_id, reason: errorText(error) });
    }
  }
  result.stale = (await existingDocuments(dir)).filter((name) => !claimed.has(name)).sort();
  return result;
}

/**
 * Run writeFlowDocuments and log the outcome. Returns false when a flow, or
 * the listing itself, could not be read: the documents are then incomplete.
 */
export async function syncFlowDocuments(client: FlowReadClient, scope: string, sourcePath: string): Promise<boolean> {
  logger.info("Writing Flow Designer documents...");
  const result = await writeFlowDocuments(client, scope, sourcePath);
  if (result.listError !== undefined) {
    logger.error(
      `Could not list the flows of scope "${scope}" (${result.listError}). ` +
        "The `flow` preset needs read access to sys_hub_flow and the flow tables."
    );
    return false;
  }
  const total = result.written.length + result.unchanged.length;
  logger.info(`Flow documents: ${result.written.length} written, ${result.unchanged.length} unchanged (${total} in scope).`);
  if (result.stale.length > 0) {
    logger.warn(
      `${result.stale.length} flow document(s) belong to no flow of this scope any more and were left in place:\n` +
        result.stale.map((name) => `  ${path.join(FLOW_DOCUMENT_DIR, name)}`).join("\n")
    );
  }
  if (result.failed.length > 0) {
    logger.error(
      `${result.failed.length} flow(s) could not be read:\n` +
        result.failed.map((f) => `  ${f.sys_id}: ${f.reason}`).join("\n")
    );
    return false;
  }
  return true;
}
