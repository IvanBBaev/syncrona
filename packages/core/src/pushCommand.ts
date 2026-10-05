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
import type {
  CreateCandidate,
  CreationPlan,
  PruneCandidate,
  PrunePlan,
} from "./pushPipeline.js";
import inquirer from "inquirer";
import { formatTable } from "./genericUtils.js";
import {
  gitDiffToChanges,
  gitDiffToEncodedPaths,
  gitWorkingTreeDeletions,
} from "./gitUtils.js";
import { getDownloadCheckpointPath } from "./downloadCheckpoint.js";
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
  // R1 (`push --create`): records this run created, `table:recordName` →
  // sys_id, written the moment each POST answers. A run interrupted between
  // the POST and the manifest write leaves the record on the instance but not
  // in the manifest; the next run adopts these instead of creating twice.
  created?: Record<string, string>;
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

// repairCommand's guard, shared by `push --prune`: with the source directory at
// the project root, a missing record directory proves nothing.
const isSourceTheProjectRoot = (): boolean =>
  path.resolve(ConfigManager.getSourcePath()) === path.resolve(ConfigManager.getRootDir());

// `push --prune` refuses a source tree in which "the files are gone" cannot be
// trusted to mean "the record was deleted": a blank `sourceDirectory`, a
// source directory that is missing or empty (a wrong checkout or a wiped tree
// would make every record look deleted), and an unfinished download, whose
// not-yet-written files are absent rather than deleted.
/**
 * Turn every `delete` of a prune plan on a table a creation failed on (all of
 * them when `failedTables` is null) into a refusal, so nothing is sent for it
 * and the manifest entry stays for the next run.
 */
export const holdPrunesAfterFailedCreates = (
  plan: PrunePlan,
  failedTables: Set<string> | null
): PrunePlan => {
  if (failedTables !== null && failedTables.size === 0) return plan;
  return {
    ...plan,
    plans: plan.plans.map((planned) =>
      planned.action === "delete" &&
      (failedTables === null || failedTables.has(planned.candidate.table))
        ? {
            ...planned,
            action: "error",
            message:
              "not deleted: a record could not be created in this table during the same push, " +
              "and a rename is a delete plus a create. The record is kept until the creation " +
              "succeeds; re-run the push.",
          }
        : planned
    ),
  };
};

/**
 * Turn every `delete` of a prune plan whose sys_id the creation plan of the
 * same run matched into a refusal. That is a record renamed on the instance
 * whose local files were renamed to match: deleting it would remove the very
 * record the new files are about to update. The creation plan refuses such an
 * adoption (the manifest already tracks the sys_id), and this keeps the
 * DELETE from landing either way, in a dry run and a real run alike.
 */
export const holdPrunesMatchedByCreation = (
  plan: PrunePlan,
  creation: CreationPlan | undefined
): PrunePlan => {
  const matched = new Map<string, string>();
  for (const planned of creation?.plans ?? []) {
    if (typeof planned.sysId === "string" && planned.sysId !== "") {
      matched.set(planned.sysId, `${planned.candidate.table} > ${planned.candidate.recordName}`);
    }
  }
  if (matched.size === 0) return plan;
  return {
    ...plan,
    plans: plan.plans.map((planned) => {
      const newFiles = matched.get(planned.candidate.sysId);
      if (planned.action !== "delete" || newFiles === undefined) return planned;
      return {
        ...planned,
        action: "error",
        message:
          `not deleted: the new local files of ${newFiles} match this same instance record ` +
          `(${planned.candidate.sysId}), so it looks renamed rather than deleted. The record ` +
          "and its manifest entry are kept; run `syncrona refresh` to pick up the new name.",
      };
    }),
  };
};

/** Tables on which the creation plan already refuses at least one record. */
const tablesWithPlannedErrors = (creation: CreationPlan | undefined): Set<string> =>
  new Set(
    (creation?.plans ?? [])
      .filter((planned) => planned.action === "error")
      .map((planned) => planned.candidate.table)
  );

const pruneSourceRefusal = async (): Promise<string | undefined> => {
  let configured: unknown;
  try {
    configured = (ConfigManager.getConfig() as Sync.Config | undefined)?.sourceDirectory;
  } catch (_) {
    configured = undefined;
  }
  if (typeof configured === "string" && configured.trim() === "") {
    return "`sourceDirectory` in sync.config.js is blank. Set the directory the records live in first.";
  }
  const sourcePath = ConfigManager.getSourcePath();
  let entries: unknown[];
  try {
    entries = await fsp.readdir(sourcePath);
  } catch (_) {
    return `the source directory ${sourcePath} does not exist or cannot be read.`;
  }
  if (entries.length === 0) {
    return `the source directory ${sourcePath} is empty, so every record would look deleted.`;
  }
  const checkpointPath = getDownloadCheckpointPath();
  try {
    await fsp.access(checkpointPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return `cannot tell whether a download is unfinished (${checkpointPath}: ${errorText(e)}).`;
  }
  return (
    `a download is unfinished (${checkpointPath} exists), so missing files may never have been written. ` +
    "Re-run `syncrona download` to finish it first."
  );
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// R1: `--create` wins when given either way; otherwise `createRecords` in
// sync.config.js decides, and the default is off. A config that cannot be read
// here is "off": creating records must never be the fallback.
const resolveCreateFlag = (flag: boolean | undefined): boolean => {
  if (typeof flag === "boolean") return flag;
  try {
    return (ConfigManager.getConfig() as Sync.Config | undefined)?.createRecords === true;
  } catch (_) {
    return false;
  }
};

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

// The checkpoint is a file on disk, so its `created` map is untrusted input:
// keep only non-empty string sys_ids under own keys, or nothing at all.
function sanitizeCreatedMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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
      // R2: `--prune` deletes instance records, so it is opt-in per run (there is
      // deliberately no config switch) and refuses a source directory that IS
      // the project root — there, "every file of the record is missing" can be
      // the result of pointing the CLI at the wrong tree.
      const prune = args.prune === true;
      if (prune && isSourceTheProjectRoot()) {
        logger.error(
          "Refusing to prune: the source directory is the project root. " +
            "Set a dedicated `sourceDirectory` in sync.config.js first."
        );
        process.exitCode = 1;
        return;
      }
      const allowMassDelete = args.allowMassDelete === true;
      if (prune) {
        const refusal = await pruneSourceRefusal();
        if (refusal) {
          logger.error(`Refusing to prune: ${refusal}`);
          process.exitCode = 1;
          return;
        }
        // Unattended, nobody reads the candidate list before the DELETEs run, so
        // the scope must come from somewhere other than "whatever is missing".
        // A dry run deletes nothing, so it may preview the whole tree.
        if (skipPrompt && !dryRun && !explicitTarget && !diff && !allowMassDelete) {
          logger.error(
            "Refusing to prune under --ci without a scope: pass --diff <ref> or a target path, " +
              "or --allow-mass-delete to consider every record of the tree."
          );
          process.exitCode = 1;
          return;
        }
      }
      let encodedPaths: string;
      let diffDeleted: string[] | undefined;
      if (prune && diff !== "") {
        // One git call yields both sides: the files to push, and the deleted
        // paths that restrict which records `--prune` may consider. An explicit
        // target still names the files to push, but the deletion evidence is
        // the diff the user asked for, as the --prune help states — not the
        // working tree against HEAD.
        const changes = await gitDiffToChanges(diff);
        encodedPaths = explicitTarget ? (target as string) : changes.changed;
        diffDeleted = changes.deleted;
      } else {
        encodedPaths = explicitTarget ? (target as string) : await gitDiffToEncodedPaths(diff);
      }
      if (prune && diffDeleted === undefined) {
        // Without --diff the evidence is the working tree against HEAD: only a
        // file git tracked and that is now gone counts as deleted. A file that
        // is merely absent — never downloaded, never committed — proves nothing.
        try {
          diffDeleted = await gitWorkingTreeDeletions();
        } catch (e) {
          logger.error(
            `Refusing to prune: git cannot list the deleted files (${errorText(e)}). ` +
              "`--prune` deletes only records whose files git shows as deleted."
          );
          process.exitCode = 1;
          return;
        }
      }

      const create = resolveCreateFlag(args.create);
      let fileList: Sync.BuildableRecord[];
      let candidates: CreateCandidate[] = [];
      if (create) {
        ({ records: fileList, candidates } = await AppUtils.getAppFileListWithCandidates(
          encodedPaths,
          { create: true }
        ));
      } else {
        fileList = await AppUtils.getAppFileList(encodedPaths);
      }
      const pruneCandidates: PruneCandidate[] = prune
        ? await AppUtils.findPruneCandidates({
            diffDeleted,
            targets: explicitTarget ? (target as string) : undefined,
          })
        : [];

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
      if (
        explicitTarget &&
        fileList.length === 0 &&
        candidates.length === 0 &&
        pruneCandidates.length === 0
      ) {
        logger.error(
          `Nothing to push: "${target}" matched no record this workspace tracks. ` +
            "Check the path, or run `syncrona refresh` if it is a real record that is not in the manifest yet."
        );
        process.exitCode = 1;
        return;
      }

      if (pruneCandidates.length > 0) {
        const volume = AppUtils.pruneVolumeRefusal(pruneCandidates.length);
        if (volume && !allowMassDelete) {
          if (!dryRun) {
            logger.error(`Refusing to prune: ${volume}`);
            process.exitCode = 1;
            return;
          }
          logger.warn(`${volume} A real run refuses it.`);
        }
        // A rename under --create is a delete plus a create: the record comes
        // back under a NEW sys_id, and whatever referenced the old one breaks.
        const pruneTables = new Set(pruneCandidates.map((c) => c.table));
        const renamed = [...new Set(candidates.map((c) => c.table))].filter((t) =>
          pruneTables.has(t)
        );
        for (const table of renamed) {
          logger.warn(
            `${table}: this push both deletes and creates records. If one is a rename, ` +
              "it is deleted and created again under a new sys_id, and references to the old sys_id break."
          );
        }
      }

      // A dry run is a read-only preview, so it returns before any checkpoint
      // state is read, resumed or cleared: previewing must never consume or
      // destroy the resume state a later real push depends on. It also previews
      // the FULL current diff, since narrowing it to a checkpoint's failures
      // would describe a push this run is not the one to perform.
      if (dryRun) {
        logger.info(`${fileList.length} files to push.`);
        // R1: the creation plan is read-only (GETs only, and the scope sys_id is
        // not persisted), so the preview can say exactly which records would be
        // created and which adopted.
        const creation =
          candidates.length > 0
            ? await AppUtils.planRecordCreation(candidates, { persistScopeId: false })
            : undefined;
        // R2: the prune plan is read-only too (one GET per candidate, scope
        // sys_id not persisted). No DELETE is sent and the manifest is untouched.
        // The same holds a real run applies before its DELETEs, so the preview
        // shows the decision the run would make.
        const prunePlan =
          pruneCandidates.length > 0
            ? holdPrunesAfterFailedCreates(
                holdPrunesMatchedByCreation(
                  await AppUtils.planRecordPrune(pruneCandidates, { persistScopeId: false }),
                  creation
                ),
                tablesWithPlannedErrors(creation)
              )
            : undefined;
        const showAction = create || prune;
        if (fileList.length > 0 || creation || prunePlan) {
          const rows = fileList.map((rec) => {
            const fieldNames = Object.keys(rec.fields);
            const recordName = rec.fields[fieldNames[0]]?.name || rec.sysId;
            const row = [rec.table, recordName, String(fieldNames.length), rec.sysId];
            return showAction ? ["update", ...row] : row;
          });
          for (const plan of creation?.plans ?? []) {
            const { table, recordName, files } = plan.candidate;
            rows.push([plan.action, table, recordName, String(files.length), plan.sysId ?? ""]);
            if (plan.action === "error") {
              logger.warn(`${table} > ${recordName} : ${plan.message}`);
            }
          }
          for (const plan of prunePlan?.plans ?? []) {
            const { table, recordName, files, sysId } = plan.candidate;
            rows.push([plan.action, table, recordName, String(files.length), sysId]);
            if (plan.action === "error" || plan.action === "unverified") {
              logger.warn(`${table} > ${recordName} : ${plan.message}`);
            }
          }
          const header = ["Table", "Record", "Fields", "sys_id"];
          logger.info(
            "Dry run — records that would be pushed:\n" +
              formatTable(showAction ? ["Action", ...header] : header, rows)
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
      // Records an interrupted run already created on THIS instance. Read before
      // the resume decision, which may discard the checkpoint: these sys_ids are
      // facts about the instance, not about the diff, and creating them again
      // would duplicate them.
      const knownCreated =
        existingCheckpoint && (existingCheckpoint.instance ?? "") === targetServer
          ? sanitizeCreatedMap(existingCheckpoint.created)
          : undefined;
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
      if (candidates.length > 0) {
        logger.info(`${candidates.length} new record(s) to create or adopt.`);
      }
      if (pruneCandidates.length > 0) {
        logger.info(
          `${pruneCandidates.length} record(s) with every local file deleted to prune.`
        );
      }

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

      // R2: plan the prune (GETs only) before anything is written, then ask a
      // separate confirmation that names the exact number of records the DELETEs
      // will remove. `--ci` is the only way past it unattended. The scope sys_id
      // is persisted only once that confirmation passed: a declined run writes
      // nothing.
      let prunePlan: PrunePlan | undefined;
      if (pruneCandidates.length > 0) {
        prunePlan = await AppUtils.planRecordPrune(pruneCandidates, { persistScopeId: false });
        for (const plan of prunePlan.plans) {
          if (plan.action === "error" || plan.action === "unverified") {
            const { table, recordName } = plan.candidate;
            logger.warn(`${table} > ${recordName} : ${plan.message}`);
          }
        }
        const toDelete = prunePlan.plans.filter((plan) => plan.action === "delete").length;
        if (toDelete > 0 && !skipPrompt) {
          const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
            {
              type: "confirm",
              name: "confirmed",
              message: `Delete ${toDelete} record(s) from ${targetServer}? This cannot be undone.`,
              default: false,
            },
          ]);
          if (!confirmed) {
            // A declined delete is a cancellation of the whole run (nothing has
            // been written yet), reported like Ctrl-C at a prompt.
            logger.warn("Push cancelled: no record was deleted and nothing was pushed.");
            process.exitCode = 130;
            return;
          }
        }
        await AppUtils.persistScopeId(prunePlan.scopeId);
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

      // R1: plan after the lock and the update set, so the idempotency lookups
      // see what any concurrent push left behind and the creations land in the
      // update set just selected.
      let creation: CreationPlan | undefined;
      if (candidates.length > 0) {
        creation = await AppUtils.planRecordCreation(candidates, {
          persistScopeId: true,
          known: knownCreated,
        });
      }

      // Write the checkpoint only after every confirmation has passed, so a
      // declined prompt leaves no fake "unfinished push" state behind.
      let attempted = fileList.map(recToCheckpointKey);
      const currentFingerprints = await getCurrentFingerprints();
      let fingerprints = Object.fromEntries(
        attempted.map((key) => [key, currentFingerprints[key]])
      );
      const created: Record<string, string> = { ...(knownCreated ?? {}) };
      const checkpointFor = (succeeded: string[], failed: string[]): PushCheckpoint => ({
        attempted,
        succeeded,
        failed,
        instance: targetServer,
        fingerprints,
        ...(Object.keys(created).length > 0 ? { created } : {}),
      });
      await writePushCheckpoint(checkpointFor([], attempted));

      let creationResults: Sync.PushResult[] = [];
      // Tables a creation failed on; `null` holds back every deletion.
      let createFailedTables: Set<string> | null = new Set();
      if (creation) {
        const outcome = await AppUtils.createRecords(creation, {
          onCreated: async (key: string, sysId: string) => {
            created[key] = sysId;
            await writePushCheckpoint(checkpointFor([], attempted));
          },
        });
        creationResults = outcome.results;
        if (Array.isArray(outcome.failedTables)) {
          createFailedTables = new Set(outcome.failedTables);
        } else if (outcome.results.some((res) => !res.success)) {
          createFailedTables = null;
        }
        if (outcome.records.length > 0) {
          // Adopted records are ordinary updates from here on.
          fileList = [...fileList, ...outcome.records];
          attempted = fileList.map(recToCheckpointKey);
          fingerprints = { ...fingerprints, ...(await fingerprintRecords(outcome.records)) };
          await writePushCheckpoint(checkpointFor([], attempted));
        }
      }

      // R2: deletions run after creations and before the PATCHes; each removes
      // its record from the manifest as it lands.
      // Batch 4 item 3: a rename is a delete plus a create, so a deletion on a
      // table whose creation failed in this run is held back — deleting the
      // old record when its replacement never landed would lose it.
      const pruneResults = prunePlan
        ? await AppUtils.pruneRecords(
            holdPrunesAfterFailedCreates(
              holdPrunesMatchedByCreation(prunePlan, creation),
              createFailedTables
            )
          )
        : [];

      const pushResults = await AppUtils.pushFiles(fileList, args.pushConcurrency);

      const succeeded = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => item.res.success)
        .map((item) => item.key);

      const failed = pushResults
        .map((res, index) => ({ res, key: attempted[index] }))
        .filter((item) => !item.res.success)
        .map((item) => item.key);

      await writePushCheckpoint(checkpointFor(succeeded, failed));
      const creationFailed = creationResults.some((res) => !res.success);
      if (failed.length === 0 && !creationFailed) {
        await clearPushCheckpoint();
      } else {
        // #3: per-record push failures never reach the outer catch (pushFiles
        // converts them to { success: false } results), so `push --ci` used to
        // exit 0 on a broken deployment. Fail the shell whenever any record failed.
        // A failed creation keeps the checkpoint too: its `created` map is what
        // stops the next run from creating a record twice.
        process.exitCode = 1;
      }
      if (pruneResults.some((res) => !res.success)) {
        // Prune is not part of the checkpoint (a DELETE is re-planned from the
        // manifest on the next run), but a refused or failed delete still fails
        // the shell.
        process.exitCode = 1;
      }

      logPushResults([...creationResults, ...pruneResults, ...pushResults]);
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
