// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WP2c: where playbook documents go. Kept free of imports so push can
 * recognise a playbook document without loading the playbook reader.
 */

export const PLAYBOOK_DOCUMENT_DIR = "sys_pd_process_definition";
export const PLAYBOOK_DOCUMENT_SUFFIX = ".playbook.json";

/** Whether `filePath` is a playbook document. */
export const isPlaybookDocumentPath = (filePath: string): boolean => {
  const segments = filePath.split(/[/\\]/).filter((token) => token !== "");
  const name = segments[segments.length - 1] ?? "";
  return (
    segments.length >= 2 &&
    segments[segments.length - 2] === PLAYBOOK_DOCUMENT_DIR &&
    name.length > PLAYBOOK_DOCUMENT_SUFFIX.length &&
    name.endsWith(PLAYBOOK_DOCUMENT_SUFFIX)
  );
};
