// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// REV-141 regression suite for the core coverage ratchet.
//
// jest.config.cjs relies on an unwritten invariant: every collected source file
// must match at least one PER-FILE threshold group, so the "global" bucket stays
// empty and Jest falls back to measuring the global thresholds across ALL covered
// files (@jest/reporters: `combineCoverage(globalFiles.length > 0 ? globalFiles :
// coveredFiles)`). The groups used to be single-level ('./src/*.ts'), while
// collectCoverageFrom is recursive ('src/**/*.ts'), so the first source file added
// under a subdirectory would match no group, land alone in the "global" bucket,
// and silently collapse the repo-wide 92/79/89/92 ratchet onto that one file.
// Nothing enforced the invariant — this suite does.
//
// It replicates Jest's own bucketing exactly: Jest resolves each threshold group
// against the cwd and runs `glob.sync` on the real filesystem, so the assertions
// below run the *real* config globs over a temp tree that contains the shape the
// invariant is about (a nested source file).
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const jestConfig = require(
  path.join(__dirname, "..", "..", "jest.config.cjs")
) as {
  collectCoverageFrom: string[];
  coverageThreshold: Record<string, Record<string, number>>;
};

// Use the very same glob implementation @jest/reporters uses, so the test cannot
// pass on semantics a different glob version happens to have.
const { glob } = createRequire(require.resolve("@jest/reporters"))("glob") as {
  glob: { sync: (pattern: string, opts: object) => string[] };
};

const TREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-rev141-"));
const TOP_LEVEL = "src/commands.ts";
const ENTRY_BARREL = "src/index.ts";
const NESTED = "src/util/paths.ts";

beforeAll(() => {
  for (const rel of [TOP_LEVEL, ENTRY_BARREL, NESTED]) {
    const abs = path.join(TREE_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
  }
});

afterAll(() => {
  fs.rmSync(TREE_ROOT, { recursive: true, force: true });
});

const perFileGroups = () =>
  Object.keys(jestConfig.coverageThreshold).filter((key) => key !== "global");

// GATE-2 added a second kind of per-file group: single-file PATH floors
// ('./src/FileUtils.ts') pinning one safety-relevant module just under its
// measured coverage, alongside the tree-wide GLOBs that hold up the REV-141
// invariant. Jest checks the two differently (a GLOB group is scored per matching
// file, a PATH group by prefix match), so the invariants below differ too — only
// the tree-wide globs have to match every source file.
const isTreeWide = (group: string) => /[*?[\]]/.test(group);
const treeWideGroups = () => perFileGroups().filter(isTreeWide);
const singleFileFloors = () => perFileGroups().filter((group) => !isTreeWide(group));

const PACKAGE_ROOT = path.join(__dirname, "..", "..");

// The real collected source set: `collectCoverageFrom: ['src/**/*.ts',
// '!src/tests/**']`.
const collectedSources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(PACKAGE_ROOT, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (rel !== "src/tests") {
          walk(abs);
        }
      } else if (entry.name.endsWith(".ts")) {
        out.push(rel);
      }
    }
  };
  walk(path.join(PACKAGE_ROOT, "src"));
  return out;
};

// Mirrors @jest/reporters: path.resolve() the group, then glob.sync it.
const filesMatching = (group: string): string[] =>
  glob
    .sync(path.resolve(TREE_ROOT, group), { windowsPathsNoEscape: true })
    .map((p) => path.relative(TREE_ROOT, path.resolve(p)).split(path.sep).join("/"));

describe("core coverage-threshold groups (REV-141)", () => {
  it("declares per-file groups alongside the global ratchet", () => {
    expect(jestConfig.coverageThreshold.global).toBeDefined();
    expect(perFileGroups().length).toBeGreaterThan(0);
  });

  it("collects coverage recursively, which is what the groups must keep up with", () => {
    expect(jestConfig.collectCoverageFrom).toContain("src/**/*.ts");
  });

  it("matches a source file in a src/ subdirectory, so it never lands alone in the global bucket", () => {
    // The core assertion: with single-level groups NESTED matches nothing, Jest
    // buckets it as "global", and the 92/79/89/92 thresholds are then computed
    // over that one file instead of the whole tree.
    const matchedBy = perFileGroups().filter((group) =>
      filesMatching(group).includes(NESTED)
    );

    expect(matchedBy.length).toBeGreaterThan(0);
  });

  it("still matches top-level source files so their per-file floors stay live", () => {
    for (const group of treeWideGroups()) {
      expect(filesMatching(group)).toContain(TOP_LEVEL);
    }
  });

  it("keeps src/index.ts exempt from the lines floor but subject to the branches floor", () => {
    const branchesGroups = treeWideGroups().filter(
      (group) => jestConfig.coverageThreshold[group].branches !== undefined
    );
    const linesGroups = treeWideGroups().filter(
      (group) => jestConfig.coverageThreshold[group].lines !== undefined
    );

    expect(branchesGroups.length).toBeGreaterThan(0);
    expect(linesGroups.length).toBeGreaterThan(0);
    for (const group of branchesGroups) {
      expect(filesMatching(group)).toContain(ENTRY_BARREL);
    }
    for (const group of linesGroups) {
      expect(filesMatching(group)).not.toContain(ENTRY_BARREL);
    }
    // The entry barrel measures 0% lines by design (it only runs in the subprocess
    // smoke tests), so no single-file floor may pin its lines either.
    for (const group of singleFileFloors()) {
      if (jestConfig.coverageThreshold[group].lines !== undefined) {
        expect(group.endsWith("/index.ts")).toBe(false);
      }
    }
  });

  // --- GATE-2: the single-file floors -----------------------------------------

  it("names a source file that really exists for every single-file floor", () => {
    // Jest reports a key that matches nothing as "Coverage data for <key> was not
    // found", so a floor left behind by a rename fails the build — but only on a
    // full coverage run. Asserting it here means the rename is reported by the
    // ordinary suite, next to the code that caused it.
    const sources = collectedSources();
    expect(singleFileFloors().length).toBeGreaterThan(0);
    for (const group of singleFileFloors()) {
      const rel = path.relative(PACKAGE_ROOT, path.resolve(PACKAGE_ROOT, group))
        .split(path.sep)
        .join("/");
      expect(sources).toContain(rel);
    }
  });

  it("scores exactly one file per single-file floor", () => {
    // A PATH group is a PREFIX match, not an equality test: a key that named a
    // directory — or a file whose name is a prefix of another ('./src/config' next
    // to 'src/configSchema.ts') — would silently average several modules together
    // and stop being a per-file floor at all.
    const sources = collectedSources();
    for (const group of singleFileFloors()) {
      const prefix = path.relative(PACKAGE_ROOT, path.resolve(PACKAGE_ROOT, group))
        .split(path.sep)
        .join("/");
      expect(sources.filter((rel) => rel.startsWith(prefix))).toEqual([prefix]);
    }
  });

  it("keeps every single-file floor at or above the tree-wide floor it refines", () => {
    // Both groups are checked independently, so a single-file value BELOW the
    // tree-wide glob does not relax anything — the glob still fails the file. Such
    // an entry is a no-op that reads like a deliberate (lower) decision, which is
    // how a floor table rots into decoration.
    for (const metric of ["lines", "branches", "statements", "functions"] as const) {
      const treeWide = treeWideGroups()
        .map((group) => jestConfig.coverageThreshold[group][metric])
        .filter((value): value is number => value !== undefined);
      if (treeWide.length === 0) {
        continue;
      }
      const strictestTreeWide = Math.max(...treeWide);
      for (const group of singleFileFloors()) {
        const value = jestConfig.coverageThreshold[group][metric];
        if (value !== undefined) {
          expect(value).toBeGreaterThanOrEqual(strictestTreeWide);
        }
      }
    }
  });

  it("keeps the tree-wide floors meaningful rather than nominal", () => {
    // They used to be 20/20, which only ever caught a file with no test at all: a
    // module could fall from 98% to 21% and still ship green. They are the only
    // floor for every file without a single-file entry, so they must stay in the
    // range of real coverage.
    for (const group of treeWideGroups()) {
      for (const value of Object.values(jestConfig.coverageThreshold[group])) {
        expect(value).toBeGreaterThanOrEqual(60);
        // Still below the global ratchet: the tree-wide floor is sized for the
        // weakest legitimate file, not for the package average.
        expect(value).toBeLessThan(jestConfig.coverageThreshold.global.lines);
      }
    }
  });
});
