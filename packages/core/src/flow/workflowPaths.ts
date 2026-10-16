// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WP2f: where legacy Workflow documents go. Kept free of imports so push can
 * recognise a workflow document without loading the workflow reader.
 */

export const WORKFLOW_DOCUMENT_DIR = "wf_workflow";
export const WORKFLOW_DOCUMENT_SUFFIX = ".workflow.json";

/** Whether `filePath` is a workflow document. */
export const isWorkflowDocumentPath = (filePath: string): boolean => {
  const segments = filePath.split(/[/\\]/).filter((token) => token !== "");
  const name = segments[segments.length - 1] ?? "";
  return (
    segments.length >= 2 &&
    segments[segments.length - 2] === WORKFLOW_DOCUMENT_DIR &&
    name.length > WORKFLOW_DOCUMENT_SUFFIX.length &&
    name.endsWith(WORKFLOW_DOCUMENT_SUFFIX)
  );
};
