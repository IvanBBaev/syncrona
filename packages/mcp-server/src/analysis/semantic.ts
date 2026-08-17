// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import path from "path";

export type SemanticSymbol = {
  name: string;
  kind: "function" | "class" | "const";
  file: string;
  line: number;
};

export function extractSymbolsFromCode(code: string, file: string): SemanticSymbol[] {
  const symbols: SemanticSymbol[] = [];
  const lines = code.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fn = line.match(/\bfunction\s+([A-Za-z0-9_]+)/);
    if (fn) {
      symbols.push({ name: fn[1], kind: "function", file, line: i + 1 });
    }
    const cls = line.match(/\bclass\s+([A-Za-z0-9_]+)/);
    if (cls) {
      symbols.push({ name: cls[1], kind: "class", file, line: i + 1 });
    }
    const cnst = line.match(/\bconst\s+([A-Za-z0-9_]+)\s*=/);
    if (cnst) {
      symbols.push({ name: cnst[1], kind: "const", file, line: i + 1 });
    }
  }

  return symbols;
}

/**
 * REV-213: every fs call in this walk is best-effort, matching
 * buildSemanticIndexFromWorkspaceAsync below and sampleSourceTree in
 * semanticIndexState.ts — whose doc comment already claimed the three walkers
 * behaved alike, while this one was the odd one out. It used bare `readdirSync`,
 * `statSync` and `readFileSync`, so anything the filesystem could refuse threw
 * straight out of `getSemanticIndex`, i.e. out of a READ path: sync_semantic_search
 * and sync_symbol_xref failed rather than returning the symbols they could see.
 * The everyday trigger is a dangling symlink (a `.ts` link whose target was removed
 * or was never checked out) — `statSync` follows links, so it raises ENOENT on an
 * entry `readdirSync` had just listed. The same shape is a genuine race for the
 * other two calls: readdir names an entry, and a checkout or an editor deletes it
 * before the stat or the read lands. Whether the crash happened was decided by the
 * state of the working tree, never by anything a caller did wrong; skipping the
 * entry costs at most one file's symbols until the next rebuild.
 */
export function buildSemanticIndexFromWorkspace(rootDir: string): SemanticSymbol[] {
  const symbols: SemanticSymbol[] = [];

  const walk = (dir: string) => {
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
      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch (_) {
        continue;
      }
      symbols.push(...extractSymbolsFromCode(content, fullPath));
    }
  };

  walk(rootDir);
  return symbols;
}

/**
 * PERF-5 (REV-98): non-blocking twin of buildSemanticIndexFromWorkspace. The
 * synchronous walker reads and parses every `.js`/`.ts` file with `readFileSync`
 * in one tick, stalling the MCP event loop for the whole workspace scan while
 * other requests wait. This variant uses `fs/promises` so each I/O yields; the
 * traversal and symbol extraction are otherwise identical. Best-effort: an
 * unreadable directory or file is skipped rather than thrown, matching the
 * staleness walker in semanticIndexState.ts.
 */
export async function buildSemanticIndexFromWorkspaceAsync(
  rootDir: string
): Promise<SemanticSymbol[]> {
  const symbols: SemanticSymbol[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
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
        st = await stat(fullPath);
      } catch (_) {
        continue;
      }
      if (st.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!/\.(js|ts)$/.test(entry)) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(fullPath, "utf-8");
      } catch (_) {
        continue;
      }
      symbols.push(...extractSymbolsFromCode(content, fullPath));
    }
  };

  await walk(rootDir);
  return symbols;
}

export function searchSemanticIndex(
  symbols: SemanticSymbol[],
  query: string
): SemanticSymbol[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return symbols.slice(0, 200);
  }
  return symbols.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 200);
}

export function buildSymbolCrossReference(
  symbols: SemanticSymbol[]
): Array<Record<string, unknown>> {
  const grouped = new Map<string, { count: number; files: Set<string>; kinds: Set<string> }>();

  for (const sym of symbols) {
    const current = grouped.get(sym.name) || {
      count: 0,
      files: new Set<string>(),
      kinds: new Set<string>(),
    };
    current.count += 1;
    current.files.add(sym.file);
    current.kinds.add(sym.kind);
    grouped.set(sym.name, current);
  }

  const rows = [...grouped.entries()].map(([name, value]) => ({
    name,
    occurrences: value.count,
    fileCount: value.files.size,
    kinds: [...value.kinds].sort((a, b) => a.localeCompare(b)),
    files: [...value.files].sort((a, b) => a.localeCompare(b)),
  }));

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}
