// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test-only: renders a record update the way the SDK build writes it, so the
// golden files can be compared byte for byte. The production writer is the
// shared recordXml serializer, not this.

import type { RecordUpdateModel } from "../../src/compiler/record";

const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => text(s).replace(/"/g, "&quot;");

export function renderRecordUpdate(model: RecordUpdateModel): string {
  const lines = model.fields.map((f) => {
    const attrs = Object.entries(f.attributes ?? {})
      .map(([k, v]) => ` ${k}="${attr(v)}"`)
      .join("");
    if (f.value === undefined || f.value === "") return `    <${f.name}${attrs}/>`;
    const body = f.cdata ? `<![CDATA[${f.value}]]>` : text(f.value);
    return `    <${f.name}${attrs}>${body}</${f.name}>`;
  });
  return [
    '<?xml version="1.0"?>',
    `<record_update table="${model.table}">`,
    `  <${model.table} action="${model.action}" apply_defaults="true">`,
    ...lines,
    `  </${model.table}>`,
    "</record_update>",
  ].join("\n");
}
