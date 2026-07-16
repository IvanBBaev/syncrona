// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";

const mockLogFilePush = jest.fn();
const mockGroupAppFiles = jest.fn();
const mockPushFiles = jest.fn();
const mockGetFileContextFromPath = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
const mockWatch = jest.fn();
const mockClose = jest.fn();

type WatchHandler = (payload: string | Error) => void;
let handlers: Record<string, WatchHandler | undefined> = {};
const changeHandler = (path: string) => handlers["change"]!(path);
const addHandler = (path: string) => handlers["add"]!(path);
const unlinkHandler = (path: string) => handlers["unlink"]!(path);
const errorHandler = (error: Error) => handlers["error"]!(error);

jest.unstable_mockModule("./../logMessages.js", () => ({
  logFilePush: (...args: unknown[]) => mockLogFilePush(...args),
}));

jest.unstable_mockModule("./../appUtils.js", () => ({
  groupAppFiles: (...args: unknown[]) => mockGroupAppFiles(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
}));

jest.unstable_mockModule("./../FileUtils.js", () => ({
  getFileContextFromPath: (...args: unknown[]) => mockGetFileContextFromPath(...args),
}));

jest.unstable_mockModule("./../Logger.js", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));

jest.unstable_mockModule("chokidar", () => ({
  __esModule: true,
  default: {
    watch: (...args: unknown[]) => mockWatch(...args),
  },
}));

const ctx = (
  filePath: string,
  tableName: string,
  sysId: string,
  targetField: string
): Sync.FileContext => ({
  filePath,
  name: filePath,
  tableName,
  targetField,
  ext: ".js",
  sys_id: sysId,
  scope: "x_nuvo_test",
});

const flushDrain = async (): Promise<void> => {
  jest.advanceTimersByTime(350);
  await Promise.resolve();
  await Promise.resolve();
};

// NOTE on ordering: Watcher.ts keeps its push queue in module state shared by
// every test in this file. The failing-push test intentionally leaves the
// failed batch REQUEUED (that is the behavior under test), so it must stay the
// LAST test here — anything after it would observe the leftover queue entry.
describe("Watcher queue behavior", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    handlers = {};

    const watcherInstance: {
      on: jest.Mock;
      close: jest.Mock;
    } = {
      on: jest.fn(),
      close: mockClose,
    };

    watcherInstance.on.mockImplementation((event: string, cb: WatchHandler) => {
        handlers[event] = cb;
        return watcherInstance;
      });

    mockWatch.mockReturnValue(watcherInstance);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("watches with ignoreInitial and awaitWriteFinish so startup scans and half-written saves are not pushed", async () => {
    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");

    expect(mockWatch).toHaveBeenCalledWith(
      "/tmp",
      expect.objectContaining({
        ignoreInitial: true,
        awaitWriteFinish: expect.objectContaining({
          stabilityThreshold: expect.any(Number),
          pollInterval: expect.any(Number),
        }),
      })
    );
    // All four blind-spot events are subscribed.
    expect(handlers["change"]).toBeDefined();
    expect(handlers["add"]).toBeDefined();
    expect(handlers["unlink"]).toBeDefined();
    expect(handlers["error"]).toBeDefined();

    stopWatching();
  });

  it("logs push results using buildable-to-context mapping after grouping", async () => {
    const rec1Script = ctx("/tmp/rec1.script.js", "sys_script", "rec_1", "script");
    const rec1Condition = ctx("/tmp/rec1.condition.js", "sys_script", "rec_1", "condition");
    const rec2Script = ctx("/tmp/rec2.script.js", "sys_script", "rec_2", "script");

    const pathMap: Record<string, Sync.FileContext | undefined> = {
      "/tmp/rec1.script.js": rec1Script,
      "/tmp/rec1.condition.js": rec1Condition,
      "/tmp/rec2.script.js": rec2Script,
    };

    mockGetFileContextFromPath.mockImplementation((path: string) => pathMap[path]);
    mockGroupAppFiles.mockReturnValue([
      { table: "sys_script", sysId: "rec_1", fields: {} },
      { table: "sys_script", sysId: "rec_2", fields: {} },
    ]);

    const res1 = { success: true, message: "ok-1" };
    const res2 = { success: false, message: "ok-2" };
    mockPushFiles.mockResolvedValue([res1, res2]);

    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    expect(handlers["change"]).toBeDefined();

    changeHandler("/tmp/rec1.script.js");
    changeHandler("/tmp/rec1.condition.js");
    changeHandler("/tmp/rec2.script.js");

    await flushDrain();

    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    expect(mockLogFilePush).toHaveBeenCalledTimes(2);
    expect(mockLogFilePush).toHaveBeenNthCalledWith(1, rec1Script, res1);
    expect(mockLogFilePush).toHaveBeenNthCalledWith(2, rec2Script, res2);
    // Multi-file drain surfaces its queue depth (3 files in this batch).
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Pushing 3 queued file changes."
    );

    stopWatching();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("does not log queue depth when draining a single file", async () => {
    const rec1Script = ctx("/tmp/rec1.script.js", "sys_script", "rec_1", "script");
    mockGetFileContextFromPath.mockReturnValue(rec1Script);
    mockGroupAppFiles.mockReturnValue([
      { table: "sys_script", sysId: "rec_1", fields: {} },
    ]);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);

    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    changeHandler("/tmp/rec1.script.js");

    await flushDrain();

    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).not.toHaveBeenCalled();

    stopWatching();
  });

  it("enqueues an added file that the manifest already tracks", async () => {
    // e.g. a tracked file restored via `git checkout` fires "add", not
    // "change" — it must sync exactly like a change.
    const rec1Script = ctx("/tmp/rec1.script.js", "sys_script", "rec_1", "script");
    mockGetFileContextFromPath.mockReturnValue(rec1Script);
    mockGroupAppFiles.mockReturnValue([
      { table: "sys_script", sysId: "rec_1", fields: {} },
    ]);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);

    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    addHandler("/tmp/rec1.script.js");

    await flushDrain();

    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();

    stopWatching();
  });

  it("warns instead of pushing when an added file is not tracked by the manifest", async () => {
    // drainQueue would silently drop an untracked path (no manifest context),
    // so the handler must tell the user how to register the new file.
    mockGetFileContextFromPath.mockReturnValue(undefined);

    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    addHandler("/tmp/brand-new.script.js");

    await flushDrain();

    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("not tracked by the manifest")
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("syncrona refresh")
    );

    stopWatching();
  });

  it("treats an added file as untracked when the manifest lookup throws", async () => {
    // getFileContextFromPath throws "No manifest has been loaded!" when no
    // manifest is present; the add handler must not crash the watcher.
    mockGetFileContextFromPath.mockImplementation(() => {
      throw new Error("No manifest has been loaded!");
    });

    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    expect(() => addHandler("/tmp/brand-new.script.js")).not.toThrow();

    await flushDrain();

    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("not tracked by the manifest")
    );

    stopWatching();
  });

  it("warns on unlink that delete propagation is unsupported and pushes nothing", async () => {
    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    unlinkHandler("/tmp/rec1.script.js");

    await flushDrain();

    expect(mockPushFiles).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("delete propagation is not supported")
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("syncrona repair")
    );

    stopWatching();
  });

  it("logs an actionable message on watcher error and keeps the process alive", async () => {
    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    expect(() => errorHandler(new Error("EMFILE: too many open files"))).not.toThrow();

    expect(mockLoggerError).toHaveBeenCalledWith(
      "File watcher error: EMFILE: too many open files"
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("local changes may silently stop syncing")
    );

    stopWatching();
  });

  it("stringifies non-Error watcher error payloads", async () => {
    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    // chokidar types promise an Error, but defensive stringification keeps
    // the log useful if a raw value ever surfaces from the fs layer.
    handlers["error"]!("raw failure" as unknown as Error);

    expect(mockLoggerError).toHaveBeenCalledWith(
      "File watcher error: raw failure"
    );

    stopWatching();
  });

  it("self-drives a retry of a requeued batch with no further fs events (Finding 9)", async () => {
    // A push fails once, then recovers. Crucially, NO further change/add event
    // is fired after the failure — the drain must schedule its own retry, or
    // the requeued path would strand forever. This proves the retry is
    // self-driving rather than dependent on an unrelated future file event.
    const rec1Script = ctx("/tmp/rec1.script.js", "sys_script", "rec_1", "script");
    mockGetFileContextFromPath.mockReturnValue(rec1Script);
    mockGroupAppFiles.mockReturnValue([
      { table: "sys_script", sysId: "rec_1", fields: {} },
    ]);
    const recovered = { success: true, message: "recovered" };
    mockPushFiles
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue([recovered]);

    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    changeHandler("/tmp/rec1.script.js");

    // First drain fails; the batch is requeued and a backoff retry is armed.
    await flushDrain();
    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith("Watcher queue processing failed");
    expect(mockLogFilePush).not.toHaveBeenCalled();

    // Let the self-scheduled backoff retry (RETRY_BASE_MS = 500) fire with no
    // intervening fs event. The recovered push must run and report success.
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPushFiles).toHaveBeenCalledTimes(2);
    expect(mockLogFilePush).toHaveBeenCalledTimes(1);
    expect(mockLogFilePush).toHaveBeenCalledWith(rec1Script, recovered);

    stopWatching();
  });

  // Keep this test LAST: it deliberately leaves the failed batch requeued in
  // the module-level push queue (see the ordering note above the describe).
  it("does not throw when queue processing fails and logs error", async () => {
    const rec1Script = ctx("/tmp/rec1.script.js", "sys_script", "rec_1", "script");
    mockGetFileContextFromPath.mockReturnValue(rec1Script);
    mockGroupAppFiles.mockReturnValue([
      { table: "sys_script", sysId: "rec_1", fields: {} },
    ]);
    mockPushFiles.mockRejectedValue(new Error("kaboom"));

    const { startWatching, stopWatching } = await import("../Watcher.js");

    startWatching("/tmp");
    expect(handlers["change"]).toBeDefined();

    changeHandler("/tmp/rec1.script.js");

    await flushDrain();

    expect(mockLoggerError).toHaveBeenCalledWith("Watcher queue processing failed");
    expect(mockLoggerError).toHaveBeenCalledWith("kaboom");

    stopWatching();
  });
});
