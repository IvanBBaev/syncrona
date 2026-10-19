// SPDX-License-Identifier: GPL-3.0-or-later

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { CHUNK_SIZE, gzip } from "../../src/compiler/attachment";
import { compileFluentProject } from "../../src/compiler/compile";
import { compile, counter, fieldsOf, IMPORT, makeProject, messages } from "./helpers";

const PORTAL = (icon: string) => `Record({ $id: Now.ID['p'], table: 'sp_portal', data: { title: 'P', icon: ${icon} } })\n`;
const PNG = { "src/fluent/logo.png": "png", "src/fluent/UP.PNG": "PNG", "src/fluent/x.txt": "t", "src/fluent/x.Png": "p" };

describe("Now.attach()", () => {
  it.each([
    ["Now.attach()", "Now.attach() must have a string argument"],
    ["Now.attach(1)", "Now.attach() must have a string argument"],
    ["Now.attach('fluent/logo.png')", "Now.attach() argument must be a relative path"],
    ["Now.attach('./x.txt')", "Now.attach() takes an image file: .jpg, .jpeg, .png, .bmp, .gif, .ico, .svg."],
    ["Now.attach('./x.Png')", "Now.attach() takes an image file: .jpg, .jpeg, .png, .bmp, .gif, .ico, .svg."],
    ["Now.attach('./missing.png')", "File not found"],
  ])("rejects %s", (call, message) => {
    expect(messages(compile(PORTAL(call), PNG))).toEqual([message]);
  });

  it("rejects a file outside the project", () => {
    const [message] = messages(compile(PORTAL("Now.attach('../../../outside.png')"), PNG));
    expect(message).toMatch(/^File path is not within project: .*outside\.png$/);
  });

  it("accepts a bare file name and an upper-case extension", () => {
    const result = compile(PORTAL("Now.attach('logo.png')") + PORTAL("Now.attach('./UP.PNG')").replace("'p'", "'q'"), PNG);
    expect(messages(result)).toEqual([]);
    const [a, b] = result.records.map((r) => r.associated!.map(fieldsOf)[0]);
    expect([a.content_type, b.content_type]).toEqual(["image/png", "image/png"]);
    expect(a.hash).toBe(crypto.createHash("sha256").update("png").digest("hex"));
  });

  it("writes the attachment and its chunks after the record, one attachment per field", () => {
    const result = compile(`const logo = Now.attach('./logo.png')\nRecord({ $id: Now.ID['p'], table: 'sp_portal', data: { icon: logo, logo } })\n`, PNG);
    expect(messages(result)).toEqual([]);
    const [record] = result.records;
    const associated = record.associated!;
    expect(associated.map((r) => r.table)).toEqual(["sys_attachment", "sys_attachment_doc", "sys_attachment_doc", "sys_attachment", "sys_attachment_doc", "sys_attachment_doc"]);
    const [icon, , , logo] = associated;
    expect(fieldsOf(record)).toMatchObject({ icon: icon.sysId, logo: logo.sysId });
    expect(fieldsOf(icon)).toMatchObject({ file_name: "icon", table_name: "ZZ_YYsp_portal", table_sys_id: record.sysId, size_bytes: "3" });
    expect(fieldsOf(associated[1])).toMatchObject({ position: "0", length: "16", sys_attachment: icon.sysId });
    expect(associated.every((r) => fieldsOf(r).sys_update_name === `${r.table}_${r.sysId}`)).toBe(true);
  });

  it("splits a large file into chunks of CHUNK_SIZE base64 characters", () => {
    const content = crypto.randomBytes(800_000);
    const projectDir = makeProject({ "src/fluent/app.now.ts": IMPORT + PORTAL("Now.attach('./big.png')") });
    fs.writeFileSync(path.join(projectDir, "src/fluent/big.png"), content);
    const result = compileFluentProject({ projectDir, generateGuid: counter() });
    expect(messages(result)).toEqual([]);
    const [attachment, ...docs] = result.records[0].associated!.map(fieldsOf);
    expect(docs.map((d) => [d.position, d.length])).toEqual([["0", "16"], ["1", String(CHUNK_SIZE)], ["2", expect.any(String)]]);
    const compressed = Buffer.concat(docs.map((d) => Buffer.from(d.data!, "base64")));
    expect(attachment.size_compressed).toBe(String(compressed.length));
    expect(zlib.gunzipSync(compressed).equals(content)).toBe(true);
    expect(compressed.equals(gzip(content))).toBe(true);
    expect([...compressed.subarray(4, 10)]).toEqual([0, 0, 0, 0, 0, 3]);
  });
});
