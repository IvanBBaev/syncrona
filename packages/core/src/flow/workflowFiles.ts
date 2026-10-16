// SPDX-License-Identifier: GPL-3.0-or-later
import { promises as fsp } from "node:fs";
import path from "node:path";
import { logger } from "../Logger.js";
import { sanitizeRecordFolderName } from "../recordFolderNames.js";
import { documentFileNames } from "./flowFiles.js";
import type { FlowReadClient } from "./flowReader.js";
import { serializeWorkflowDocument } from "./workflowDocument.js";
import { isWorkflowDocumentPath, WORKFLOW_DOCUMENT_DIR, WORKFLOW_DOCUMENT_SUFFIX } from "./workflowPaths.js";
import { listScopeWorkflows, readWorkflowDocument, type WorkflowListing } from "./workflowReader.js";

export { isWorkflowDocumentPath, WORKFLOW_DOCUMENT_DIR, WORKFLOW_DOCUMENT_SUFFIX };

/**
 * WP2f: writes every legacy workflow of a scope as one decoded document,
 * `<source>/wf_workflow/<name>.workflow.json`, the way the `flow`
 * preset writes flows (see flowFiles.ts). Read-only: nothing reads the
 * documents back. No command calls this yet.
 */

// The same file-name rules as flow documents: path separators, the characters
// Windows refuses and the flat layout's `~` become `_`.
const baseNameOf = (workflow: WorkflowListing): string =>
  sanitizeRecordFolderName(workflow.name.replace(/[\\/:*?"<>|~]/g, "_")) || workflow.sys_id;

/** The file name of each workflow, keyed by sys_id; see documentFileNames. */
export function workflowFileNames(workflows: readonly WorkflowListing[]): Map<string, string> {
  return documentFileNames(
    workflows.map((workflow) => ({ sys_id: workflow.sys_id, base: baseNameOf(workflow) })),
    WORKFLOW_DOCUMENT_SUFFIX
  );
}

export type WorkflowSyncResult = {
  written: string[];
  unchanged: string[];
  failed: { sys_id: string; reason: string }[];
  /** Workflow documents on disk that no listed workflow wrote; left in place. */
  stale: string[];
  /** Set when the scope's workflows could not be listed at all. */
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
    return (await fsp.readdir(dir)).filter((name) => isWorkflowDocumentPath(path.join(dir, name)));
  } catch {
    return [];
  }
}

/**
 * Write the document of every workflow in `scope` under `sourcePath`. A
 * workflow that cannot be read is reported and skipped; the others are still
 * written. Files are rewritten only when their bytes change.
 */
export async function writeWorkflowDocuments(
  client: FlowReadClient,
  scope: string,
  sourcePath: string
): Promise<WorkflowSyncResult> {
  const result: WorkflowSyncResult = { written: [], unchanged: [], failed: [], stale: [] };
  let workflows: WorkflowListing[];
  try {
    workflows = await listScopeWorkflows(client, scope);
  } catch (error) {
    result.listError = errorText(error);
    return result;
  }
  const dir = path.join(sourcePath, WORKFLOW_DOCUMENT_DIR);
  const names = workflowFileNames(workflows);
  const claimed = new Set(names.values());
  // Sequential: each workflow is several paged reads, and bursts trip rate limits.
  for (const workflow of workflows) {
    const name = names.get(workflow.sys_id) as string;
    const filePath = path.join(dir, name);
    try {
      // Inside the try: a folder that cannot be made fails these documents, not the run.
      await fsp.mkdir(dir, { recursive: true });
      // The assembler already withholds secret-typed values.
      const text = serializeWorkflowDocument(await readWorkflowDocument(client, workflow.sys_id));
      if ((await readText(filePath)) === text) {
        result.unchanged.push(name);
        continue;
      }
      await writeAtomic(filePath, text);
      result.written.push(name);
    } catch (error) {
      result.failed.push({ sys_id: workflow.sys_id, reason: errorText(error) });
    }
  }
  result.stale = (await existingDocuments(dir)).filter((name) => !claimed.has(name)).sort();
  return result;
}

/**
 * Run writeWorkflowDocuments and log the outcome. Returns false when a
 * workflow, or the listing itself, could not be read.
 */
export async function syncWorkflowDocuments(
  client: FlowReadClient,
  scope: string,
  sourcePath: string
): Promise<boolean> {
  logger.info("Writing workflow documents...");
  const result = await writeWorkflowDocuments(client, scope, sourcePath);
  if (result.listError !== undefined) {
    logger.error(
      `Could not list the workflows of scope "${scope}" (${result.listError}). ` +
        "Workflow documents need read access to wf_workflow, wf_workflow_version, wf_activity, wf_condition, wf_transition, wf_stage and sys_variable_value."
    );
    return false;
  }
  const total = result.written.length + result.unchanged.length;
  logger.info(
    `Workflow documents: ${result.written.length} written, ${result.unchanged.length} unchanged (${total} in scope).`
  );
  if (result.stale.length > 0) {
    logger.warn(
      `${result.stale.length} workflow document(s) belong to no workflow of this scope any more and were left in place:\n` +
        result.stale.map((name) => `  ${path.join(WORKFLOW_DOCUMENT_DIR, name)}`).join("\n")
    );
  }
  if (result.failed.length > 0) {
    logger.error(
      `${result.failed.length} workflow(s) could not be read:\n` +
        result.failed.map((f) => `  ${f.sys_id}: ${f.reason}`).join("\n")
    );
    return false;
  }
  return true;
}
