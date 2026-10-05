// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// R1, `push --create`, at the command level: how the flag and the
// `createRecords` config key combine, the dry-run Action column, the order of
// plan -> create -> pushFiles in a real run, and the `created` map the push
// checkpoint carries so an interrupted run never creates a record twice.
// The pipeline functions are mocked; pushCreate.test.ts covers them.

const mockCheckScope = jest.fn();
const mockGetAppFileList = jest.fn();
const mockGetAppFileListWithCandidates = jest.fn();
const mockPlanRecordCreation = jest.fn();
const mockCreateRecords = jest.fn();
const mockPushFiles = jest.fn();
const mockCreateAndAssignUpdateSet = jest.fn();
const mockLogPushResults = jest.fn();
const mockPrompt = jest.fn();
const mockCheckConnection = jest.fn();
const mockResolveCredentials = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockUnlink = jest.fn();
const mockGetConfig = jest.fn();

jest.unstable_mockModule("../appUtils.js", () => ({
  checkScope: (...args: unknown[]) => mockCheckScope(...args),
  getAppFileList: (...args: unknown[]) => mockGetAppFileList(...args),
  getAppFileListWithCandidates: (...args: unknown[]) => mockGetAppFileListWithCandidates(...args),
  planRecordCreation: (...args: unknown[]) => mockPlanRecordCreation(...args),
  createRecords: (...args: unknown[]) => mockCreateRecords(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
  createAndAssignUpdateSet: (...args: unknown[]) => mockCreateAndAssignUpdateSet(...args),
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  gitDiffToEncodedPaths: jest.fn(),
  gitDiffToChanges: jest.fn(),
  gitWorkingTreeDeletions: jest.fn(async () => []),
  writeDiff: jest.fn(),
  clearDiff: jest.fn(),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    success: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: jest.fn(),
    silly: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.unstable_mockModule("../logMessages.js", () => ({
  scopeCheckMessage: jest.fn(),
  logPushResults: (...args: unknown[]) => mockLogPushResults(...args),
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({
    checkConnection: (...args: unknown[]) => mockCheckConnection(...args),
  }),
  resolveCredentials: (...args: unknown[]) => mockResolveCredentials(...args),
  getScopedEndpointPrefix: () => "x_nuvo_sinc",
  setActiveInstanceProfile: jest.fn(),
}));

jest.unstable_mockModule("../auth.js", () => ({
  getActiveInstance: async () => null,
  loadCredentials: async () => ({}),
}));

jest.unstable_mockModule("../config.js", () => ({
  getRootDir: () => "/tmp/project",
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    link: async () => undefined,
    readdir: async () => [],
    stat: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

let pushCommand: typeof import("../pushCommand.js").pushCommand;

beforeAll(async () => {
  ({ pushCommand } = await import("../pushCommand.js"));
});

const enoent = () => Object.assign(new Error("not found"), { code: "ENOENT" });
const CHECKPOINT = "sync.push.checkpoint.json";

const rec = (sysId: string, table = "sys_script") =>
  ({ table, sysId, fields: { script: { filePath: `/tmp/${sysId}.js`, name: `R${sysId}` } } }) as any;

const candidate = (recordName: string) => ({
  table: "sys_script_include",
  recordName,
  files: [{ filePath: `/tmp/src/sys_script_include/${recordName}/script.js`, field: "script", ext: ".js", isSidecar: false }],
});

const plan = (recordName: string, action: string, extra: Record<string, unknown> = {}) => ({
  candidate: candidate(recordName),
  action,
  nameField: "name",
  nameValue: recordName,
  ...extra,
});

const runPush = (overrides: Record<string, unknown> = {}) =>
  pushCommand({
    logLevel: "info",
    ci: true,
    target: "encoded:/tmp/a.js",
    diff: "",
    scopeSwap: false,
    updateSet: "",
    ...overrides,
  } as any);

const checkpointWrites = () =>
  mockWriteFile.mock.calls
    .filter((c) => String(c[0]).includes(CHECKPOINT))
    .map((c) => JSON.parse(String(c[1])));

describe("pushCommand --create", () => {
  const originalInstance = process.env.SN_INSTANCE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    process.env.SN_INSTANCE = "instance.service-now.com";
    mockCheckScope.mockResolvedValue({ match: true });
    mockCheckConnection.mockResolvedValue(undefined);
    mockResolveCredentials.mockImplementation(() => ({
      instance: "instance.service-now.com",
      user: "u",
      password: "p",
      profile: undefined,
    }));
    mockGetConfig.mockReturnValue({});
    mockGetAppFileList.mockResolvedValue([rec("1")]);
    mockGetAppFileListWithCandidates.mockResolvedValue({
      records: [rec("1")],
      candidates: [candidate("New"), candidate("Existing")],
    });
    mockPlanRecordCreation.mockResolvedValue({
      scopeId: "scope-1",
      plans: [plan("New", "create"), plan("Existing", "adopt", { sysId: "ex-1" })],
    });
    mockCreateRecords.mockImplementation(async (_creation: unknown, options: any) => {
      await options.onCreated("sys_script_include:New", "new-1");
      return {
        results: [{ success: true, message: "sys_script_include > New : created (new-1)." }],
        records: [rec("ex-1", "sys_script_include")],
      };
    });
    mockPushFiles.mockImplementation(async (list: unknown[]) =>
      list.map(() => ({ success: true, message: "ok" }))
    );
    mockPrompt.mockResolvedValue({ confirmed: true });
    mockReadFile.mockRejectedValue(enoent());
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.SN_INSTANCE = originalInstance;
  });

  it("keeps the plain path when neither the flag nor the config asks for creation", async () => {
    await runPush();
    expect(mockGetAppFileList).toHaveBeenCalled();
    expect(mockGetAppFileListWithCandidates).not.toHaveBeenCalled();
    expect(mockPlanRecordCreation).not.toHaveBeenCalled();
  });

  it("turns creation on from createRecords in sync.config.js", async () => {
    mockGetConfig.mockReturnValue({ createRecords: true });
    await runPush();
    expect(mockGetAppFileListWithCandidates).toHaveBeenCalledWith("encoded:/tmp/a.js", {
      create: true,
    });
  });

  it("lets --no-create win over createRecords: true", async () => {
    mockGetConfig.mockReturnValue({ createRecords: true });
    await runPush({ create: false });
    expect(mockGetAppFileListWithCandidates).not.toHaveBeenCalled();
  });

  it("treats an unreadable config as creation off", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("no config");
    });
    await runPush();
    expect(mockGetAppFileListWithCandidates).not.toHaveBeenCalled();
  });

  // AT-R1-6: the dry run shows an Action column and never creates anything.
  it("dry run previews update/create/adopt/error rows without writing", async () => {
    mockPlanRecordCreation.mockResolvedValue({
      scopeId: "scope-1",
      plans: [
        plan("New", "create"),
        plan("Existing", "adopt", { sysId: "ex-1" }),
        plan("Bad", "error", { message: "denied" }),
      ],
    });
    await runPush({ create: true, dryRun: true });

    expect(mockPlanRecordCreation).toHaveBeenCalledWith(expect.any(Array), { persistScopeId: false });
    const preview = mockLoggerInfo.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.startsWith("Dry run — records"));
    expect(preview).toBeDefined();
    for (const token of ["Action", "update", "create", "adopt", "error", "ex-1"]) {
      expect(preview).toContain(token);
    }
    expect(mockLoggerWarn).toHaveBeenCalledWith("sys_script_include > Bad : denied");
    expect(mockCreateRecords).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("dry run with only new records still previews them", async () => {
    mockGetAppFileListWithCandidates.mockResolvedValue({ records: [], candidates: [candidate("New")] });
    mockPlanRecordCreation.mockResolvedValue({ scopeId: "s", plans: [plan("New", "create")] });
    await runPush({ create: true, dryRun: true });
    expect(process.exitCode).toBeUndefined();
    expect(
      mockLoggerInfo.mock.calls.some((c) => String(c[0]).startsWith("Dry run — records"))
    ).toBe(true);
  });

  it("creates, then pushes the known and the adopted records, and records created sys_ids", async () => {
    await runPush({ create: true });

    expect(mockPlanRecordCreation).toHaveBeenCalledWith(expect.any(Array), {
      persistScopeId: true,
      known: undefined,
    });
    const pushed = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    expect(pushed.map((r) => r.sysId)).toEqual(["1", "ex-1"]);
    const writes = checkpointWrites();
    expect(writes.some((w) => w.created?.["sys_script_include:New"] === "new-1")).toBe(true);
    expect(writes[writes.length - 1].attempted).toEqual([
      "sys_script:1",
      "sys_script_include:ex-1",
    ]);
    const logged = mockLogPushResults.mock.calls[0][0] as Array<{ message: string }>;
    expect(logged[0].message).toContain("created (new-1)");
    expect(logged).toHaveLength(3);
    // Everything succeeded, so the checkpoint is cleared.
    expect(mockUnlink.mock.calls.some((c) => String(c[0]).includes(CHECKPOINT))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails the shell and keeps the checkpoint when a creation fails", async () => {
    mockCreateRecords.mockResolvedValue({
      results: [{ success: false, message: "sys_script_include > Bad : denied" }],
      records: [],
    });
    await runPush({ create: true });
    expect(process.exitCode).toBe(1);
    expect(mockUnlink.mock.calls.some((c) => String(c[0]).includes(CHECKPOINT))).toBe(false);
  });

  it("hands the previous run's created map on, for this instance only", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes(CHECKPOINT)) {
        return JSON.stringify({
          attempted: [],
          succeeded: [],
          failed: [],
          instance: "instance.service-now.com",
          created: { "sys_script_include:New": "prev-1", bogus: 5 },
        });
      }
      throw enoent();
    });
    await runPush({ create: true });
    expect(mockPlanRecordCreation).toHaveBeenCalledWith(expect.any(Array), {
      persistScopeId: true,
      known: { "sys_script_include:New": "prev-1" },
    });

    mockPlanRecordCreation.mockClear();
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes(CHECKPOINT)) {
        return JSON.stringify({
          attempted: [],
          succeeded: [],
          failed: [],
          instance: "other.service-now.com",
          created: { "sys_script_include:New": "prev-1" },
        });
      }
      throw enoent();
    });
    await runPush({ create: true });
    expect(mockPlanRecordCreation).toHaveBeenCalledWith(expect.any(Array), {
      persistScopeId: true,
      known: undefined,
    });
  });

  it("ignores a created map that is not an object", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes(CHECKPOINT)) {
        return JSON.stringify({
          attempted: [],
          succeeded: [],
          failed: [],
          instance: "instance.service-now.com",
          created: ["x"],
        });
      }
      throw enoent();
    });
    await runPush({ create: true });
    expect(mockPlanRecordCreation).toHaveBeenCalledWith(expect.any(Array), {
      persistScopeId: true,
      known: undefined,
    });
  });

  it("accepts an explicit target that names only a new record", async () => {
    mockGetAppFileListWithCandidates.mockResolvedValue({ records: [], candidates: [candidate("New")] });
    mockPlanRecordCreation.mockResolvedValue({ scopeId: "s", plans: [plan("New", "create")] });
    mockCreateRecords.mockResolvedValue({
      results: [{ success: true, message: "created" }],
      records: [],
    });
    await runPush({ create: true });
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockCreateRecords).toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith("1 new record(s) to create or adopt.");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not plan when create mode finds no new record", async () => {
    mockGetAppFileListWithCandidates.mockResolvedValue({ records: [rec("1")], candidates: [] });
    await runPush({ create: true });
    expect(mockPlanRecordCreation).not.toHaveBeenCalled();
    expect(mockCreateRecords).not.toHaveBeenCalled();
    expect(mockPushFiles).toHaveBeenCalled();
  });
});
