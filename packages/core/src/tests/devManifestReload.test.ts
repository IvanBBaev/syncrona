// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { Sync } from "@syncrona/types";

export {};

// REV-110 (CONC-6): `dev` loads the manifest once at startup and holds it in
// memory. A concurrent `refresh`/`repair` that rewrites sync.manifest.json (for
// example a record whose sys_id changed) was invisible to the running watcher,
// so the next save would resolve the file against the STALE in-memory sys_id and
// overwrite the wrong record. The fix re-reads the manifest from disk before
// every drain resolves paths. Two layers are covered here:
//   1. ConfigStore.reloadManifest re-reads the on-disk manifest and, unlike the
//      private startup loader, preserves the good in-memory manifest on a
//      transient read/parse failure (a partial write must not blank it out).
//   2. The dev watcher actually calls reloadManifest before resolving, so a push
//      that lands after a concurrent refresh targets the NEW sys_id.
//
// config.js and FileUtils.js are intentionally NOT mocked: both layers are
// exercised against the real modules.

const mockGroupAppFiles = jest.fn();
const mockPushFiles = jest.fn();
const mockLogFilePush = jest.fn();
const mockWatch = jest.fn();
const mockClose = jest.fn(async () => undefined);

type WatchHandler = (payload: string) => void;
let handlers: Record<string, WatchHandler | undefined> = {};

jest.unstable_mockModule("../appUtils.js", () => ({
  // Preserve the ctx -> buildable sys_id linkage so the pushed buildable
  // reflects exactly what getFileContextFromPath resolved from the manifest.
  groupAppFiles: (...args: unknown[]) => mockGroupAppFiles(...args),
  pushFiles: (...args: unknown[]) => mockPushFiles(...args),
}));

jest.unstable_mockModule("../logMessages.js", () => ({
  logFilePush: (...args: unknown[]) => mockLogFilePush(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    getLogLevel: () => "info",
    isRoutedToStderr: () => false,
  },
}));

// chokidar 5 has named exports only — mock the { watch } shape, no default (DEP1).
jest.unstable_mockModule("chokidar", () => ({
  __esModule: true,
  watch: (...args: unknown[]) => mockWatch(...args),
}));

const OLD_ID = "old_sys_id_1111";
const NEW_ID = "new_sys_id_2222";

const manifestWith = (sysId: string): string =>
  JSON.stringify({
    scope: "x_test_app",
    tables: {
      sys_script: {
        records: {
          myrec: { sys_id: sysId, files: [{ name: "script" }] },
        },
      },
    },
  });

// ---- Layer 1: the ConfigStore.reloadManifest method (real fs) ---------------

describe("ConfigStore.reloadManifest (REV-110)", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    jest.clearAllMocks();
  });

  async function loadStoreFrom(manifestContents: string) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-reload-"));
    fs.writeFileSync(
      path.join(project, "sync.config.js"),
      "module.exports = { sourceDirectory: 'src' };\n"
    );
    fs.writeFileSync(path.join(project, "sync.manifest.json"), manifestContents);
    process.chdir(project);
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();
    await store.loadConfigs();
    return { store, project };
  }

  const sysIdOf = (store: { getManifest: () => unknown }): string =>
    (
      store.getManifest() as {
        tables: { sys_script: { records: { myrec: { sys_id: string } } } };
      }
    ).tables.sys_script.records.myrec.sys_id;

  it("re-reads a rewritten on-disk manifest into memory", async () => {
    const { store } = await loadStoreFrom(manifestWith(OLD_ID));
    expect(sysIdOf(store)).toBe(OLD_ID);

    // A concurrent refresh/repair rewrites the manifest on disk.
    fs.writeFileSync(store.getManifestPath(), manifestWith(NEW_ID));
    await store.reloadManifest();

    expect(sysIdOf(store)).toBe(NEW_ID);
  });

  it("preserves the in-memory manifest when the on-disk file is unreadable", async () => {
    const { store } = await loadStoreFrom(manifestWith(NEW_ID));
    expect(sysIdOf(store)).toBe(NEW_ID);

    // Simulate a partial write mid-refresh: the file is momentarily invalid
    // JSON. Unlike the startup loader, reloadManifest must NOT blank out the
    // good in-memory manifest (that would make every subsequent push no-op).
    fs.writeFileSync(store.getManifestPath(), "{ half-written not json");
    await store.reloadManifest();

    expect(sysIdOf(store)).toBe(NEW_ID);
  });
});

// ---- Layer 2: the dev watcher reloads before it resolves a push -------------

describe("dev watch drain reloads the manifest before resolving (REV-110)", () => {
  const originalCwd = process.cwd();
  let project: string;
  let cfg: typeof import("../config.js");
  let FileUtils: typeof import("../FileUtils.js");
  let startWatching: typeof import("../Watcher.js").startWatching;
  let stopWatching: typeof import("../Watcher.js").stopWatching;

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 8000,
    stepMs = 20
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the push.");
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    handlers = {};

    const watcherInstance = {
      on: jest.fn((event: string, cb: WatchHandler) => {
        handlers[event] = cb;
        return watcherInstance;
      }),
      close: mockClose,
    };
    mockWatch.mockReturnValue(watcherInstance);

    // Real groupAppFiles-equivalent: carry each resolved ctx.sys_id onto its
    // buildable so the assertion reads the sys_id the manifest actually yielded.
    mockGroupAppFiles.mockImplementation((ctxs: Sync.FileContext[]) =>
      ctxs.map((c) => ({
        table: c.tableName,
        sysId: c.sys_id,
        fields: { [c.targetField]: c },
      }))
    );
    mockPushFiles.mockResolvedValue([{ success: true, message: "ok" }]);

    project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-dev-reload-"));
    fs.writeFileSync(
      path.join(project, "sync.config.js"),
      "module.exports = { sourceDirectory: 'src' };\n"
    );
    fs.writeFileSync(
      path.join(project, "sync.manifest.json"),
      manifestWith(OLD_ID)
    );
    fs.mkdirSync(path.join(project, "src"));
    process.chdir(project);

    // Import config/FileUtils/Watcher dynamically, after the module mocks are
    // registered, so config and FileUtils bind the same (mocked) Logger the
    // dynamically-imported Watcher does — jest.unstable_mockModule does not
    // hoist, so a static import would bind the real Logger first.
    cfg = await import("../config.js");
    FileUtils = await import("../FileUtils.js");
    cfg.resetConfigState();
    await cfg.loadConfigs();
    ({ startWatching, stopWatching } = await import("../Watcher.js"));
  });

  afterEach(async () => {
    await stopWatching();
    process.chdir(originalCwd);
    cfg.resetConfigState();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("pushes to the NEW sys_id after a concurrent refresh rewrote the manifest", async () => {
    const target = path.join(cfg.getSourcePath(), "sys_script", "myrec", "script.js");

    // Sanity: the in-memory manifest (loaded once at startup) still resolves to
    // the OLD sys_id — this is exactly the staleness that caused the misroute.
    expect(FileUtils.getFileContextFromPath(target)?.sys_id).toBe(OLD_ID);

    // A concurrent refresh/repair rewrites the manifest on disk with the new id.
    fs.writeFileSync(cfg.getManifestPath(), manifestWith(NEW_ID));

    startWatching(cfg.getSourcePath());
    // Drive a save through the captured chokidar 'change' handler.
    handlers["change"]!(target);

    await waitFor(() => mockPushFiles.mock.calls.length > 0);

    const buildables = mockPushFiles.mock.calls[0][0] as Array<{ sysId: string }>;
    // With the fix the drain reloaded the manifest before resolving, so the
    // push targets the NEW sys_id. Against the old code it would carry OLD_ID.
    expect(buildables[0].sysId).toBe(NEW_ID);
  });
});
