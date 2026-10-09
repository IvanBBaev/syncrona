// SPDX-License-Identifier: GPL-3.0-or-later
//
// CR26: the IO and network edges of the appUtils surface (scope management,
// the progress tick, push/build fan-out, prune and create execution): non-Error
// rejections, empty or unreadable instance answers, empty inputs, and the
// option combinations that pick the default client or the composite push order.
// Everything goes through the `../appUtils.js` barrel, as the commands do.
import { jest } from "@jest/globals";
import type { Sync } from "@syncrona/types";

const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const getFinalFileContents = jest.fn();
const loggerError = jest.fn();
const loggerInfo = jest.fn();

type Resp = Promise<{ data: { result: unknown } }>;
const ok = (result: unknown) => Promise.resolve({ data: { result } });

const mockClient = {
  getScopeId: jest.fn((_scope: string) => ok([{ sys_id: "scope-1" }])),
  getCurrentScope: jest.fn(() => ok({ scope: "x_demo", sys_id: "scope-1" })),
  getUserSysId: jest.fn(() => ok([{ sys_id: "user-1" }])),
  getCurrentAppUserPrefSysId: jest.fn((_user: string) => ok([])),
  updateCurrentAppUserPref: jest.fn(async () => ({})),
  createCurrentAppUserPref: jest.fn(async () => ({})),
  createUpdateSet: jest.fn((_name: string) => ok({ sys_id: "us-1" })),
  getCurrentUpdateSetUserPref: jest.fn((_user: string) => ok([])),
  updateCurrentUpdateSetUserPref: jest.fn(async () => ({})),
  createCurrentUpdateSetUserPref: jest.fn(async () => ({})),
  updateRecord: jest.fn(async (..._a: unknown[]) => ({ data: { result: {} } })),
  tableAPIGet: jest.fn(async (..._a: unknown[]) => ({ data: { result: [] as unknown } })),
  createRecord: jest.fn(async () => ({ sys_id: "new-1" })),
  deleteRecord: jest.fn(async () => ({})),
  getRecordScope: jest.fn(async () => undefined),
};
const defaultClient = jest.fn(() => mockClient);

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => defaultClient(),
  retryOnErr: (task: () => unknown) => task(),
  processPushResponse: (_res: unknown, summary: string) => ({
    success: true,
    message: `${summary} pushed`,
  }),
  getErrorResponseStatus: (e: { response?: { status?: number } } | null) =>
    e && e.response ? e.response.status : undefined,
  isRetryableRequestError: () => false,
  SNClient: class {},
  resolveCredentials: jest.fn(),
  unwrapSNResponse: async (p: Resp) => (await p).data.result,
  unwrapTableAPIFirstItem: async (p: Resp, key: string) =>
    ((await p).data.result as Record<string, unknown>[])[0]?.[key],
  unwrapTableAPIFirstItemOrEmpty: async (p: Resp, key: string) =>
    ((await p).data.result as Record<string, unknown>[])[0]?.[key] ?? "",
}));

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  getManifest: (...a: unknown[]) => mockGetManifest(...a),
  getSourcePath: () => "/proj/src",
  getBuildPath: () => "/proj/build",
}));

jest.unstable_mockModule("../PluginManager.js", () => ({
  default: {
    getFinalFileContents: (...a: unknown[]) => getFinalFileContents(...a),
  },
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    warn: jest.fn(),
    success: jest.fn(),
    error: (...a: unknown[]) => loggerError(...a),
    debug: jest.fn(),
    silly: jest.fn(),
    // "error" keeps pushFiles/buildFiles from painting a progress bar.
    getLogLevel: () => "error",
  },
}));

let App: typeof import("../appUtils.js");

beforeAll(async () => {
  App = await import("../appUtils.js");
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfig.mockReturnValue({ pushConcurrency: 1 });
  mockGetManifest.mockReturnValue({ scope: "x_demo", scopeId: "scope-1", tables: {} });
  getFinalFileContents.mockImplementation(async () => "gs.info('x');");
});

const scriptRecord = (table: string, name: string, sysId = `${name}-id`): Sync.BuildableRecord =>
  ({
    table,
    sysId,
    fields: {
      script: {
        name,
        tableName: table,
        targetField: "script",
        filePath: `/proj/src/${table}/${name}/script.js`,
        ext: ".js",
        sys_id: sysId,
        scope: "x_demo",
      },
    },
  }) as Sync.BuildableRecord;

describe("scope management edges", () => {
  it("logs a non-Error rejection of the user-pref swap as text and rethrows it unchanged", async () => {
    mockClient.getUserSysId.mockImplementationOnce(() => Promise.reject("socket hang up"));
    await expect(App.swapScope("x_demo")).rejects.toBe("socket hang up");
    expect(loggerError).toHaveBeenCalledWith("socket hang up");
    expect(mockClient.createCurrentAppUserPref).not.toHaveBeenCalled();
    expect(mockClient.getCurrentScope).not.toHaveBeenCalled();
  });

  it("creates an update set with a blank name when none is given", async () => {
    const res = await App.createAndAssignUpdateSet();
    expect(loggerInfo).toHaveBeenCalledWith("Update Set Name: ");
    expect(mockClient.createUpdateSet).toHaveBeenCalledWith("");
    expect(mockClient.createCurrentUpdateSetUserPref).toHaveBeenCalledWith("us-1", "user-1");
    expect(res).toEqual({ name: "", id: "us-1" });
  });
});

describe("getProgTick edges", () => {
  const ttyStream = () => {
    const writes: string[] = [];
    const stream = {
      isTTY: true,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    return { stream, writes };
  };

  it("renders a zero total as complete and ends the line", () => {
    const { stream, writes } = ttyStream();
    const tick = App.getProgTick("info", 0, stream);
    tick?.();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^\r={40} 1\/0 \(100%\) ~.* left$/);
    expect(writes[1]).toBe("\n");
  });

  it("ends the line only on the final tick, and clamps a tick past the total at 100%", () => {
    const { stream, writes } = ttyStream();
    const tick = App.getProgTick("info", 2, stream);
    tick?.();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\r={20} {20} 1\/2 \(50%\)/);
    tick?.();
    expect(writes.slice(1)).toEqual([expect.stringMatching(/ 2\/2 \(100%\)/), "\n"]);
    tick?.();
    expect(writes[3]).toMatch(/^\r={40} 3\/2 \(100%\)/);
  });

  it("advances silently on a stream that is not a terminal", () => {
    const write = jest.fn();
    const tick = App.getProgTick("info", 1, { write } as unknown as NodeJS.WritableStream);
    expect(typeof tick).toBe("function");
    tick?.();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("pushFiles network edges", () => {
  it("returns no results for an empty push and sends nothing", async () => {
    await expect(App.pushFiles([])).resolves.toEqual([]);
    expect(mockClient.updateRecord).not.toHaveBeenCalled();
    expect(getFinalFileContents).not.toHaveBeenCalled();
  });

  it("reports a non-Error update rejection by its text", async () => {
    mockClient.updateRecord.mockImplementationOnce(() => Promise.reject("ECONNRESET"));
    const results = await App.pushFiles([scriptRecord("sys_script", "Rule")]);
    expect(results).toEqual([{ success: false, message: "sys_script > Rule : ECONNRESET" }]);
  });

  it("reports an update error without a message as too many retries", async () => {
    mockClient.updateRecord.mockRejectedValueOnce(new Error(""));
    const results = await App.pushFiles([scriptRecord("sys_script", "Rule")]);
    expect(results).toEqual([{ success: false, message: "sys_script > Rule : Too many retries" }]);
  });

  it.each<[string, unknown, string]>([
    ["a non-Error", "plugin died", "plugin died"],
    ["an Error without a message", new Error(""), "Failed to build!"],
  ])("reports a plugin that rejects with %s as a build failure and sends nothing", async (_label, reason, text) => {
    getFinalFileContents.mockImplementationOnce(() => Promise.reject(reason));
    const results = await App.pushFiles([scriptRecord("sys_script", "Rule")]);
    expect(results).toEqual([{ success: false, message: `sys_script > Rule : \n0:\n${text}` }]);
    expect(mockClient.updateRecord).not.toHaveBeenCalled();
  });

  it("still pushes, in the records layout, when the config cannot be read", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("no sync.config.js");
    });
    const results = await App.pushFiles(
      [scriptRecord("sys_choice", "Choice"), scriptRecord("sys_db_object", "Table")],
      1
    );
    expect(results.map((r) => r.message)).toEqual([
      "sys_choice > Choice pushed",
      "sys_db_object > Table pushed",
    ]);
    expect(mockClient.updateRecord.mock.calls.map((c) => c[0])).toEqual([
      "sys_choice",
      "sys_db_object",
    ]);
  });

  it("pushes the composite layout tier by tier and returns results in input order", async () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 1, dataModelLayout: "composite" });
    const recs = [
      scriptRecord("sys_choice", "Choice"),
      scriptRecord("sys_script", "Rule"),
      scriptRecord("sys_dictionary", "ColumnA"),
      scriptRecord("sys_db_object", "Table"),
      scriptRecord("sys_dictionary", "ColumnB"),
    ];
    const results = await App.pushFiles(recs);
    expect(mockClient.updateRecord.mock.calls.map((c) => c[1])).toEqual([
      "Table-id",
      "ColumnA-id",
      "ColumnB-id",
      "Choice-id",
      "Rule-id",
    ]);
    expect(results.map((r) => r.message)).toEqual([
      "sys_choice > Choice pushed",
      "sys_script > Rule pushed",
      "sys_dictionary > ColumnA pushed",
      "sys_db_object > Table pushed",
      "sys_dictionary > ColumnB pushed",
    ]);
  });
});

describe("pushFiles data-model sidecar reads", () => {
  const TABLE = "sys_dictionary";
  const sidecarRecord = (): Sync.BuildableRecord =>
    ({
      table: TABLE,
      sysId: "d1",
      fields: {
        ".meta": {
          name: "x_demo_task.u_foo",
          tableName: TABLE,
          targetField: ".meta",
          filePath: `/proj/src/${TABLE}/x_demo_task.u_foo/.meta.json`,
          ext: ".json",
          sys_id: "d1",
          scope: "x_demo",
        },
      },
    }) as Sync.BuildableRecord;

  beforeEach(() => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 1, dataModelTables: [TABLE] });
    mockGetManifest.mockReturnValue({
      scope: "x_demo",
      tables: {
        [TABLE]: {
          metaFields: ["column_label", "max_length"],
          records: { "x_demo_task.u_foo": { sys_id: "d1", files: [] } },
        },
      },
    });
    getFinalFileContents.mockImplementation(async () =>
      JSON.stringify({ column_label: "Foo", max_length: "80" })
    );
  });

  it("refuses to send the sidecar when the instance answers without a result list", async () => {
    mockClient.tableAPIGet.mockResolvedValueOnce({ data: { result: { sys_id: "d1" } } });
    const results = await App.pushFiles([sidecarRecord()]);
    expect(results).toEqual([
      {
        success: false,
        message: expect.stringMatching(
          /^sys_dictionary > x_demo_task\.u_foo : could not read the record from the instance/
        ),
      },
    ]);
    expect(mockClient.updateRecord).not.toHaveBeenCalled();
  });

  it("reports a non-Error read failure by its text and sends nothing", async () => {
    mockClient.tableAPIGet.mockImplementationOnce(() => Promise.reject("read timed out"));
    const results = await App.pushFiles([sidecarRecord()]);
    expect(results).toEqual([
      { success: false, message: "sys_dictionary > x_demo_task.u_foo : read timed out" },
    ]);
    expect(mockClient.updateRecord).not.toHaveBeenCalled();
  });
});

describe("buildFiles fan-out failures", () => {
  const fieldless = (sysId: string) =>
    ({ table: "sys_script", sysId, fields: {} }) as unknown as Sync.BuildableRecord;

  it("rethrows a lone worker failure unchanged", async () => {
    await expect(App.buildFiles([fieldless("a")])).rejects.toBeInstanceOf(TypeError);
  });

  it("collects several worker failures into one AggregateError", async () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 2 });
    const error = await App.buildFiles([fieldless("a"), fieldless("b")]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe("2 concurrent operations failed.");
    expect((error as AggregateError).errors).toHaveLength(2);
  });
});

describe("prune and create execution without an explicit client", () => {
  const pruneCandidate = (recordName: string) => ({
    table: "sys_script_include",
    recordKey: recordName,
    recordName,
    sysId: "a".repeat(32),
    files: [],
  });

  it("returns early for empty plans without creating a client", async () => {
    await expect(App.pruneRecords({ scopeId: "", plans: [] })).resolves.toEqual([]);
    await expect(App.planRecordPrune([], { persistScopeId: false })).resolves.toEqual({
      scopeId: "",
      plans: [],
    });
    expect(defaultClient).not.toHaveBeenCalled();
  });

  it("reports error and unverified prune plans through the default client without a DELETE", async () => {
    const results = await App.pruneRecords({
      scopeId: "scope-1",
      plans: [
        { candidate: pruneCandidate("Refused"), action: "error", message: "refusing to delete." },
        { candidate: pruneCandidate("Hidden"), action: "unverified", message: "skipped: 404." },
      ],
    });
    expect(defaultClient).toHaveBeenCalledTimes(1);
    expect(mockClient.deleteRecord).not.toHaveBeenCalled();
    expect(results).toEqual([
      { success: false, message: "sys_script_include > Refused : refusing to delete." },
      { success: true, message: "sys_script_include > Hidden : skipped: 404." },
    ]);
  });

  it("plans a prune through the default client and keeps a record the instance hides", async () => {
    const plan = await App.planRecordPrune([pruneCandidate("Gone")], { persistScopeId: false });
    expect(defaultClient).toHaveBeenCalledTimes(1);
    expect(mockClient.getRecordScope).toHaveBeenCalledWith("sys_script_include", "a".repeat(32));
    expect(plan.plans[0].action).toBe("unverified");
  });

  it("plans and reports a conflicting create through the default client without a POST", async () => {
    const creation = await App.planRecordCreation(
      [
        {
          table: "sys_script_include",
          recordName: "Twice",
          files: [],
          conflict: "two files claim the script field.",
        },
      ],
      { persistScopeId: false }
    );
    expect(creation).toMatchObject({
      scopeId: "scope-1",
      plans: [{ action: "error", message: "two files claim the script field." }],
    });
    const outcome = await App.createRecords(creation);
    expect(defaultClient).toHaveBeenCalledTimes(2);
    expect(mockClient.createRecord).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      results: [
        { success: false, message: "sys_script_include > Twice : two files claim the script field." },
      ],
      records: [],
      failedTables: ["sys_script_include"],
    });
  });
});
