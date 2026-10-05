// SPDX-License-Identifier: GPL-3.0-or-later
//
// SDK-F2: `repair` refuses a workspace that mixes the two data-model layouts
// before it computes anything, and names document entries no manifest record
// claims. A document is never an orphan file.
import { jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { SN } from "@syncrona/types";

let src: string;
let config: Record<string, unknown> | undefined;
let manifest: SN.AppManifest;
const findMissingFiles = jest.fn();
const processMissingFiles = jest.fn();
const error = jest.fn();
const warn = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getManifest: () => manifest,
  getSourcePath: () => src,
  getRootDir: () => path.dirname(src),
  getConfig: () => {
    if (!config) throw new Error("no config loaded");
    return config;
  },
}));
jest.unstable_mockModule("../appUtils.js", () => ({
  findMissingFiles: (...a: unknown[]) => findMissingFiles(...a),
  processMissingFiles: (...a: unknown[]) => processMissingFiles(...a),
}));
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    debug: jest.fn(),
    warn: (...a: unknown[]) => warn(...a),
    error: (...a: unknown[]) => error(...a),
    setLogLevel: jest.fn(),
    getLogLevel: () => "info",
  },
}));

let repairCommand: typeof import("../repairCommand.js").repairCommand;

const DOC = {
  format: "syncrona.data-model/1",
  table: "x_t",
  sys_dictionary: { "x_t.u_a": { element: "u_a", name: "x_t" }, "x_t.u_new": { element: "u_new", name: "x_t" } },
};

beforeAll(async () => {
  ({ repairCommand } = await import("../repairCommand.js"));
});

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  src = path.join(mkdtempSync(path.join(os.tmpdir(), "sdk-f2-repair-")), "src");
  mkdirSync(path.join(src, "data-model"), { recursive: true });
  writeFileSync(path.join(src, "data-model", "x_t.json"), JSON.stringify(DOC));
  config = { dataModelLayout: "composite", dataModelTables: ["sys_dictionary"] };
  manifest = {
    scope: "x_t",
    tables: {
      sys_dictionary: {
        records: { "x_t.u_a": { name: "x_t.u_a", sys_id: "d1", files: [{ name: ".meta", type: "json" }] } },
      },
    },
  } as unknown as SN.AppManifest;
  findMissingFiles.mockResolvedValue({});
});

afterEach(() => {
  rmSync(path.dirname(src), { recursive: true, force: true });
  process.exitCode = undefined;
});

it("warns about an entry no manifest record claims, and does not call the document an orphan", async () => {
  await repairCommand({ logLevel: "info" } as never);
  expect(process.exitCode).toBeUndefined();
  expect(error).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(/^1 data-model document entry no manifest record claims[\s\S]*"x_t.u_new"/)
  );
  expect(findMissingFiles).toHaveBeenCalled();
});

it("refuses a workspace holding both layouts and runs nothing else", async () => {
  const stale = path.join(src, "sys_dictionary", "x_t.u_a");
  mkdirSync(stale, { recursive: true });
  writeFileSync(path.join(stale, ".meta.json"), "{}\n");
  await repairCommand({ logLevel: "info", apply: true } as never);
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringMatching(/^Data-model layout conflict \(dataModelLayout "composite"\)[\s\S]*both layouts/)
  );
  expect(findMissingFiles).not.toHaveBeenCalled();
  expect(processMissingFiles).not.toHaveBeenCalled();
});

it("refuses documents under the records layout, also when no config is loaded", async () => {
  config = { dataModelTables: ["sys_dictionary"] };
  await repairCommand({ logLevel: "info" } as never);
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('dataModelLayout "records"'));
  jest.clearAllMocks();
  process.exitCode = undefined;
  config = undefined;
  await repairCommand({ logLevel: "info" } as never);
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('dataModelLayout "records"'));
});
