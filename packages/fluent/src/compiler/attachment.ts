// SPDX-License-Identifier: GPL-3.0-or-later
//
// `Now.attach()` → the sys_attachment record and its sys_attachment_doc chunks,
// written inside the file of the record whose field holds the attachment, the
// way the SDK's attach plugin writes them.
//
// The file is gzipped and base64-encoded: the first doc holds the 10-byte gzip
// header, the rest of the stream is split into `CHUNK_SIZE` pieces. The SDK
// compresses with fflate and stamps the build time into the header, so its
// output changes on every build; the native compiler uses node:zlib (level 6)
// with a zero modification time instead, which keeps builds reproducible. The
// compressed bytes — `data`, `size_compressed` and the doc sys_ids derived
// from them — therefore differ from the SDK's, while the attachment's sys_id,
// hash and decompressed content match.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { SourceLocation } from "./diagnostics";
import type { CompiledRecord, RecordFactory } from "./record";

export const CHUNK_SIZE = 933336;

const CONTENT_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/ico"],
  [".svg", "image/svg+xml"],
]);

/** The SDK's id scheme for attachment records: md5 of the parts joined by `:`. */
function generateId(...parts: (string | number)[]): string {
  return createHash("md5").update(parts.join(":")).digest("hex");
}

/** A gzip stream with a fixed header: no modification time, unix as the OS. */
export function gzip(buffer: Buffer): Buffer {
  const out = gzipSync(buffer, { level: 6 });
  out.fill(0, 4, 9);
  out[9] = 3;
  return out;
}

function chunk(data: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) chunks.push(data.substring(offset, offset + CHUNK_SIZE));
  return chunks;
}

/**
 * The attachment of `file` to `field` of `parent`: the sys_attachment record
 * followed by its docs. `parent`'s field takes the attachment's sys_id.
 */
export function attachmentRecords(factory: RecordFactory, parent: CompiledRecord, field: string, file: string, source: SourceLocation): CompiledRecord[] {
  const buffer = fs.readFileSync(file);
  const hash = createHash("sha256").update(buffer).digest("hex");
  const compressed = gzip(buffer);
  const data = [compressed.subarray(0, 10).toString("base64"), ...chunk(compressed.subarray(10).toString("base64"))];
  const parentId = parent.id.getValue();
  const attachmentId = generateId(parentId, "sys_attachment", hash, field);
  const attachment = factory.createAssociated("sys_attachment", attachmentId, source, {
    average_image_color: "",
    chunk_size_bytes: CHUNK_SIZE,
    compressed: true,
    content_type: CONTENT_TYPES.get(path.extname(file).toLowerCase()),
    hash,
    image_height: "",
    image_width: "",
    size_bytes: buffer.length,
    size_compressed: compressed.length,
    file_name: field,
    table_name: `ZZ_YY${parent.table}`,
    table_sys_id: parentId,
  });
  const docs = data.map((piece, position) =>
    factory.createAssociated("sys_attachment_doc", generateId(parentId, "sys_attachment_doc", field, piece), source, {
      data: piece,
      length: piece.length,
      position,
      sys_attachment: attachmentId,
    }),
  );
  return [attachment, ...docs];
}
