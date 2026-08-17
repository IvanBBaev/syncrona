// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";

// Seventh-wave re-examination of the refuted Watcher.ts finding: "the
// watch-mode retry ladder never engages for the common failure mode (a push
// failure during watch)". This suite is the reproduction harness the
// refutation lacked — it drives the REAL Watcher drain against the REAL
// pushPipeline (groupAppFiles, pushFiles, pushRec, mapWithConcurrency),
// mocking only the transport client, the fs-context lookup, chokidar and the
// logger: exactly the seams a live dev session crosses.
//
// The finding was REAL. pushRec converts every transport/HTTP error into a
// RESOLVED { success: false } PushResult (pushPipeline.ts, pushRec's catch),
// so the common failure mode — instance unreachable, expired auth, 5xx —
// never rejected pushFiles, never reached drainQueue's catch, and the backoff
// ladder built for exactly this case never armed: the failed change was
// silently dropped until the user happened to re-save the file. The first
// test pins that resolved-failure mechanism; the rest pin the fix (requeue of
// the failed record's files + the self-driving capped backoff) and fail on
// the unfixed code.

const mockUpdateRecord = jest.fn<
  (table: string, sysId: string, rec: Record<string, string>) => Promise<{ status: number }>
>();
const mockLogFilePush = jest.fn();
const mockGetFileContextFromPath = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
const mockWatch = jest.fn();
const mockClose = jest.fn();

type WatchHandler = (payload: string | Error) => void;
let handlers: Record<string, WatchHandler | undefined> = {};
const changeHandler = (path: string) => handlers["change"]!(path);

jest.unstable_mockModule("../snClient.js", () => ({
  SNClient: jest.fn(),
  defaultClient: () => ({ updateRecord: mockUpdateRecord }),
  // The real retryOnErr rethrows the original error once its inner retries
  // are exhausted (snClient.ts), so a transparent passthrough is
  // terminal-behavior-equivalent and keeps this suite off the 3s retry waits.
  retryOnErr: async (f: () => Promise<unknown>) => f(),
  getErrorResponseStatus: (e: unknown) =>
    (e as { response?: { status?: number } } | null)?.response?.status,
  isRetryableRequestError: () => true,
  // Mirrors the real contract: a non-2xx response resolves to a failed
  // PushResult; 2xx resolves to a successful one.
  processPushResponse: (response: { status: number }, recSummary: string) =>
    response.status < 200 || response.status > 299
      ? { success: false, message: `Failed to push ${recSummary} (${response.status})` }
      : { success: true, message: `${recSummary} pushed successfully!` },
  unwrapSNResponse: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

jest.unstable_mockModule("../config.js", () => ({
  reloadManifest: async () => undefined,
  getConfig: () => ({}),
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(),
  isScopedEndpointUnavailableError: jest.fn(),
  isNotFoundError: jest.fn(),
}));

jest.unstable_mockModule("../PluginManager.js", () => ({
  __esModule: true,
  default: { getFinalFileContents: jest.fn(async () => "built content") },
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  getFileContextFromPath: (...args: unknown[]) => mockGetFileContextFromPath(...args),
}));

jest.unstable_mockModule("../logMessages.js", () => ({
  logFilePush: (...args: unknown[]) => mockLogFilePush(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    debug: jest.fn(),
    // "warn" makes the real getProgTick a no-op so no progress bar renders.
    getLogLevel: () => "warn",
  },
}));

// chokidar 5 has named exports only — mock the { watch } shape, no default.
jest.unstable_mockModule("chokidar", () => ({
  __esModule: true,
  watch: (...args: unknown[]) => mockWatch(...args),
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

const connectionRefused = (): Error =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
    code: "ECONNREFUSED",
  });

// The real drain crosses many awaits (reloadManifest, mapWithConcurrency,
// allSettled, retryOnErr, updateRecord); each loop turn releases one
// continuation, so a generous count settles the whole chain deterministically.
const flushMicrotasks = async (ticks = 60): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
};

const drainAfter = async (ms: number): Promise<void> => {
  await jest.advanceTimersByTimeAsync(ms);
  await flushMicrotasks();
};

describe("Watcher retry ladder vs resolved push failures (seventh-wave re-examination)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    handlers = {};

    const watcherInstance: { on: jest.Mock; close: jest.Mock } = {
      on: jest.fn(),
      close: mockClose,
    };
    watcherInstance.on.mockImplementation((event: string, cb: WatchHandler) => {
      handlers[event] = cb;
      return watcherInstance;
    });
    mockWatch.mockReturnValue(watcherInstance);
    mockClose.mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    // Releases the watcher, the pending retry timer and the queued paths, so
    // module-level Watcher state cannot leak into the next test.
    const { stopWatching } = await import("../Watcher.js");
    await stopWatching();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("pushFiles RESOLVES a transport failure as { success: false } — it never rejects, so a throw-only ladder cannot see the common failure mode", async () => {
    // Pins the mechanism that made the original finding true: the real
    // pushRec catches the transport error (even after its inner retries are
    // exhausted) and returns a result object instead of rethrowing. Any
    // watch-mode retry design keyed solely on drainQueue's catch is therefore
    // dead code for a push failure.
    const { pushFiles, groupAppFiles } = await import("../appUtils.js");
    const rec = ctx("/watched/rec1.script.js", "sys_script", "rec_1", "script");
    const buildables = groupAppFiles([rec]);
    mockUpdateRecord.mockRejectedValue(connectionRefused());

    await expect(pushFiles(buildables)).resolves.toEqual([
      expect.objectContaining({
        success: false,
        message: expect.stringContaining("ECONNREFUSED"),
      }),
    ]);
  });

  it("requeues a resolved push failure and drains it on the self-driven backoff retry with no further fs event", async () => {
    const rec = ctx("/watched/rec1.script.js", "sys_script", "rec_1", "script");
    mockGetFileContextFromPath.mockReturnValue(rec);
    mockUpdateRecord
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValue({ status: 200 });

    const { startWatching } = await import("../Watcher.js");
    startWatching("/watched");
    changeHandler("/watched/rec1.script.js");

    // Debounced drain runs; the push fails as a RESOLVED failure.
    await drainAfter(350);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
    expect(mockLogFilePush).toHaveBeenCalledWith(
      rec,
      expect.objectContaining({ success: false })
    );
    // The throw-path never ran — proving the failure did not reject...
    expect(mockLoggerError).not.toHaveBeenCalledWith(
      "Watcher queue processing failed"
    );
    // ...yet the ladder armed anyway: the failed file was requeued.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "1 file(s) failed to push — retrying automatically."
    );

    // The self-driven retry (RETRY_BASE_MS = 500) drains the requeued file
    // without any intervening change/add event.
    await drainAfter(500);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(2);
    expect(mockLogFilePush).toHaveBeenLastCalledWith(
      rec,
      expect.objectContaining({ success: true })
    );

    // Full failure-free drain reset the ladder: nothing fires afterwards.
    await drainAfter(60_000);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(2);
  });

  it("escalates the capped exponential backoff while pushes keep resolving as failures", async () => {
    const rec = ctx("/watched/rec1.script.js", "sys_script", "rec_1", "script");
    mockGetFileContextFromPath.mockReturnValue(rec);
    mockUpdateRecord.mockRejectedValue(connectionRefused());

    const { startWatching } = await import("../Watcher.js");
    startWatching("/watched");
    changeHandler("/watched/rec1.script.js");

    await drainAfter(350);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(1);

    // No hot immediate retry: the first backoff step is 500ms.
    await drainAfter(100);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
    await drainAfter(500);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(2);

    // Second step escalated to 1000ms (a flat 500ms ladder would fire here).
    await drainAfter(400);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(2);
    await drainAfter(700);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(3);

    // Third step escalated to 2000ms (a flat 1000ms ladder would fire here).
    await drainAfter(1000);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(3);
    await drainAfter(1500);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(4);
  });

  it("requeues only the failed record's files — the successfully pushed record is not re-pushed by the retry", async () => {
    const recA = ctx("/watched/aaa.script.js", "sys_script", "rec_a", "script");
    const recB = ctx("/watched/bbb.script.js", "sys_script", "rec_b", "script");
    mockGetFileContextFromPath.mockImplementation((p: unknown) =>
      p === recA.filePath ? recA : recB
    );
    let recAAttempts = 0;
    mockUpdateRecord.mockImplementation(async (_table, sysId) => {
      if (sysId === "rec_a" && recAAttempts++ === 0) {
        throw connectionRefused();
      }
      return { status: 200 };
    });

    const { startWatching } = await import("../Watcher.js");
    startWatching("/watched");
    changeHandler(recA.filePath);
    changeHandler(recB.filePath);

    await drainAfter(350);
    expect(mockUpdateRecord).toHaveBeenCalledTimes(2);

    await drainAfter(600);
    const pushedSysIds = mockUpdateRecord.mock.calls.map((call) => call[1]);
    expect(pushedSysIds.slice(0, 2).sort()).toEqual(["rec_a", "rec_b"]);
    // Only rec_a was requeued; rec_b's clean push is not repeated.
    expect(pushedSysIds.slice(2)).toEqual(["rec_a"]);
    expect(mockLogFilePush).toHaveBeenLastCalledWith(
      recA,
      expect.objectContaining({ success: true })
    );
  });
});
