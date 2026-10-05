// SPDX-License-Identifier: GPL-3.0-or-later
//
// R4, push half: editing a data-model record's sidecar.
//
// A data-model sidecar carries every column of the record. An ordinary sidecar
// push sends all of them, which for a dictionary entry re-runs the dictionary
// business rules on columns nobody touched and overwrites concurrent edits made
// on the instance. For an opted-in table the push therefore reads the current
// values first and sends only the columns that differ.
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";
export {};

const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const updateRecord = jest.fn();
const tableAPIGet = jest.fn();
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
  defaultClient: () => ({ updateRecord, tableAPIGet }),
  retryOnErr: (task: () => unknown) => task(),
  processPushResponse: (_res: unknown, summary: string) => ({
    success: true,
    message: `${summary} pushed`,
  }),
  getErrorResponseStatus: () => undefined,
  isRetryableRequestError: () => false,
  SNClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) => (await p).data.result,
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

let pushFiles: typeof import("../pushPipeline.js").pushFiles;

const TABLE = "sys_dictionary";
const RECORD = "x_demo_task.u_foo";
const SIDECAR_PATH = `/proj/src/${TABLE}/${RECORD}/.meta.json`;
const CALCULATION_PATH = `/proj/src/${TABLE}/${RECORD}/calculation.js`;

const ctx = (filePath: string, targetField: string): Sync.FileContext => ({
  filePath,
  ext: filePath.endsWith(".js") ? ".js" : ".json",
  name: RECORD,
  scope: "x_demo",
  sys_id: "d1",
  tableName: TABLE,
  targetField,
});

const sidecarOnly = (): Sync.BuildableRecord => ({
  table: TABLE,
  sysId: "d1",
  fields: { ".meta": ctx(SIDECAR_PATH, ".meta") },
});

const withCalculation = (): Sync.BuildableRecord => ({
  table: TABLE,
  sysId: "d1",
  fields: {
    calculation: ctx(CALCULATION_PATH, "calculation"),
    ".meta": ctx(SIDECAR_PATH, ".meta"),
  },
});

// What a refresh wrote, and what the instance holds now.
const PULLED = {
  column_label: "Foo",
  element: "u_foo",
  internal_type: "string",
  max_length: "40",
  name: "x_demo_task",
};
const INSTANCE_ROW = {
  ...PULLED,
  // A reference column comes back as {link, value}; the sidecar holds the value.
  internal_type: { link: "https://x/api/now/table/sys_glide_object/s", value: "string" },
};

const fileContents: Record<string, string> = {};

describe("pushing an edited data-model sidecar (R4)", () => {
  beforeAll(async () => {
    ({ pushFiles } = await import("../pushPipeline.js"));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ pushConcurrency: 1, dataModelTables: [TABLE] });
    mockGetManifest.mockReturnValue({
      scope: "x_demo",
      tables: {
        [TABLE]: {
          metaFields: ["column_label", "element", "internal_type", "max_length", "name"],
          records: {
            [RECORD]: { sys_id: "d1", files: [{ name: ".meta", type: "json" }] },
          },
        },
      },
    });
    fileContents[SIDECAR_PATH] = JSON.stringify({ ...PULLED, max_length: "80" });
    fileContents[CALCULATION_PATH] = "current.u_foo;";
    getFinalFileContents.mockImplementation(async (context: unknown) =>
      fileContents[(context as Sync.FileContext).filePath]
    );
    tableAPIGet.mockResolvedValue({ data: { result: [INSTANCE_ROW] } });
    updateRecord.mockResolvedValue({ data: { result: {} } });
  });

  it("AT-R4-2: an edited max_length is the only column sent", async () => {
    const results = await pushFiles([sidecarOnly()]);

    expect(results[0].success).toBe(true);
    expect(updateRecord).toHaveBeenCalledTimes(1);
    expect(updateRecord.mock.calls[0][0]).toBe(TABLE);
    expect(updateRecord.mock.calls[0][1]).toBe("d1");
    expect({ ...(updateRecord.mock.calls[0][2] as object) }).toEqual({ max_length: "80" });

    // One read of exactly the columns the push would have sent.
    expect(tableAPIGet).toHaveBeenCalledTimes(1);
    const [table, query, fields, limit] = tableAPIGet.mock.calls[0] as [string, string, string, number];
    expect(table).toBe(TABLE);
    expect(query).toBe("sys_id=d1");
    expect(fields.split(",").sort()).toEqual(Object.keys(PULLED).sort());
    expect(limit).toBe(1);
  });

  it("AT-R4-3: an unknown sidecar key is a hard error and nothing is sent", async () => {
    fileContents[SIDECAR_PATH] = JSON.stringify({ ...PULLED, max_lenght: "80" });

    const results = await pushFiles([sidecarOnly()]);

    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/max_lenght/);
    expect(updateRecord).not.toHaveBeenCalled();
    expect(tableAPIGet).not.toHaveBeenCalled();
  });

  it("reports nothing to push when every column already matches the instance", async () => {
    fileContents[SIDECAR_PATH] = JSON.stringify(PULLED);

    const results = await pushFiles([sidecarOnly()]);

    expect(results[0].success).toBe(true);
    expect(results[0].message).toMatch(/nothing to push/);
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it("fails the record, sending nothing, when the current values cannot be read", async () => {
    tableAPIGet.mockResolvedValue({ data: { result: [] } });

    const results = await pushFiles([sidecarOnly()]);

    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/could not read the record.*nothing was sent/);
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it("fails the record when the read itself fails", async () => {
    tableAPIGet.mockRejectedValue(new Error("socket hang up"));

    const results = await pushFiles([sidecarOnly()]);

    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/socket hang up/);
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it("sends a column the instance did not return, having no value to compare", async () => {
    const { column_label: _hidden, ...row } = INSTANCE_ROW;
    tableAPIGet.mockResolvedValue({ data: { result: [row] } });

    await pushFiles([sidecarOnly()]);

    expect({ ...(updateRecord.mock.calls[0][2] as object) }).toEqual({
      column_label: "Foo",
      max_length: "80",
    });
  });

  it("always sends the field files, and reads only the sidecar columns", async () => {
    mockGetManifest.mockReturnValue({
      scope: "x_demo",
      tables: {
        [TABLE]: {
          metaFields: ["column_label", "element", "internal_type", "max_length", "name"],
          records: {
            [RECORD]: {
              sys_id: "d1",
              files: [
                { name: "calculation", type: "js" },
                { name: ".meta", type: "json" },
              ],
            },
          },
        },
      },
    });

    await pushFiles([withCalculation()]);

    expect({ ...(updateRecord.mock.calls[0][2] as object) }).toEqual({
      calculation: "current.u_foo;",
      max_length: "80",
    });
    expect(String(tableAPIGet.mock.calls[0][2]).split(",")).not.toContain("calculation");
  });

  it("sends the whole sidecar, as before, for a table that is not opted in", async () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 1, dataModelTables: [] });

    await pushFiles([sidecarOnly()]);

    expect(tableAPIGet).not.toHaveBeenCalled();
    expect(updateRecord.mock.calls[0][2]).toEqual({ ...PULLED, max_length: "80" });
  });

  it("does not read the instance when metaPush: false leaves only field files", async () => {
    mockGetConfig.mockReturnValue({
      pushConcurrency: 1,
      dataModelTables: [TABLE],
      metaPush: false,
    });

    await pushFiles([withCalculation()]);

    expect(tableAPIGet).not.toHaveBeenCalled();
    expect(updateRecord.mock.calls[0][2]).toEqual({ calculation: "current.u_foo;" });
  });
});
