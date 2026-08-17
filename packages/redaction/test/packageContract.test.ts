// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(__dirname, "..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageManifest;

describe("package contract", () => {
  it("is a leaf: no internal @syncrona dependency of any kind", () => {
    // The acceptance criterion for the extraction, asserted rather than assumed.
    // A security primitive at the bottom of the graph can be audited on its own and
    // can never be made to import something that imports it back — but only for as
    // long as nobody adds a "small" convenience dependency on @syncrona/types.
    // dependency-cruiser enforces the same rule at the module level; this catches the
    // manifest-level version, which is where such a dependency actually gets added.
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
    expect(declared.filter((name) => name.startsWith("@syncrona/"))).toEqual([]);
  });

  it("declares no runtime dependencies at all", () => {
    // Stronger than the rule above and true today: the only import in src/ is
    // `node:crypto`. Stated as a test so that adding the first third-party
    // dependency to a module that redacts credentials is a deliberate act.
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("carries the SPDX header on every source file", () => {
    // The repo publishes under GPL-3.0-or-later and the licence gate reads the
    // header, not the manifest.
    for (const file of readdirSync(SRC_DIR).filter((name) => name.endsWith(".ts"))) {
      const contents = readFileSync(join(SRC_DIR, file), "utf8");
      expect(contents.startsWith("// SPDX-License-Identifier: GPL-3.0-or-later\n")).toBe(true);
    }
  });

  it("imports nothing but node:crypto in src/", () => {
    // Backs the "pure, synchronous, no I/O, no clock, no configuration" claim in the
    // README with something that fails when it stops being true. The redactor runs
    // once per field of every record on an instance while the MCP server holds the
    // audit lock, so its cost must be bounded and its result a function of the input.
    //
    // Anchored at the start of a line (`m` flag) rather than matching `from "…"`
    // anywhere: the comments in src/ quote example values, and an unanchored scan
    // read the prose `from "Bearer credentials rejected"` as a module specifier.
    const external = new Set<string>();
    for (const file of readdirSync(SRC_DIR).filter((name) => name.endsWith(".ts"))) {
      const contents = readFileSync(join(SRC_DIR, file), "utf8");
      // `\}` covers the continuation line of a multi-line `export { … } from "…";`.
      for (const match of contents.matchAll(/^(?:import\b|export\b|\})[^\n]*\bfrom\s+"([^"]+)";/gm)) {
        if (!match[1].startsWith(".")) {
          external.add(match[1]);
        }
      }
    }
    expect([...external]).toEqual(["node:crypto"]);
  });
});
