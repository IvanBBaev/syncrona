// SPDX-License-Identifier: GPL-3.0-or-later
//
// GATE-3: the per-file coverage floors in jest.config.cjs are a gate, and a gate
// nobody tests is a gate that can quietly stop gating. mcp-server's floors live in
// a script and self-test through `findStaleFloors`; core's are jest-native, so this
// suite audits the config itself.
//
// Every check below corresponds to a way a floor stops biting WITHOUT anything
// turning red:
//   - a floor pinned above what the file measures cannot be satisfied, and the
//     annotation next to it is the only record of what was actually measured — so
//     the two must agree;
//   - a floor far BELOW what the file measures is the GATE-2 defect all over again
//     (the old 20/20 pair let a module fall from 98% to 21% and ship green);
//   - the tree-wide globs must stay recursive, or the first file added under a
//     subdirectory lands alone in Jest's `global` bucket and silently converts the
//     repo-wide ratchet into a single-file check (REV-141);
//   - the global thresholds are a ratchet: they may rise, never fall.
//
// This is a static audit, deliberately: it must run in milliseconds inside the
// ordinary suite. That Jest ENFORCES these keys at all is proven by the gate
// itself — `npm run test:coverage:gates` fails on a floor no file satisfies, and a
// key matching nothing fails loudly as "Jest: Coverage data for <key> was not
// found." rather than passing vacuously.
import { createRequire } from "module";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

// The suite is native ESM (see jest.config.cjs), so there is no __dirname and no
// require; both are derived from the module URL.
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = path.resolve(HERE, "../../jest.config.cjs");
const PACKAGE_ROOT = path.dirname(CONFIG_PATH);

type Floor = { statements?: number; branches?: number; functions?: number; lines?: number };

const config = require(CONFIG_PATH) as {
  collectCoverageFrom: string[];
  coverageThreshold: Record<string, Floor>;
};
const configSource = fs.readFileSync(CONFIG_PATH, "utf8");

// The recorded ratchet. Raising these is the point; lowering one to turn a red
// build green is the failure this pins.
const GLOBAL_RATCHET: Required<Floor> = {
  statements: 92,
  branches: 79,
  functions: 89,
  lines: 92,
};

// A floor this far under the measured value is not a floor. The widest gap in the
// config today is 6 points (a branch floor), and branch coverage is the metric
// that moves between macOS and Linux CI, so 8 leaves room for the noise the
// annotations describe without tolerating a dead floor.
const MAX_HEADROOM_POINTS = 8;

const TREE_WIDE_KEYS = ["./src/**/*.ts", "./src/**/!(index).ts"];

/** The `// measured L / B` annotation Jest never sees, keyed by threshold key. */
function parseMeasuredAnnotations(): Map<string, { lines?: number; branches?: number }> {
  const measured = new Map<string, { lines?: number; branches?: number }>();
  for (const line of configSource.split("\n")) {
    const keyMatch = line.match(/^\s*'([^']+)':\s*\{/);
    if (!keyMatch) {
      continue;
    }
    // Two shapes are in use: "measured 98.21 / 91.80" and, for a file that
    // declares no branches, "measured 100.00 lines (0 branches)".
    //
    // The mcp-server side has a third — `measured L / B (also L / B: cause)`,
    // declaring the second value V8 range coverage reports for an unchanged tree.
    // It is deliberately absent here: istanbul is reproducible (three full runs of
    // this suite produced a byte-identical coverage-summary.json), so
    // scripts/check-coverage-annotations.mjs REJECTS that form on this file. If one
    // ever appears, the regex below would silently read only its first pair, and
    // the annotations gate is what stops it from getting that far.
    const pair = line.match(/\/\/\s*measured\s+([\d.]+)\s*\/\s*([\d.]+)/);
    if (pair) {
      measured.set(keyMatch[1], { lines: Number(pair[1]), branches: Number(pair[2]) });
      continue;
    }
    const linesOnly = line.match(/\/\/\s*measured\s+([\d.]+)\s*lines/);
    if (linesOnly) {
      measured.set(keyMatch[1], { lines: Number(linesOnly[1]) });
    }
  }
  return measured;
}

const perFileKeys = Object.keys(config.coverageThreshold).filter(
  (key) => key !== "global" && !TREE_WIDE_KEYS.includes(key)
);

describe("GATE-3 core per-file coverage floors", () => {
  it("keeps the recorded set of pinned modules", () => {
    // A floor deleted outright is the cheapest way to make a red build green, and
    // deleting one leaves nothing behind to notice. Both the count and the
    // highest-risk members are asserted, so a removal has to be deliberate.
    expect(perFileKeys.length).toBeGreaterThanOrEqual(20);
    for (const critical of [
      "./src/FileUtils.ts", // writes local files, owns the containment guard
      "./src/pushCommand.ts", // mutates the instance
      "./src/pushPipeline.ts",
      "./src/downloadPipeline.ts",
      "./src/repairCommand.ts", // deletes local files under --prune
      "./src/manifestBuilder.ts", // widest trust boundary: remote data -> paths
      "./src/snClient.ts", // transport + auth headers
      "./src/authCommands.ts", // credentials
    ]) {
      expect(perFileKeys).toContain(critical);
    }
  });

  it("pins exactly one existing, coverage-collected file per key", () => {
    for (const key of perFileKeys) {
      // A glob here would make one key score a whole group, so a single strong
      // file could carry a weak one past the floor.
      expect(key).not.toMatch(/[*?[\]]/);
      const relative = key.replace(/^\.\//, "");
      expect(fs.existsSync(path.join(PACKAGE_ROOT, relative))).toBe(true);
      // collectCoverageFrom decides which files are in the report at all; a key
      // outside it can never be satisfied.
      expect(relative.startsWith("src/")).toBe(true);
      expect(relative.endsWith(".ts")).toBe(true);
      expect(relative.startsWith("src/tests/")).toBe(false);
    }
  });

  it("agrees with the measured value recorded next to each floor", () => {
    const measured = parseMeasuredAnnotations();
    for (const key of perFileKeys) {
      const annotation = measured.get(key);
      // The annotation is the only record of what the floor was derived from.
      expect(annotation).toBeDefined();
      const floor = config.coverageThreshold[key];
      for (const metric of ["lines", "branches"] as const) {
        const pinned = floor[metric];
        const recorded = annotation?.[metric];
        if (pinned === undefined) {
          continue;
        }
        // A floor above the measured value cannot pass; a floor far below it is
        // not a floor.
        expect(recorded).toBeDefined();
        expect(pinned).toBeLessThanOrEqual(recorded as number);
        expect((recorded as number) - pinned).toBeLessThanOrEqual(MAX_HEADROOM_POINTS);
      }
    }
  });

  it("keeps the tree-wide globs recursive so the global bucket stays empty", () => {
    // REV-141: single-level globs ('./src/*.ts') leave the first file added under
    // a subdirectory matching no group, so Jest evaluates the GLOBAL thresholds
    // against that one file instead of the whole tree.
    for (const key of TREE_WIDE_KEYS) {
      expect(Object.keys(config.coverageThreshold)).toContain(key);
      expect(key).toContain("**");
    }
    // ...and collectCoverageFrom must stay recursive too, or the globs above
    // describe a tree Jest never reports on.
    expect(config.collectCoverageFrom).toContain("src/**/*.ts");
  });

  it("holds the global ratchet at or above its recorded floor", () => {
    const global = config.coverageThreshold.global;
    for (const metric of ["statements", "branches", "functions", "lines"] as const) {
      expect(global[metric]).toBeGreaterThanOrEqual(GLOBAL_RATCHET[metric]);
    }
  });
});
