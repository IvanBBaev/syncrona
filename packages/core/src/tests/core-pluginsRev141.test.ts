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
    for (const group of perFileGroups()) {
      expect(filesMatching(group)).toContain(TOP_LEVEL);
    }
  });

  it("keeps src/index.ts exempt from the lines floor but subject to the branches floor", () => {
    const branchesGroups = perFileGroups().filter(
      (group) => jestConfig.coverageThreshold[group].branches !== undefined
    );
    const linesGroups = perFileGroups().filter(
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
  });
});
