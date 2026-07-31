// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import path from "path";
export {};

// Closes the pushCommand.ts branches the flow/lock suites leave uncovered:
//  - getStateBaseDir's cwd fallback when no config root is loaded,
//  - loadPushCheckpoint rejecting a shape-invalid payload and swallowing a
//    non-ENOENT read error,
//  - clearPushCheckpoint / releaseCollaborationLock re-throwing a non-ENOENT
//    unlink error,
//  - loadCollaborationLock rejecting an invalid object and swallowing errors,
//  - acquireCollaborationLock re-throwing a non-EEXIST write error and giving up
//    after every atomic-create attempt loses to a lock that keeps coming back,
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
const mockLink = jest.fn();
const mockReaddir = jest.fn();
const mockStat = jest.fn();
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
    // REV-233: the lock and its eviction claims are no longer written in place.
    // They are staged under a private name and published with link(), and the
    // post-acquire sweep walks the state directory — so the seam has to answer
    // link/readdir/stat as well, or every acquire aborts before it starts.
    link: (...args: unknown[]) => mockLink(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
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

const LOCK_FILE_NAME = "sync.collaboration.lock.json";
const LOCK_PATH = path.join("/tmp/project", LOCK_FILE_NAME);

// An in-memory filesystem for the collaboration-lock family of files.
//
// The lock suite below cannot script an exact syscall sequence any more: one
// acquire now writes a staging file, links it into place, unlinks the staging
// file and lists the directory, and an eviction adds three more calls on a path
// derived from the lock's own bytes. Modelling that as ordered mock returns is
// both unreadable and brittle. A path→content map instead lets each test state
// the situation it means — "a stale lock is already there" — and assert the
// logical outcome, while still exercising link()'s real contract: it publishes
// an already-complete file and fails EEXIST rather than overwriting.
const collabFiles = new Map<string, string>();
const isCollabPath = (target: unknown): boolean =>
  String(target).includes("sync.collaboration.");

function installCollaborationFs(): void {
  collabFiles.clear();
  mockReadFile.mockImplementation((target: unknown) =>
    collabFiles.has(String(target))
      ? Promise.resolve(collabFiles.get(String(target)))
      : Promise.reject(enoent())
  );
  mockStat.mockImplementation((target: unknown) =>
    collabFiles.has(String(target))
      ? Promise.resolve({ mtimeMs: Date.now() })
      : Promise.reject(enoent())
  );
  mockWriteFile.mockImplementation((target: unknown, data: unknown) => {
    if (isCollabPath(target)) {
      collabFiles.set(String(target), String(data));
    }
    return Promise.resolve(undefined);
  });
  mockLink.mockImplementation((from: unknown, to: unknown) => {
    if (collabFiles.has(String(to))) {
      return Promise.reject(eexist());
    }
    if (!collabFiles.has(String(from))) {
      return Promise.reject(enoent());
    }
    collabFiles.set(String(to), collabFiles.get(String(from)) as string);
    return Promise.resolve(undefined);
  });
  mockUnlink.mockImplementation((target: unknown) => {
    collabFiles.delete(String(target));
    return Promise.resolve(undefined);
  });
  mockReaddir.mockImplementation((dir: unknown) =>
    Promise.resolve(
      [...collabFiles.keys()]
        .filter((entry) => path.dirname(entry) === String(dir))
        .map((entry) => path.basename(entry))
    )
  );
}

 
const rec = (sysId: string) => ({ table: "sys_script", sysId, fields: { script: { filePath: `/tmp/${sysId}.js` } } }) as any;

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

describe("pushCommand lock/checkpoint internals (mocked fs)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRootDir.mockReturnValue("/tmp/project");
    installCollaborationFs();
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

  it("acquireCollaborationLock re-throws a non-EEXIST publish error and still clears its staging file", async () => {
    // REV-233 publishes the lock with link(), and EEXIST is the one failure that
    // means something benign: someone else got there first. Anything else — a
    // read-only tree, a permission problem — is a real failure the caller must
    // see. Reading it as "lost the race" would send acquire into its retry loop
    // and end in a misleading "could not acquire" for a filesystem fault.
    mockLink.mockRejectedValueOnce(eacces());

    await expect(__lockInternals.acquireCollaborationLock("push")).rejects.toMatchObject({
      code: "EACCES",
    });

    // The staging file is cleaned up on the failure path too, so a tree that
    // recovers is not left carrying litter nobody will ever claim.
    expect([...collabFiles.keys()]).toEqual([]);
  });

  it("gives up after every attempt loses to a lock that keeps coming back", async () => {
    // Worst case for the retry loop: the lock in the path is always stale (dead
    // pid), so every round evicts it successfully — and a collaborator restarting
    // its push in a tight loop puts a fresh one back before the next atomic create
    // reaches the path. Acquire must terminate with the honest failure rather than
    // spin, and must leave no eviction litter behind on the way out.
    const stale = JSON.stringify({
      command: "push",
      pid: 2 ** 22,
      createdAt: new Date().toISOString(),
    });
    collabFiles.set(LOCK_PATH, stale);
    mockUnlink.mockImplementation((target: unknown) => {
      collabFiles.delete(String(target));
      if (String(target) === LOCK_PATH) {
        collabFiles.set(LOCK_PATH, stale);
      }
      return Promise.resolve(undefined);
    });

    const result = await __lockInternals.acquireCollaborationLock("push");

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("Could not acquire collaboration lock.");
    // One atomic create per round, every one of them losing to the lock in place.
    expect(mockLink.mock.calls.filter((call) => String(call[1]) === LOCK_PATH)).toHaveLength(4);
    // Every eviction claim it won was released again, and every staging file it
    // wrote was cleaned up: only the collaborator's lock is left.
    expect([...collabFiles.keys()]).toEqual([LOCK_PATH]);
  });

  it("releaseCollaborationLock re-throws a non-ENOENT unlink error", async () => {
    // Release is ownership-checked (REV-205) and removes the lock through the same
    // eviction claim the acquire path uses (REV-233), so it only reaches the lock's
    // own unlink for a lock it still holds — which is why it has to acquire first.
    expect((await __lockInternals.acquireCollaborationLock("push")).acquired).toBe(true);
    mockUnlink.mockImplementation((target: unknown) => {
      if (String(target) === LOCK_PATH) {
        return Promise.reject(eacces());
      }
      collabFiles.delete(String(target));
      return Promise.resolve(undefined);
    });

    await expect(__lockInternals.releaseCollaborationLock()).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("releaseCollaborationLock leaves a lock it does not own in place", async () => {
    // A lock whose owner token is not ours (a collaborator reclaimed the path
    // while our long push was still running) must never be removed.
    expect((await __lockInternals.acquireCollaborationLock("push")).acquired).toBe(true);
    const foreign = JSON.stringify({
      command: "push",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      owner: "someone-else",
    });
    collabFiles.set(LOCK_PATH, foreign);

    await expect(__lockInternals.releaseCollaborationLock()).resolves.toBeUndefined();

    expect(collabFiles.get(LOCK_PATH)).toBe(foreign);
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
    // These branches are about the orchestration around the lock, not the lock
    // itself, so the seam is the permissive one: the staging link always lands
    // (the lock is always free) and the post-acquire sweep finds nothing.
    mockLink.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockRejectedValue(enoent());
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

  it("fails the shell when the instance cannot be reached, before touching any record", async () => {
    // #3: an unreachable instance must fail the shell rather than report success,
    // and #49: the hint has to classify the real reason instead of hardcoding
    // SN_* advice. Nothing may be pushed and no update set created on the way out.
    mockCheckConnection.mockRejectedValue(
      Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })
    );

    await runPush();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unable to reach ServiceNow instance instance.service-now.com")
    );
    expect(process.exitCode).toBe(1);
    expect(mockGetAppFileList).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(mockCreateAndAssignUpdateSet).not.toHaveBeenCalled();
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

  it("re-pushes a succeeded record whose content changed after the checkpoint was written", async () => {
    // sys_script:1 succeeded and sys_script:2 failed, so the checkpoint matches
    // the current diff and auto-resume is legitimate. But sys_script:1's source
    // has been edited since: its recorded fingerprint no longer describes the
    // file on disk. Skipping it on table:sysId identity alone (the old rule)
    // meant the edit never reached the instance while the run still exited 0.
    mockGetAppFileList.mockResolvedValue([rec("1"), rec("2")]);
    mockPushFiles.mockResolvedValue([
      { success: true, message: "ok" },
      { success: true, message: "ok" },
    ]);
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:1", "sys_script:2"],
          succeeded: ["sys_script:1"],
          failed: ["sys_script:2"],
          instance: "instance.service-now.com",
          fingerprints: {
            "sys_script:1": "fingerprint-of-the-superseded-content",
            "sys_script:2": "fingerprint-of-the-superseded-content",
          },
        });
      }
      return "// the current, edited source";
    });

    await runPush();

    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    const pushed = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    expect(pushed.map((r) => r.sysId)).toEqual(["1", "2"]);
  });

  it("still skips a succeeded record whose content is unchanged since the checkpoint", async () => {
    // Round-trip: the checkpoint fed back to the second run is exactly the one
    // the first run wrote, so the fingerprints are real rather than hand-made.
    // With the sources untouched, resume must still narrow to the failed record.
    mockGetAppFileList.mockResolvedValue([rec("1"), rec("2")]);
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        throw enoent();
      }
      return "// unchanged source";
    });
    mockPushFiles.mockResolvedValue([
      { success: true, message: "ok" },
      { success: false, message: "boom" },
    ]);

    await runPush();

    const checkpoint = mockWriteFile.mock.calls
      .filter((c) => String(c[0]).includes("sync.push.checkpoint.json"))
      .map((c) => String(c[1]))
      .pop() as string;
    expect(JSON.parse(checkpoint).succeeded).toEqual(["sys_script:1"]);

    mockPushFiles.mockClear();
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return checkpoint;
      }
      return "// unchanged source";
    });

    await runPush();

    const pushed = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    expect(pushed.map((r) => r.sysId)).toEqual(["2"]);
  });

  it("fails the shell when --ci aborts on a collaboration lock conflict (Finding 9)", async () => {
    // The atomic create loses to an existing lock that is fresh and whose owning
    // process is alive, so it is not stale and cannot be reclaimed. The push is
    // aborted having pushed nothing — which must fail the shell rather than
    // report a green, no-op deployment to CI.
    mockLink.mockImplementation(async (_from: string, to: string) => {
      if (String(to).endsWith("sync.collaboration.lock.json")) {
        throw eexist();
      }
      return undefined;
    });
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("sync.collaboration.lock.json")) {
        return JSON.stringify({
          command: "push",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        });
      }
      throw enoent();
    });

    await runPush();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("collaboration lock conflict")
    );
    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("dry run never deletes another run's checkpoint (Finding 10)", async () => {
    // A checkpoint left by a partially-failed push against ANOTHER instance is
    // not resumable here, but a read-only preview is not the run that gets to
    // discard it: unlinking it during a dry run destroys resume state a later
    // real push against that instance would have used.
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).includes("sync.push.checkpoint.json")) {
        return JSON.stringify({
          attempted: ["sys_script:99"],
          succeeded: [],
          failed: ["sys_script:99"],
          instance: "other.service-now.com",
        });
      }
      throw enoent();
    });

    await runPush({ dryRun: true });

    const unlinked = mockUnlink.mock.calls.map((c) => String(c[0]));
    expect(unlinked.some((p) => p.includes("sync.push.checkpoint.json"))).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  it("dry run with a matching checkpoint neither prompts nor narrows the preview (Finding 10)", async () => {
    // An interactive dry run must not block on the resume prompt, and its
    // preview must describe the full current diff rather than the subset some
    // future resume might choose.
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

    await runPush({ ci: false, dryRun: true });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith("2 files to push.");
    expect(mockUnlink).not.toHaveBeenCalled();
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

  // Ctrl-C at the overwrite prompt rejects (inquirer 14 raises ExitPromptError
  // instead of killing the process). The catch treated it as a push failure:
  // an error banner plus exit 1, which reads as "the push broke" in CI. A
  // cancellation is 130 (SIGINT), with nothing logged as an error.
  it("exits 130 without an error banner when a prompt is cancelled", async () => {
    mockPrompt.mockImplementation(async () => {
      const abort = new Error("User force closed the prompt with 0 null");
      abort.name = "ExitPromptError";
      throw abort;
    });

    await runPush({ ci: false });

    expect(process.exitCode).toBe(130);
    expect(mockInternalError).not.toHaveBeenCalled();
    expect(mockPushFiles).not.toHaveBeenCalled();
  });

  // The catch used to hand the raw Error object to the internal logger, which
  // renders it as "{}"/"[object Object]" depending on the transport — so the
  // reason a push failed was invisible. Log the message instead.
  it("logs the failure message, not the raw Error object", async () => {
    mockGetAppFileList.mockRejectedValue(new Error("boom: table not found"));

    await runPush();

    expect(process.exitCode).toBe(1);
    expect(mockInternalError).toHaveBeenCalledWith("boom: table not found");
  });
});
