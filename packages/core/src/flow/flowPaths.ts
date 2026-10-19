// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WP2: where the `flow` preset writes its documents. Kept free of imports so
 * push can recognise a flow or action document without loading the readers.
 */

export const FLOW_DOCUMENT_DIR = "sys_hub_flow";
export const FLOW_DOCUMENT_SUFFIX = ".flow.json";
export const ACTION_DOCUMENT_DIR = "sys_hub_action_type_definition";
export const ACTION_DOCUMENT_SUFFIX = ".action.json";

const isDocumentPath = (filePath: string, dir: string, suffix: string): boolean => {
  const segments = filePath.split(/[/\\]/).filter((token) => token !== "");
  const name = segments[segments.length - 1] ?? "";
  return (
    segments.length >= 2 &&
    segments[segments.length - 2] === dir &&
    name.length > suffix.length &&
    name.endsWith(suffix)
  );
};

/** Whether `filePath` is a flow document the `flow` preset writes. */
export const isFlowDocumentPath = (filePath: string): boolean =>
  isDocumentPath(filePath, FLOW_DOCUMENT_DIR, FLOW_DOCUMENT_SUFFIX);

/** Whether `filePath` is a custom-action document the `flow` preset writes. */
export const isActionDocumentPath = (filePath: string): boolean =>
  isDocumentPath(filePath, ACTION_DOCUMENT_DIR, ACTION_DOCUMENT_SUFFIX);
