// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, statSync } from "fs";
import { readdir, stat } from "fs/promises";
import path from "path";
import {
  buildSemanticIndexFromWorkspace,
  buildSemanticIndexFromWorkspaceAsync,
  type SemanticSymbol,
} from "./analysis";
import { writeAuditEvent } from "./audit";
import { AUDIT_DIR, AUDIT_FILE, PROJECT_DIR } from "./runtimeConfig";

let LAST_SEMANTIC_INDEX: SemanticSymbol[] | null = null;
let LAST_SEMANTIC_INDEX_DIRTY = true;
let LAST_SEMANTIC_INDEX_BUILT_AT = 0;
// REV-155: how many source files the walk saw when the cached index was built.
// null means "unknown provenance" (rows handed in by setSemanticIndex), in which
// case the deletion check below is skipped rather than guessed at.
let LAST_SEMANTIC_INDEX_FILE_COUNT: number | null = null;
// PERF-5 (REV-98): a single in-flight async build shared by concurrent readers.
// Without it, N requests arriving while the index is dirty each launch their own
// full workspace walk (thundering herd); they collapse onto one build here.
let SEMANTIC_INDEX_BUILD_IN_FLIGHT: Promise<SemanticSymbol[]> | null = null;
// REV-154: bumped by every invalidation so a build can tell whether the workspace
// changed while it was running. See commitSemanticIndex.
let INVALIDATION_EPOCH = 0;
// REV-156: memoized result of the async staleness poll, so a burst of tool calls
// shares one workspace walk instead of one walk per call.
const STALENESS_POLL_INTERVAL_MS = 500;
let LAST_STALENESS_POLL_AT = 0;
let LAST_STALENESS_POLL_RESULT = false;

type SourceTreeSample = {
  newestMtimeMs: number;
  fileCount: number;
};

export function setSemanticIndex(rows: SemanticSymbol[]): void {
  LAST_SEMANTIC_INDEX = rows;
  LAST_SEMANTIC_INDEX_DIRTY = false;
  LAST_SEMANTIC_INDEX_BUILT_AT = Date.now();
  // Rows built elsewhere carry no tree sample; forget the previous one instead of
  // attributing it to this index. (REV-155)
  LAST_SEMANTIC_INDEX_FILE_COUNT = null;
  LAST_STALENESS_POLL_AT = 0;
}

/**
 * REV-154: publish a build together with the state it was started from. The old
 * code called setSemanticIndex() when the build finished, which cleared the dirty
 * flag unconditionally — so an invalidation that arrived WHILE the (async) build
 * was walking the workspace was swallowed: the freshly published index predated
 * the change, yet the index reported itself clean and the change stayed invisible
 * until some later tool call happened to invalidate again. Clearing the flag is
 * now conditional on the epoch being unchanged, and builtAt records when the walk
 * STARTED, so a file written mid-build still reads as newer than the index.
 */
function commitSemanticIndex(
  rows: SemanticSymbol[],
  build: { startedAt: number; epoch: number; fileCount: number }
): void {
  LAST_SEMANTIC_INDEX = rows;
  LAST_SEMANTIC_INDEX_BUILT_AT = build.startedAt;
  LAST_SEMANTIC_INDEX_FILE_COUNT = build.fileCount;
  if (build.epoch === INVALIDATION_EPOCH) {
    LAST_SEMANTIC_INDEX_DIRTY = false;
  }
  LAST_STALENESS_POLL_AT = 0;
}

export function invalidateSemanticIndex(reason: string = "unknown"): void {
  LAST_SEMANTIC_INDEX_DIRTY = true;
  INVALIDATION_EPOCH += 1;
  LAST_STALENESS_POLL_AT = 0;

  writeAuditEvent(AUDIT_DIR, AUDIT_FILE, {
    timestamp: new Date().toISOString(),
    event: "semantic_index.invalidated",
    reason,
  });
}

function isSkippedEntry(entry: string): boolean {
  return entry === "node_modules" || entry === "dist" || entry.startsWith(".");
}

function isSourceFile(entry: string): boolean {
  return /\.(js|ts)$/.test(entry);
}

/**
 * CONC-2 (REV-93): newest mtime (ms since epoch) of any `.js`/`.ts` source under
 * `rootDir`, mirroring buildSemanticIndexFromWorkspace's walk (skips node_modules,
 * dist, and dotfiles). Best-effort: unreadable dirs/entries are skipped so a
 * transient fs error can never throw out of a read path.
 *
 * REV-155: the walk also counts the files it saw. mtime alone cannot see a
 * DELETION — removing a file leaves every survivor older than the index, so the
 * deleted symbols kept being served as if they still existed. The count closes
 * that: fewer sources than at build time means the index describes files that are
 * gone.
 */
function sampleSourceTree(rootDir: string): SourceTreeSample {
  let newestMtimeMs = 0;
  let fileCount = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (isSkippedEntry(entry)) {
        continue;
      }
      const fullPath = path.join(dir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch (_) {
        continue;
      }
      if (st.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!isSourceFile(entry)) {
        continue;
      }
      fileCount += 1;
      if (st.mtimeMs > newestMtimeMs) {
        newestMtimeMs = st.mtimeMs;
      }
    }
  };
  walk(rootDir);
  return { newestMtimeMs, fileCount };
}

/**
 * REV-156: async twin of sampleSourceTree. The poll used to run the SYNCHRONOUS
 * walk from getSemanticIndexAsync — the deliberately non-blocking getter — so
 * every tool call stalled the event loop for a full stat-walk of the workspace,
 * cache hits included. Same traversal rules, same best-effort error handling.
 */
async function sampleSourceTreeAsync(rootDir: string): Promise<SourceTreeSample> {
  let newestMtimeMs = 0;
  let fileCount = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (isSkippedEntry(entry)) {
        continue;
      }
      const fullPath = path.join(dir, entry);
      let st;
      try {
        st = await stat(fullPath);
      } catch (_) {
        continue;
      }
      if (st.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!isSourceFile(entry)) {
        continue;
      }
      fileCount += 1;
      if (st.mtimeMs > newestMtimeMs) {
        newestMtimeMs = st.mtimeMs;
      }
    }
  };
  await walk(rootDir);
  return { newestMtimeMs, fileCount };
}

/**
 * CONC-2 (REV-93): lightweight, poll-on-read staleness check (no fs watcher).
 * The index is stale when a source file was modified after the index was built,
 * or when sources have disappeared since (REV-155) — this catches out-of-band
 * edits, deletions and bootstrap downloads that the tool-triggered invalidation
 * allowlist misses. Returns false when nothing is built yet (the primary guard
 * handles that) or when freshness cannot be determined.
 *
 * Honest limit: an edit that leaves the file count unchanged AND back-dates the
 * mtime below builtAt (restoring a backup in place, or a checkout that preserves
 * timestamps) is still invisible to the poll; only an explicit invalidation or a
 * later edit recovers. Detecting it would need a content hash of the whole tree
 * on every read, which is exactly the cost this poll exists to avoid.
 */
function isSampleStale(sample: SourceTreeSample): boolean {
  if (!LAST_SEMANTIC_INDEX) {
    return false;
  }
  if (
    LAST_SEMANTIC_INDEX_FILE_COUNT !== null &&
    sample.fileCount < LAST_SEMANTIC_INDEX_FILE_COUNT
  ) {
    return true;
  }
  if (sample.newestMtimeMs === 0) {
    return false;
  }
  return sample.newestMtimeMs > LAST_SEMANTIC_INDEX_BUILT_AT;
}

async function isSemanticIndexStaleAsync(projectDir: string): Promise<boolean> {
  if (!LAST_SEMANTIC_INDEX) {
    return false;
  }
  // REV-156: a burst of tool calls polls the same unchanged workspace; reuse the
  // last answer inside a short window so the walk is amortized instead of paid per
  // call. Every publish/invalidation resets the window, so the delay only ever
  // defers noticing an out-of-band edit by up to STALENESS_POLL_INTERVAL_MS —
  // tool-triggered changes still invalidate immediately.
  const now = Date.now();
  if (LAST_STALENESS_POLL_AT !== 0 && now - LAST_STALENESS_POLL_AT < STALENESS_POLL_INTERVAL_MS) {
    return LAST_STALENESS_POLL_RESULT;
  }
  const stale = isSampleStale(await sampleSourceTreeAsync(projectDir));
  LAST_STALENESS_POLL_AT = Date.now();
  LAST_STALENESS_POLL_RESULT = stale;
  return stale;
}

export function getSemanticIndex(projectDir: string = PROJECT_DIR): SemanticSymbol[] {
  // Snapshot before the walk so a file written while it runs still reads as newer
  // than the index it produced. (REV-154)
  const startedAt = Date.now();
  const epoch = INVALIDATION_EPOCH;
  // One walk answers both questions: is the cache stale, and what did the tree look
  // like when this build started.
  const sample = sampleSourceTree(projectDir);
  if (!LAST_SEMANTIC_INDEX || LAST_SEMANTIC_INDEX_DIRTY || isSampleStale(sample)) {
    const nextIndex = buildSemanticIndexFromWorkspace(projectDir);
    commitSemanticIndex(nextIndex, { startedAt, epoch, fileCount: sample.fileCount });
  }

  return LAST_SEMANTIC_INDEX || [];
}

/**
 * PERF-5 (REV-98): non-blocking twin of getSemanticIndex. Same freshness policy
 * (missing / dirty / mtime-stale triggers a rebuild), but the rebuild runs the
 * async workspace walk so it never stalls the event loop, and concurrent callers
 * that all observe a stale index share one build via SEMANTIC_INDEX_BUILD_IN_FLIGHT
 * instead of each launching their own. This is the path the MCP tool dispatcher
 * uses; the synchronous getter above is retained for callers that cannot await
 * (and for the staleness unit tests).
 */
export async function getSemanticIndexAsync(
  projectDir: string = PROJECT_DIR
): Promise<SemanticSymbol[]> {
  if (
    LAST_SEMANTIC_INDEX &&
    !LAST_SEMANTIC_INDEX_DIRTY &&
    !(await isSemanticIndexStaleAsync(projectDir))
  ) {
    return LAST_SEMANTIC_INDEX;
  }

  if (SEMANTIC_INDEX_BUILD_IN_FLIGHT) {
    return SEMANTIC_INDEX_BUILD_IN_FLIGHT;
  }

  SEMANTIC_INDEX_BUILD_IN_FLIGHT = (async () => {
    // Snapshot the pre-build state BEFORE any await, so an invalidation raised
    // while this build runs is observable at publish time. (REV-154)
    const startedAt = Date.now();
    const epoch = INVALIDATION_EPOCH;
    try {
      const sample = await sampleSourceTreeAsync(projectDir);
      const nextIndex = await buildSemanticIndexFromWorkspaceAsync(projectDir);
      commitSemanticIndex(nextIndex, { startedAt, epoch, fileCount: sample.fileCount });
      return nextIndex;
    } finally {
      SEMANTIC_INDEX_BUILD_IN_FLIGHT = null;
    }
  })();

  return SEMANTIC_INDEX_BUILD_IN_FLIGHT;
}

export function getSemanticIndexState(): {
  built: boolean;
  dirty: boolean;
  symbolCount: number;
  builtAt: number;
} {
  return {
    built: Array.isArray(LAST_SEMANTIC_INDEX),
    dirty: LAST_SEMANTIC_INDEX_DIRTY,
    symbolCount: LAST_SEMANTIC_INDEX ? LAST_SEMANTIC_INDEX.length : 0,
    builtAt: LAST_SEMANTIC_INDEX_BUILT_AT,
  };
}
