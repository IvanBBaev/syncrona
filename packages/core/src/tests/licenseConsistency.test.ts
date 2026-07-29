// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // The gate above inspected only legally-binding artifacts, so
  // packages/types/README.md could claim "MIT — see LICENSE" while its LICENSE
  // was verbatim GPL-3.0 and its package.json said GPL-3.0-or-later, and CI
  // still went green. npm renders the README on the package page, so that line
  // was the license a consumer actually read — exactly the misrepresentation
  // docs/PROVENANCE.md records as the original violation. Assert the READMEs
  // too, so a revert to an MIT claim fails the gate.
  it("no README claims MIT, and every README License section names GPL-3.0", () => {
    const packagesDir = path.join(REPO_ROOT, "packages");
    const readmes = [path.join(REPO_ROOT, "README.md")];
    for (const name of readdirSync(packagesDir)) {
      if (!existsSync(path.join(packagesDir, name, "package.json"))) continue;
      const readmePath = path.join(packagesDir, name, "README.md");
      if (existsSync(readmePath)) readmes.push(readmePath);
    }

    // "MIT" stated as the license, in the usual phrasings ("MIT License",
    // "License: MIT", "licensed under MIT", "MIT — see LICENSE").
    const MIT_CLAIMS = [
      /\bMIT\b[^\n]*\blicen[cs]e/i,
      /\blicen[cs]e[ds]?\b[^\n]*\bMIT\b/i,
      /^\s*(?:[-*]\s*)?MIT\b\s*[—–-]/,
    ];
    const isLicenseHeading = (line: string): boolean => /^#{2,}\s.*licen[cs]e/i.test(line);
    const GPL_MENTION = /GPL-3\.0|General Public License/i;
    // HTML comments are not rendered by npm or GitHub, so they cannot mislead a
    // reader; drop them (e.g. maintainer notes about this very regression).
    const stripHtmlComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");

    const mitClaims: string[] = [];
    const sectionsMissingGpl: string[] = [];
    for (const readmePath of readmes) {
      const rel = path.relative(REPO_ROOT, readmePath);
      const lines = stripHtmlComments(readFileSync(readmePath, "utf-8")).split("\n");
      let licenseSection: string[] | undefined;
      for (const line of lines) {
        if (MIT_CLAIMS.some((pattern) => pattern.test(line))) {
          mitClaims.push(`${rel}: ${line.trim()}`);
        }
        if (/^#{2,}\s/.test(line)) {
          // A "License" heading must state the GPL, not leave it implicit.
          if (licenseSection && !licenseSection.some((body) => GPL_MENTION.test(body))) {
            sectionsMissingGpl.push(rel);
          }
          licenseSection = isLicenseHeading(line) ? [] : undefined;
          continue;
        }
        licenseSection?.push(line);
      }
      if (licenseSection && !licenseSection.some((body) => GPL_MENTION.test(body))) {
        sectionsMissingGpl.push(rel);
      }
    }

    expect({ mitClaims, sectionsMissingGpl }).toEqual({
      mitClaims: [],
      sectionsMissingGpl: [],
    });
  });
});
