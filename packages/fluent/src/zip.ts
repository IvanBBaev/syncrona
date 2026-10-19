// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deterministic zip writer for the native `fluent pack`.
//
// The SDK packs with fflate; this package keeps zero runtime dependencies, so
// it writes the (small) subset of PKZIP it needs itself: deflate (level 6, as
// the SDK uses) through `node:zlib`, a table-driven CRC-32 (`zlib.crc32` only
// arrived in Node 22.2 and the engines floor is 22.0), local headers, the
// central directory and the end-of-central-directory record. No zip64, no
// extra fields, no comments.
//
// Output is byte-stable for the same input: entries are sorted by name and
// every entry carries the same DOS timestamp (1980-01-01 00:00, the earliest a
// DOS date can express), so packing an unchanged build twice yields an
// identical archive — unlike the SDK, which stamps the wall clock.

import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Entry name as stored, `/`-separated. */
  name: string;
  data: Uint8Array;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** PKZIP 2.0, MS-DOS host — the same "version made by" / "needed" fflate writes. */
const VERSION = 20;
const METHOD_DEFLATE = 8;
/** General-purpose bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as PKZIP stores it. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Prepared {
  name: Buffer;
  flags: number;
  crc: number;
  size: number;
  compressed: Buffer;
  offset: number;
}

function localHeader(entry: Prepared): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(METHOD_DEFLATE, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry: Prepared): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(VERSION, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(METHOD_DEFLATE, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  // extra length, comment length, disk number, internal and external attributes: all zero
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

/** Build a zip archive from `entries`, sorted by name. Duplicate names are rejected. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.length > MAX_U16) throw new ZipError(`Too many zip entries (${sorted.length}); zip64 is not supported.`);

  const parts: Buffer[] = [];
  const prepared: Prepared[] = [];
  let offset = 0;
  let previous: string | undefined;
  for (const entry of sorted) {
    if (entry.name === previous) throw new ZipError(`Duplicate zip entry: ${entry.name}`);
    previous = entry.name;
    const name = Buffer.from(entry.name, "utf8");
    if (name.length > MAX_U16) throw new ZipError(`Zip entry name too long: ${entry.name.slice(0, 80)}…`);
    const compressed = deflateRawSync(entry.data, { level: 6 });
    /* istanbul ignore if -- a 4 GiB fixture is not practical in a unit test; the guard keeps the 32-bit fields honest */
    if (entry.data.length > MAX_U32 || offset > MAX_U32) {
      throw new ZipError(`Zip archive exceeds 4 GiB at ${entry.name}; zip64 is not supported.`);
    }
    const item: Prepared = {
      name,
      flags: name.length === entry.name.length ? 0 : FLAG_UTF8,
      crc: crc32(entry.data),
      size: entry.data.length,
      compressed,
      offset,
    };
    const header = localHeader(item);
    parts.push(header, name, compressed);
    offset += header.length + name.length + compressed.length;
    prepared.push(item);
  }

  const centralOffset = offset;
  for (const item of prepared) {
    const header = centralHeader(item);
    parts.push(header, item.name);
    offset += header.length + item.name.length;
  }
  /* istanbul ignore if -- same as the per-entry 4 GiB guard above */
  if (offset > MAX_U32) throw new ZipError("Zip archive exceeds 4 GiB; zip64 is not supported.");

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(offset - centralOffset, 12);
  end.writeUInt32LE(centralOffset, 16);
  parts.push(end);
  return Buffer.concat(parts);
}
