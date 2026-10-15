// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal zip reader for tests: walks the central directory and inflates each entry.
import { inflateRawSync } from "node:zlib";

export interface ReadEntry {
  name: string;
  data: Buffer;
  crc: number;
  flags: number;
  method: number;
  versionMadeBy: number;
  time: number;
  date: number;
  extraLength: number;
}

export function readZip(zip: Buffer): ReadEntry[] {
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error("no end-of-central-directory record");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central header");
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("bad local header");
    const localName = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const compressed = zip.subarray(start, start + zip.readUInt32LE(p + 20));
    const method = zip.readUInt16LE(p + 10);
    entries.push({
      name,
      data: method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed),
      crc: zip.readUInt32LE(p + 16),
      flags: zip.readUInt16LE(p + 8),
      method,
      versionMadeBy: zip.readUInt16LE(p + 4),
      time: zip.readUInt16LE(p + 12),
      date: zip.readUInt16LE(p + 14),
      extraLength,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
