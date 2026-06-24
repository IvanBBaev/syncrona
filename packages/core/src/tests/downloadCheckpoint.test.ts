// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import os from "os";
import path from "path";
import * as ConfigManager from "../config";
import {
  DOWNLOAD_CHECKPOINT_FILE,
  getDownloadCheckpointPath,
  readDownloadCheckpoint,
  writeDownloadCheckpoint,
  deleteDownloadCheckpoint,
} from "../downloadCheckpoint";

// G3 checkpoint persistence. The base dir is pinned to a temp directory so the
// test never writes into the tracked tree (invariant: tests stay clean).

describe("download checkpoint", () => {
  let dir: string;
  let rootDirSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncdlcp-"));
    rootDirSpy = jest.spyOn(ConfigManager, "getRootDir").mockReturnValue(dir);
    // Guard: if the spy did not take, fail before any write touches the tree.
    expect(getDownloadCheckpointPath()).toBe(path.join(dir, DOWNLOAD_CHECKPOINT_FILE));
  });
  afterEach(() => {
    rootDirSpy.mockRestore();
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
