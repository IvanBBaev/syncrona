// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test-only: renders a record update the way the SDK build writes it, so the
// golden files can be compared byte for byte. The production writer is the
// shared recordXml serializer, not this.

import type { RecordElementModel, RecordUpdateModel } from "../../src/compiler/record";

const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => text(s).replace(/"/g, "&quot;");

function renderElement(model: RecordElementModel): string[] {
  const lines = model.fields.map((f) => {
    const attrs = Object.entries(f.attributes ?? {})
      .map(([k, v]) => ` ${k}="${attr(v)}"`)
      .join("");
    if (f.value === undefined || f.value === "") return `    <${f.name}${attrs}/>`;
    const body = f.cdata ? `<![CDATA[${f.value}]]>` : text(f.value);
    return `    <${f.name}${attrs}>${body}</${f.name}>`;
  });
  const recordAttrs = Object.entries(model.attributes ?? {})
    .map(([k, v]) => ` ${k}="${attr(v)}"`)
    .join("");
  return [`  <${model.table} action="${model.action}"${recordAttrs} apply_defaults="true">`, ...lines, `  </${model.table}>`];
}

export function renderRecordUpdate(model: RecordUpdateModel): string {
  // A record with attachments shares a table-less record_update with them.
  return [
    '<?xml version="1.0"?>',
    model.associated ? "<record_update>" : `<record_update table="${model.rootTable ?? model.table}">`,
    ...[model, ...(model.associated ?? [])].flatMap(renderElement),
    "</record_update>",
  ].join("\n");
}
