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

// jest.unstable_mockModule does not hoist, so a static import would bind the
// REAL ../config.js before the mock registers — pushCommand's getStateBaseDir
// would then fall back to process.cwd() and the tests would pollute the repo
// root with lock files. Import pushCommand lazily, after the mock is in place.
type LockInternals = typeof import("../pushCommand.js").__lockInternals;
let acquireCollaborationLock: LockInternals["acquireCollaborationLock"];
let releaseCollaborationLock: LockInternals["releaseCollaborationLock"];
let reclaimStaleLock: LockInternals["reclaimStaleLock"];
let loadCollaborationLock: LockInternals["loadCollaborationLock"];
let isCollaborationLockStale: LockInternals["isCollaborationLockStale"];
let isProcessAlive: LockInternals["isProcessAlive"];
let getCollaborationLockPath: LockInternals["getCollaborationLockPath"];
let evictLockFile: LockInternals["evictLockFile"];
let getEvictionClaimPath: LockInternals["getEvictionClaimPath"];
let isEvictionClaimAbandoned: LockInternals["isEvictionClaimAbandoned"];
let sweepEvictionClaims: LockInternals["sweepEvictionClaims"];

beforeAll(async () => {
  ({
    acquireCollaborationLock,
    releaseCollaborationLock,
    reclaimStaleLock,
    loadCollaborationLock,
    isCollaborationLockStale,
    isProcessAlive,
    getCollaborationLockPath,
    evictLockFile,
    getEvictionClaimPath,
    isEvictionClaimAbandoned,
    sweepEvictionClaims,
  } = (await import("../pushCommand.js")).__lockInternals);
});

// A pid that is essentially guaranteed not to be running. process.kill(pid, 0)
// on it throws ESRCH, which the liveness check reads as "owner is gone".
const DEAD_PID = 2 ** 22; // ~4.19M, well above any real pid on the test host

// Mirrors of pushCommand's private eviction constants, spelled out on purpose.
// A value re-derived from the module under test moves *with* a mutant, so the
// assertion stays true while measuring nothing (see CONTRIBUTING, "a
// table-completeness fixture must be a literal list inside the test file").
const EVICT_MAX_AGE_MS = 10 * 1000;
const EVICT_MAX_GENERATIONS = 8;
const EVICT_PREFIX = "sync.collaboration.evict.";
const STAGING_PREFIX = "sync.collaboration.staging.";

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

  // Finding 6: stale reclaim must never destroy a LIVE lock a racing push
  // created in the window after we observed the stale one. The old blind unlink
  // did exactly that, letting two pushes both acquire.
  describe("atomic stale-lock reclaim (Finding 6)", () => {
    it("discards a genuinely stale lock and leaves no reclaim temp behind", async () => {
      const stalePayload = {
        command: "push",
        pid: DEAD_PID,
        createdAt: new Date().toISOString(),
      };
      const lockPath = getCollaborationLockPath();
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload), "utf8");

      await reclaimStaleLock();

      // The stale lock is gone, and no `.reclaim` sidecar was orphaned.
      expect(fs.existsSync(lockPath)).toBe(false);
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".reclaim"));
      expect(leftovers).toEqual([]);
    });

    it("restores (never deletes) a LIVE lock found at the path instead of the stale one", async () => {
      // Simulate the race: by the time reclaim runs, a racing push has replaced
      // the observed stale lock with its own LIVE lock (this process, fresh).
      const livePayload = {
        command: "push",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      const lockPath = getCollaborationLockPath();
      fs.writeFileSync(lockPath, JSON.stringify(livePayload), "utf8");

      await reclaimStaleLock();

      // The live lock must survive untouched — its owner keeps mutual exclusion.
      expect(fs.existsSync(lockPath)).toBe(true);
      const loaded = await loadCollaborationLock();
      expect(loaded?.pid).toBe(process.pid);
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".reclaim"));
      expect(leftovers).toEqual([]);
    });

    it("is a no-op when the lock has already been removed by another racer", async () => {
      // Nothing at the path — the ENOENT branch returns without throwing.
      await expect(reclaimStaleLock()).resolves.toBeUndefined();
      expect(fs.existsSync(getCollaborationLockPath())).toBe(false);
    });

    it("discards an unparseable (corrupt) lock file", async () => {
      const lockPath = getCollaborationLockPath();
      fs.writeFileSync(lockPath, "{ this is not json", "utf8");

      await reclaimStaleLock();

      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  // REV-205: reclaim was hardened against destroying a lock it does not own
  // (Finding 6 above), but RELEASE was not — it unlinked whatever file sat at
  // the lock path. The two halves of the same invariant must both hold, because
  // a lock can legitimately change hands WHILE its original owner is still
  // running: the age window (30 min) declares a long push stale even though its
  // process is alive, so a collaborator reclaims the path and takes the lock.
  // When the long push then finishes, its `finally` release deleted the
  // collaborator's live lock, and the next push walked straight in — two pushes
  // writing the same records with no mutual exclusion.
  describe("release is ownership-checked (REV-205)", () => {
    /** The lock a collaborator holds after reclaiming a path we had aged out of. */
    const otherOwnersLock = () =>
      JSON.stringify({
        command: "push",
        // Deliberately this process's pid: the point is that pid alone cannot
        // establish ownership, so the check must rest on the lock's identity.
        pid: process.pid,
        createdAt: new Date().toISOString(),
        instanceProfile: "collaborator",
      });

    it("does not delete a lock another push acquired after ours was reclaimed as stale", async () => {
      const lockPath = getCollaborationLockPath();
      const ours = await acquireCollaborationLock("push");
      expect(ours.acquired).toBe(true);

      // Our push runs past the age window; a collaborator judges our lock stale,
      // reclaims the path and installs its own live lock.
      fs.writeFileSync(lockPath, otherOwnersLock(), "utf8");

      await releaseCollaborationLock();

      // The collaborator must still hold the lock.
      expect(fs.existsSync(lockPath)).toBe(true);
      expect((await loadCollaborationLock())?.instanceProfile).toBe("collaborator");
    });

    it("still removes the lock it does own, so the path is never left blocked", async () => {
      const lockPath = getCollaborationLockPath();
      expect((await acquireCollaborationLock("push", "mine")).acquired).toBe(true);

      await releaseCollaborationLock();

      expect(fs.existsSync(lockPath)).toBe(false);
      // And the freed path is immediately re-acquirable.
      expect((await acquireCollaborationLock("push", "next")).acquired).toBe(true);
    });

    it("forgets the released lock, so a repeated release cannot reach the next owner", async () => {
      const lockPath = getCollaborationLockPath();
      expect((await acquireCollaborationLock("push")).acquired).toBe(true);
      await releaseCollaborationLock();
      expect(fs.existsSync(lockPath)).toBe(false);

      // A collaborator now takes the freed path. A second (buggy or retried)
      // release from us must not touch it.
      fs.writeFileSync(lockPath, otherOwnersLock(), "utf8");
      await expect(releaseCollaborationLock()).resolves.toBeUndefined();

      expect(fs.existsSync(lockPath)).toBe(true);
      expect((await loadCollaborationLock())?.instanceProfile).toBe("collaborator");
    });
  });

  // REV-233: emptying the lock path is the one operation that can break mutual
  // exclusion, so it is mediated by an eviction claim — a file named after the
  // exact bytes being removed. The multi-process harness (`npm run race:lock`)
  // proves the scheme end to end but cannot reach its failure branches on demand:
  // a claim that is abandoned, contended, unreadable, or exhausted needs the
  // filesystem put into that exact state first. These do that, still against a
  // real directory, because the primitives are the kernel's (link, stat, mtime).
  describe("eviction claims (REV-233)", () => {
    /** Bytes of a lock that every reader agrees is stale: its owner is gone. */
    const staleLockBytes = () =>
      JSON.stringify({ command: "push", pid: DEAD_PID, createdAt: new Date().toISOString() });

    const claimBytes = (pid: number, ageMs = 0) =>
      JSON.stringify({ pid, createdAt: new Date(Date.now() - ageMs).toISOString() });

    /** Everything the eviction scheme wrote and did not clean up. */
    const litter = () =>
      fs.readdirSync(dir).filter((f) => f.startsWith(EVICT_PREFIX) || f.startsWith(STAGING_PREFIX));

    describe("isEvictionClaimAbandoned — only positive evidence counts", () => {
      // The whole point of this predicate is that "I cannot tell" must never read
      // as "abandoned": 'wx' creates a claim and fills it in two steps, so a racer
      // legitimately sees an empty or half-written claim, and judging that
      // abandoned is exactly what puts two evictors on the same lock. Every
      // unjudgeable shape below therefore has to fall back to the file's own
      // mtime, which a claim being written right now cannot fake.
      const FRESH = Date.now();
      const ANCIENT = Date.now() - 10 * EVICT_MAX_AGE_MS;

      it.each([
        ["half-written (invalid JSON)", "{ \"pid\": 12"],
        ["JSON null", "null"],
        ["JSON scalar, not an object", "5"],
        ["object without createdAt", JSON.stringify({ pid: 12 })],
        ["object whose pid is not a number", JSON.stringify({ pid: "12", createdAt: new Date().toISOString() })],
        ["object whose createdAt is unparseable", JSON.stringify({ pid: 12, createdAt: "whenever" })],
      ])("falls back to mtime for a claim it cannot judge: %s", (_label, raw) => {
        expect(isEvictionClaimAbandoned(raw, FRESH)).toBe(false);
        expect(isEvictionClaimAbandoned(raw, ANCIENT)).toBe(true);
      });

      it("treats a claim with no usable mtime as live, never as abandoned", () => {
        // stat() failed, so there is no evidence at all — and absence of evidence
        // must not free the claim.
        expect(isEvictionClaimAbandoned("{ truncated", Number.NaN)).toBe(false);
        expect(isEvictionClaimAbandoned("{ truncated", Number.POSITIVE_INFINITY)).toBe(false);
      });

      it("abandons a claim whose holder is gone, however young the claim is", () => {
        expect(isEvictionClaimAbandoned(claimBytes(DEAD_PID), FRESH)).toBe(true);
      });

      it("keeps a live holder's fresh claim and steps over its aged one", () => {
        expect(isEvictionClaimAbandoned(claimBytes(process.pid), FRESH)).toBe(false);
        expect(isEvictionClaimAbandoned(claimBytes(process.pid, 6 * EVICT_MAX_AGE_MS), FRESH)).toBe(
          true
        );
      });
    });

    describe("evictLockFile", () => {
      it("removes exactly the content it claimed, and leaves no claim behind", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(getCollaborationLockPath(), raw, "utf8");

        await expect(evictLockFile(raw)).resolves.toBe(true);

        expect(fs.existsSync(getCollaborationLockPath())).toBe(false);
        expect(litter()).toEqual([]);
      });

      it("leaves the path alone when its content changed under the claim", async () => {
        // The only process allowed to remove these bytes is us, so different bytes
        // at the path mean their owner released and someone else took it — there is
        // nothing here for this eviction to remove, and removing it would be the
        // two-winners bug the claim exists to prevent.
        const raw = staleLockBytes();
        const successor = JSON.stringify({
          command: "push",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        });
        fs.writeFileSync(getCollaborationLockPath(), successor, "utf8");

        await expect(evictLockFile(raw)).resolves.toBe(true);

        expect(fs.readFileSync(getCollaborationLockPath(), "utf8")).toBe(successor);
        expect(litter()).toEqual([]);
      });

      it("reports success when the lock is already gone", async () => {
        await expect(evictLockFile(staleLockBytes())).resolves.toBe(true);
        expect(litter()).toEqual([]);
      });

      it("backs off while another process actively holds the claim", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(getCollaborationLockPath(), raw, "utf8");
        const claimPath = getEvictionClaimPath(raw, 0);
        const otherEvictor = claimBytes(process.pid);
        fs.writeFileSync(claimPath, otherEvictor, "utf8");

        await expect(evictLockFile(raw)).resolves.toBe(false);

        // Neither the lock nor the other evictor's claim was touched.
        expect(fs.readFileSync(getCollaborationLockPath(), "utf8")).toBe(raw);
        expect(fs.readFileSync(claimPath, "utf8")).toBe(otherEvictor);
      });

      it("steps to the next generation over an abandoned claim rather than stealing it", async () => {
        // A claim whose holder was killed mid-eviction would otherwise wedge the
        // path forever. Every racer that agrees it is abandoned steps to the SAME
        // next generation, where the atomic create again admits exactly one.
        const raw = staleLockBytes();
        fs.writeFileSync(getCollaborationLockPath(), raw, "utf8");
        const wedged = getEvictionClaimPath(raw, 0);
        fs.writeFileSync(wedged, claimBytes(DEAD_PID), "utf8");

        await expect(evictLockFile(raw)).resolves.toBe(true);

        expect(fs.existsSync(getCollaborationLockPath())).toBe(false);
        // The abandoned claim is stepped over, never removed — unlinking another
        // process's claim is the one thing this scheme must not do.
        expect(fs.existsSync(wedged)).toBe(true);
        expect(fs.existsSync(getEvictionClaimPath(raw, 1))).toBe(false);
      });

      it("gives up after the generation budget, leaving the lock for the caller to retry", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(getCollaborationLockPath(), raw, "utf8");
        for (let generation = 0; generation < EVICT_MAX_GENERATIONS; generation += 1) {
          fs.writeFileSync(getEvictionClaimPath(raw, generation), claimBytes(DEAD_PID), "utf8");
        }

        await expect(evictLockFile(raw)).resolves.toBe(false);

        expect(fs.readFileSync(getCollaborationLockPath(), "utf8")).toBe(raw);
        // It stopped at the budget instead of minting a ninth generation.
        expect(fs.existsSync(getEvictionClaimPath(raw, EVICT_MAX_GENERATIONS))).toBe(false);
      });

      it("retries a claim it cannot read at the same generation, then gives up", async () => {
        // A claim that exists for the atomic create but is unreadable a moment
        // later (here: not a regular file at all) may simply have been released.
        // Stepping to the next generation would let a racer win the freed name
        // while we win the next one — two evictors, which is the whole hazard — so
        // this case must re-race the SAME name until the step budget stops it.
        const raw = staleLockBytes();
        fs.writeFileSync(getCollaborationLockPath(), raw, "utf8");
        fs.mkdirSync(getEvictionClaimPath(raw, 0));

        await expect(evictLockFile(raw)).resolves.toBe(false);

        expect(fs.readFileSync(getCollaborationLockPath(), "utf8")).toBe(raw);
        expect(fs.existsSync(getEvictionClaimPath(raw, 1))).toBe(false);
        // Every staging file it wrote on the way was cleaned up.
        expect(fs.readdirSync(dir).filter((f) => f.startsWith(STAGING_PREFIX))).toEqual([]);
      });
    });

    describe("sweepEvictionClaims", () => {
      it("clears finished claims and aged staging files, and nothing else", async () => {
        const aged = (name: string) => {
          const full = path.join(dir, name);
          fs.writeFileSync(full, "x", "utf8");
          const past = (Date.now() - 6 * EVICT_MAX_AGE_MS) / 1000;
          fs.utimesSync(full, past, past);
          return full;
        };
        const fresh = (name: string) => {
          const full = path.join(dir, name);
          fs.writeFileSync(full, "x", "utf8");
          return full;
        };

        const finishedClaim = fresh(`${EVICT_PREFIX}deadbeefdeadbeef.0.json`);
        // Same prefix, wrong suffix: not a claim, so the sweep must not touch it.
        const notAClaim = fresh(`${EVICT_PREFIX}deadbeefdeadbeef.0.tmp`);
        // A staging file belongs to a link() a syscall or two from finishing, so
        // it is removed on age and never on sight.
        const liveStaging = fresh(`${STAGING_PREFIX}${process.pid}.in-flight`);
        const abandonedStaging = aged(`${STAGING_PREFIX}999999.crashed`);
        const unrelated = fresh("sync.push.checkpoint.json");

        await expect(sweepEvictionClaims()).resolves.toBeUndefined();

        expect(fs.existsSync(finishedClaim)).toBe(false);
        expect(fs.existsSync(abandonedStaging)).toBe(false);
        expect(fs.existsSync(notAClaim)).toBe(true);
        expect(fs.existsSync(liveStaging)).toBe(true);
        expect(fs.existsSync(unrelated)).toBe(true);
      });

      it("ignores a staging entry that cannot be stat'd", async () => {
        // Removed by its own owner between our readdir and our stat: already
        // cleaned up, nothing to do. A dangling symlink reproduces it exactly,
        // since stat() follows the link.
        const dangling = path.join(dir, `${STAGING_PREFIX}${process.pid}.vanished`);
        fs.symlinkSync(path.join(dir, "no-such-target"), dangling);

        await expect(sweepEvictionClaims()).resolves.toBeUndefined();

        expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true);
      });

      it("is a no-op when the state directory cannot be listed", async () => {
        mockGetRootDir.mockReturnValue(path.join(dir, "never-created"));
        await expect(sweepEvictionClaims()).resolves.toBeUndefined();
      });
    });

    describe("acquireCollaborationLock — paths only the eviction scheme reaches", () => {
      it("retries, then fails honestly, when the lock path is occupied but unreadable", async () => {
        // Occupied for the atomic create yet unreadable a moment later: the lock
        // may have been released and re-created, so the loop re-races the path
        // rather than deciding anything about content it never saw.
        fs.mkdirSync(getCollaborationLockPath());

        const res = await acquireCollaborationLock("push");

        expect(res.acquired).toBe(false);
        expect(res.reason).toBe("Could not acquire collaboration lock.");
        expect(litter()).toEqual([]);
      });

      it("never evicts a live lock that is merely too malformed to describe", async () => {
        // A legacy lock, written before the `command` field existed: unparseable
        // for reporting, but its createdAt is fresh and its owner is alive.
        // Refusing to name the holder is the correct outcome; evicting it is not.
        const legacy = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
        fs.writeFileSync(getCollaborationLockPath(), legacy, "utf8");

        const res = await acquireCollaborationLock("push");

        expect(res.acquired).toBe(false);
        expect(res.reason).toBe("Detected an active collaboration lock.");
        expect(fs.readFileSync(getCollaborationLockPath(), "utf8")).toBe(legacy);
      });

      it("waits out a competing evictor instead of racing it, and reports failure", async () => {
        // The lock is stale, so we are entitled to it — but another process holds
        // the claim on those exact bytes. Every attempt must back off and re-read
        // rather than remove a lock someone else is already removing.
        const raw = staleLockBytes();
        fs.writeFileSync(getCollaborationLockPath(), raw, "utf8");
        const claimPath = getEvictionClaimPath(raw, 0);
        const otherEvictor = claimBytes(process.pid);
        fs.writeFileSync(claimPath, otherEvictor, "utf8");

        const res = await acquireCollaborationLock("push");

        expect(res.acquired).toBe(false);
        expect(res.reason).toBe("Could not acquire collaboration lock.");
        expect(fs.readFileSync(getCollaborationLockPath(), "utf8")).toBe(raw);
        expect(fs.readFileSync(claimPath, "utf8")).toBe(otherEvictor);
      });
    });
  });
});
