// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";

// QA guard for the GPL relicense (BA8): the MIT->GPL-3.0 relicense silently
// drifted (Homebrew formula, docs site, package-lock all kept MIT) because
// nothing checked license consistency. This locks the legally-binding artifacts
// so a future revert to MIT — which would re-introduce the GPL violation — fails
// the gate. (Mirrors the project's docs-drift checkers.)

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const EXPECTED_LICENSE = "GPL-3.0-or-later";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

describe("license consistency (GPL relicense, BA8)", () => {
  it("the root LICENSE is the GPL-3.0 text", () => {
    const license = readFileSync(path.join(REPO_ROOT, "LICENSE"), "utf-8");
    expect(license).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3");
    expect(license).not.toContain("Permission is hereby granted, free of charge"); // MIT preamble
  });

  it("a NOTICE exists and attributes the Sincronia/Nuvolo origin", () => {
    const noticePath = path.join(REPO_ROOT, "NOTICE");
    expect(existsSync(noticePath)).toBe(true);
    const notice = readFileSync(noticePath, "utf-8");
    expect(notice).toMatch(/Sincronia/);
    expect(notice).toMatch(/GPL-3\.0|General Public License/);
  });

  it("the root package.json declares GPL-3.0-or-later", () => {
    const root = readJson(path.join(REPO_ROOT, "package.json"));
    expect(root.license).toBe(EXPECTED_LICENSE);
  });

  it("every workspace package declares GPL-3.0-or-later (no MIT drift)", () => {
    const packagesDir = path.join(REPO_ROOT, "packages");
    const offenders: string[] = [];
    for (const name of readdirSync(packagesDir)) {
      const pkgPath = path.join(packagesDir, name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      if (pkg.license !== EXPECTED_LICENSE) {
        offenders.push(`${name}: ${String(pkg.license)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // #26: the package.json `license` field alone is not enough — a package can
  // ship an SPDX pointer to GPL while its LICENSE file still contains stale MIT
  // text (a GPL violation in the published tarball). Assert the FILE content.
  // The LICENSE files are added by a separate work stream; where a LICENSE is
  // not present yet, skip that package (tolerant of the in-flight race) but
  // still fail hard on any package whose LICENSE contains MIT text.
  it("every package LICENSE file, when present, is GPL text (never MIT)", () => {
    const packagesDir = path.join(REPO_ROOT, "packages");
    const mitOffenders: string[] = [];
    const nonGplOffenders: string[] = [];
    for (const name of readdirSync(packagesDir)) {
      const pkgPath = path.join(packagesDir, name, "package.json");
      if (!existsSync(pkgPath)) continue; // not a package dir
      const licensePath = path.join(packagesDir, name, "LICENSE");
      if (!existsSync(licensePath)) {
        // LICENSE not copied in yet — tolerate the race, don't fail spuriously.
        continue;
      }
      const text = readFileSync(licensePath, "utf-8");
      // The MIT preamble is the unambiguous marker of stale MIT text.
      if (text.includes("Permission is hereby granted, free of charge")) {
        mitOffenders.push(name);
      }
      if (!text.includes("GNU GENERAL PUBLIC LICENSE") || !text.includes("Version 3")) {
        nonGplOffenders.push(name);
      }
    }
    expect({ mitOffenders, nonGplOffenders }).toEqual({
      mitOffenders: [],
      nonGplOffenders: [],
    });
  });
});
