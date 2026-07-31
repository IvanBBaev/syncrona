// SPDX-License-Identifier: GPL-3.0-or-later
//
// Child driver for collaborationLockRace.test.ts — one OS process per racer.
//
// Why a plain .mjs and not a TypeScript module: the point of the race harness is
// that the contenders are REAL, separately scheduled OS processes running the
// REAL lock implementation. A ts-jest worker cannot be that (its module registry,
// mocks and `heldLockOwner` are all in-process), so each racer is a bare `node`
// process that imports the compiled implementation from dist/. The parent test
// passes the absolute path to dist/pushCommand.js as argv[2] so there is one
// source of truth for that path, and the parent — not this file — is responsible
// for failing loudly when dist/ is missing.
//
// The lock path itself is never passed in: it must be resolved by the
// implementation under test (getStateBaseDir → ConfigManager.getRootDir(), which
// throws when no syncrona config is loaded, falling back to process.cwd()). The
// parent therefore spawns every child with cwd set to the test's temp dir, and
// this child reports the path it resolved so the parent can assert the racers
// really are contending for one file rather than passing trivially in isolation.
//
// Protocol: line-delimited JSON. The child emits `ready` once, then one message
// per command it is given on stdin. Commands:
//   {"op":"acquire","command":"push","profile":"a"}        → {"event":"acquire-result",...}
//   {"op":"arm","barrier":"<path>","command":"push",...}   → {"event":"armed"} then acquire-result
//   {"op":"release"}                                       → {"event":"release-result",...}
//   {"op":"exit"}                                          → exits 0
import { existsSync, readFileSync } from "fs";
import readline from "readline";
import { pathToFileURL } from "url";

const distEntry = process.argv[2];
if (!distEntry) {
  process.stderr.write("collaborationLockChild: missing dist entry argument\n");
  process.exit(2);
}

const { __lockInternals: lock } = await import(pathToFileURL(distEntry).href);
const lockPath = lock.getCollaborationLockPath();

const say = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

// The owner token is minted inside acquireCollaborationLock and kept in a
// module-private variable, so the only way to observe it is the file the winner
// just wrote. Read straight after the acquire so the parent can later assert the
// token that ends up on disk is still the same acquisition's.
const ownerOnDisk = () => {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")).owner ?? null;
  } catch {
    return null;
  }
};

// Busy-wait, deliberately: a sleep-poll would stagger the racers by the poll
// interval and they would line up instead of colliding inside the `wx` create,
// which is the only window this harness exists to exercise. Bounded so a barrier
// that never appears fails the child (and the parent's wait) instead of hanging.
const spinUntilBarrier = (barrier, deadlineMs) => {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) return false;
  }
  return true;
};

const acquire = async (msg) => {
  const result = await lock.acquireCollaborationLock(msg.command ?? "push", msg.profile);
  say({ event: "acquire-result", pid: process.pid, result, ownerOnDisk: ownerOnDisk() });
};

say({ event: "ready", pid: process.pid, lockPath });

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    say({ event: "error", pid: process.pid, error: `unparseable command: ${line}` });
    continue;
  }
  try {
    switch (msg.op) {
      case "acquire":
        await acquire(msg);
        break;
      case "arm":
        say({ event: "armed", pid: process.pid });
        if (!spinUntilBarrier(msg.barrier, msg.deadlineMs ?? 10000)) {
          say({ event: "error", pid: process.pid, error: "barrier never appeared" });
          break;
        }
        await acquire(msg);
        break;
      case "release":
        // Report the throw rather than dying on it: "release does not throw when
        // the lock changed hands" is one of the properties under test, so the
        // parent must be able to tell a clean release from a rejected one.
        try {
          await lock.releaseCollaborationLock();
          say({ event: "release-result", pid: process.pid, threw: false });
        } catch (e) {
          say({ event: "release-result", pid: process.pid, threw: true, error: String(e) });
        }
        break;
      case "exit":
        process.exit(0);
      default:
        say({ event: "error", pid: process.pid, error: `unknown op: ${String(msg.op)}` });
    }
  } catch (e) {
    say({ event: "error", pid: process.pid, error: String(e) });
  }
}
