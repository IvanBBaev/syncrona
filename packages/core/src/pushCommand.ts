// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import { createHash, randomUUID } from "crypto";
import { promises as fsp } from "fs";
import path from "path";
import * as AppUtils from "./appUtils.js";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import { logPushResults } from "./logMessages.js";
import { defaultClient, resolveCredentials } from "./snClient.js";
import inquirer from "inquirer";
import { formatTable } from "./genericUtils.js";
import { gitDiffToEncodedPaths } from "./gitUtils.js";
import { isPromptAbort } from "./errorTaxonomy.js";
import {
  setLogLevel,
  scopeCheck,
  logScopedEndpointCapability,
  getActiveStoreDecryptWarning,
  logErrorHint,
} from "./commandHelpers.js";

type PushCheckpoint = {
  attempted: string[];
  succeeded: string[];
  failed: string[];
  // The instance the checkpoint was written against. A checkpoint may only be
  // resumed against the same target — resuming instance A's failures against
  // instance B would push the wrong (partial) set of records. Optional so a
  // legacy checkpoint (written before this field existed) is treated as
  // "unknown instance" and safely discarded rather than misapplied.
  instance?: string;
  // Content fingerprint of every attempted record, keyed like `attempted`.
  // Record identity (table:sysId) alone cannot tell "already pushed" from
  // "pushed, then edited": resume would skip the edited record and still exit 0,
  // so the edit would never reach the instance. Optional so a legacy checkpoint
  // (written before this field existed) still resumes on identity alone.
  fingerprints?: Record<string, string>;
};

type CollaborationLock = {
  command: string;
  pid: number;
  createdAt: string;
  instanceProfile?: string;
  // REV-205: identity of the acquisition, not of the process. A pid cannot
  // establish ownership — the same pid can hold the lock twice in a row (release
  // then re-acquire), and a lock written on another host may carry a pid that
  // happens to match ours. Release compares this token so it can only ever
  // remove the lock file it created. Optional so a legacy lock (written before
  // this field existed) still parses; such a lock is simply never recognized as
  // ours, which fails safe — we leave it for the age/liveness reclaim path.
  owner?: string;
};

const PUSH_CHECKPOINT_FILE = "sync.push.checkpoint.json";
const COLLABORATION_LOCK_FILE = "sync.collaboration.lock.json";
const COLLABORATION_LOCK_MAX_AGE_MS = 30 * 60 * 1000;

// REV-233: emptying the lock path is the one operation that can break mutual
// exclusion, so it is mediated by an *eviction claim* — a file named after the exact
// bytes being removed, created with the same atomic 'wx' as the lock itself. See
// evictLockFile for why the atomic create on the lock alone was not enough.
const COLLABORATION_EVICT_PREFIX = "sync.collaboration.evict.";
const COLLABORATION_EVICT_SUFFIX = ".json";
// Where a lock or a claim is assembled before it is published under its real name.
// Never inspected by anyone, so its contents are allowed to be momentarily incomplete.
const COLLABORATION_STAGING_PREFIX = "sync.collaboration.staging.";
// A claim is held across three filesystem calls, so ten seconds is roughly four
// orders of magnitude of headroom: a claim older than that is abandoned, not slow.
const COLLABORATION_EVICT_MAX_AGE_MS = 10 * 1000;
// How many abandoned claims one eviction steps over before giving up and letting the
// caller retry. Reached only after repeated crashes inside the eviction itself.
const COLLABORATION_EVICT_MAX_GENERATIONS = 8;
// Acquisition retries: enough for a racer that lost the eviction to observe the
// winner's lock, short enough that a wedged path fails the CLI in well under a second.
const COLLABORATION_LOCK_ACQUIRE_ATTEMPTS = 4;
const COLLABORATION_LOCK_RETRY_MS = 20;

// Lock/checkpoint live in the project root so runs from subdirectories share
// the same state; fall back to cwd when no config has been loaded yet.
const getStateBaseDir = (): string => {
  try {
    return ConfigManager.getRootDir();
  } catch (_) {
    return process.cwd();
  }
};

const getPushCheckpointPath = () => path.join(getStateBaseDir(), PUSH_CHECKPOINT_FILE);
const getCollaborationLockPath = () => path.join(getStateBaseDir(), COLLABORATION_LOCK_FILE);

const recToCheckpointKey = (rec: Sync.BuildableRecord): string =>
  `${rec.table}:${rec.sysId}`;

// Fingerprints the sources a record pushes, so a later resume can tell whether
// the record still holds the content that was pushed. Field order is normalized
// so the fingerprint depends on content only. A source that cannot be read
// hashes to a unique value on purpose: content we cannot read is content we
// cannot prove unchanged, so the record is always re-pushed rather than skipped.
async function fingerprintRecord(rec: Sync.BuildableRecord): Promise<string> {
  const hash = createHash("sha256");
  for (const field of Object.keys(rec.fields).sort()) {
    hash.update(`${field}\0`);
    try {
      hash.update(await fsp.readFile(rec.fields[field].filePath));
    } catch (_) {
      hash.update(randomUUID());
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function fingerprintRecords(
  recs: Sync.BuildableRecord[]
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    recs.map(
      async (rec) => [recToCheckpointKey(rec), await fingerprintRecord(rec)] as const
    )
  );
  return Object.fromEntries(entries);
}

async function loadPushCheckpoint(): Promise<PushCheckpoint | null> {
  try {
    const raw = await fsp.readFile(getPushCheckpointPath(), "utf8");
    const parsed = JSON.parse(raw) as PushCheckpoint;
    if (!Array.isArray(parsed.attempted) || !Array.isArray(parsed.succeeded) || !Array.isArray(parsed.failed)) {
      return null;
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writePushCheckpoint(checkpoint: PushCheckpoint): Promise<void> {
  await fsp.writeFile(
    getPushCheckpointPath(),
    JSON.stringify(checkpoint, null, 2),
    "utf8"
  );
}

async function clearPushCheckpoint(): Promise<void> {
  try {
    await fsp.unlink(getPushCheckpointPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
}

function parseCollaborationLock(raw: string): CollaborationLock | null {
  try {
    const parsed = JSON.parse(raw) as CollaborationLock;
    return parsed &&
      typeof parsed === "object" &&
      typeof parsed.command === "string" &&
      typeof parsed.createdAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function loadCollaborationLock(): Promise<CollaborationLock | null> {
  try {
    return parseCollaborationLock(await fsp.readFile(getCollaborationLockPath(), "utf8"));
  } catch {
    // ENOENT (no lock) and an unreadable lock are both reported as "nothing usable
    // here" — every caller treats the two identically, so they are not separated.
    return null;
  }
}

// process.kill(pid, 0) sends no signal but performs the permission/existence
// check: it throws ESRCH when no such process exists (owner crashed/exited) and
// EPERM when the process exists but is owned by another user. "Alive" therefore
// means "did not throw ESRCH". A non-finite/absent pid is treated as unknown →
// alive, so the age check stays the sole authority for legacy/foreign locks.
function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists (we just can't signal it) → still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isCollaborationLockStale(lock: CollaborationLock): boolean {
  const createdAtMs = Date.parse(lock.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }
  // A lock whose owning process is gone is stale immediately, even inside the
  // 30-minute window: a crashed push must not block collaborators for half an
  // hour. Age remains the backstop for locks whose owner is still alive (or
  // whose pid can't be checked, e.g. a lock written on another host).
  if (!isProcessAlive(lock.pid)) {
    return true;
  }
  return Date.now() - createdAtMs > COLLABORATION_LOCK_MAX_AGE_MS;
}

// The owner token of the lock this process currently holds, or null when it
// holds none. Set only after a successful atomic create, cleared on release.
let heldLockOwner: string | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Judged on `createdAt` alone — deliberately looser than parseCollaborationLock, so
// a legacy lock written before the `command` field existed is still reclaimable
// rather than permanently immovable. Anything less structured than that is junk, and
// junk is stale.
function isRawLockStale(raw: string): boolean {
  let parsed: CollaborationLock | null = null;
  try {
    parsed = JSON.parse(raw) as CollaborationLock;
  } catch {
    return true;
  }
  return parsed && typeof parsed === "object" && typeof parsed.createdAt === "string"
    ? isCollaborationLockStale(parsed)
    : true;
}

// An eviction claim records who is currently allowed to remove one specific lock
// content from the lock path, and nothing else.
type EvictionClaim = { pid: number; createdAt: string };

// Create `targetPath` carrying `body`, atomically, failing rather than overwriting.
//
// `writeFile(..., {flag:"wx"})` looks like this primitive but is not: O_CREAT|O_EXCL
// publishes the *name* first and the bytes second, so a racer that reads in between
// gets an empty or half-written file. That is not theoretical here — every reader of
// the lock path decides "is this stale?" from the bytes, and unparseable bytes read as
// stale, so a racer could judge a lock that was being born as abandoned and remove it.
// Measured with sixteen racers: 1/20 rounds lost a live lock to exactly that.
//
// link() has no such split. The staging file is fully written under a name nobody
// inspects, and link() then publishes it complete-or-not-at-all, still failing EEXIST
// if someone else got there first — the same mutual exclusion, without the window.
async function createExclusiveWithContent(targetPath: string, body: string): Promise<boolean> {
  const stagingPath = `${COLLABORATION_STAGING_PREFIX}${process.pid}.${path.basename(targetPath)}`;
  const staging = path.join(path.dirname(targetPath), stagingPath);
  await fsp.writeFile(staging, body, { encoding: "utf8" });
  try {
    await fsp.link(staging, targetPath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw e;
  } finally {
    await fsp.unlink(staging).catch(() => undefined);
  }
}

// Named after the exact bytes it authorizes removing, so every racer looking at the
// same stale lock competes for the same file — and the atomic 'wx' create picks
// exactly one of them. `generation` exists only to keep the scheme live: a claim
// whose holder was killed mid-eviction would otherwise wedge the lock path forever,
// so racers that agree it is abandoned all step to the same next generation and
// again exactly one wins.
const getEvictionClaimPath = (raw: string, generation: number): string => {
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return path.join(
    getStateBaseDir(),
    `${COLLABORATION_EVICT_PREFIX}${digest}.${generation}${COLLABORATION_EVICT_SUFFIX}`
  );
};

// A claim is abandoned only on *positive* evidence: a holder that no longer exists, or
// an age no live eviction could reach. Absence of evidence is not evidence — 'wx'
// creates the file and fills it in two steps, so a racer can legitimately read a claim
// that is still empty or half-written, and judging that "abandoned" is precisely what
// lets two evictors exist for the same content. Measured with sixteen racers: 2/20
// rounds lost a *live* lock that way, the second racer walking into the path the rogue
// evictor had emptied. Unjudgeable content therefore falls back to the file's own
// mtime, which a claim being written right now cannot fake.
function isEvictionClaimAbandoned(raw: string, mtimeMs: number): boolean {
  const abandonedByMtime =
    Number.isFinite(mtimeMs) && Date.now() - mtimeMs > COLLABORATION_EVICT_MAX_AGE_MS;
  let parsed: EvictionClaim | null = null;
  try {
    parsed = JSON.parse(raw) as EvictionClaim;
  } catch {
    return abandonedByMtime;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.pid !== "number"
  ) {
    return abandonedByMtime;
  }
  const createdAtMs = Date.parse(parsed.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return abandonedByMtime;
  }
  if (!isProcessAlive(parsed.pid)) {
    return true;
  }
  return Date.now() - createdAtMs > COLLABORATION_EVICT_MAX_AGE_MS;
}

// REV-233: WHY REMOVAL NEEDS A CLAIM, when the lock create is already an atomic 'wx'.
//
// Atomicity of the create was never the hole. The hole was the *removal*. To drop a
// stale lock without blindly unlinking a lock a racer may have just created, the old
// reclaim took custody of the path with a rename and put the file back if it turned
// out to be live. Between that rename and the restore the lock path stood EMPTY — and
// a third push's 'wx' create walked straight into it and reported success. The restore
// then overwrote that push's lock, so two processes both believed they held the lock
// and pushed the same records concurrently. Reproduced with a real multi-process
// harness against a planted stale lock: 2/15 rounds with three racers, 9/12 with five
// (three simultaneous winners in two of those). With no stale lock present, 0/12 — the
// plain 'wx' path was always sound.
//
// No amount of care inside a rename-based reclaim closes that window, and a mutex over
// the path only moves it: the mutex file is itself a contended path that has to be
// reclaimed when abandoned, which is the same problem one level up (measured — a guard
// built that way held at three and five racers and broke at eight).
//
// So removal is made exclusive the same way creation already is, with one atomic 'wx'
// on a path derived from the bytes being removed. The path is never held aside and
// never restored: it is emptied by exactly one process, and everyone else meets either
// the old content (and re-evaluates) or a free path (and races for it with 'wx', which
// is atomic). That is the whole invariant — the lock file is removed only by the winner
// of a claim on its exact content — and it holds for the acquire path and the release
// path alike.
//
// Residual: a claim holder that neither dies nor finishes for over
// COLLABORATION_EVICT_MAX_AGE_MS is stepped over, so two evictors can be live at once;
// they would have to interleave two syscalls precisely for the second to remove a lock
// the first already replaced. That needs a process stalled inside three filesystem calls
// for ten seconds — the same class of assumption the lock's own 30-minute age window
// already rests on.
async function evictLockFile(raw: string): Promise<boolean> {
  let generation = 0;
  // `generation` advances only on a claim we confirmed abandoned, so a claim that
  // merely vanished is retried at the same generation — stepping over it would let a
  // racer win the freed name while we win the next one, and two evictors is exactly
  // what this is here to prevent. `step` bounds the retries either way.
  for (let step = 0; step < COLLABORATION_EVICT_MAX_GENERATIONS * 2; step += 1) {
    if (generation >= COLLABORATION_EVICT_MAX_GENERATIONS) {
      return false;
    }
    const claimPath = getEvictionClaimPath(raw, generation);
    const won = await createExclusiveWithContent(
      claimPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)
    );
    if (!won) {
      let existing: string | null = null;
      let mtimeMs = Number.NaN;
      try {
        // Read and stat together: the content answers "whose claim is this", and the
        // mtime answers "how old is it" for a claim the content cannot answer for.
        const [content, stats] = await Promise.all([
          fsp.readFile(claimPath, "utf8"),
          fsp.stat(claimPath),
        ]);
        existing = content;
        mtimeMs = stats.mtimeMs;
      } catch {
        existing = null;
      }
      if (existing !== null && isEvictionClaimAbandoned(existing, mtimeMs)) {
        // Every racer that agrees it is abandoned steps to the same next generation,
        // where the atomic create again admits exactly one of them.
        generation += 1;
        continue;
      }
      if (existing !== null) {
        // Someone is actively evicting this content. Back off and re-read the path.
        return false;
      }
      continue;
    }

    try {
      // Re-read under the claim. We are the only process permitted to remove this
      // content, so the only way it can have changed is its own owner releasing it —
      // and then there is nothing here for us to remove.
      let current: string | null = null;
      try {
        current = await fsp.readFile(getCollaborationLockPath(), "utf8");
      } catch {
        current = null;
      }
      if (current === raw) {
        try {
          await fsp.unlink(getCollaborationLockPath());
        } catch (e) {
          // ENOENT means it is already gone, which is the outcome we wanted. Anything
          // else (a permission problem, a read-only tree) is a real failure the caller
          // must see rather than silently treat as a released lock.
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            throw e;
          }
        }
      }
    } finally {
      await fsp.unlink(claimPath).catch(() => undefined);
    }
    return true;
  }
  return false;
}

// Safe only from a process that has just created the lock: a live claim would mean a
// racer is removing content from the lock path, but the path now holds our brand-new
// lock, which nothing can yet have judged stale. Any claim still lying around is
// therefore the litter of an eviction that already finished or crashed, and re-winning
// one can only lead its holder to the same "content changed, nothing to remove" no-op.
async function sweepEvictionClaims(): Promise<void> {
  const baseDir = getStateBaseDir();
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(baseDir);
  } catch {
    // No readable state directory (or a test seam without readdir) — litter, if any,
    // is inert and the next successful acquire will get another chance to clear it.
    return;
  }
  await Promise.all(
    entries.map(async (name) => {
      const full = path.join(baseDir, name);
      if (name.startsWith(COLLABORATION_EVICT_PREFIX) && name.endsWith(COLLABORATION_EVICT_SUFFIX)) {
        await fsp.unlink(full).catch(() => undefined);
        return;
      }
      if (!name.startsWith(COLLABORATION_STAGING_PREFIX)) {
        return;
      }
      // A staging file belongs to a link() that is a syscall or two from finishing, so
      // unlinking one on age alone is safe while unlinking one on sight is not: it
      // would make its owner's link() fail spuriously.
      try {
        const stats = await fsp.stat(full);
        if (Date.now() - stats.mtimeMs > COLLABORATION_EVICT_MAX_AGE_MS) {
          await fsp.unlink(full).catch(() => undefined);
        }
      } catch {
        // Already gone, or no stat in this seam — nothing to clean either way.
      }
    })
  );
}

async function acquireCollaborationLock(
  command: string,
  instanceProfile?: string
): Promise<{ acquired: boolean; reason?: string }> {
  const owner = randomUUID();
  const lockPayload: CollaborationLock = {
    command,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    instanceProfile,
    owner,
  };
  const payload = JSON.stringify(lockPayload, null, 2);

  // Creation is atomic *and* whole: two concurrent runs cannot both win the race, and
  // no racer can ever observe a lock mid-write. The retries exist for the one case the
  // atomic create cannot settle by itself — a stale lock occupying the path — where the
  // loop re-reads and re-evaluates after each eviction attempt rather than assuming
  // what it will find.
  for (let attempt = 0; attempt < COLLABORATION_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (await createExclusiveWithContent(getCollaborationLockPath(), payload)) {
      heldLockOwner = owner;
      await sweepEvictionClaims();
      return { acquired: true };
    }

    let raw: string | null = null;
    try {
      raw = await fsp.readFile(getCollaborationLockPath(), "utf8");
    } catch {
      // Released between our failed create and this read; the next iteration races
      // for the freed path with the same atomic create.
      continue;
    }

    const existing = parseCollaborationLock(raw);
    if (existing !== null && !isCollaborationLockStale(existing)) {
      const holder = typeof existing.pid === "number" ? `pid ${existing.pid}` : "unknown pid";
      return {
        acquired: false,
        reason: `Detected active ${existing.command} lock (${holder}) created at ${existing.createdAt}.`,
      };
    }
    if (!isRawLockStale(raw)) {
      // Live, but too malformed to describe — a legacy lock written before the
      // `command` field existed. Never evicted on those grounds alone.
      return { acquired: false, reason: "Detected an active collaboration lock." };
    }

    if (!(await evictLockFile(raw))) {
      // Another racer is evicting the same content. Wait out its three filesystem
      // calls, with jitter so racers that arrived together do not retry in lockstep.
      await sleep(
        COLLABORATION_LOCK_RETRY_MS + Math.floor(Math.random() * COLLABORATION_LOCK_RETRY_MS)
      );
    }
  }

  return { acquired: false, reason: "Could not acquire collaboration lock." };
}

// REV-205: release must be as ownership-aware as reclaimStaleLock below. The old
// code unlinked whatever file sat at the lock path, and a lock can legitimately
// change hands while its original owner is still running: a push that outlives
// the 30-minute age window is judged stale by a collaborator, who reclaims the
// path and takes the lock: when the long push then reached the `finally` in
// pushCommand it deleted the collaborator's LIVE lock, and the next push walked
// straight in — two pushes writing the same records with no mutual exclusion.
// So we remove the lock only while it still carries the token we created.
//
// Refusing to delete is the safe direction: a lock we cannot prove is ours is
// left in place, and once this process exits its pid stops answering
// process.kill(pid, 0), so isCollaborationLockStale reclaims it immediately —
// nobody is blocked for the age window by our restraint.
async function releaseCollaborationLock(): Promise<void> {
  const owner = heldLockOwner;
  if (owner === null) {
    // We hold no lock (never acquired, or already released). Notably this is
    // what makes a repeated release harmless: without it, a second call would
    // delete whichever lock the next push had meanwhile acquired. Checked before
    // the guard so the common no-op release costs nothing.
    return;
  }
  let raw: string | null = null;
  try {
    raw = await fsp.readFile(getCollaborationLockPath(), "utf8");
  } catch {
    // Gone already (or unreadable). Either way there is nothing of ours left here.
    heldLockOwner = null;
    return;
  }
  const current = parseCollaborationLock(raw);
  if (current === null || current.owner !== owner) {
    // Another acquisition owns the path now. Leave it alone, and stop claiming to
    // hold a lock, so no later release retries this.
    heldLockOwner = null;
    return;
  }
  // REV-233: release removes the lock through the same eviction claim the acquire
  // path uses, so the invariant has no exception — the lock file is only ever removed
  // by the winner of a claim on its exact content. Without that, a collaborator who
  // judged our aged-out lock stale could install its own between our read and our
  // unlink, and we would delete a live lock we do not own.
  //
  // A failure here propagates with heldLockOwner still set: the file is still there
  // and still ours, so a retry may yet release it rather than abandoning it to the
  // stale path.
  await evictLockFile(raw);
  heldLockOwner = null;
}

// Drops a lock we've judged stale, without ever removing a lock a concurrent push may
// have legitimately created. The removal itself goes through evictLockFile, so it is
// exclusive and content-checked; this wrapper only supplies the staleness verdict.
// A live lock found at the path is left exactly as it is.
async function reclaimStaleLock(): Promise<void> {
  let raw: string;
  try {
    raw = await fsp.readFile(getCollaborationLockPath(), "utf8");
  } catch {
    // Another racer already removed it (or there was never one). Nothing to reclaim.
    return;
  }
  if (!isRawLockStale(raw)) {
    return;
  }
  await evictLockFile(raw);
}

// #18: the collaboration-lock primitives are otherwise reachable only through
// the full pushCommand flow (network client, inquirer prompts, config). This
// test-facing surface lets the lock lifecycle — atomic acquire, stale-pid
// reclaim, real-filesystem release — be exercised directly against a temp dir.
// Not part of the public CLI API; exported solely for coverage of the lock
// contract that guards concurrent pushes.
export const __lockInternals = {
  acquireCollaborationLock,
  releaseCollaborationLock,
  reclaimStaleLock,
  loadCollaborationLock,
  isCollaborationLockStale,
  isProcessAlive,
  getCollaborationLockPath,
  // REV-233 eviction-claim primitives.
  evictLockFile,
  getEvictionClaimPath,
  isEvictionClaimAbandoned,
  isRawLockStale,
  sweepEvictionClaims,
};

export async function pushCommand(args: Sync.PushCmdArgs): Promise<void> {
  setLogLevel(args);
  await scopeCheck(async () => {
    let lockAcquired = false;
    try {
      const dryRun = args.dryRun === true;
      const credentials = resolveCredentials(args.instanceProfile);
      const targetServer = credentials.instance;
      if (!targetServer) {
        logger.error("No server configured for push!");
        // DX20b: a logged-in user with no env creds may have a stored instance
        // that won't decrypt — that's the real reason, not "no server".
        const decryptWarning = await getActiveStoreDecryptWarning();
        if (decryptWarning) {
          logger.warn(decryptWarning);
        }
        // #49: tailor the next step to how credentials are configured instead of
        // hardcoding SN_* advice, and route it through the DX19 taxonomy sink.
        // No instance resolved is a configuration problem (missing config/.env).
        logErrorHint(new Error("missing config: no instance configured for push"));
        // #3: a misconfigured push (including `push --ci`) must fail the shell.
        process.exitCode = 1;
        return;
      }

      const client = defaultClient(args.instanceProfile);
      try {
        await client.checkConnection(5000);
        logScopedEndpointCapability("push");
      } catch (e) {
        logger.error(
          `Unable to reach ServiceNow instance ${targetServer} before push. Check the instance URL and network connectivity.`
        );
        // #49: classify the real reason (network vs auth) via the DX19 taxonomy
        // rather than hardcoding SN_* env-var advice.
        logErrorHint(e);
        // #3: an unreachable instance must fail the shell, not report success.
        process.exitCode = 1;
        return;
      }

      const { updateSet, ci: skipPrompt, target, diff } = args;
      // Did the caller name the scope, or did we derive it? The two answers make
      // an empty result mean opposite things, so the distinction is kept.
      const explicitTarget = target !== undefined && target !== "";
      let encodedPaths;
      if (explicitTarget) encodedPaths = target as string;
      else encodedPaths = await gitDiffToEncodedPaths(diff);

      let fileList = await AppUtils.getAppFileList(encodedPaths);

      // #15: `syncrona push <path>` names its own scope, and three ordinary
      // mistakes empty it out — a typo (encodedPathsToFilePaths drops paths that
      // do not exist, silently), a path outside the source tree, and a file no
      // manifest record claims (getAppFileList warns, then drops it). All three
      // used to log "0 files to push.", push nothing and exit 0: a green
      // `push --ci`, and a successful MCP push tool result, for a push that never
      // happened.
      //
      // A derived scope is the opposite case and stays a no-op: `push --diff main`
      // with nothing changed since main is a legitimate success, and so is a push
      // over a source tree that holds no tracked record yet.
      if (explicitTarget && fileList.length === 0) {
        logger.error(
          `Nothing to push: "${target}" matched no record this workspace tracks. ` +
            "Check the path, or run `syncrona refresh` if it is a real record that is not in the manifest yet."
        );
        process.exitCode = 1;
        return;
      }

      // A dry run is a read-only preview, so it returns before any checkpoint
      // state is read, resumed or cleared: previewing must never consume or
      // destroy the resume state a later real push depends on. It also previews
      // the FULL current diff, since narrowing it to a checkpoint's failures
      // would describe a push this run is not the one to perform.
      if (dryRun) {
        logger.info(`${fileList.length} files to push.`);
        if (fileList.length > 0) {
          const rows = fileList.map((rec) => {
            const fieldNames = Object.keys(rec.fields);
            const recordName = rec.fields[fieldNames[0]]?.name || rec.sysId;
            return [rec.table, recordName, String(fieldNames.length), rec.sysId];
          });
          logger.info(
            "Dry run — records that would be pushed:\n" +
              formatTable(["Table", "Record", "Fields", "sys_id"], rows)
          );
        }
        logger.info("Dry run enabled: skipping push checkpoint writes and remote push operation.");
        return;
      }

      // The resume decision below and the checkpoint written further down must
      // describe the same content, so the sources are fingerprinted once and the
      // result reused. It is computed on demand: a run that aborts before it
      // pushes anything (a declined prompt, a lock conflict) must not read every
      // source to reach that abort.
      let fingerprintsPromise: Promise<Record<string, string>> | undefined;
      const getCurrentFingerprints = () => {
        // Memoized against the record set current at first call. Later lookups
        // are by checkpoint key and only ever ask about records still in
        // fileList, which resume can shrink but never extend.
        if (!fingerprintsPromise) {
          fingerprintsPromise = fingerprintRecords(fileList);
        }
        return fingerprintsPromise;
      };

      const existingCheckpoint = await loadPushCheckpoint();
      if (existingCheckpoint && existingCheckpoint.failed.length > 0) {
        // A checkpoint only belongs to *this* push when three things all hold.
        // Otherwise it is discarded and the FULL current diff is pushed — never
        // silently narrowed — because a partial push that still exits 0 hides a
        // broken deployment.
        const currentKeys = new Set(fileList.map(recToCheckpointKey));
        const attemptedSet = new Set(existingCheckpoint.attempted);

        // #7: the checkpoint must belong to the instance we are pushing to now.
        // A checkpoint written against another instance (or a legacy checkpoint
        // with no recorded instance) must not be resumed here.
        const sameInstance = (existingCheckpoint.instance ?? "") === targetServer;
        // Every record the checkpoint still needs to retry is part of this diff.
        // Guards against a stale checkpoint from an unrelated earlier commit.
        const failedInCurrent = existingCheckpoint.failed.every((key) =>
          currentKeys.has(key)
        );
        // #1: the current diff introduces no record the checkpoint never attempted.
        // If the diff GREW since the checkpoint (a new record appeared), resuming
        // "only failed" would silently drop the new record and still exit 0.
        const currentIsSubsetOfAttempted = fileList.every((rec) =>
          attemptedSet.has(recToCheckpointKey(rec))
        );

        const checkpointMatchesDiff =
          sameInstance && failedInCurrent && currentIsSubsetOfAttempted;

        if (!checkpointMatchesDiff) {
          logger.warn(
            "Ignoring an unrelated push checkpoint from a previous run — it targets a different instance or does not match the current changes. Pushing the full current diff."
          );
          await clearPushCheckpoint();
        } else {
          const shouldResume = skipPrompt
            ? true
            : (
                await inquirer.prompt<{ confirmed: boolean }>([
                  {
                    type: "confirm",
                    name: "confirmed",
                    message:
                      "Found unfinished push checkpoint. Resume only failed records from the previous run?",
                    default: true,
                  },
                ])
              ).confirmed;

          if (shouldResume) {
            const failedKeys = new Set(existingCheckpoint.failed);
            // A record is skipped only when it already succeeded AND still holds
            // the content that succeeded. A record edited after the checkpoint
            // was written is pushed again — skipping it on identity alone would
            // drop the edit while the run still exits 0. A checkpoint with no
            // fingerprints predates the field and can only resume on identity.
            const recordedFingerprints = existingCheckpoint.fingerprints;
            // Nothing to compare a legacy checkpoint against, so the sources are
            // not read at all in that case.
            const currentFingerprints = recordedFingerprints
              ? await getCurrentFingerprints()
              : undefined;
            fileList = fileList.filter((rec) => {
              const key = recToCheckpointKey(rec);
              if (failedKeys.has(key)) {
                return true;
              }
              if (!recordedFingerprints || !currentFingerprints) {
                return false;
              }
              return recordedFingerprints[key] !== currentFingerprints[key];
            });
            logger.info(`Resuming from checkpoint with ${fileList.length} records.`);
          } else {
            await clearPushCheckpoint();
          }
        }
      }

      logger.info(`${fileList.length} files to push.`);

      const lock = await acquireCollaborationLock("push", args.instanceProfile);
      if (!lock.acquired) {
        logger.warn(`Push aborted due to collaboration lock conflict. ${lock.reason || ""}`.trim());
        logger.warn(
          "If this lock is stale, delete sync.collaboration.lock.json or wait for the active push to complete."
        );
        // A lock conflict pushed nothing, so it must fail the shell like every
        // other non-success abort; exiting 0 reports a no-op deploy as green.
        process.exitCode = 1;
        return;
      }
      lockAcquired = true;

      if (!skipPrompt) {
        const answers: { confirmed: boolean } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirmed",
            message:
              "Pushing will overwrite code in your instance. Are you sure?",
            default: false,
          },
        ]);
        if (!answers["confirmed"]) return;
      }

      // Does not create update set if updateSetName is blank
      if (updateSet) {
        if (!skipPrompt) {
          const answers: { confirmed: boolean } = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirmed",
              message: `A new Update Set "${updateSet}" will be created for these pushed changes. Do you want to proceed?`,
              default: false,
            },
          ]);
          if (!answers["confirmed"]) {
            return;
          }
        }

        const newUpdateSet = await AppUtils.createAndAssignUpdateSet(updateSet);
        logger.debug(
          `New Update Set Created(${newUpdateSet.name}) sys_id:${newUpdateSet.id}`
        );
      }

      // Write the checkpoint only after every confirmation has passed, so a
      // declined prompt leaves no fake "unfinished push" state behind.
      const attempted = fileList.map(recToCheckpointKey);
      const currentFingerprints = await getCurrentFingerprints();
      const fingerprints = Object.fromEntries(
        attempted.map((key) => [key, currentFingerprints[key]])
      );
      await writePushCheckpoint({
        attempted,
        succeeded: [],
        failed: attempted,
        instance: targetServer,
        fingerprints,
      });

      const pushResults = await AppUtils.pushFiles(fileList, args.pushConcurrency);

      const succeeded = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => item.res.success)
        .map((item) => item.key);

      const failed = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => !item.res.success)
        .map((item) => item.key);

      await writePushCheckpoint({
        attempted,
        succeeded,
        failed,
        instance: targetServer,
        fingerprints,
      });
      if (failed.length === 0) {
        await clearPushCheckpoint();
      } else {
        // #3: per-record push failures never reach the outer catch (pushFiles
        // converts them to { success: false } results), so `push --ci` used to
        // exit 0 on a broken deployment. Fail the shell whenever any record failed.
        process.exitCode = 1;
      }

      logPushResults(pushResults);
    } catch (e) {
      // Ctrl-C at the overwrite/confirmation prompt is a cancellation, not a
      // push failure: it used to be logged as an error and exit 1, which reads
      // as "the push broke" in CI. 130 is the conventional SIGINT exit code
      // (same mapping as commander.ts).
      if (isPromptAbort(e)) {
        process.exitCode = 130;
        return;
      }
      // Log the MESSAGE, not the raw Error object: the internal logger renders
      // an Error as "[object Object]"/"{}" depending on the transport, so the
      // actual reason for the failed push was invisible.
      const message = e instanceof Error ? e.message : String(e);
      logger.getInternalLogger().error(message || "Push failed with an unknown error.");
      logErrorHint(e); // DX19: actionable next step based on error category
      // exitCode instead of process.exit so the finally block can still
      // release the collaboration lock before the process ends.
      process.exitCode = 1;
    } finally {
      if (lockAcquired) {
        await releaseCollaborationLock();
      }
    }
  }, args.scopeSwap);
}
