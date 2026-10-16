// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WP2: where the `flow` preset writes its documents. Kept free of imports so
 * push can recognise a flow document without loading the flow reader.
 */

export const FLOW_DOCUMENT_DIR = "sys_hub_flow";
export const FLOW_DOCUMENT_SUFFIX = ".flow.json";

/** Whether `filePath` is a flow document the `flow` preset writes. */
export const isFlowDocumentPath = (filePath: string): boolean => {
  const segments = filePath.split(/[/\\]/).filter((token) => token !== "");
  const name = segments[segments.length - 1] ?? "";
  return (
    segments.length >= 2 &&
    segments[segments.length - 2] === FLOW_DOCUMENT_DIR &&
    name.length > FLOW_DOCUMENT_SUFFIX.length &&
    name.endsWith(FLOW_DOCUMENT_SUFFIX)
  );
};
