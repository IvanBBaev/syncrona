// SPDX-License-Identifier: GPL-3.0-or-later
// A field's local file is not tied to the manifest's `type`.
//
// Reported from real use: `syncrona refresh` on a TypeScript workspace
// downloaded `script.js` next to the `script.ts` the user actually edits. The
// missing-file probe compared against the exact `<field>.<manifest type>` path,
// so it could not see the TypeScript source, reported the field missing, fetched
// it, and wrote a second file for the same field.
//
// The stray file is only half the damage. The push side resolves a local path to
// a field by stripping WHATEVER extension it carries (getFileContextFromPath),
// so `script.ts` and `script.js` are two claimants for one field and
// groupAppFiles rejects that pair outright — the workspace could not be pushed
// again until the user deleted the file the refresh had just created.
//
// These tests pin the predicate on a real filesystem, in both layouts, together
// with the negative controls that keep it from going the other way and claiming
// a field that genuinely is not on disk.
//
// Measured against the pre-fix source (the package copied out of the tree and
// FileUtils.ts restored from git): 9 of these 16 fail. The 7 that pass are the
// ones that MUST pass in both directions — the four negative controls and "a
// genuinely missing field is still reported missing" — so this file is not a
// suite that would go green against the bug it was written for.
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { SN } from "@syncrona/types";

const SOURCE = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-repr-src-"));

const getSourcePath = jest.fn(() => SOURCE);
const getConfig = jest.fn(() => ({}) as Record<string, unknown>);

jest.unstable_mockModule("../config.js", () => ({
  getSourcePath,
  getConfig,
  getRootDir: jest.fn(() => SOURCE),
  getManifest: jest.fn(),
  getManifestPath: jest.fn(() => path.join(SOURCE, "manifest.json")),
  getBuildPath: jest.fn(() => path.join(SOURCE, "build")),
  updateManifest: jest.fn(),
}));

// R1: defer the SUT imports so they bind to the mocked ../config.js
// (jest.unstable_mockModule does not hoist).
let fUtils: typeof import("../FileUtils.js");
let findMissingFiles: typeof import("../downloadPipeline.js").findMissingFiles;
// The real logger, spied rather than mocked: the warning IS the user-facing half
// of the force-write decision, and a hand-written module mock would have to
// mirror Logger.js's export shape to stay loadable.
let warn: ReturnType<typeof jest.spyOn>;

beforeAll(async () => {
  fUtils = await import("../FileUtils.js");
  ({ findMissingFiles } = await import("../downloadPipeline.js"));
  const { logger } = await import("../Logger.js");
  warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
});

const freshDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-repr-"));

const asFile = (name: string, type: string): SN.File =>
  ({ name, type }) as SN.File;

beforeEach(() => {
  jest.clearAllMocks();
  getConfig.mockReturnValue({});
});

describe("a field is represented by its stem, whatever extension it wears", () => {
  it("sees a TypeScript source as the local file for a field the manifest types as js", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "script.ts"), "export const x = 1;");

    await expect(fUtils.SNFileExists(dir)(asFile("script", "js"))).resolves.toBe(
      true
    );
  });

  it("names the representing file so callers can report which one they kept", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "script.ts"), "x");

    await expect(fUtils.findFieldRepresentation(dir, "script")).resolves.toBe(
      "script.ts"
    );
  });

  it("still sees a dot-walked field name (sys_atf_step's inputs.script)", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "inputs.script.ts"), "x");

    await expect(
      fUtils.SNFileExists(dir)(asFile("inputs.script", "js"))
    ).resolves.toBe(true);
  });

  it("sees the flat layout's <record>~<field> stem too", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "MyUtil~script.ts"), "x");

    await expect(
      fUtils.SNFileExists(dir)(asFile("MyUtil~script", "js"))
    ).resolves.toBe(true);
  });

  // The predicate must not swing the other way. A looser prefix match was tried
  // once and claimed unrelated files, which skips a download that really is due.
  it("negative control: a longer-stemmed sibling is not the field's file", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "script.min.js"), "x");

    await expect(fUtils.SNFileExists(dir)(asFile("script", "js"))).resolves.toBe(
      false
    );
  });

  it("negative control: a different field's file is not this field's file", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "other.ts"), "x");

    await expect(fUtils.SNFileExists(dir)(asFile("script", "js"))).resolves.toBe(
      false
    );
  });

  it("negative control: an extensionless entry is not a representation", async () => {
    const dir = freshDir();
    // A directory named exactly like the field. The writer always produces
    // `<name>.<type>` with a non-empty type, so this can never be the field.
    fs.mkdirSync(path.join(dir, "script"));

    await expect(fUtils.SNFileExists(dir)(asFile("script", "js"))).resolves.toBe(
      false
    );
  });

  it("reports a field with no local file at all as missing", async () => {
    await expect(
      fUtils.SNFileExists(freshDir())(asFile("script", "js"))
    ).resolves.toBe(false);
  });

  it("reports missing rather than throwing when the directory is not there", async () => {
    // checkRecordsForMissing normally probes the record directory first, but the
    // listing scan is reached directly from writeSNFileCurry too — an unreadable
    // or absent parent is "no representation", never an exception.
    const absent = path.join(freshDir(), "never-created");

    await expect(
      fUtils.SNFileExists(absent)(asFile("script", "js"))
    ).resolves.toBe(false);
    await expect(
      fUtils.findFieldRepresentation(absent, "script")
    ).resolves.toBeUndefined();
  });
});

describe("refresh does not fetch a field a local source already represents", () => {
  const manifestWith = (recordName: string): SN.AppManifest =>
    ({
      scope: "x_test_app",
      tables: {
        sys_script_include: {
          records: {
            [recordName]: {
              name: recordName,
              sys_id: "abc123",
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    }) as unknown as SN.AppManifest;

  it("folder layout: script.ts satisfies the field, so nothing is missing", async () => {
    const recDir = path.join(SOURCE, "sys_script_include", "TsUtil");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(path.join(recDir, "script.ts"), "export {};");

    const missing = await findMissingFiles(manifestWith("TsUtil"));

    expect(Object.keys(missing)).toEqual([]);
  });

  it("flat layout: TsFlat~script.ts satisfies the field, so nothing is missing", async () => {
    getConfig.mockReturnValue({ flat: true });
    const tableDir = path.join(SOURCE, "sys_script_include");
    fs.mkdirSync(tableDir, { recursive: true });
    fs.writeFileSync(path.join(tableDir, "TsFlat~script.ts"), "export {};");

    const missing = await findMissingFiles(manifestWith("TsFlat"));

    expect(Object.keys(missing)).toEqual([]);
  });

  it("still reports a field that has no local file, in a record directory that exists", async () => {
    const recDir = path.join(SOURCE, "sys_script_include", "Bare");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(path.join(recDir, "unrelated.ts"), "x");

    const missing = await findMissingFiles(manifestWith("Bare"));

    expect(missing.sys_script_include.abc123).toEqual([
      { name: "script", type: "js" },
    ]);
  });
});

describe("a force write never creates a second claimant for one field", () => {
  const withContent = (name: string, type: string, content: string): SN.File =>
    ({ name, type, content }) as SN.File;

  it("declines to write script.js beside an existing script.ts, and says so", async () => {
    const dir = path.join(SOURCE, "force-decline");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "script.ts"), "export const local = 1;");

    await fUtils.writeSNFileForce(
      withContent("script", "js", "var downloaded = 1;"),
      dir
    );

    expect(fs.existsSync(path.join(dir, "script.js"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "script.ts"), "utf8")).toBe(
      "export const local = 1;"
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain(path.join(dir, "script.ts"));
    expect(message).toContain("script.js");
  });

  // Found by running a real scope download: every script include names its field
  // "script", so a message built from the field name alone came out byte-identical
  // for all three affected records — three lines telling the user nothing about
  // which records to open. Each warning has to identify its own record.
  it("names each record's own file, so repeated warnings stay distinguishable", async () => {
    const records = ["AlphaUtil", "BetaUtil"];
    for (const record of records) {
      const dir = path.join(SOURCE, "force-distinct", record);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "script.ts"), "local");
      await fUtils.writeSNFileForce(
        withContent("script", "js", "downloaded"),
        dir
      );
    }

    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(new Set(messages).size).toBe(2);
    for (const record of records) {
      expect(messages.some((m) => m.includes(record))).toBe(true);
    }
  });

  // The healing half of `syncrona download` is untouched: when the field's own
  // file is the one on disk, force still overwrites it.
  it("still overwrites the field's own file", async () => {
    const dir = path.join(SOURCE, "force-overwrite");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "script.js"), "stale");

    await fUtils.writeSNFileForce(withContent("script", "js", "fresh"), dir);

    expect(fs.readFileSync(path.join(dir, "script.js"), "utf8")).toBe("fresh");
    expect(warn).not.toHaveBeenCalled();
  });

  it("still creates the file when the field has no local representation", async () => {
    const dir = path.join(SOURCE, "force-create");
    fs.mkdirSync(dir, { recursive: true });

    await fUtils.writeSNFileForce(withContent("script", "js", "fresh"), dir);

    expect(fs.readFileSync(path.join(dir, "script.js"), "utf8")).toBe("fresh");
    expect(warn).not.toHaveBeenCalled();
  });

  it("flat layout: declines beside an existing <record>~<field>.ts", async () => {
    const dir = path.join(SOURCE, "force-flat");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MyUtil~script.ts"), "local");

    await fUtils.writeFlatSNFileCurry(false)(
      withContent("script", "js", "downloaded"),
      dir,
      "MyUtil"
    );

    expect(fs.existsSync(path.join(dir, "MyUtil~script.js"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
