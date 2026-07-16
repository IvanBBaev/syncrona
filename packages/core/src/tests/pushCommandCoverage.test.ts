// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// Closes the pushCommand.ts branches the flow/lock suites leave uncovered:
//  - getStateBaseDir's cwd fallback when no config root is loaded,
//  - loadPushCheckpoint rejecting a shape-invalid payload and swallowing a
//    non-ENOENT read error,
//  - clearPushCheckpoint / releaseCollaborationLock re-throwing a non-ENOENT
//    unlink error,
//  - loadCollaborationLock rejecting an invalid object and swallowing errors,
//  - acquireCollaborationLock re-throwing a non-EEXIST write error and giving up
//    after both atomic-create attempts lose to a (repeatedly stale) lock,
//  - the decrypt-warning branch when no server is configured,
//  - the git-diff path selection, the declined-resume clearPushCheckpoint call,
//    and the update-set confirm/decline/create prompts.
//
// fs.promises is fully mocked (like commandsFlow.test.ts) so every ENOENT /
// EEXIST / EACCES branch is deterministic and no write leaves the temp process.

const mockCheckScope = jest.fn();
const mockGetAppFileList = jest.fn();
const mockPushFiles = jest.fn();
const mockCreateAndAssignUpdateSet = jest.fn();
const mockLogPushResults = jest.fn();
const mockPrompt = jest.fn();
const mockCheckConnection = jest.fn();
const mockResolveCredentials = jest.fn();
const mockGetScopedEndpointPrefix = jest.fn();
const mockSetActiveInstanceProfile = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerDebug = jest.fn();
const mockInternalError = jest.fn();
const mockGitDiffToEncodedPaths = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockUnlink = jest.fn();
const mockRename = jest.fn();
const mockGetRootDir = jest.fn();
const mockGetActiveInstance = jest.fn();
const mockLoadCredentials = jest.fn();

jest.unstable_mockModule("../appUtils.js", () => ({
  checkScope: (...args: unknown[]) => mockCheckScope(...args),
  getAppFileList: (...args: unknown[]) => mockGetAppFileList(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
  createAndAssignUpdateSet: (...args: unknown[]) => mockCreateAndAssignUpdateSet(...args),
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  gitDiffToEncodedPaths: (...args: unknown[]) => mockGitDiffToEncodedPaths(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    success: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    silly: jest.fn(),
    getInternalLogger: () => ({ error: (...args: unknown[]) => mockInternalError(...args) }),
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
  getScopedEndpointPrefix: (...args: unknown[]) => mockGetScopedEndpointPrefix(...args),
  setActiveInstanceProfile: (...args: unknown[]) => mockSetActiveInstanceProfile(...args),
}));

jest.unstable_mockModule("../auth.js", () => ({
  getActiveInstance: (...args: unknown[]) => mockGetActiveInstance(...args),
  loadCredentials: (...args: unknown[]) => mockLoadCredentials(...args),
}));

jest.unstable_mockModule("../config.js", () => ({
  getRootDir: (...args: unknown[]) => mockGetRootDir(...args),
}));

// fs is a CommonJS core module, so requireActual loads it synchronously. Spread
// the real surface (some graph modules do `import fs from "fs"` / named imports
// like `readFileSync`) and override only the promises used by the SUT so every
// ENOENT/EEXIST/EACCES branch is deterministic and no write leaves the process.
jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const promises = {
    ...actual.promises,
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    rename: (...args: unknown[]) => mockRename(...args),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: {
    prompt: (...args: unknown[]) => mockPrompt(...args),
  },
}));

// The SUT is imported dynamically AFTER the module mocks are registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the
// real appUtils/config (which run real code and throw "Error getting manifest")
// before the mocks take effect.
let pushCommand: typeof import("../pushCommand.js").pushCommand;
let __lockInternals: typeof import("../pushCommand.js").__lockInternals;

beforeAll(async () => {
  ({ pushCommand, __lockInternals } = await import("../pushCommand.js"));
});

const enoent = () => Object.assign(new Error("not found"), { code: "ENOENT" });
const eexist = () => Object.assign(new Error("exists"), { code: "EEXIST" });
const eacces = () => Object.assign(new Error("denied"), { code: "EACCES" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rec = (sysId: string) => ({ table: "sys_script", sysId, fields: { script: { filePath: `/tmp/${sysId}.js` } } }) as any;

const runPush = (overrides: Record<string, unknown> = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pushCommand({
    logLevel: "info",
    ci: true,
    target: "encoded:/tmp/a.js",
    diff: "",
    scopeSwap: false,
    updateSet: "",
    ...overrides,
  } as any);

describe("pushCommand lock/checkpoint internals (mocked fs)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRootDir.mockReturnValue("/tmp/project");
    mockUnlink.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(enoent());
    mockRename.mockResolvedValue(undefined);
  });

  it("getStateBaseDir falls back to cwd when no config root is loaded", () => {
    mockGetRootDir.mockImplementation(() => {
      throw new Error("no config loaded");
    });
    const lockPath = __lockInternals.getCollaborationLockPath();
    expect(lockPath).toContain(process.cwd());
    expect(lockPath).toContain("sync.collaboration.lock.json");
  });

  it("loadCollaborationLock returns null for a shape-invalid payload", async () => {
    // Valid JSON but missing the required command/createdAt string fields.
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ pid: 1 }));
    await expect(__lockInternals.loadCollaborationLock()).resolves.toBeNull();
  });

  it("loadCollaborationLock swallows a non-ENOENT read error and returns null", async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("is dir"), { code: "EISDIR" }));
    await expect(__lockInternals.loadCollaborationLock()).resolves.toBeNull();
  });

  it("acquireCollaborationLock re-throws a non-EEXIST write error", async () => {
    mockWriteFile.mockRejectedValueOnce(eacces());
    await expect(__lockInternals.acquireCollaborationLock("push")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("gives up after both attempts lose to a repeatedly stale lock", async () => {
    // Every atomic create hits EEXIST; the existing lock is always stale (dead
    // pid), so it is reclaimed and retried — but after two rounds acquire returns
    // the "could not acquire" fallback rather than looping forever.
    mockWriteFile.mockRejectedValue(eexist());
    mockReadFile.mockResolvedValue(
      JSON.stringify({ command: "push", pid: 2 ** 22, createdAt: new Date().toISOString() })
    );

    const result = await __lockInternals.acquireCollaborationLock("push");
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("Could not acquire collaboration lock.");
    // Two atomic-create attempts, each followed by an atomic stale-lock reclaim:
    // rename the lock aside, confirm it is stale, then unlink the moved-aside file.
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockRename).toHaveBeenCalledTimes(2);
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    // Each unlink targets the reclaim sidecar, never the live lock path directly.
    for (const call of mockUnlink.mock.calls) {
      expect(String(call[0])).toContain(".reclaim");
    }
  });

  it("releaseCollaborationLock re-throws a non-ENOENT unlink error", async () => {
    mockUnlink.mockRejectedValueOnce(eacces());
    await expect(__lockInternals.releaseCollaborationLock()).rejects.toMatchObject({
      code: "EACCES",
    });
  });
});

describe("pushCommand orchestration branches (mocked fs)", () => {
  const originalInstance = process.env.SN_INSTANCE;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    jest.clearAllMocks();
    // Establish a clean exit-code baseline: another suite may run first in the
    // same worker and leave process.exitCode set, which would otherwise make
    // the "does not fail" assertions order-dependent.
    process.exitCode = undefined;
    process.env.SN_INSTANCE = "instance.service-now.com";
    mockCheckScope.mockResolvedValue({ match: true });
    mockGetRootDir.mockReturnValue("/tmp/project");
    mockGetScopedEndpointPrefix.mockReturnValue("x_nuvo_sinc");
    mockCheckConnection.mockResolvedValue(undefined);
    mockGetAppFileList.mockResolvedValue([rec("1")]);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);
    mockPrompt.mockResolvedValue({ confirmed: true });
    mockGitDiffToEncodedPaths.mockResolvedValue(["encoded:/tmp/from-diff.js"]);
    mockCreateAndAssignUpdateSet.mockResolvedValue({ name: "MySet", id: "us-123" });
    mockGetActiveInstance.mockResolvedValue(null);
    mockLoadCredentials.mockResolvedValue({});
    mockResolveCredentials.mockImplementation(() => ({
      instance: process.env.SN_INSTANCE || "",
      user: "u",
      password: "p",
      profile: undefined,
    }));
    mockReadFile.mockRejectedValue(enoent());
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.SN_INSTANCE = originalInstance;
    process.exitCode = originalExitCode;
  });

  it("surfaces the decrypt warning when no server is configured but a stored instance won't decrypt", async () => {
    delete process.env.SN_INSTANCE;
    mockResolveCredentials.mockReturnValue({ instance: "", user: "", password: "", profile: undefined });
    // A stored instance exists but its credentials fail to decrypt → warning.
    mockGetActiveInstance.mockResolvedValue("dev");
    mockLoadCredentials.mockRejectedValue(new Error("bad key"));

    await runPush();

    expect(mockLoggerError).toHaveBeenCalledWith("No server configured for push!");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Stored credentials for "dev" failed to decrypt')
    );
    expect(process.exitCode).toBe(1);
    expect(mockCheckConnection).not.toHaveBeenCalled();
  });

  it("derives encoded paths from the git diff when no target is provided", async () => {
    await runPush({ target: "" });

    expect(mockGitDiffToEncodedPaths).toHaveBeenCalledWith("");
    expect(mockGetAppFileList).toHaveBeenCalledWith(["encoded:/tmp/from-diff.js"]);
    expect(mockPushFiles).toHaveBeenCalled();
  });

  it("clears the checkpoint when the user declines to resume a failed run", async () => {
    // An existing checkpoint with failures + an interactive decline must wipe the
    // stale checkpoint (unlink) instead of resuming it.
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:1"],
          succeeded: [],
          failed: ["sys_script:1"],
          instance: "instance.service-now.com",
        });
      }
      throw enoent();
    });
    mockPrompt.mockResolvedValueOnce({ confirmed: false });

    await runPush({ ci: false });

    const unlinked = mockUnlink.mock.calls.map((c) => String(c[0]));
    expect(unlinked.some((p) => p.includes("sync.push.checkpoint.json"))).toBe(true);
    expect(mockPushFiles).toHaveBeenCalled();
  });

  it("under --ci, ignores a stale checkpoint whose failed records are not in the current diff and pushes the full diff (Finding 2)", async () => {
    // Reused CI workspace: a leftover checkpoint from an earlier commit failed on
    // sys_script:99, which is NOT part of the current diff (sys_script:1). The old
    // code auto-resumed it, filtered the push down to the empty intersection,
    // cleared the checkpoint and exited 0 — silently dropping the intended push.
    mockGetAppFileList.mockResolvedValue([rec("1")]);
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:99"],
          succeeded: [],
          failed: ["sys_script:99"],
          instance: "instance.service-now.com",
        });
      }
      throw enoent();
    });

    await runPush(); // ci: true

    // The unrelated checkpoint is discarded with a warning...
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring an unrelated push checkpoint")
    );
    // ...and the FULL current diff is pushed, not the empty intersection.
    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    const pushed = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    expect(pushed.map((r) => r.sysId)).toEqual(["1"]);
  });

  it("under --ci, resumes only the failed records when the checkpoint matches the current diff (Finding 2)", async () => {
    // The checkpoint's failed key (sys_script:2) is part of the current diff
    // (sys_script:1 + sys_script:2), so auto-resume is legitimate: only the
    // previously-failed record is retried.
    mockGetAppFileList.mockResolvedValue([rec("1"), rec("2")]);
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:1", "sys_script:2"],
          succeeded: ["sys_script:1"],
          failed: ["sys_script:2"],
          instance: "instance.service-now.com",
        });
      }
      throw enoent();
    });

    await runPush();

    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    const pushed = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    expect(pushed.map((r) => r.sysId)).toEqual(["2"]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Resuming from checkpoint with 1 records")
    );
  });

  it("under --ci, discards the checkpoint and pushes the full diff when the diff grew since the checkpoint (Finding 1)", async () => {
    // The checkpoint attempted/failed only sys_script:1, but the current diff now
    // ALSO contains a brand-new sys_script:2. Resuming "only failed" would filter
    // the push down to sys_script:1 and silently never push the new sys_script:2
    // (while still exiting 0). The checkpoint must be discarded and the full
    // current diff pushed instead.
    mockGetAppFileList.mockResolvedValue([rec("1"), rec("2")]);
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:1"],
          succeeded: [],
          failed: ["sys_script:1"],
          instance: "instance.service-now.com",
        });
      }
      throw enoent();
    });

    await runPush(); // ci: true

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring an unrelated push checkpoint")
    );
    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    const pushed = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    expect(pushed.map((r) => r.sysId)).toEqual(["1", "2"]);
  });

  it("under --ci, discards a checkpoint written for a different instance and pushes the full diff (Finding 7)", async () => {
    // The checkpoint's failed record IS part of the current diff, but it was
    // written while pushing to a DIFFERENT instance. Resuming "only failed"
    // against the current instance would push a wrong partial set. The checkpoint
    // must be discarded and the full current diff pushed to this instance.
    mockGetAppFileList.mockResolvedValue([rec("1"), rec("2")]);
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:1", "sys_script:2"],
          succeeded: ["sys_script:1"],
          failed: ["sys_script:2"],
          instance: "other.service-now.com",
        });
      }
      throw enoent();
    });

    await runPush(); // ci: true, targets instance.service-now.com

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring an unrelated push checkpoint")
    );
    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    const pushed = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    expect(pushed.map((r) => r.sysId)).toEqual(["1", "2"]);
  });

  it("records the target instance in the checkpoint it writes (Finding 7)", async () => {
    // The written checkpoint must carry the instance it was pushed against so a
    // later run on a different instance can recognise and discard it.
    mockGetAppFileList.mockResolvedValue([rec("1")]);
    // Keep at least one failure so the checkpoint is written and NOT cleared,
    // making the persisted payload observable.
    mockPushFiles.mockResolvedValue([{ success: false, message: "boom" }]);

    await runPush(); // ci: true

    const checkpointWrites = mockWriteFile.mock.calls.filter((c) =>
      String(c[0]).includes("sync.push.checkpoint.json")
    );
    expect(checkpointWrites.length).toBeGreaterThan(0);
    for (const call of checkpointWrites) {
      const payload = JSON.parse(String(call[1]));
      expect(payload.instance).toBe("instance.service-now.com");
    }
  });

  it("ignores a shape-invalid checkpoint file and pushes normally", async () => {
    // Valid JSON but the arrays are missing → loadPushCheckpoint returns null,
    // so the run behaves as if there were no checkpoint at all.
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({ attempted: "not-an-array" });
      }
      throw enoent();
    });

    await runPush();

    expect(mockPushFiles).toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
  });

  it("swallows a non-ENOENT checkpoint read error and pushes normally", async () => {
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        throw eacces();
      }
      throw enoent();
    });

    await runPush();

    expect(mockPushFiles).toHaveBeenCalled();
  });

  it("fails the run when clearing a declined checkpoint hits a non-ENOENT unlink error", async () => {
    // Existing failed checkpoint + declined resume → clearPushCheckpoint runs and
    // its unlink rejects with EACCES, which must propagate (not be swallowed) and
    // fail the shell via the outer catch.
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:1"],
          succeeded: [],
          failed: ["sys_script:1"],
          instance: "instance.service-now.com",
        });
      }
      throw enoent();
    });
    mockPrompt.mockResolvedValueOnce({ confirmed: false });
    mockUnlink.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        throw eacces();
      }
      return undefined;
    });

    await runPush({ ci: false });

    expect(mockInternalError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("creates the update set after the confirm prompts are accepted", async () => {
    // Overwrite prompt + update-set prompt both accepted → the update set is
    // created and its details are logged.
    mockPrompt.mockResolvedValue({ confirmed: true });

    await runPush({ ci: false, updateSet: "MySet" });

    expect(mockCreateAndAssignUpdateSet).toHaveBeenCalledWith("MySet");
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      expect.stringContaining("New Update Set Created(MySet) sys_id:us-123")
    );
    expect(mockPushFiles).toHaveBeenCalled();
  });

  it("aborts before creating an update set when its confirm prompt is declined", async () => {
    // First prompt (overwrite) accepted, second prompt (update-set) declined.
    mockPrompt
      .mockResolvedValueOnce({ confirmed: true })
      .mockResolvedValueOnce({ confirmed: false });

    await runPush({ ci: false, updateSet: "MySet" });

    expect(mockCreateAndAssignUpdateSet).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("skips the update-set prompt under --ci but still creates the set", async () => {
    // skipPrompt short-circuits both confirmations; the set is still created.
    await runPush({ ci: true, updateSet: "MySet" });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockCreateAndAssignUpdateSet).toHaveBeenCalledWith("MySet");
    expect(mockPushFiles).toHaveBeenCalled();
  });
});
