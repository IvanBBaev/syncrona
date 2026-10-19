// SPDX-License-Identifier: GPL-3.0-or-later
//
// Golden tests for Now.attach(): the fixture project is an SDK 4.13 build probe.
// The SDK gzips with fflate, which stamps the current time into the header and
// deflates differently from zlib, so the chunk data, its sizes and the chunk ids
// (hashed from the data) are masked; everything else must match byte for byte,
// and the chunks must still unzip to the attached file.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { compileFluentProject } from "../../src/compiler/compile";
import { renderRecordUpdate } from "./xml";

const FIXTURE = path.join(__dirname, "../fixtures/attach");
const PROJECT = path.join(FIXTURE, "project");
const EXPECTED = path.join(FIXTURE, "expected/update");

/** Masks what depends on the gzip encoder: chunk ids, chunk data and the compressed size. */
function mask(xml: string): string {
  const docIds = new Set([...xml.matchAll(/<sys_update_name>sys_attachment_doc_([0-9a-f]{32})</g)].map((m) => m[1]));
  let masked = xml
    .replace(/<data>[^<]*<\/data>/g, "<data>*</data>")
    .replace(/<length>\d+<\/length>/g, "<length>*</length>")
    .replace(/<size_compressed>\d+<\/size_compressed>/g, "<size_compressed>*</size_compressed>");
  for (const id of docIds) masked = masked.split(id).join("<doc id>");
  return masked;
}

/** Each attachment's hash and the file its chunks unzip to, in document order. */
function attachments(xml: string): { hash: string; content: Buffer }[] {
  return [...xml.matchAll(/<sys_attachment action[\s\S]*?<sys_id>([0-9a-f]{32})<[\s\S]*?<hash>([0-9a-f]+)</g)].map(([, id, hash]) => {
    const chunks = [...xml.matchAll(/<sys_attachment_doc [\s\S]*?<data>([^<]*)<\/data>[\s\S]*?<sys_attachment>([0-9a-f]{32})</g)]
      .filter((m) => m[2] === id)
      .map((m) => Buffer.from(m[1], "base64"));
    return { hash, content: zlib.gunzipSync(Buffer.concat(chunks)) };
  });
}

describe("native compiler golden output: Now.attach() (SDK 4.13 probe)", () => {
  const result = compileFluentProject({ projectDir: PROJECT });
  const actual = new Map(result.records.map((r) => [r.path, renderRecordUpdate(r)]));
  const expected = new Map(fs.readdirSync(EXPECTED).map((file) => [`update/${file}`, fs.readFileSync(path.join(EXPECTED, file), "utf8")]));

  it("compiles without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the SDK's record updates apart from the gzip encoding", () => {
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, xml] of expected) expect(`${file}\n${mask(actual.get(file)!)}`).toBe(`${file}\n${mask(xml)}`);
  });

  it("writes chunks that unzip to the attached files", () => {
    const files = { dot: fs.readFileSync(path.join(PROJECT, "src/assets/dot.png")), big: fs.readFileSync(path.join(PROJECT, "src/assets/big.svg")) };
    for (const [file, xml] of expected) {
      const ours = attachments(actual.get(file)!);
      expect(ours).toEqual(attachments(xml));
      for (const { hash, content } of ours) {
        expect(hash).toBe(crypto.createHash("sha256").update(content).digest("hex"));
        expect([files.dot, files.big].some((f) => f.equals(content))).toBe(true);
      }
    }
  });

  it("writes keys.ts back unchanged", () => {
    expect(result.keysPath).toBe(path.join(PROJECT, "src/fluent/generated/keys.ts"));
    expect(result.keysText).toBe(fs.readFileSync(result.keysPath, "utf8"));
  });
});
