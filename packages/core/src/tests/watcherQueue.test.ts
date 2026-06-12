import { Sync } from "@syncrona/types";

const mockLogFilePush = jest.fn();
const mockGroupAppFiles = jest.fn();
const mockPushFiles = jest.fn();
const mockGetFileContextFromPath = jest.fn();
const mockLoggerError = jest.fn();
const mockWatch = jest.fn();
const mockClose = jest.fn();

let changeHandler: ((path: string) => void) | undefined;

jest.mock("./../logMessages", () => ({
  logFilePush: (...args: unknown[]) => mockLogFilePush(...args),
}));

jest.mock("./../appUtils", () => ({
  groupAppFiles: (...args: unknown[]) => mockGroupAppFiles(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
}));

jest.mock("./../FileUtils", () => ({
  getFileContextFromPath: (...args: unknown[]) => mockGetFileContextFromPath(...args),
}));

jest.mock("./../Logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

jest.mock("chokidar", () => ({
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

describe("Watcher queue behavior", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    changeHandler = undefined;

    const watcherInstance: {
      on: jest.Mock;
      close: jest.Mock;
    } = {
      on: jest.fn(),
      close: mockClose,
    };

    watcherInstance.on.mockImplementation((event: string, cb: (path: string) => void) => {
        if (event === "change") {
          changeHandler = cb;
        }
        return watcherInstance;
      });

    mockWatch.mockReturnValue(watcherInstance);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
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

    const { startWatching, stopWatching } = await import("../Watcher");

    startWatching("/tmp");
    expect(changeHandler).toBeDefined();

    changeHandler!("/tmp/rec1.script.js");
    changeHandler!("/tmp/rec1.condition.js");
    changeHandler!("/tmp/rec2.script.js");

    jest.advanceTimersByTime(350);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPushFiles).toHaveBeenCalledTimes(1);
    expect(mockLogFilePush).toHaveBeenCalledTimes(2);
    expect(mockLogFilePush).toHaveBeenNthCalledWith(1, rec1Script, res1);
    expect(mockLogFilePush).toHaveBeenNthCalledWith(2, rec2Script, res2);

    stopWatching();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("does not throw when queue processing fails and logs error", async () => {
    const rec1Script = ctx("/tmp/rec1.script.js", "sys_script", "rec_1", "script");
    mockGetFileContextFromPath.mockReturnValue(rec1Script);
    mockGroupAppFiles.mockReturnValue([
      { table: "sys_script", sysId: "rec_1", fields: {} },
    ]);
    mockPushFiles.mockRejectedValue(new Error("kaboom"));

    const { startWatching, stopWatching } = await import("../Watcher");

    startWatching("/tmp");
    expect(changeHandler).toBeDefined();

    changeHandler!("/tmp/rec1.script.js");

    jest.advanceTimersByTime(350);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLoggerError).toHaveBeenCalledWith("Watcher queue processing failed");
    expect(mockLoggerError).toHaveBeenCalledWith("kaboom");

    stopWatching();
  });
});
