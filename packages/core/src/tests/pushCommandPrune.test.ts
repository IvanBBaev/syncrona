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
const mockGitWorkingTreeDeletions = jest.fn();
const mockPruneVolumeRefusal = jest.fn();
const mockPersistScopeId = jest.fn();
const mockReaddir = jest.fn();
const mockAccess = jest.fn();

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
  pruneVolumeRefusal: (...args: unknown[]) => mockPruneVolumeRefusal(...args),
  persistScopeId: (...args: unknown[]) => mockPersistScopeId(...args),
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  gitDiffToEncodedPaths: (...args: unknown[]) => mockGitDiffToEncodedPaths(...args),
  gitDiffToChanges: (...args: unknown[]) => mockGitDiffToChanges(...args),
  gitWorkingTreeDeletions: (...args: unknown[]) => mockGitWorkingTreeDeletions(...args),
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
    readdir: (...args: unknown[]) => mockReaddir(...args),
    access: (...args: unknown[]) => mockAccess(...args),
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

const CHECKPOINT = "/tmp/project/sync.download.checkpoint.json";
const WT_DELETED = ["/tmp/project/src/sys_script_include/Gone/script.js"];

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
    mockGitWorkingTreeDeletions.mockResolvedValue(WT_DELETED);
    mockPruneVolumeRefusal.mockReturnValue(undefined);
    mockPersistScopeId.mockResolvedValue(undefined);
    mockReaddir.mockImplementation(async (dir: unknown) =>
      dir === "/tmp/project/src" ? ["sys_script_include"] : []
    );
    mockAccess.mockRejectedValue(enoent());
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

  it("without --diff, only files git tracked in HEAD and now misses are evidence", async () => {
    await runPush({ allowMassDelete: true });
    expect(mockGitDiffToChanges).not.toHaveBeenCalled();
    expect(mockGitWorkingTreeDeletions).toHaveBeenCalledTimes(1);
    expect(mockFindPruneCandidates).toHaveBeenCalledWith({
      diffDeleted: WT_DELETED,
      targets: undefined,
    });
  });

  it("--diff evidence is the diff's deleted set, not the working tree", async () => {
    await runPush({ diff: "main" });
    expect(mockGitWorkingTreeDeletions).not.toHaveBeenCalled();
  });

  it("refuses to prune when git cannot list the deleted files", async () => {
    mockGitWorkingTreeDeletions.mockRejectedValue(new Error("not a git repository"));
    await runPush({ ci: false });
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to prune: git cannot list the deleted files (not a git repository)")
    );
    expect(mockFindPruneCandidates).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("refuses to prune while a download is unfinished", async () => {
    mockAccess.mockImplementation(async (p: unknown) => {
      if (p !== CHECKPOINT) throw enoent();
    });
    await runPush({ diff: "main" });
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining(`Refusing to prune: a download is unfinished (${CHECKPOINT} exists)`)
    );
    expect(mockFindPruneCandidates).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("refuses to prune when the download checkpoint cannot be checked", async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await runPush({ diff: "main" });
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("cannot tell whether a download is unfinished")
    );
  });

  it.each([
    ["a blank sourceDirectory", () => mockGetConfig.mockReturnValue({ sourceDirectory: "  " }), /`sourceDirectory` in sync\.config\.js is blank/],
    ["a missing source directory", () => mockReaddir.mockRejectedValue(enoent()), /source directory \/tmp\/project\/src does not exist/],
    ["an empty source directory", () => mockReaddir.mockResolvedValue([]), /source directory \/tmp\/project\/src is empty/],
  ])("refuses to prune with %s", async (_label, arrange, pattern) => {
    arrange();
    await runPush({ diff: "main" });
    expect(process.exitCode).toBe(1);
    expect(String(mockLoggerError.mock.calls[0][0])).toMatch(pattern);
    expect(mockFindPruneCandidates).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("a config that cannot be read falls through to the directory check", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("no config");
    });
    await runPush({ diff: "main" });
    expect(mockFindPruneCandidates).toHaveBeenCalled();
  });

  it("under --ci, refuses to prune without --diff, a target, or --allow-mass-delete", async () => {
    await runPush();
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to prune under --ci without a scope")
    );
    expect(mockFindPruneCandidates).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("refuses a mass delete without --allow-mass-delete", async () => {
    mockPruneVolumeRefusal.mockReturnValue("30 of the 40 record(s) would be deleted.");
    await runPush({ diff: "main" });
    expect(mockPruneVolumeRefusal).toHaveBeenCalledWith(1);
    expect(process.exitCode).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Refusing to prune: 30 of the 40 record(s) would be deleted."
    );
    expect(mockPlanRecordPrune).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("--allow-mass-delete lets a mass delete through", async () => {
    mockPruneVolumeRefusal.mockReturnValue("30 of the 40 record(s) would be deleted.");
    await runPush({ diff: "main", allowMassDelete: true });
    expect(process.exitCode).toBeUndefined();
    expect(mockPruneRecords).toHaveBeenCalled();
  });

  it("a dry run only warns about a mass delete", async () => {
    mockPruneVolumeRefusal.mockReturnValue("30 of the 40 record(s) would be deleted.");
    await runPush({ diff: "main", dryRun: true });
    expect(process.exitCode).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "30 of the 40 record(s) would be deleted. A real run refuses it."
    );
    expect(mockPruneRecords).not.toHaveBeenCalled();
  });

  it("warns that a rename under --create gets a new sys_id", async () => {
    mockGetAppFileListWithCandidates.mockResolvedValue({
      records: [],
      candidates: [{ table: "sys_script_include", recordName: "Renamed", files: [] }],
    });
    mockPlanRecordCreation.mockResolvedValue({ scopeId: "scope-1", plans: [] });
    mockCreateRecords.mockResolvedValue({ results: [], records: [] });
    await runPush({ diff: "main", create: true, dryRun: true });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        "sys_script_include: this push both deletes and creates records. If one is a rename"
      )
    );
  });

  it("no rename warning when creates and deletes touch different tables", async () => {
    mockGetAppFileListWithCandidates.mockResolvedValue({
      records: [],
      candidates: [{ table: "sys_script", recordName: "New", files: [] }],
    });
    mockPlanRecordCreation.mockResolvedValue({ scopeId: "scope-1", plans: [] });
    await runPush({ diff: "main", create: true, dryRun: true });
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(expect.stringContaining("new sys_id"));
  });

  it("logs an unverified record before the delete prompt", async () => {
    mockPlanRecordPrune.mockResolvedValue(
      prunePlan([{ name: "Hidden", sysId: SYS_GONE, action: "unverified", message: "skipped: 404" }])
    );
    await runPush({ diff: "main" });
    expect(mockLoggerWarn).toHaveBeenCalledWith("sys_script_include > Hidden : skipped: 404");
  });

  it("an explicit target narrows candidates and is not an error when only prune matches", async () => {
    mockGetAppFileList.mockResolvedValue([]);
    await runPush({ target: "/tmp/project/src/sys_script_include/Gone" });
    expect(mockFindPruneCandidates).toHaveBeenCalledWith({
      diffDeleted: WT_DELETED,
      targets: "/tmp/project/src/sys_script_include/Gone",
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockPruneRecords).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("an explicit target with --diff takes its evidence from the diff, and pushes the target", async () => {
    await runPush({ target: "/tmp/project/src/sys_script_include/Gone", diff: "main" });
    expect(mockGitDiffToChanges).toHaveBeenCalledWith("main");
    expect(mockGitWorkingTreeDeletions).not.toHaveBeenCalled();
    expect(mockGitDiffToEncodedPaths).not.toHaveBeenCalled();
    expect(mockGetAppFileList).toHaveBeenCalledWith("/tmp/project/src/sys_script_include/Gone");
    expect(mockFindPruneCandidates).toHaveBeenCalledWith({
      diffDeleted: ["/tmp/project/src/sys_script_include/Gone/script.js"],
      targets: "/tmp/project/src/sys_script_include/Gone",
    });
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
    await runPush({ dryRun: true, diff: "main" });
    expect(mockPlanRecordPrune).toHaveBeenCalledWith(expect.any(Array), { persistScopeId: false });
    expect(mockPersistScopeId).not.toHaveBeenCalled();
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
    expect(mockPersistScopeId).not.toHaveBeenCalled();
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
    expect(mockPersistScopeId).toHaveBeenCalledWith("scope-1");
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
    await runPush({ diff: "main" });
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockPlanRecordPrune).toHaveBeenCalledWith(expect.any(Array), { persistScopeId: false });
    expect(mockPersistScopeId).toHaveBeenCalledWith("scope-1");
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
    await runPush({ diff: "main" });
    expect(process.exitCode).toBe(1);
    expect(mockPushFiles).toHaveBeenCalled();
  });

  // Batch 4 item 3: a rename is a delete plus a create. When the create fails,
  // deleting the renamed-from record would lose it, so the delete is held.
  const renameRun = async (failedTables: string[] | undefined, createdOk = false) => {
    mockGetAppFileListWithCandidates.mockResolvedValue({
      records: [rec("1")],
      candidates: [{ table: "sys_script_include", recordName: "Renamed", files: [] }],
    });
    mockPlanRecordCreation.mockResolvedValue({ scopeId: "scope-1", plans: [{}] });
    mockCreateRecords.mockResolvedValue({
      results: [{ success: createdOk, message: "sys_script_include > Renamed : boom" }],
      records: [],
      ...(failedTables ? { failedTables } : {}),
    });
    await runPush({ diff: "main", create: true });
    return mockPruneRecords.mock.calls[0][0] as { plans: { action: string; message?: string }[] };
  };

  it("holds the delete of a record whose replacement create failed in the same push", async () => {
    const sent = await renameRun(["sys_script_include"]);
    expect(sent.plans).toHaveLength(1);
    expect(sent.plans[0].action).toBe("error");
    expect(sent.plans[0].message).toContain("a rename is a delete plus a create");
    expect(process.exitCode).toBe(1);
  });

  it("still deletes when the failed create was on another table", async () => {
    const sent = await renameRun(["sys_script"]);
    expect(sent.plans[0].action).toBe("delete");
  });

  it("holds every delete when the outcome does not say which table failed", async () => {
    const sent = await renameRun(undefined);
    expect(sent.plans[0].action).toBe("error");
  });

  it("deletes as planned when every create succeeded", async () => {
    const sent = await renameRun(undefined, true);
    expect(sent.plans[0].action).toBe("delete");
  });

  it("no candidates means no plan and no prompt", async () => {
    mockFindPruneCandidates.mockResolvedValue([]);
    await runPush({ ci: false });
    expect(mockPlanRecordPrune).not.toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockPruneRecords).not.toHaveBeenCalled();
  });
});
