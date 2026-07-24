// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, statSync } from "fs";
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
// PERF-5 (REV-98): a single in-flight async build shared by concurrent readers.
// Without it, N requests arriving while the index is dirty each launch their own
// full workspace walk (thundering herd); they collapse onto one build here.
let SEMANTIC_INDEX_BUILD_IN_FLIGHT: Promise<SemanticSymbol[]> | null = null;

export function setSemanticIndex(rows: SemanticSymbol[]): void {
  LAST_SEMANTIC_INDEX = rows;
  LAST_SEMANTIC_INDEX_DIRTY = false;
  LAST_SEMANTIC_INDEX_BUILT_AT = Date.now();
}

export function invalidateSemanticIndex(reason: string = "unknown"): void {
  LAST_SEMANTIC_INDEX_DIRTY = true;

  writeAuditEvent(AUDIT_DIR, AUDIT_FILE, {
    timestamp: new Date().toISOString(),
    event: "semantic_index.invalidated",
    reason,
  });
}

/**
 * CONC-2 (REV-93): newest mtime (ms since epoch) of any `.js`/`.ts` source under
 * `rootDir`, mirroring buildSemanticIndexFromWorkspace's walk (skips node_modules,
 * dist, and dotfiles). Best-effort: unreadable dirs/entries are skipped so a
 * transient fs error can never throw out of a read path.
 */
function newestSourceMtimeMs(rootDir: string): number {
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
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
      if (!/\.(js|ts)$/.test(entry)) {
        continue;
      }
      if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
      }
    }
  };
  walk(rootDir);
  return newest;
}

/**
 * CONC-2 (REV-93): lightweight, poll-on-read staleness check (no fs watcher).
 * The index is stale when a source file was modified after the index was built —
 * this catches out-of-band edits and bootstrap downloads that the tool-triggered
 * invalidation allowlist misses. Returns false when nothing is built yet (the
 * primary guard handles that) or when freshness cannot be determined.
 */
function isSemanticIndexStale(projectDir: string): boolean {
  if (!LAST_SEMANTIC_INDEX) {
    return false;
  }
  const newest = newestSourceMtimeMs(projectDir);
  if (newest === 0) {
    return false;
  }
  return newest > LAST_SEMANTIC_INDEX_BUILT_AT;
}

export function getSemanticIndex(projectDir: string = PROJECT_DIR): SemanticSymbol[] {
  if (!LAST_SEMANTIC_INDEX || LAST_SEMANTIC_INDEX_DIRTY || isSemanticIndexStale(projectDir)) {
    const nextIndex = buildSemanticIndexFromWorkspace(projectDir);
    setSemanticIndex(nextIndex);
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
    !isSemanticIndexStale(projectDir)
  ) {
    return LAST_SEMANTIC_INDEX;
  }

  if (SEMANTIC_INDEX_BUILD_IN_FLIGHT) {
    return SEMANTIC_INDEX_BUILD_IN_FLIGHT;
  }

  SEMANTIC_INDEX_BUILD_IN_FLIGHT = (async () => {
    try {
      const nextIndex = await buildSemanticIndexFromWorkspaceAsync(projectDir);
      setSemanticIndex(nextIndex);
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
