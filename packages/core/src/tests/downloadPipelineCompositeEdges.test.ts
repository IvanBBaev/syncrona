// SPDX-License-Identifier: GPL-3.0-or-later
//
// SDK-F2 edge cases of the composite data-model layout in downloadPipeline that
// dataModelCompositeFlow leaves out: a sidecar that arrived empty or without
// content (written nowhere, in either layout), and the refresh reconciliation
// for a configured table the manifest does not list, a record without a
// sidecar, a record whose manifest name is empty, a table that keeps another
// missing record after one is found in its document, and a stale per-record
// sidecar the document does not hold. Real FileUtils on a temp workspace; only
// config, the logger and the instance client are mocked.
import { jest } from "@jest/globals";
import { promises as fsp, mkdtempSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { SN } from "@syncrona/types";

let root: string;
let src: string;
let config: Record<string, unknown>;

jest.unstable_mockModule("../config.js", () => ({
  getConfig: () => config,
  getSourcePath: () => src,
  getBuildPath: () => path.join(root, "build"),
  getRootDir: () => root,
  getManifest: () => undefined,
  getManifestPath: () => path.join(root, "syncrona.manifest.json"),
  updateManifest: jest.fn(),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getLogLevel: () => "info",
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({}),
  retryOnErr: (task: () => unknown) => task(),
  processPushResponse: jest.fn(),
  getErrorResponseStatus: () => undefined,
  isRetryableRequestError: () => false,
  SNClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

const { processTablesInManifest, findMissingFiles } = await import("../downloadPipeline.js");

const ALL = ["sys_db_object", "sys_dictionary", "sys_choice"];
const COLUMN = { column_label: "Foo", element: "u_foo", name: "x_demo_task" };

const sidecar = (columns: Record<string, string>) =>
  `${JSON.stringify(
    Object.fromEntries(Object.keys(columns).sort().map((k) => [k, columns[k]])),
    null,
    2
  )}\n`;
const record = (name: string, sysId: string, files: SN.File[]) => ({ name, sys_id: sysId, files });
const metaWith = (content?: string): SN.File =>
  ({ name: ".meta", type: "json", ...(content !== undefined ? { content } : {}) }) as SN.File;
const calculation = (content?: string): SN.File =>
  ({ name: "calculation", type: "js", ...(content !== undefined ? { content } : {}) }) as SN.File;

const docPath = () => path.join(src, "data-model", "x_demo_task.json");
const recordDir = (name: string) => path.join(src, "sys_dictionary", name);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "sdk-f2-edges-"));
  src = path.join(root, "src");
  config = { dataModelLayout: "composite", dataModelTables: ALL, tableOptions: {} };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("composite download of a sidecar with nothing to merge", () => {
  it("writes neither a document nor a per-record sidecar for an empty sidecar", async () => {
    await processTablesInManifest(
      {
        sys_dictionary: {
          records: { "x_demo_task.u_foo": record("x_demo_task.u_foo", "d1", [metaWith("")]) },
        },
      } as unknown as SN.TableMap,
      true
    );
    expect(existsSync(docPath())).toBe(false);
    // A composite table whose records carry only metadata gets no directory.
    expect(existsSync(path.join(src, "sys_dictionary"))).toBe(false);
  });

  it.each([
    ["nested", false, (f: string) => path.join(recordDir("x_demo_task.u_foo"), f)],
    ["flat", true, (f: string) => path.join(src, "sys_dictionary", `x_demo_task.u_foo~${f}`)],
  ])(
    "skips a content-less sidecar but still writes the record's other fields (%s layout)",
    async (_layout, flat, fileAt) => {
      config.flat = flat;
      await processTablesInManifest(
        {
          sys_dictionary: {
            records: {
              "x_demo_task.u_foo": record("x_demo_task.u_foo", "d1", [
                metaWith(),
                calculation("current.u_foo;"),
              ]),
            },
          },
        } as unknown as SN.TableMap,
        true
      );
      expect(await fsp.readFile(fileAt("calculation.js"), "utf8")).toBe("current.u_foo;");
      expect(existsSync(fileAt(".meta.json"))).toBe(false);
      expect(existsSync(docPath())).toBe(false);
    }
  );
});

describe("composite reconciliation in findMissingFiles", () => {
  it("clears held sidecars, keeps the table for a record still missing, and ignores what it cannot judge", async () => {
    // The document holds u_foo only.
    await processTablesInManifest(
      {
        sys_dictionary: {
          records: {
            "x_demo_task.u_foo": record("x_demo_task.u_foo", "d1", [metaWith(sidecar(COLUMN))]),
          },
        },
      } as unknown as SN.TableMap,
      true
    );
    expect(existsSync(docPath())).toBe(true);

    const manifest = {
      scope: "x_demo",
      tables: {
        // sys_choice is configured as composite but this manifest lists none.
        sys_dictionary: {
          records: {
            // Empty name: the document entry is looked up by the manifest key.
            "x_demo_task.u_foo": record("", "d1", [metaWith()]),
            // Not in the document: its sidecar stays missing.
            "x_demo_task.u_bar": record("x_demo_task.u_bar", "d2", [metaWith()]),
            // No sidecar at all: only its field file is judged.
            "x_demo_task.u_calc": record("x_demo_task.u_calc", "d3", [calculation()]),
          },
        },
      },
    } as unknown as SN.AppManifest;

    const missing = await findMissingFiles(manifest);
    expect(missing).toEqual({
      sys_dictionary: {
        d2: [{ name: ".meta", type: "json" }],
        d3: [{ name: "calculation", type: "js" }],
      },
    });
  });

  it("reports the sidecar missing when only a stale per-record file holds it", async () => {
    // Left over from the records layout: on disk, but not in any document, so
    // under the composite layout the record's metadata is not actually present.
    await fsp.mkdir(recordDir("x_demo_task.u_foo"), { recursive: true });
    await fsp.writeFile(path.join(recordDir("x_demo_task.u_foo"), ".meta.json"), sidecar(COLUMN));
    await fsp.writeFile(path.join(recordDir("x_demo_task.u_foo"), "calculation.js"), "x");

    const missing = await findMissingFiles({
      scope: "x_demo",
      tables: {
        sys_dictionary: {
          records: {
            "x_demo_task.u_foo": record("x_demo_task.u_foo", "d1", [metaWith(), calculation()]),
          },
        },
      },
    } as unknown as SN.AppManifest);
    expect(missing).toEqual({ sys_dictionary: { d1: [{ name: ".meta", type: "json" }] } });
  });
});
