// SPDX-License-Identifier: GPL-3.0-or-later
//
// Edge shapes for findWithdrawnFieldFiles: hand-edited manifests with missing
// `tables` / `records` / `files`, null entries, records that moved sys_id,
// unsafe table or record names, and a record folder that is not on disk.
// Real fs, only under os.tmpdir().
import { jest } from "@jest/globals";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { SN } from "@syncrona/types";

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
  },
}));

const { findWithdrawnFieldFiles } = await import("../withdrawnFieldFiles.js");

const TABLE = "x_demo_cred";
const asManifest = (raw: unknown) => raw as SN.AppManifest;
const withTable = (table: unknown, name = TABLE) =>
  asManifest({ scope: "x_demo", tables: { [name]: table } });

const BOTH = [
  { name: "script", type: "js" },
  { name: "u_token", type: "txt" },
];
const SCRIPT_ONLY = [{ name: "script", type: "js" }];
const credBefore = (tableName = TABLE) =>
  withTable({ records: { Cred: { name: "Cred", sys_id: "c1", files: BOTH } } }, tableName);
const credAfter = (tableName = TABLE) =>
  withTable({ records: { Cred: { name: "Cred", sys_id: "c1", files: SCRIPT_ONLY } } }, tableName);

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "withdrawn-edges-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const write = async (rel: string, content = "x") => {
  const target = path.join(root, rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
  return target;
};

describe("findWithdrawnFieldFiles: missing manifest sections", () => {
  it("reports nothing when either manifest has no tables section", async () => {
    await write(`${TABLE}/Cred/u_token.txt`);
    const bare = asManifest({ scope: "x_demo" });

    expect(await findWithdrawnFieldFiles(credBefore(), bare, root, false)).toEqual([]);
    expect(await findWithdrawnFieldFiles(bare, credAfter(), root, false)).toEqual([]);
  });

  it("reports nothing for a table whose new entry has no records, or whose old entry is null", async () => {
    await write(`${TABLE}/Cred/u_token.txt`);

    expect(await findWithdrawnFieldFiles(credBefore(), withTable({}), root, false)).toEqual([]);
    expect(await findWithdrawnFieldFiles(credBefore(), withTable(null), root, false)).toEqual([]);
    expect(await findWithdrawnFieldFiles(withTable(null), credAfter(), root, false)).toEqual([]);
  });

  it("ignores null records and records without a string sys_id on either side", async () => {
    await write(`${TABLE}/Cred/u_token.txt`);
    const previous = withTable({
      records: { Gone: null, Cred: { name: "Cred", sys_id: "c1", files: BOTH } },
    });
    const next = withTable({
      records: {
        Gone: null,
        Numeric: { name: "Cred", sys_id: 7, files: [] },
        Cred: { name: "Cred", sys_id: "c2", files: SCRIPT_ONLY },
      },
    });

    // c1 is not in the new manifest (c2 replaced it): a different event, left to repair.
    expect(await findWithdrawnFieldFiles(previous, next, root, false)).toEqual([]);
  });

  it("treats a missing new files list as every field withdrawn, and a missing old one as none", async () => {
    const script = await write(`${TABLE}/Cred/script.js`);
    const token = await write(`${TABLE}/Cred/u_token.txt`);
    const nextNoFiles = withTable({ records: { Cred: { name: "Cred", sys_id: "c1" } } });

    const found = await findWithdrawnFieldFiles(credBefore(), nextNoFiles, root, false);
    expect([...found].sort()).toEqual([script, token].sort());

    const previousNoFiles = withTable({ records: { Cred: { name: "Cred", sys_id: "c1" } } });
    expect(await findWithdrawnFieldFiles(previousNoFiles, nextNoFiles, root, false)).toEqual([]);
  });
});

describe("findWithdrawnFieldFiles: folder names", () => {
  it("falls back to the record key when the new record has no name", async () => {
    const stale = await write(`${TABLE}/CredKey/u_token.txt`);
    const next = withTable({ records: { CredKey: { name: "", sys_id: "c1", files: SCRIPT_ONLY } } });

    expect(await findWithdrawnFieldFiles(credBefore(), next, root, false)).toEqual([stale]);
  });

  it("never looks under an unsafe table name", async () => {
    // The file a traversal would reach if `..` were joined unchecked
    // (<source>/../Cred with <source> = <root>/nested).
    await write("Cred/u_token.txt");
    const source = path.join(root, "nested");

    expect(await findWithdrawnFieldFiles(credBefore(".."), credAfter(".."), source, false)).toEqual(
      []
    );
  });

  it("never looks under an unsafe record name", async () => {
    // The file a traversal would reach if the record name `..` were joined unchecked.
    // (<source>/x_demo_cred/.. is <source> itself.)
    await write("nested/u_token.txt");
    const next = withTable({ records: { Cred: { name: "..", sys_id: "c1", files: SCRIPT_ONLY } } });

    expect(await findWithdrawnFieldFiles(credBefore(), next, path.join(root, "nested"), false)).toEqual(
      []
    );
    // Sanity: the same manifest pair finds the file when the name is safe.
    await write(`${TABLE}/Cred/u_token.txt`);
    expect(await findWithdrawnFieldFiles(credBefore(), credAfter(), root, false)).toHaveLength(1);
  });

  it("reports nothing when the record folder is not on disk at all", async () => {
    expect(await findWithdrawnFieldFiles(credBefore(), credAfter(), root, false)).toEqual([]);
    expect(await findWithdrawnFieldFiles(credBefore(), credAfter(), root, true)).toEqual([]);
  });

  it("does not take an extensionless entry for the field's file", async () => {
    await write(`${TABLE}/Cred/u_token`);

    expect(await findWithdrawnFieldFiles(credBefore(), credAfter(), root, false)).toEqual([]);
  });
});
