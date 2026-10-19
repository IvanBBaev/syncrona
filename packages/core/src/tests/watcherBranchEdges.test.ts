// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { Sync } from "@syncrona/types";

// Branch edges of the Watcher drain the other watcher suites leave untaken:
// a drain triggered while another is in flight, a second failure while a retry
// is already pending, a clean drain cancelling a pending retry, push results
// that cannot be mapped back to a queued file, and a non-Error rejection.

const mockLogFilePush = jest.fn();
const mockGroupAppFiles = jest.fn();
const mockPushFiles = jest.fn<(buildables: unknown[]) => Promise<Sync.PushResult[]>>();
const mockGetFileContextFromPath = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
const mockWatch = jest.fn();

type WatchHandler = (payload: string) => void;
let handlers: Record<string, WatchHandler | undefined> = {};
const change = (p: string) => handlers["change"]!(p);

jest.unstable_mockModule("../logMessages.js", () => ({
  logFilePush: (...a: unknown[]) => mockLogFilePush(...a),
}));
jest.unstable_mockModule("../appUtils.js", () => ({
  groupAppFiles: (...a: unknown[]) => mockGroupAppFiles(...a),
  pushFiles: (b: unknown[]) => mockPushFiles(b),
}));
jest.unstable_mockModule("../FileUtils.js", () => ({
  getFileContextFromPath: (...a: unknown[]) => mockGetFileContextFromPath(...a),
}));
jest.unstable_mockModule("../config.js", () => ({
  reloadManifest: async () => undefined,
  getSourcePath: () => "/src",
  getConfig: () => ({}),
}));
jest.unstable_mockModule("../dataModelComposite.js", () => ({
  LAYOUT_CONFLICT_HINT: "",
  strayCompositeSidecarMessage: () => "",
  strayCompositeSidecarTable: () => undefined,
}));
jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
  },
}));
jest.unstable_mockModule("chokidar", () => ({
  __esModule: true,
  watch: (...a: unknown[]) => mockWatch(...a),
}));

const { startWatching, stopWatching } = await import("../Watcher.js");

const DEBOUNCE = 300;
const ctxFor = (p: string): Sync.FileContext => ({
  filePath: p,
  name: p,
  tableName: "sys_script_include",
  targetField: "script",
  ext: ".js",
  sys_id: p.replace(/\W/g, ""),
  scope: "x_test",
});
const pushedSysIds = (call: number): string[] =>
  (mockPushFiles.mock.calls[call][0] as { sysId: string }[]).map((b) => b.sysId);

// Lets the async drain (reloadManifest, pushFiles, then-chains) settle.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const advance = async (ms: number): Promise<void> => {
  jest.advanceTimersByTime(ms);
  await settle();
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  handlers = {};
  const instance = {
    on: jest.fn((event: string, cb: WatchHandler) => {
      handlers[event] = cb;
      return instance;
    }),
    close: jest.fn(async () => undefined),
  };
  mockWatch.mockReturnValue(instance);
  mockGetFileContextFromPath.mockImplementation((p: unknown) => ctxFor(String(p)));
  mockGroupAppFiles.mockImplementation((ctxs: unknown) =>
    (ctxs as Sync.FileContext[]).map((c) => ({ table: c.tableName, sysId: c.sys_id, fields: {} }))
  );
  mockPushFiles.mockImplementation(async (b) => b.map(() => ({ success: true, message: "ok" })));
  startWatching("/src");
});

afterEach(async () => {
  await stopWatching();
  await settle();
  jest.useRealTimers();
});

describe("Watcher drain edges", () => {
  it("does not requeue or retry a push that fails after the watcher stopped", async () => {
    let release!: (r: Sync.PushResult[]) => void;
    mockPushFiles.mockImplementationOnce(
      () => new Promise<Sync.PushResult[]>((resolve) => (release = resolve))
    );

    change("/src/a.js");
    await advance(DEBOUNCE);
    expect(mockPushFiles).toHaveBeenCalledTimes(1);

    await stopWatching();
    release([{ success: false, message: "503" }]);
    await settle();
    await advance(60_000);

    // The failed file belonged to the stopped session: no retry pushes it later.
    expect(mockPushFiles).toHaveBeenCalledTimes(1);
  });

  it("does not requeue a thrown push from a stopped session, but drains the new session's changes", async () => {
    let reject!: (e: unknown) => void;
    mockPushFiles.mockImplementationOnce(
      () => new Promise<Sync.PushResult[]>((_resolve, rej) => (reject = rej))
    );

    change("/src/a.js");
    await advance(DEBOUNCE);
    await stopWatching();
    startWatching("/src");
    change("/src/b.js");
    await advance(DEBOUNCE); // the stale drain still holds the lock

    reject(new Error("socket hang up"));
    await settle();
    await advance(60_000);

    expect(mockPushFiles).toHaveBeenCalledTimes(2);
    expect(pushedSysIds(1)).toEqual(["srcbjs"]);
  });

  it("serializes a drain triggered while a push is in flight into the running drain", async () => {
    let release!: (r: Sync.PushResult[]) => void;
    mockPushFiles.mockImplementationOnce(
      () => new Promise<Sync.PushResult[]>((resolve) => (release = resolve))
    );

    change("/src/a.js");
    await advance(DEBOUNCE);
    expect(mockPushFiles).toHaveBeenCalledTimes(1);

    change("/src/b.js");
    await advance(DEBOUNCE);
    // The second debounced drain found the first still running and backed off.
    expect(mockPushFiles).toHaveBeenCalledTimes(1);

    release([{ success: true, message: "ok" }]);
    await settle();
    // The running drain picked the late change up in its next loop iteration.
    expect(mockPushFiles).toHaveBeenCalledTimes(2);
    expect(pushedSysIds(1)).toEqual(["srcbjs"]);
  });

  it("does not stack a second retry when a push fails while a retry is already pending", async () => {
    mockPushFiles.mockImplementation(async (b) =>
      b.map(() => ({ success: false, message: "503" }))
    );

    change("/src/a.js");
    await advance(DEBOUNCE); // t=300: fails, retry armed for t=800 (500ms)
    expect(mockPushFiles).toHaveBeenCalledTimes(1);

    change("/src/b.js");
    await advance(DEBOUNCE); // t=600: fails again, retry already pending
    expect(mockPushFiles).toHaveBeenCalledTimes(2);
    expect(pushedSysIds(1).sort()).toEqual(["srcajs", "srcbjs"]);

    await advance(200); // t=800: the single pending retry fires
    expect(mockPushFiles).toHaveBeenCalledTimes(3);

    // Only one backoff step was consumed, so the next retry is 1000ms out —
    // a stacked second timer would have fired in between.
    await advance(999);
    expect(mockPushFiles).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(mockPushFiles).toHaveBeenCalledTimes(4);
  });

  it("cancels the pending retry once a later drain pushes everything cleanly", async () => {
    mockPushFiles.mockImplementationOnce(async (b) =>
      b.map(() => ({ success: false, message: "503" }))
    );

    change("/src/a.js");
    await advance(DEBOUNCE); // fails, retry armed for +500ms
    change("/src/b.js");
    await advance(DEBOUNCE); // +300ms: clean drain of the requeued a + new b
    expect(mockPushFiles).toHaveBeenCalledTimes(2);
    expect(pushedSysIds(1).sort()).toEqual(["srcajs", "srcbjs"]);

    await advance(60_000);
    expect(mockPushFiles).toHaveBeenCalledTimes(2);
  });

  it("ignores push results it cannot map back to a queued file", async () => {
    mockGroupAppFiles.mockReturnValue([{ table: "other_table", sysId: "zzz", fields: {} }]);
    // One result for the unmapped buildable, plus a surplus result with no buildable.
    mockPushFiles.mockResolvedValue([
      { success: false, message: "failed" },
      { success: true, message: "ok" },
    ]);

    change("/src/a.js");
    await advance(DEBOUNCE);

    expect(mockLogFilePush).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(expect.stringContaining("failed to push"));
    await advance(60_000);
    expect(mockPushFiles).toHaveBeenCalledTimes(1);
  });

  it("reports a non-Error rejection and retries the batch", async () => {
    mockPushFiles.mockRejectedValueOnce("socket hang up");

    change("/src/a.js");
    await advance(DEBOUNCE);

    expect(mockLoggerError).toHaveBeenCalledWith("Watcher queue processing failed");
    expect(mockLoggerError).toHaveBeenCalledWith("socket hang up");

    await advance(500);
    expect(mockPushFiles).toHaveBeenCalledTimes(2);
    expect(pushedSysIds(1)).toEqual(["srcajs"]);
  });
});
