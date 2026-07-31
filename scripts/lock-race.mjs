#!/usr/bin/env node
// REV-233: multi-process race harness for the push collaboration lock.
//
// Usage:
//   npm run race:lock                                  # default matrix-ish single run
//   node scripts/lock-race.mjs --rounds 20 --racers 16 --mode stale
//   node scripts/lock-race.mjs --racers 12 --hold-ms 0 --release 0
//
// It imports the COMPILED core (`packages/core/dist/pushCommand.js`), so build first.
//
// WHY A PROCESS HARNESS AND NOT A UNIT TEST
// The lock's two load-bearing mechanisms are kernel-level: link()'s all-or-nothing
// publication, and process.kill(pid, 0) liveness. Neither means anything inside one
// Node process against a mocked filesystem, so the unit suites can only assert the
// logic around them. Every real defect this lock has had was found here and was
// invisible to the unit suites.
//
// WHAT THE INVARIANT IS — AND IS NOT
// It is NOT "at most one racer per round acquires". That check is wrong in both
// directions and its first version reported 15/15 failures against correct code: a
// winner that releases (or simply exits, freeing its lock by pid liveness) legitimately
// hands the lock to a racer still inside its retry loop. Sequential handoff is the
// system working. Two checks are sound instead:
//
//   1. TEMPORAL OVERLAP. Each racer reports a held interval that is a strict subset of
//      the true one, so any overlap between two of them is a genuine mutual-exclusion
//      break — two processes that both believed they owned the lock at the same instant.
//   2. THE SELF-WATCH (decisive). The holder polls its own lock file for the whole hold
//      and must never see anything but its own pid. This needs no clock reasoning: a
//      holder that sees a rival's pid, an empty file or a missing file has been robbed.
//
// Handoffs are counted and printed, not flagged. A clean run with zero handoffs would
// mean the racers never actually contended and the run proved nothing.
//
// WHAT IT HAS CAUGHT
//   rename-based reclaim   2/15 rounds at 3 racers, 9/12 at 5 (three simultaneous
//                          winners in two of those) — the lock path stood empty between
//                          the rename-aside and the restore.
//   mutex-file guard       held at 3 and 5 racers, broke 7/20 at 8 — the mutex is itself
//                          a contended path with the same reclaim problem one level up.
//   claim + 'wx' create    2/20 at 16 racers — O_CREAT|O_EXCL publishes the name before
//                          the bytes, so a claim being born reads as empty, and empty
//                          read as abandoned.
//   claim + 'wx' on lock   1/20 at 16 racers — the same window on the lock file itself.
//   claim + link()         0 anomalies over ~180 rounds up to 24 racers (current design).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, "lock-race-child.mjs");
const DIST = path.resolve(here, "../packages/core/dist/pushCommand.js");
const LOCK_FILE = "sync.collaboration.lock.json";
const EVICT_PREFIX = "sync.collaboration.evict.";
const STAGING_PREFIX = "sync.collaboration.staging.";
// Comfortably above any pid a live process holds, so the planted lock is stale by the
// liveness rule without being stale by age — which is the case that has to be reclaimed.
const DEAD_PID = 2 ** 22;
// Enough for a child to boot Node, import the compiled core and reach the barrier.
const BARRIER_LEAD_MS = 700;

function parseArgs(argv) {
  const args = { rounds: 20, racers: 8, mode: "stale", holdMs: 60, release: true };
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case "--rounds":
        args.rounds = Number(next);
        i += 1;
        break;
      case "--racers":
        args.racers = Number(next);
        i += 1;
        break;
      case "--mode":
        args.mode = String(next);
        i += 1;
        break;
      case "--hold-ms":
        args.holdMs = Number(next);
        i += 1;
        break;
      case "--release":
        args.release = next !== "0";
        i += 1;
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(2);
    }
  }
  if (args.mode !== "stale" && args.mode !== "fresh") {
    console.error(`--mode must be "stale" or "fresh", got "${args.mode}"`);
    process.exit(2);
  }
  // A harness that silently accepts NaN reports a green run of zero rounds, which is
  // the worst possible failure mode for a safety check — it looks like proof. Caught
  // for real: a shell loop that did not word-split its configuration passed the whole
  // string as --rounds, and every configuration in the matrix "passed" instantly.
  for (const [flag, value] of [
    ["--rounds", args.rounds],
    ["--racers", args.racers],
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      console.error(`${flag} must be a positive integer, got "${value}"`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(args.holdMs) || args.holdMs < 0) {
    console.error(`--hold-ms must be a non-negative integer, got "${args.holdMs}"`);
    process.exit(2);
  }
  return args;
}

const opts = parseArgs(process.argv.slice(2));

if (!fs.existsSync(DIST)) {
  console.error(`Could not find ${DIST}. Run \`npm run build\` first.`);
  process.exit(2);
}

function runChild(dir, startAt) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CHILD, DIST, String(startAt), String(opts.holdMs), opts.release ? "1" : "0"],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      // Process exit is the outer bound of any lock this child still holds: an
      // unreleased lock stays authoritative only while its pid answers.
      const closedAt = Date.now();
      const line = out.trim().split("\n").filter(Boolean).pop();
      try {
        resolve({ ...JSON.parse(line), closedAt });
      } catch {
        resolve({ acquired: false, closedAt, parseFailure: out.trim(), stderr: err.trim() });
      }
    });
  });
}

// Held intervals that overlap ⇒ two processes believed they owned the lock at once.
function findOverlap(results) {
  const held = results
    .filter((r) => r.acquired && typeof r.acquiredAt === "number")
    .map((r) => ({
      pid: r.pid,
      from: r.acquiredAt,
      // releasedAt when the child released; otherwise it holds the lock until its pid
      // stops answering, which is exactly process close.
      to: typeof r.releasedAt === "number" ? r.releasedAt : r.closedAt,
    }))
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < held.length; i += 1) {
    if (held[i].from < held[i - 1].to) {
      return { a: held[i - 1], b: held[i] };
    }
  }
  return null;
}

const tally = {
  stolen: 0,
  overlap: 0,
  zeroWinner: 0,
  leftoverLock: 0,
  leftoverClaim: 0,
  leftoverStaging: 0,
  childError: 0,
  // Neither is an anomaly. Both are printed because a run in which nobody ever lost
  // the race and nobody ever took it over proves nothing about mutual exclusion.
  handoffs: 0,
  losses: 0,
};

for (let round = 1; round <= opts.rounds; round += 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-lock-race-"));
  const lockPath = path.join(dir, LOCK_FILE);

  if (opts.mode === "stale") {
    // A crashed push's leftovers: young enough to pass the age check, owned by a pid
    // that no longer exists — exactly what the reclaim path has to handle, and the
    // only configuration in which any of the broken designs above ever failed.
    fs.writeFileSync(
      lockPath,
      JSON.stringify(
        { command: "push", pid: DEAD_PID, createdAt: new Date().toISOString(), owner: "planted" },
        null,
        2
      )
    );
  }

  const startAt = Date.now() + BARRIER_LEAD_MS;
  const results = await Promise.all(
    Array.from({ length: opts.racers }, () => runChild(dir, startAt))
  );

  const winners = results.filter((r) => r.acquired).length;
  const errors = results.filter((r) => r.error || r.parseFailure);
  const leftovers = fs.readdirSync(dir);
  const claimsLeft = leftovers.filter((f) => f.startsWith(EVICT_PREFIX));
  const stagingLeft = leftovers.filter((f) => f.startsWith(STAGING_PREFIX));
  const overlap = findOverlap(results);
  const stolen = results.filter((r) => r.stolen);

  const flags = [];
  if (stolen.length > 0) {
    tally.stolen += 1;
    flags.push(
      `STOLEN from pid ${stolen[0].pid} at ${stolen[0].stolen.at} — saw ${stolen[0].stolen.saw}`
    );
  }
  if (overlap) {
    tally.overlap += 1;
    flags.push(
      `OVERLAP pid ${overlap.a.pid} [${overlap.a.from}..${overlap.a.to}] vs pid ${overlap.b.pid} [${overlap.b.from}..${overlap.b.to}]`
    );
  }
  if (winners > 1) {
    // Sequential handoff: legal, and reported so a clean run is not mistaken for one
    // in which the racers never met.
    tally.handoffs += winners - 1;
  }
  tally.losses += results.length - winners;
  if (winners === 0) {
    // Nobody got in even though the only lock present was a dead process's: a
    // liveness failure rather than a safety one, but still a bug.
    tally.zeroWinner += 1;
    flags.push("WINNERS=0");
  }
  if (opts.release && leftovers.includes(LOCK_FILE)) {
    tally.leftoverLock += 1;
    flags.push("LOCK-FILE-LEFT");
  }
  if (claimsLeft.length > 0) {
    tally.leftoverClaim += 1;
    flags.push(`CLAIM-LEFT=${claimsLeft.length}`);
  }
  if (stagingLeft.length > 0) {
    tally.leftoverStaging += 1;
    flags.push(`STAGING-LEFT=${stagingLeft.length}`);
  }
  if (errors.length > 0) {
    tally.childError += 1;
    flags.push(`CHILD-ERROR=${JSON.stringify(errors[0]).slice(0, 200)}`);
  }
  if (flags.length > 0) {
    console.log(`round ${round}: winners=${winners} ${flags.join(" | ")}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

const anomalies =
  tally.stolen +
  tally.overlap +
  tally.zeroWinner +
  tally.leftoverLock +
  tally.leftoverClaim +
  tally.leftoverStaging +
  tally.childError;

console.log(
  `rounds=${opts.rounds} racers=${opts.racers} mode=${opts.mode} hold=${opts.holdMs}ms ` +
    `release=${opts.release ? 1 : 0} → ${JSON.stringify(tally)}`
);

if (anomalies > 0) {
  console.error(`FAIL: ${anomalies} anomalous round(s).`);
  process.exit(1);
}
if (opts.racers > 1 && tally.losses === 0 && tally.handoffs === 0) {
  // No racer ever lost the path and none ever took it over, so the run never
  // exercised the contended path it exists to exercise. Passing on that would be a
  // false negative, and the usual cause is a configuration mistake (an unbuilt dist,
  // a barrier lead too short for the machine) rather than a healthy lock.
  console.error("INCONCLUSIVE: no contention observed — check the harness configuration.");
  process.exit(1);
}
console.log("OK: no mutual-exclusion violations.");
