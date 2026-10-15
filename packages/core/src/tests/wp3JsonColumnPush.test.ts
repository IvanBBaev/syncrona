// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP3, push half: a `.json` field file goes back in the form download read it
// in, a file that is not JSON fails the build, and a generated UI Builder
// snapshot is never pushed.
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";
export {};

const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const updateRecord = jest.fn();
const getFinalFileContents = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
}));

jest.unstable_mockModule("../PluginManager.js", () => ({
  default: {
    getFinalFileContents: (...args: unknown[]) => getFinalFileContents(...args),
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({ updateRecord }),
  retryOnErr: (task: () => unknown) => task(),
  processPushResponse: (_res: unknown, summary: string) => ({
    success: true,
    message: `${summary} pushed`,
  }),
  getErrorResponseStatus: () => undefined,
  isRetryableRequestError: () => false,
  SNClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

let pushFiles: typeof import("../pushPipeline.js").pushFiles;

const COMPOSITION = { root: { component: "now-heading" }, items: [1, 2] };
const COMPOSITION_PATH = "/proj/src/sys_ux_macroponent/Home/composition.json";
const SCRIPT_PATH = "/proj/src/sys_ux_macroponent/Home/script.js";

const ctx = (filePath: string, ext: string, targetField: string, table: string) =>
  ({
    filePath,
    ext,
    name: "Home",
    scope: "x_demo",
    sys_id: "rec-1",
    tableName: table,
    targetField,
  }) as Sync.FileContext;

const record = (table = "sys_ux_macroponent"): Sync.BuildableRecord => ({
  table,
  sysId: "rec-1",
  fields: {
    composition: ctx(COMPOSITION_PATH, ".json", "composition", table),
    script: ctx(SCRIPT_PATH, ".js", "script", table),
  },
});

const fileContents: Record<string, string> = {};

describe("pushing a JSON field file (WP3)", () => {
  beforeAll(async () => {
    ({ pushFiles } = await import("../pushPipeline.js"));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ pushConcurrency: 1 });
    mockGetManifest.mockReturnValue({ scope: "x_demo", tables: {} });
    fileContents[SCRIPT_PATH] = "  var pretty = {\n  };\n";
    getFinalFileContents.mockImplementation(async (context: unknown) =>
      fileContents[(context as Sync.FileContext).filePath]
    );
    updateRecord.mockResolvedValue({ data: { result: {} } });
  });

  it("minifies the pretty form download wrote, and leaves other files alone", async () => {
    fileContents[COMPOSITION_PATH] = `${JSON.stringify(COMPOSITION, null, 2)}\n`;

    const results = await pushFiles([record()]);

    expect(results[0].success).toBe(true);
    expect(updateRecord).toHaveBeenCalledWith("sys_ux_macroponent", "rec-1", {
      composition: JSON.stringify(COMPOSITION),
      script: "  var pretty = {\n  };\n",
    });
  });

  it("sends valid JSON in any other form unchanged", async () => {
    fileContents[COMPOSITION_PATH] = JSON.stringify(COMPOSITION, null, 4);

    await pushFiles([record()]);

    const body = updateRecord.mock.calls[0][2] as Record<string, string>;
    expect(body.composition).toBe(JSON.stringify(COMPOSITION, null, 4));
  });

  it("fails the record, without sending it, when the file is not JSON", async () => {
    fileContents[COMPOSITION_PATH] = '{ "root": ';

    const results = await pushFiles([record()]);

    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain(`${COMPOSITION_PATH} is not valid JSON`);
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it("refuses a generated UI Builder snapshot", async () => {
    fileContents[COMPOSITION_PATH] = JSON.stringify(COMPOSITION);

    const results = await pushFiles([record("sys_uxf_snapshot")]);

    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/Refusing to push sys_uxf_snapshot/);
    expect(updateRecord).not.toHaveBeenCalled();
  });
});
