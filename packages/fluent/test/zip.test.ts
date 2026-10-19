// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, createZip, ZipError } from "../src/zip";
import { readZip } from "./helpers/zipReader";

const text = (s: string) => Buffer.from(s, "utf8");

describe("crc32", () => {
  it("matches the IEEE check value", () => {
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("createZip", () => {
  const entries = [
    { name: "/update/b.xml", data: text("<b/>".repeat(100)) },
    { name: "/package_inventory.csv", data: text("#build=x\n") },
    { name: "/scope/ä.xml", data: text("utf8 name") },
    { name: "/empty", data: new Uint8Array() },
  ];

  it("round-trips sorted entries with fixed metadata", () => {
    const read = readZip(createZip(entries));
    expect(read.map((e) => e.name)).toEqual(["/empty", "/package_inventory.csv", "/scope/ä.xml", "/update/b.xml"]);
    expect(read.map((e) => e.data.toString("utf8"))).toEqual(["", "#build=x\n", "utf8 name", "<b/>".repeat(100)]);
    for (const e of read) {
      expect(e).toMatchObject({ method: 8, versionMadeBy: 20, time: 0, date: 0x21, extraLength: 0 });
      expect(e.crc).toBe(crc32(e.data));
    }
    expect(read.map((e) => e.flags)).toEqual([0, 0, 0x0800, 0]);
  });

  it("is byte-identical across runs and input orders", () => {
    expect(createZip(entries).equals(createZip([...entries].reverse()))).toBe(true);
  });

  it("writes an empty archive", () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("is accepted by the system unzip", () => {
    const dir = mkdtempSync(join(tmpdir(), "syncrona-zip-"));
    try {
      const file = join(dir, "a.zip");
      writeFileSync(file, createZip(entries));
      let out: string;
      try {
        out = execFileSync("unzip", ["-tq", file], { encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // no unzip on this runner
        throw error;
      }
      expect(out).toMatch(/No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicates, over-long names and too many entries", () => {
    expect(() => createZip([entries[0], { ...entries[0] }])).toThrow(new ZipError("Duplicate zip entry: /update/b.xml"));
    expect(() => createZip([{ name: "n".repeat(0x10000), data: new Uint8Array() }])).toThrow(/name too long/);
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: String(i), data: new Uint8Array() }));
    expect(() => createZip(many)).toThrow(/Too many zip entries \(65536\)/);
  });
});
