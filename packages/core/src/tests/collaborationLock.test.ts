// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// #18: the collaboration lock guards concurrent pushes, but its stale detection
// was age-only (30 min) with NO pid-liveness and had zero real-filesystem
// coverage — every prior test mocked fs. A push that CRASHES leaves a young
// lock behind that blocked collaborators for half an hour. These tests drive the
// real lock primitives against a REAL temp directory (atomic wx create, EEXIST
// contention, stale-pid reclaim, real unlink release) and prove the new
// pid-liveness path: a lock owned by a dead pid is reclaimed immediately.

const mockGetRootDir = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getRootDir: (...a: unknown[]) => mockGetRootDir(...a),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { __lockInternals } from "../pushCommand.js";

const {
  acquireCollaborationLock,
  releaseCollaborationLock,
  loadCollaborationLock,
  isCollaborationLockStale,
  isProcessAlive,
  getCollaborationLockPath,
} = __lockInternals;

// A pid that is essentially guaranteed not to be running. process.kill(pid, 0)
// on it throws ESRCH, which the liveness check reads as "owner is gone".
const DEAD_PID = 2 ** 22; // ~4.19M, well above any real pid on the test host

describe("collaboration lock (#18) — real filesystem", () => {
  let dir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-lock-"));
    mockGetRootDir.mockReturnValue(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes an atomic lock file on the real filesystem and releases it", async () => {
    const res = await acquireCollaborationLock("push", "dev");
    expect(res.acquired).toBe(true);

    // The lock physically exists and records THIS process as the owner.
    const lockPath = getCollaborationLockPath();
    expect(fs.existsSync(lockPath)).toBe(true);
    const loaded = await loadCollaborationLock();
    expect(loaded?.command).toBe("push");
    expect(loaded?.pid).toBe(process.pid);
    expect(loaded?.instanceProfile).toBe("dev");

    await releaseCollaborationLock();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refuses to acquire when a LIVE lock (current process) already holds it", async () => {
    // First acquire wins; the owner (this process) is alive and the lock is
    // fresh, so a second attempt must be denied rather than stealing it.
    const first = await acquireCollaborationLock("push");
    expect(first.acquired).toBe(true);

    const second = await acquireCollaborationLock("push");
    expect(second.acquired).toBe(false);
    expect(second.reason).toContain(`pid ${process.pid}`);

    // The original lock file is untouched.
    expect(fs.existsSync(getCollaborationLockPath())).toBe(true);
  });

  it("reclaims a lock whose owning process is DEAD, even inside the age window (pid-liveness)", async () => {
    // Plant a young lock owned by a dead pid — created "now", so the age check
    // alone would NOT consider it stale. Only pid-liveness reclaims it.
    const stalePayload = {
      command: "push",
      pid: DEAD_PID,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      getCollaborationLockPath(),
      JSON.stringify(stalePayload),
      "utf8"
    );

    // Sanity: the planted lock is fresh by age but its owner is gone.
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isCollaborationLockStale(stalePayload)).toBe(true);

    // Acquire must succeed by removing the dead-owner lock and taking it over.
    const res = await acquireCollaborationLock("push");
    expect(res.acquired).toBe(true);
    const loaded = await loadCollaborationLock();
    expect(loaded?.pid).toBe(process.pid);
  });

  it("treats a lock older than the max age as stale regardless of pid", () => {
    const oldLock = {
      command: "push",
      pid: process.pid, // alive, but ancient
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    };
    expect(isCollaborationLockStale(oldLock)).toBe(true);
  });

  it("treats a lock with an unparseable timestamp as stale", () => {
    expect(
      isCollaborationLockStale({ command: "push", pid: process.pid, createdAt: "not-a-date" })
    ).toBe(true);
  });

  it("considers the current process alive and an absent/invalid pid alive (age is authority)", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // Undefined or non-positive pids can't be checked, so they must not be
    // wrongly reclaimed by liveness — the age window governs those.
    expect(isProcessAlive(undefined)).toBe(true);
    expect(isProcessAlive(0)).toBe(true);
    expect(isProcessAlive(-1)).toBe(true);
  });

  it("release is a no-op when no lock file exists (idempotent)", async () => {
    await expect(releaseCollaborationLock()).resolves.toBeUndefined();
  });
});
