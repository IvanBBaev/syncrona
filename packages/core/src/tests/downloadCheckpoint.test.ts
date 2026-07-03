// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// G3 checkpoint persistence. The base dir is pinned to a temp directory so the
// test never writes into the tracked tree (invariant: tests stay clean).

// ESM namespace objects are frozen, so jest.spyOn(ConfigManager, "getRootDir")
// throws "Cannot assign to read only property". Mock the module with a jest.fn()
// instead and drive it directly (graph-complete fills in any other names the
// config graph hard-links). The real fs is kept unmocked so the SUT performs
// genuine reads/writes inside the temp directory.
const mockGetRootDir = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getRootDir: (...args: unknown[]) => mockGetRootDir(...args),
}));

// The SUT is imported dynamically AFTER the module mock is registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the
// real ConfigManager before the mock takes effect.
let DOWNLOAD_CHECKPOINT_FILE: typeof import("../downloadCheckpoint.js").DOWNLOAD_CHECKPOINT_FILE;
let getDownloadCheckpointPath: typeof import("../downloadCheckpoint.js").getDownloadCheckpointPath;
let readDownloadCheckpoint: typeof import("../downloadCheckpoint.js").readDownloadCheckpoint;
let writeDownloadCheckpoint: typeof import("../downloadCheckpoint.js").writeDownloadCheckpoint;
let deleteDownloadCheckpoint: typeof import("../downloadCheckpoint.js").deleteDownloadCheckpoint;

describe("download checkpoint", () => {
  let dir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({
      DOWNLOAD_CHECKPOINT_FILE,
      getDownloadCheckpointPath,
      readDownloadCheckpoint,
      writeDownloadCheckpoint,
      deleteDownloadCheckpoint,
    } = await import("../downloadCheckpoint.js"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncdlcp-"));
    mockGetRootDir.mockReturnValue(dir);
    // Guard: if the mock did not take, fail before any write touches the tree.
    expect(getDownloadCheckpointPath()).toBe(path.join(dir, DOWNLOAD_CHECKPOINT_FILE));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes, reads and deletes a checkpoint", async () => {
    expect(await readDownloadCheckpoint("x_app")).toBeNull();

    await writeDownloadCheckpoint({ scope: "x_app", completedTables: ["a", "b"] });
    const cp = await readDownloadCheckpoint("x_app");
    expect(cp?.scope).toBe("x_app");
    expect(cp?.completedTables).toEqual(["a", "b"]);

    await deleteDownloadCheckpoint();
    expect(await readDownloadCheckpoint("x_app")).toBeNull();
  });

  it("treats a checkpoint from another scope as stale", async () => {
    await writeDownloadCheckpoint({ scope: "other_scope", completedTables: ["a"] });
    expect(await readDownloadCheckpoint("x_app")).toBeNull();
  });

  it("ignores a malformed checkpoint file", async () => {
    fs.writeFileSync(getDownloadCheckpointPath(), "{ not valid json");
    expect(await readDownloadCheckpoint("x_app")).toBeNull();
  });

  it("delete is a no-op when no checkpoint exists", async () => {
    await expect(deleteDownloadCheckpoint()).resolves.toBeUndefined();
  });
});
