// SPDX-License-Identifier: GPL-3.0-or-later
import { promises as fsp } from "node:fs";
import path from "node:path";
import { logger } from "../Logger.js";
import { canonicalFolderKey, sanitizeRecordFolderName } from "../recordFolderNames.js";
import { serializeActionDocument } from "./actionDocument.js";
import { listScopeActions, readActionDocument } from "./actionReader.js";
import { redactActionSecrets } from "./actionSecrets.js";
import { serializeFlowDocument } from "./flowDocument.js";
import {
  ACTION_DOCUMENT_DIR,
  ACTION_DOCUMENT_SUFFIX,
  FLOW_DOCUMENT_DIR,
  FLOW_DOCUMENT_SUFFIX,
  isActionDocumentPath,
  isFlowDocumentPath,
} from "./flowPaths.js";
import { listScopeFlows, readFlowDocument, type FlowListing, type FlowReadClient } from "./flowReader.js";
import { redactFlowSecrets } from "./flowSecrets.js";

export {
  ACTION_DOCUMENT_DIR,
  ACTION_DOCUMENT_SUFFIX,
  FLOW_DOCUMENT_DIR,
  FLOW_DOCUMENT_SUFFIX,
  isActionDocumentPath,
  isFlowDocumentPath,
};

/**
 * WP2: the `flow` table preset. Refresh and download write every flow and
 * subflow of the scope as one decoded document, `<source>/sys_hub_flow/<name>.flow.json`,
 * and every custom action as `<source>/sys_hub_action_type_definition/<name>.action.json`.
 *
 * Read-only: the documents show a flow's definition in git and nothing reads
 * them back — push skips them (see isFlowDocumentPath, isActionDocumentPath). They sit directly in
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
 * The file name of each entry, keyed by sys_id. A base name two entries share
 * gets the sys_id appended on every one of them, so neither name depends on
 * which entry the instance listed first. Names are compared as the file system
 * compares them (canonicalFolderKey: case, Unicode normalization): on macOS and
 * Windows `A.flow.json` and `a.flow.json` are one file. A final name that still
 * collides — a generated `<name>_<sys_id>` that another entry's real name
 * spells — falls back to the bare sys_id, which is unique.
 */
export function documentFileNames(
  entries: readonly { sys_id: string; base: string }[],
  suffix: string
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { base } of entries) {
    const key = canonicalFolderKey(base);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const { sys_id, base } of entries) {
    const unique = counts.get(canonicalFolderKey(base)) === 1 || base === sys_id;
    names.set(sys_id, `${unique ? base : `${base}_${sys_id}`}${suffix}`);
  }
  // Each pass moves at least one entry onto its sys_id, so this ends.
  for (;;) {
    const owners = new Map<string, string[]>();
    for (const [sysId, name] of names) {
      const key = canonicalFolderKey(name);
      owners.set(key, [...(owners.get(key) ?? []), sysId]);
    }
    const clashing = [...owners.values()]
      .filter((ids) => ids.length > 1)
      .flat()
      .filter((sysId) => names.get(sysId) !== `${sysId}${suffix}`);
    if (clashing.length === 0) return names;
    for (const sysId of clashing) names.set(sysId, `${sysId}${suffix}`);
  }
}

/** The file name of each flow, keyed by sys_id; see documentFileNames. */
export function flowFileNames(
  flows: readonly FlowListing[],
  suffix: string = FLOW_DOCUMENT_SUFFIX
): Map<string, string> {
  return documentFileNames(
    flows.map((flow) => ({ sys_id: flow.sys_id, base: baseNameOf(flow) })),
    suffix
  );
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

async function existingDocuments(dir: string, isPath: (filePath: string) => boolean): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((name) => isPath(path.join(dir, name)));
  } catch {
    return [];
  }
}

/** One kind of document the preset writes: flows, or custom actions. */
type DocumentKind = {
  dir: string;
  suffix: string;
  isPath: (filePath: string) => boolean;
  list: (client: FlowReadClient, scope: string) => Promise<FlowListing[]>;
  read: (client: FlowReadClient, sysId: string) => Promise<string>;
};

const FLOW_KIND: DocumentKind = {
  dir: FLOW_DOCUMENT_DIR,
  suffix: FLOW_DOCUMENT_SUFFIX,
  isPath: isFlowDocumentPath,
  list: listScopeFlows,
  read: async (client, sysId) => serializeFlowDocument(redactFlowSecrets(await readFlowDocument(client, sysId))),
};

const ACTION_KIND: DocumentKind = {
  dir: ACTION_DOCUMENT_DIR,
  suffix: ACTION_DOCUMENT_SUFFIX,
  isPath: isActionDocumentPath,
  list: listScopeActions,
  read: async (client, sysId) => serializeActionDocument(redactActionSecrets(await readActionDocument(client, sysId))),
};

async function writeDocuments(
  kind: DocumentKind,
  client: FlowReadClient,
  scope: string,
  sourcePath: string
): Promise<FlowSyncResult> {
  const result: FlowSyncResult = { written: [], unchanged: [], failed: [], stale: [] };
  let listings: FlowListing[];
  try {
    listings = await kind.list(client, scope);
  } catch (error) {
    result.listError = errorText(error);
    return result;
  }
  const dir = path.join(sourcePath, kind.dir);
  const names = flowFileNames(listings, kind.suffix);
  const claimed = new Set(names.values());
  // Sequential: each document is several paged reads, and bursts trip rate limits.
  for (const listing of listings) {
    const name = names.get(listing.sys_id) as string;
    const filePath = path.join(dir, name);
    try {
      // Inside the try: a folder that cannot be made fails these documents, not the run.
      await fsp.mkdir(dir, { recursive: true });
      const text = await kind.read(client, listing.sys_id);
      if ((await readText(filePath)) === text) {
        result.unchanged.push(name);
        continue;
      }
      await writeAtomic(filePath, text);
      result.written.push(name);
    } catch (error) {
      result.failed.push({ sys_id: listing.sys_id, reason: errorText(error) });
    }
  }
  result.stale = (await existingDocuments(dir, kind.isPath)).filter((name) => !claimed.has(name)).sort();
  return result;
}

/**
 * Write the flow document of every flow in `scope` under `sourcePath`. A flow
 * that cannot be read is reported and skipped; the others are still written.
 * Files are rewritten only when their bytes change.
 */
export const writeFlowDocuments = (client: FlowReadClient, scope: string, sourcePath: string): Promise<FlowSyncResult> =>
  writeDocuments(FLOW_KIND, client, scope, sourcePath);

/** Write the document of every custom action in `scope`, as writeFlowDocuments does for flows. */
export const writeActionDocuments = (client: FlowReadClient, scope: string, sourcePath: string): Promise<FlowSyncResult> =>
  writeDocuments(ACTION_KIND, client, scope, sourcePath);

/** Log one kind's outcome; false when the documents are incomplete. */
function report(result: FlowSyncResult, scope: string, noun: string, dir: string, tables: string): boolean {
  if (result.listError !== undefined) {
    logger.error(
      `Could not list the ${noun}s of scope "${scope}" (${result.listError}). ` +
        `The \`flow\` preset needs read access to ${tables}.`
    );
    return false;
  }
  const total = result.written.length + result.unchanged.length;
  logger.info(
    `${noun[0].toUpperCase()}${noun.slice(1)} documents: ${result.written.length} written, ` +
      `${result.unchanged.length} unchanged (${total} in scope).`
  );
  if (result.stale.length > 0) {
    logger.warn(
      `${result.stale.length} ${noun} document(s) belong to no ${noun} of this scope any more and were left in place:\n` +
        result.stale.map((name) => `  ${path.join(dir, name)}`).join("\n")
    );
  }
  if (result.failed.length > 0) {
    logger.error(
      `${result.failed.length} ${noun}(s) could not be read:\n` +
        result.failed.map((f) => `  ${f.sys_id}: ${f.reason}`).join("\n")
    );
    return false;
  }
  return true;
}

/**
 * Write the flow and custom-action documents and log the outcome. Returns
 * false when a flow or action, or a listing itself, could not be read: the
 * documents are then incomplete. Actions are written even when flows failed.
 */
export async function syncFlowDocuments(client: FlowReadClient, scope: string, sourcePath: string): Promise<boolean> {
  logger.info("Writing Flow Designer documents...");
  const flows = report(
    await writeFlowDocuments(client, scope, sourcePath),
    scope,
    "flow",
    FLOW_DOCUMENT_DIR,
    "sys_hub_flow and the flow tables"
  );
  const actions = report(
    await writeActionDocuments(client, scope, sourcePath),
    scope,
    "action",
    ACTION_DOCUMENT_DIR,
    `${ACTION_DOCUMENT_DIR} and the action tables`
  );
  return flows && actions;
}
