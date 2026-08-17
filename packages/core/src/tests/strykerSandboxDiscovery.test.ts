// SPDX-License-Identifier: GPL-3.0-or-later
//
// `testPathIgnorePatterns` has to satisfy two opposite requirements at once, and a
// pattern that satisfies only the first still looks correct in review.
//
//   1. From the PACKAGE root, a leftover `.stryker-tmp/` sandbox must be skipped.
//      Stryker copies the whole package — tests included — into that sandbox and
//      leaves it behind when a run is interrupted, so without the skip the ordinary
//      suite runs every file twice, and the sandbox copies resolve REPO_ROOT
//      relative to themselves and fail the license-consistency suite from inside an
//      otherwise green tree.
//   2. From INSIDE a sandbox, the very same tests must be found. That is how the
//      mutation run works: Stryker makes the copy and starts Jest within it.
//
// The trap is that Jest matches these patterns against the ABSOLUTE path of each
// test file. A sandboxed test lives at
// `<pkg>/.stryker-tmp/sandbox-XXXXXX/src/tests/*.test.ts`, which contains
// `/.stryker-tmp/` just as a leftover does — so an UNANCHORED pattern satisfies (1)
// and silently destroys (2). That is not hypothetical: it shipped, and the symptom
// was the whole mutation run dying with "No tests were found" while the ordinary
// suite stayed green, because nothing outside `npm run test:mutation` exercises the
// sandbox path. Anchoring with `<rootDir>/` fixes it — Jest expands the token to
// whichever root it was started with, so the pattern points at
// `<pkg>/.stryker-tmp/` from the package and at `<sandbox>/.stryker-tmp/` (which
// does not exist) from inside the sandbox.
//
// A third check catches the neighbouring foot-gun: these are REGEXES, not globs, so
// the innocent-looking `".js"` entry is "any character, then js" and would match a
// checkout under a directory such as `nodejs/`. Asserting against the package's real
// test files keeps every pattern honest about what it actually excludes.
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

const config = require(CONFIG_PATH) as {
  testPathIgnorePatterns: string[];
  modulePathIgnorePatterns: string[];
};

// Jest's own resolution: expand `<rootDir>` against the root it was started with,
// then test the result as a regex against the absolute path of the candidate file.
const matches = (patterns: string[], candidate: string, rootDir: string): boolean =>
  patterns.some((pattern) => new RegExp(pattern.replace(/<rootDir>/g, rootDir)).test(candidate));

const isIgnored = (testPath: string, rootDir: string): boolean =>
  matches(config.testPathIgnorePatterns, testPath, rootDir);

// A representative sandbox, named the way Stryker names them.
const SANDBOX = path.join(PACKAGE_ROOT, ".stryker-tmp", "sandbox-Ab3xYz");
const SANDBOXED_TEST = path.join(SANDBOX, "src", "tests", "genericUtils.test.ts");

describe("testPathIgnorePatterns and the Stryker sandbox", () => {
  it("skips a leftover sandbox when Jest runs from the package root", () => {
    expect(isIgnored(SANDBOXED_TEST, PACKAGE_ROOT)).toBe(true);
  });

  it("still finds those same tests when Jest runs from inside the sandbox", () => {
    // This is the assertion the unanchored pattern failed, and the one that keeps
    // `npm run test:mutation` from silently measuring nothing.
    expect(isIgnored(SANDBOXED_TEST, SANDBOX)).toBe(false);
  });

  it("anchors every sandbox pattern to <rootDir> rather than to a bare path", () => {
    const sandboxPatterns = [
      ...config.testPathIgnorePatterns,
      ...config.modulePathIgnorePatterns,
    ].filter((pattern) => pattern.includes("stryker-tmp"));
    expect(sandboxPatterns.length).toBeGreaterThan(0);
    for (const pattern of sandboxPatterns) {
      expect(pattern.startsWith("<rootDir>/")).toBe(true);
    }
  });

  it("keeps a leftover sandbox out of the haste map without hiding the sandbox's own modules", () => {
    // Two `package.json` files declaring the same module name is a "Haste module
    // naming collision", and Jest picks a winner arbitrarily — so the outer suite
    // could import the stale copy. The same anchoring rule applies: from inside the
    // sandbox its own modules must stay resolvable.
    const stalePackageJson = path.join(SANDBOX, "package.json");
    expect(matches(config.modulePathIgnorePatterns, stalePackageJson, PACKAGE_ROOT)).toBe(true);
    expect(matches(config.modulePathIgnorePatterns, stalePackageJson, SANDBOX)).toBe(false);
  });

  it("excludes none of the package's real test files", () => {
    const testDir = path.join(PACKAGE_ROOT, "src", "tests");
    const testFiles = fs
      .readdirSync(testDir)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => path.join(testDir, name));

    expect(testFiles.length).toBeGreaterThan(50);
    const excluded = testFiles.filter((file) => isIgnored(file, PACKAGE_ROOT));
    expect(excluded).toEqual([]);
  });
});
