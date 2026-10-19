#!/usr/bin/env node
// One racer in the collaboration-lock race harness. Spawned by scripts/lock-race.mjs,
// never run directly: it takes its whole configuration positionally and reports a
// single JSON line on stdout.
//
//   node scripts/lock-race-child.mjs <distPath> <startAtEpochMs> <holdMs> <release:0|1>
//
// It runs in its own process on purpose. The lock exists to exclude *processes*, and
// its two decisive mechanisms — O_EXCL/link() atomicity in the kernel and
// process.kill(pid, 0) liveness — have no meaning inside a single Node process with a
// mocked filesystem. A concurrency bug here is only reachable when real processes race
// on a real directory.

import fs from "node:fs";
import path from "node:path";

const [distPath, startAtRaw, holdRaw, releaseRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);
const holdMs = Number(holdRaw);
const doRelease = releaseRaw === "1";

const { acquireCollaborationLock, releaseCollaborationLock } = (await import(distPath))
  .__lockInternals;

const LOCK_PATH = path.join(process.cwd(), "sync.collaboration.lock.json");

// Spin to the barrier so every racer enters acquire() in the same millisecond.
// setTimeout granularity is far too coarse to line up a race this narrow.
while (Date.now() < startAt) {
  /* busy-wait, deliberately */
}

const out = {
  pid: process.pid,
  acquired: false,
  reason: null,
  released: false,
  // Narrow bounds of the interval this process held the lock: stamped after acquire
  // returned and before release was called, so the recorded interval is a strict
  // subset of the true one. An overlap detected between two of these is always real.
  acquiredAt: null,
  releasedAt: null,
  // The decisive check, and the one that needs no clock reasoning at all. Nothing may
  // remove or replace a *live* lock, so a holder polling its own lock file must never
  // see anything but its own pid — not a rival's, not an empty file, not a missing one.
  stolen: null,
  error: null,
};

function watchOwnLock(untilMs) {
  while (Date.now() < untilMs) {
    let raw = null;
    try {
      raw = fs.readFileSync(LOCK_PATH, "utf8");
    } catch (e) {
      out.stolen ??= { at: Date.now(), saw: `unreadable: ${e.code ?? e.message}` };
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      out.stolen ??= { at: Date.now(), saw: `unparseable: ${raw.slice(0, 120)}` };
      return;
    }
    if (parsed?.pid !== process.pid) {
      out.stolen ??= { at: Date.now(), saw: `pid ${parsed?.pid} owner ${parsed?.owner}` };
      return;
    }
  }
}

try {
  const res = await acquireCollaborationLock("push", `probe-${process.pid}`);
  out.acquired = res.acquired === true;
  out.reason = res.reason ?? null;
  if (out.acquired) {
    out.acquiredAt = Date.now();
    // Synchronous reads on purpose: this must not yield to the event loop between
    // the read and the comparison, or the window it is looking for closes unobserved.
    watchOwnLock(out.acquiredAt + holdMs);
  }
  if (doRelease) {
    if (out.acquired) {
      out.releasedAt = Date.now();
    }
    await releaseCollaborationLock();
    out.released = true;
  }
} catch (e) {
  out.error = String(e && e.message ? e.message : e);
}

process.stdout.write(`${JSON.stringify(out)}\n`);
