// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// R2, `push --prune`, at the command level: the project-root refusal, how
// `--diff` feeds the deleted paths in (AT-R2-4), the read-only dry run with its
// `delete` rows (AT-R2-5), the separate destructive confirmation and its
// exit-130 decline (AT-R2-6), and the order prune -> pushFiles in a real run.
// The pipeline functions are mocked; pushPrune.test.ts covers them.

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
const mockGetSourcePath = jest.fn();
const mockGitDiffToChanges = jest.fn();
const mockGitDiffToEncodedPaths = jest.fn();
const mockFindPruneCandidates = jest.fn();
const mockPlanRecordPrune = jest.fn();
const mockPruneRecords = jest.fn();

jest.unstable_mockModule("../appUtils.js", () => ({
  checkScope: (...args: unknown[]) => mockCheckScope(...args),
  getAppFileList: (...args: unknown[]) => mockGetAppFileList(...args),
  getAppFileListWithCandidates: (...args: unknown[]) => mockGetAppFileListWithCandidates(...args),
  planRecordCreation: (...args: unknown[]) => mockPlanRecordCreation(...args),
  createRecords: (...args: unknown[]) => mockCreateRecords(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
  createAndAssignUpdateSet: (...args: unknown[]) => mockCreateAndAssignUpdateSet(...args),
  findPruneCandidates: (...args: unknown[]) => mockFindPruneCandidates(...args),
  planRecordPrune: (...args: unknown[]) => mockPlanRecordPrune(...args),
  pruneRecords: (...args: unknown[]) => mockPruneRecords(...args),
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  gitDiffToEncodedPaths: (...args: unknown[]) => mockGitDiffToEncodedPaths(...args),
  gitDiffToChanges: (...args: unknown[]) => mockGitDiffToChanges(...args),
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
  getSourcePath: (...args: unknown[]) => mockGetSourcePath(...args),
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
const SYS_GONE = "a".repeat(32);
const SYS_FOREIGN = "b".repeat(32);

const rec = (sysId: string, table = "sys_script") =>
  ({ table, sysId, fields: { script: { filePath: `/tmp/${sysId}.js`, name: `R${sysId}` } } }) as any;

const pruneCandidate = (recordName: string, sysId: string) => ({
  table: "sys_script_include",
  recordKey: recordName,
  recordName,
  sysId,
  files: [{ name: "script", type: "js" }],
});

const prunePlan = (
  plans: { name: string; sysId: string; action: string; message?: string }[]
) => ({
  scopeId: "scope-1",
  plans: plans.map(({ name, sysId, action, message }) => ({
    candidate: pruneCandidate(name, sysId),
    action,
    ...(message ? { message } : {}),
  })),
});

const runPush = (overrides: Record<string, unknown> = {}) =>
  pushCommand({
    logLevel: "info",
    ci: true,
    target: "",
    diff: "",
    scopeSwap: false,
    updateSet: "",
    prune: true,
    ...overrides,
  } as any);

const loggedTables = () =>
  mockLoggerInfo.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("Dry run —"));

describe("pushCommand --prune", () => {
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
    mockGetSourcePath.mockReturnValue("/tmp/project/src");
    mockGitDiffToEncodedPaths.mockResolvedValue("encoded:/tmp/project/src");
    mockGitDiffToChanges.mockResolvedValue({
      changed: "/tmp/project/src/sys_script/R1/script.js",
      deleted: ["/tmp/project/src/sys_script_include/Gone/script.js"],
    });
    mockGetAppFileList.mockResolvedValue([rec("1")]);
    mockFindPruneCandidates.mockResolvedValue([pruneCandidate("Gone", SYS_GONE)]);
    mockPlanRecordPrune.mockResolvedValue(
      prunePlan([{ name: "Gone", sysId: SYS_GONE, action: "delete" }])
    );
    mockPruneRecords.mockResolvedValue([
      { success: true, message: `sys_script_include > Gone : deleted (${SYS_GONE}).` },
    ]);
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

  it("never looks for prune candidates without the flag", async () => {
    await runPush({ prune: false });
    expect(mockFindPruneCandidates).not.toHaveBeenCalled();
    expect(mockGitDiffToChanges).not.toHaveBeenCalled();
    expect(mockPruneRecords).not.toHaveBeenCalled();
    expect(mockPushFiles).toHaveBeenCalled();
  });

  it("refuses to prune when the source directory is the project root", async () => {
    mockGetSourcePath.mockReturnValue("/tmp/project/");
    await runPush();
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to prune: the source directory is the project root")
    );
    expect(mockFindPruneCandidates).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("AT-R2-4: --diff hands the diff's deleted paths to candidate discovery", async () => {
    await runPush({ diff: "main" });
    expect(mockGitDiffToChanges).toHaveBeenCalledWith("main");
    expect(mockGitDiffToEncodedPaths).not.toHaveBeenCalled();
    expect(mockGetAppFileList).toHaveBeenCalledWith("/tmp/project/src/sys_script/R1/script.js");
    expect(mockFindPruneCandidates).toHaveBeenCalledWith({
      diffDeleted: ["/tmp/project/src/sys_script_include/Gone/script.js"],
      targets: undefined,
    });
  });

  it("without --diff, every record of the tree is considered", async () => {
    await runPush();
    expect(mockGitDiffToChanges).not.toHaveBeenCalled();
    expect(mockFindPruneCandidates).toHaveBeenCalledWith({
      diffDeleted: undefined,
      targets: undefined,
    });
  });

  it("an explicit target narrows candidates and is not an error when only prune matches", async () => {
    mockGetAppFileList.mockResolvedValue([]);
    await runPush({ target: "/tmp/project/src/sys_script_include/Gone" });
    expect(mockFindPruneCandidates).toHaveBeenCalledWith({
      diffDeleted: undefined,
      targets: "/tmp/project/src/sys_script_include/Gone",
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockPruneRecords).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("an explicit target matching nothing at all is still an error", async () => {
    mockGetAppFileList.mockResolvedValue([]);
    mockFindPruneCandidates.mockResolvedValue([]);
    await runPush({ target: "/tmp/project/src/typo" });
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining("Nothing to push"));
  });

  it("AT-R2-5: dry run plans read-only, shows delete rows, and deletes nothing", async () => {
    mockPlanRecordPrune.mockResolvedValue(
      prunePlan([
        { name: "Gone", sysId: SYS_GONE, action: "delete" },
        {
          name: "Foreign",
          sysId: SYS_FOREIGN,
          action: "error",
          message: "refusing to delete: the record belongs to scope \"global\"",
        },
      ])
    );
    await runPush({ dryRun: true });
    expect(mockPlanRecordPrune).toHaveBeenCalledWith(expect.any(Array), { persistScopeId: false });
    expect(mockPruneRecords).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
    const [table] = loggedTables();
    expect(table).toMatch(/Action/);
    expect(table).toMatch(/update\s+.*sys_script/);
    expect(table).toMatch(new RegExp(`delete\\s+.*Gone.*${SYS_GONE}`));
    expect(table).toMatch(new RegExp(`error\\s+.*Foreign.*${SYS_FOREIGN}`));
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("sys_script_include > Foreign : refusing to delete")
    );
  });

  it("dry run with only prune candidates still previews them", async () => {
    mockGetAppFileList.mockResolvedValue([]);
    await runPush({ dryRun: true });
    const [table] = loggedTables();
    expect(table).toMatch(/delete/);
  });

  it("AT-R2-6: a declined delete prompt cancels the run with exit 130 and writes nothing", async () => {
    mockPrompt
      .mockResolvedValueOnce({ confirmed: true }) // overwrite
      .mockResolvedValueOnce({ confirmed: false }); // delete
    await runPush({ ci: false });
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    const deletePrompt = (mockPrompt.mock.calls[1][0] as any[])[0];
    expect(deletePrompt.message).toBe(
      "Delete 1 record(s) from instance.service-now.com? This cannot be undone."
    );
    expect(deletePrompt.default).toBe(false);
    expect(process.exitCode).toBe(130);
    expect(mockPruneRecords).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("an accepted delete prompt deletes, then pushes", async () => {
    const order: string[] = [];
    mockPruneRecords.mockImplementation(async () => {
      order.push("prune");
      return [{ success: true, message: "deleted" }];
    });
    mockPushFiles.mockImplementation(async (list: unknown[]) => {
      order.push("push");
      return list.map(() => ({ success: true, message: "ok" }));
    });
    await runPush({ ci: false });
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["prune", "push"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("does not ask to delete when every candidate is refused", async () => {
    mockPlanRecordPrune.mockResolvedValue(
      prunePlan([{ name: "Foreign", sysId: SYS_FOREIGN, action: "error", message: "out of scope" }])
    );
    mockPruneRecords.mockResolvedValue([{ success: false, message: "out of scope" }]);
    await runPush({ ci: false });
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith("sys_script_include > Foreign : out of scope");
    expect(process.exitCode).toBe(1);
  });

  it("--ci skips the delete prompt, persists the scope, and logs prune results with the push", async () => {
    await runPush();
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockPlanRecordPrune).toHaveBeenCalledWith(expect.any(Array), { persistScopeId: true });
    expect(mockPruneRecords).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "1 record(s) with every local file deleted to prune."
    );
    const logged = mockLogPushResults.mock.calls[0][0] as { message: string }[];
    expect(logged.map((r) => r.message)).toEqual([
      `sys_script_include > Gone : deleted (${SYS_GONE}).`,
      "ok",
    ]);
  });

  it("a failed delete fails the shell", async () => {
    mockPruneRecords.mockResolvedValue([{ success: false, message: "ACL denied" }]);
    await runPush();
    expect(process.exitCode).toBe(1);
    expect(mockPushFiles).toHaveBeenCalled();
  });

  it("no candidates means no plan and no prompt", async () => {
    mockFindPruneCandidates.mockResolvedValue([]);
    await runPush({ ci: false });
    expect(mockPlanRecordPrune).not.toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockPruneRecords).not.toHaveBeenCalled();
  });
});
