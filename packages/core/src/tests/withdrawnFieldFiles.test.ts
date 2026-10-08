// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { SN } from "@syncrona/types";

// 17c: a column the `includes` type filter now drops (or one taken out of
// `includes`) leaves the value file an earlier version wrote on disk. Nothing
// syncs it any more, and it may hold a credential, so the refresh must say so
// once — naming the files — and must never delete them itself.

const loggerWarn = jest.fn();
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
  },
}));

const { findWithdrawnFieldFiles, warnWithdrawnFieldFiles } = await import(
  "../withdrawnFieldFiles.js"
);

const record = (name: string, sysId: string, files: SN.File[]) => ({
  name,
  sys_id: sysId,
  files,
});

const manifest = (records: Record<string, ReturnType<typeof record>>): SN.AppManifest =>
  ({
    scope: "x_demo",
    tables: { x_demo_cred: { records } },
  }) as unknown as SN.AppManifest;

const BEFORE = manifest({
  Cred: record("Cred", "c1", [
    { name: "script", type: "js" },
    { name: "u_token", type: "txt" },
  ] as SN.File[]),
});
const AFTER = manifest({
  Cred: record("Cred", "c1", [{ name: "script", type: "js" }] as SN.File[]),
});

let root: string;

beforeEach(async () => {
  loggerWarn.mockClear();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "withdrawn-fields-"));
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

describe("17c findWithdrawnFieldFiles", () => {
  it("names the value file of a field the new manifest no longer lists", async () => {
    await write("x_demo_cred/Cred/script.js");
    const stale = await write("x_demo_cred/Cred/u_token.txt", "s3cr3t");

    expect(await findWithdrawnFieldFiles(BEFORE, AFTER, root, false)).toEqual([stale]);
  });

  it("finds the flat-layout file `<record>~<field>.<ext>`", async () => {
    await write("x_demo_cred/Cred~script.js");
    const stale = await write("x_demo_cred/Cred~u_token.txt");

    expect(await findWithdrawnFieldFiles(BEFORE, AFTER, root, true)).toEqual([stale]);
  });

  it("finds the file under the extension the workspace edits it in", async () => {
    const stale = await write("x_demo_cred/Cred/u_token.ts");

    expect(await findWithdrawnFieldFiles(BEFORE, AFTER, root, false)).toEqual([stale]);
  });

  it("looks for the record at its new folder name (matched by sys_id)", async () => {
    const renamed = manifest({
      "Cred Renamed": record("Cred Renamed", "c1", [{ name: "script", type: "js" }] as SN.File[]),
    });
    const stale = await write("x_demo_cred/Cred Renamed/u_token.txt");

    expect(await findWithdrawnFieldFiles(BEFORE, renamed, root, false)).toEqual([stale]);
  });

  it("reports nothing when the withdrawn field never reached the disk", async () => {
    await write("x_demo_cred/Cred/script.js");

    expect(await findWithdrawnFieldFiles(BEFORE, AFTER, root, false)).toEqual([]);
  });

  it("leaves a whole record or table that left the manifest to repair", async () => {
    await write("x_demo_cred/Cred/u_token.txt");
    const gone = { scope: "x_demo", tables: {} } as unknown as SN.AppManifest;

    expect(await findWithdrawnFieldFiles(BEFORE, gone, root, false)).toEqual([]);
  });

  it("never reports the metadata sidecar", async () => {
    const withMeta = manifest({
      Cred: record("Cred", "c1", [
        { name: "script", type: "js" },
        { name: ".meta", type: "json" },
      ] as SN.File[]),
    });
    await write("x_demo_cred/Cred/.meta.json", "{}");

    expect(await findWithdrawnFieldFiles(withMeta, AFTER, root, false)).toEqual([]);
  });

  it("skips a manifest name that is not a safe path segment", async () => {
    const hostile = manifest({
      Cred: record("Cred", "c1", [
        { name: "script", type: "js" },
        { name: "../../outside", type: "txt" },
      ] as SN.File[]),
    });
    await write("outside.txt");

    expect(await findWithdrawnFieldFiles(hostile, AFTER, root, false)).toEqual([]);
  });
});

describe("17c warnWithdrawnFieldFiles", () => {
  it("warns once, naming the stale files, and deletes nothing", async () => {
    const stale = await write("x_demo_cred/Cred/u_token.txt", "s3cr3t");

    await warnWithdrawnFieldFiles(BEFORE, AFTER, { sourcePath: root, flat: false });

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const message = String(loggerWarn.mock.calls[0][0]);
    expect(message).toContain(stale);
    expect(message).toMatch(/no longer synced/);
    expect(message).toMatch(/can be deleted/);
    expect(message).toMatch(/syncrona repair/);
    expect(await fsp.readFile(stale, "utf8")).toBe("s3cr3t");
  });

  it("stays silent when nothing was withdrawn", async () => {
    await write("x_demo_cred/Cred/u_token.txt");

    await warnWithdrawnFieldFiles(BEFORE, BEFORE, { sourcePath: root, flat: false });

    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("does not repeat on the next run, whose old manifest no longer lists the field", async () => {
    await write("x_demo_cred/Cred/u_token.txt");

    await warnWithdrawnFieldFiles(AFTER, AFTER, { sourcePath: root, flat: false });

    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("does nothing without a previous manifest or across scopes", async () => {
    await write("x_demo_cred/Cred/u_token.txt");

    await warnWithdrawnFieldFiles(undefined, AFTER, { sourcePath: root, flat: false });
    await warnWithdrawnFieldFiles(
      BEFORE,
      { ...AFTER, scope: "x_other" },
      { sourcePath: root, flat: false }
    );

    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("never fails the caller when the workspace cannot be read", async () => {
    await expect(
      warnWithdrawnFieldFiles(BEFORE, AFTER, () => {
        throw new Error("no config loaded");
      })
    ).resolves.toBeUndefined();
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});
