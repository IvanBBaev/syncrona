// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

// INJ-1, the per-FILE half of the download write seam.
//
// processTablesInManifest validated the TABLE name and the RECORD name, but the
// per-file `name` and `type` were passed through untouched even though both are
// interpolated into `<name>.<type>` and joined onto the record (or table)
// directory by the writer. The containment guard inside writeSNFileCurry anchors
// at the workspace SOURCE ROOT, not at the record's own folder, so a ".." inside
// a field name stays inside the source root and passes the guard while landing
// on a DIFFERENT record's file. The directory pool has already created every
// record folder by then, so the write succeeds; the victim record's own write is
// then silently skipped (checkExists is on unless --force), and a later
// `syncrona push` uploads the attacker's payload into the victim's field.
//
// These suites drive the real seam against a real filesystem (config and Logger
// mocked, network modules stubbed) so both layouts and both interpolated fields
// are covered.

const getManifest = jest.fn();
const getConfig = jest.fn();
const getSourcePath = jest.fn();
const getManifestPath = jest.fn();
const getBuildPath = jest.fn(() => "/tmp/build");
const updateManifest = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getManifest,
  getConfig,
  getSourcePath,
  getManifestPath,
  getBuildPath,
  updateManifest,
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    silly: jest.fn(),
    getLogLevel: jest.fn(() => "warn"),
  },
}));

// The pipeline imports the transport and the Table-API builder at module load;
// nothing in these tests reaches them, but the module graph must still resolve.
jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({}),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) =>
    (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  // DX22: the scoped-manifest enrichment is a no-op for these suites — they
  // assert on the manifest they hand in, not on the metadata layer.
  attachMetaFieldsToManifest: jest.fn(async (manifest: unknown) => manifest),
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(),
  isScopedEndpointUnavailableError: () => false,
  ManifestRecordNames: jest.fn(),
}));

jest.unstable_mockModule("../downloadCheckpoint.js", () => ({
  DownloadCheckpoint: jest.fn(),
  readDownloadCheckpoint: jest.fn(async () => null),
  writeDownloadCheckpoint: jest.fn(async () => undefined),
  deleteDownloadCheckpoint: jest.fn(async () => undefined),
}));

const PAYLOAD = "gs.eval('attacker');\n";
const VICTIM = "var bar = 1;\n";

// path.join() normalizes as it builds, which would collapse the very `x/..`
// sequences these fixtures depend on. Join the segments raw instead — a tampered
// manifest is a JSON string, not something Node normalized on the way in.
const rawPath = (...segments: string[]): string => segments.join(path.sep);

let TMP_ROOT: string;
let srcPath: string;

const readIfPresent = (p: string): string | undefined =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;

beforeEach(() => {
  jest.clearAllMocks();
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-inj1-"));
  srcPath = path.join(TMP_ROOT, "src");
  fs.mkdirSync(srcPath, { recursive: true });
  getSourcePath.mockReturnValue(srcPath);
  getManifestPath.mockReturnValue(path.join(TMP_ROOT, "manifest.json"));
  // writeConcurrency 1 makes the exploit deterministic: the attacker record is
  // ordered first, so with the hole open it wins the race to the victim's path
  // and the victim's own write is then skipped as "already present".
  getConfig.mockReturnValue({ writeConcurrency: 1 });
});

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("INJ-1 — an unsafe file name relocates the write onto a sibling record", () => {
  it("refuses a folder-layout field name that walks into another record's directory", async () => {
    const { processTablesInManifest } = await import("../downloadPipeline.js");
    const tables: SN.TableMap = {
      sys_script_include: {
        records: {
          foo: {
            name: "Foo",
            sys_id: "sysFoo",
            files: [
              // Escapes Foo's own folder and lands on Bar's real field file.
              {
                name: path.join("..", "Bar", "script"),
                type: "js",
                content: PAYLOAD,
              },
            ],
          },
          bar: {
            name: "Bar",
            sys_id: "sysBar",
            files: [{ name: "script", type: "js", content: VICTIM }],
          },
        },
      },
    } as unknown as SN.TableMap;

    await expect(processTablesInManifest(tables, false)).rejects.toThrow(
      /unsafe field name/
    );

    // Whatever the seam decided, the payload must never reach Bar's file.
    const barPath = path.join(srcPath, "sys_script_include", "Bar", "script.js");
    expect(readIfPresent(barPath)).not.toBe(PAYLOAD);
  });

  it("refuses a flat-layout field name that walks into another table's directory", async () => {
    getConfig.mockReturnValue({ flat: true, writeConcurrency: 1 });
    const { processTablesInManifest } = await import("../downloadPipeline.js");
    // Flat mode prefixes the record name onto the stem, so the traversal has to
    // start with a harmless segment; `x/../../<table>` still climbs out of the
    // attacker's table directory and onto a sibling table's flat file.
    const tables: SN.TableMap = {
      sys_script_include: {
        records: {
          foo: {
            name: "Foo",
            sys_id: "sysFoo",
            files: [
              {
                name: rawPath("x", "..", "..", "sys_script", "Bar~script"),
                type: "js",
                content: PAYLOAD,
              },
            ],
          },
        },
      },
      sys_script: {
        records: {
          bar: {
            name: "Bar",
            sys_id: "sysBar",
            files: [{ name: "script", type: "js", content: VICTIM }],
          },
        },
      },
    } as unknown as SN.TableMap;

    await expect(processTablesInManifest(tables, false)).rejects.toThrow(
      /unsafe field name/
    );

    const barPath = path.join(srcPath, "sys_script", "Bar~script.js");
    expect(readIfPresent(barPath)).not.toBe(PAYLOAD);
  });

  it("refuses a file type that carries a path separator", async () => {
    const { processTablesInManifest } = await import("../downloadPipeline.js");
    const tables: SN.TableMap = {
      sys_script_include: {
        records: {
          foo: {
            name: "Foo",
            sys_id: "sysFoo",
            files: [
              // `${name}.${type}` becomes "script.js/../../Bar/script.js".
              {
                name: "script",
                type: rawPath("js", "..", "..", "Bar", "script.js"),
                content: PAYLOAD,
              },
            ],
          },
          bar: {
            name: "Bar",
            sys_id: "sysBar",
            files: [{ name: "script", type: "js", content: VICTIM }],
          },
        },
      },
    } as unknown as SN.TableMap;

    await expect(processTablesInManifest(tables, false)).rejects.toThrow(
      /unsafe file type/
    );

    const barPath = path.join(srcPath, "sys_script_include", "Bar", "script.js");
    expect(readIfPresent(barPath)).not.toBe(PAYLOAD);
  });

  it("still writes legitimate dot-walked field names in both layouts", async () => {
    const { processTablesInManifest } = await import("../downloadPipeline.js");
    const tables = (): SN.TableMap =>
      ({
        sys_atf_step: {
          records: {
            step: {
              name: "Step One",
              sys_id: "sysS",
              files: [
                { name: "inputs.script", type: "js", content: "atf();\n" },
              ],
            },
          },
        },
      }) as unknown as SN.TableMap;

    await processTablesInManifest(tables(), false);
    expect(
      fs.readFileSync(
        path.join(srcPath, "sys_atf_step", "Step One", "inputs.script.js"),
        "utf8"
      )
    ).toBe("atf();\n");

    getConfig.mockReturnValue({ flat: true, writeConcurrency: 1 });
    await processTablesInManifest(tables(), false);
    expect(
      fs.readFileSync(
        path.join(srcPath, "sys_atf_step", "Step One~inputs.script.js"),
        "utf8"
      )
    ).toBe("atf();\n");
  });
});

describe("INJ-1 — writeSNFileCurry is the chokepoint", () => {
  it("rejects an unsafe name even when the resulting path stays inside the source root", async () => {
    const { writeSNFileCurry } = await import("../FileUtils.js");
    const recordDir = path.join(srcPath, "sys_script_include", "Foo");
    const victimDir = path.join(srcPath, "sys_script_include", "Bar");
    fs.mkdirSync(recordDir, { recursive: true });
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, "script.js"), VICTIM);

    await expect(
      writeSNFileCurry(false)(
        {
          name: path.join("..", "Bar", "script"),
          type: "js",
          content: PAYLOAD,
        } as SN.File,
        recordDir
      )
    ).rejects.toThrow(/unsafe/);
    expect(fs.readFileSync(path.join(victimDir, "script.js"), "utf8")).toBe(
      VICTIM
    );
  });

  it("accepts the composed flat name and a dot-walked field name", async () => {
    const { writeSNFileCurry, writeFlatSNFileCurry } = await import(
      "../FileUtils.js"
    );
    const tableDir = path.join(srcPath, "sys_atf_step");
    fs.mkdirSync(tableDir, { recursive: true });

    await writeFlatSNFileCurry(false)(
      { name: "inputs.script", type: "js", content: "flat\n" } as SN.File,
      tableDir,
      "Step One"
    );
    expect(
      fs.readFileSync(path.join(tableDir, "Step One~inputs.script.js"), "utf8")
    ).toBe("flat\n");

    await writeSNFileCurry(false)(
      { name: "inputs.script", type: "js", content: "nested\n" } as SN.File,
      tableDir
    );
    expect(
      fs.readFileSync(path.join(tableDir, "inputs.script.js"), "utf8")
    ).toBe("nested\n");
  });
});
