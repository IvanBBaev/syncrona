// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// #5: the flagship dev watch loop had no NON-mocked coverage. watcherQueue.test.ts
// hand-drives a captured 'change' handler with chokidar fully mocked, so it never
// proves that a REAL editor save produces a 'change' event, that the batch actually
// reaches pushFiles, or that stopWatching() tears the watcher down cleanly (and is
// idempotent). This drives the real chokidar watcher over a temp directory and mocks
// only at the pushFiles / FileUtils / snClient seam — exactly the seam a live dev
// session would hit. A chokidar 3->4 regression (Dependabot bumps it weekly) that
// broke event delivery or teardown would fail here instead of shipping green.

const mockPushFiles = jest.fn();
const mockGroupAppFiles = jest.fn();
const mockGetFileContextFromPath = jest.fn();

jest.unstable_mockModule("../logMessages.js", () => ({
  logFilePush: jest.fn(),
}));

jest.unstable_mockModule("../appUtils.js", () => ({
  groupAppFiles: (...args: unknown[]) => mockGroupAppFiles(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  getFileContextFromPath: (...args: unknown[]) => mockGetFileContextFromPath(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

// Under ESM, jest.unstable_mockModule does not hoist: a static import of the SUT
// (Watcher) binds the real appUtils/FileUtils/logMessages/Logger dependencies
// before the mocks register. The SUT is imported dynamically in beforeAll, after
// the mocks are in place.
let startWatching: typeof import("../Watcher.js").startWatching;
let stopWatching: typeof import("../Watcher.js").stopWatching;

beforeAll(async () => {
  ({ startWatching, stopWatching } = await import("../Watcher.js"));
});

// A real editor save can take a moment to surface through chokidar's polling on
// some filesystems; wait for pushFiles rather than a fixed sleep.
const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 8000,
  stepMs = 25
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the watcher condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
};

describe("Watcher real filesystem integration (#5)", () => {
  let dir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-watch-"));
    mockGetFileContextFromPath.mockImplementation((p: string) => ({
      filePath: p,
      name: path.basename(p),
      tableName: "sys_script",
      targetField: "script",
      ext: ".js",
      sys_id: "rec_1",
      scope: "x_nuvo_test",
    }));
    mockGroupAppFiles.mockReturnValue([
      { table: "sys_script", sysId: "rec_1", fields: {} },
    ]);
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);
  });

  afterEach(async () => {
    // Always release the watcher even if an assertion threw, so no fs handle
    // leaks into the next test.
    await stopWatching();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("delivers a real file modification to pushFiles through the real watcher", async () => {
    const target = path.join(dir, "rec.script.js");
    // Seed the file BEFORE watching so the initial add is not what we observe —
    // we want to prove a genuine post-startup modification is delivered.
    fs.writeFileSync(target, "// initial\n");

    startWatching(dir);
    // Give chokidar a beat to finish its initial scan before mutating.
    await new Promise((resolve) => setTimeout(resolve, 150));

    fs.writeFileSync(target, "// modified\n");

    await waitFor(() => mockPushFiles.mock.calls.length > 0);
    expect(mockPushFiles).toHaveBeenCalled();
    // getFileContextFromPath is invoked as a .map() callback, so it also
    // receives (index, array); assert only on the resolved file path.
    const contextPaths = mockGetFileContextFromPath.mock.calls.map((c) => c[0]);
    expect(contextPaths).toContain(target);
  });

  it("ignores pre-existing files on startup and pushes a newly added tracked file", async () => {
    // Seed files BEFORE watching: with ignoreInitial the initial scan must
    // not reach the push queue — without it chokidar fires "add" for every
    // pre-existing file and a fresh dev session would flood the queue.
    fs.writeFileSync(path.join(dir, "one.script.js"), "// one\n");
    fs.writeFileSync(path.join(dir, "two.script.js"), "// two\n");

    // Let the OS event stream settle before watching: fsevents/inotify can
    // deliver just-completed writes AFTER chokidar's initial scan, where they
    // would surface as post-startup "add" events and fake a flood.
    await new Promise((resolve) => setTimeout(resolve, 500));

    startWatching(dir);
    // Long enough for the initial scan, the awaitWriteFinish settle window
    // and the push debounce: if the startup scan had been enqueued, it would
    // have drained into pushFiles by now.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mockPushFiles).not.toHaveBeenCalled();

    // A file created after startup fires "add"; the suite's manifest mock
    // tracks every path, so it must sync exactly like a change.
    const added = path.join(dir, "three.script.js");
    fs.writeFileSync(added, "// three\n");

    await waitFor(() => mockPushFiles.mock.calls.length > 0);
    const contextPaths = mockGetFileContextFromPath.mock.calls.map((c) => c[0]);
    expect(contextPaths).toContain(added);
  });

  it("stopWatching tears the watcher down and is safe to call twice", async () => {
    startWatching(dir);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(stopWatching()).resolves.toBeUndefined();
    // Idempotent: a second stop (e.g. SIGINT after the loop already exited) must
    // not throw on an already-closed watcher.
    await expect(stopWatching()).resolves.toBeUndefined();

    // After teardown, a further modification must NOT reach pushFiles — proving
    // the underlying fs handle was really released, not just the reference.
    const target = path.join(dir, "after-close.script.js");
    fs.writeFileSync(target, "// ignored\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mockPushFiles).not.toHaveBeenCalled();
  });
});
