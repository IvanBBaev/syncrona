#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// #60 — tarball-content gate.
//
// `release.yml` publishes every non-private workspace tarball. Nothing exercised
// what those tarballs actually contain, so a broken `files` glob, a missing
// build, or a stray `src/`/`.env` leak would ship sight-unseen. This gate runs
// `npm pack --dry-run --json --workspaces` (which itself runs each package's
// `prepack`, so the reported contents are freshly built) and asserts, per
// publishable package:
//   - a LICENSE file is bundled,
//   - the `main` entry point is inside the tarball,
//   - every `bin` target is inside the tarball,
//   - packages that declare `files: ["dist"]` actually ship compiled output,
//   - no forbidden files leak in (src/, test dirs, *.test.*, .env*, tsconfig,
//     jest.config).
// Finally it packs `core` for real, unpacks the tarball against the already
// resolved dependency tree, and smoke-runs the published CLI (`--version`).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, "packages");

/** Normalise a tarball/relative path: forward slashes, no leading "./". */
function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "");
}

// name -> absolute package directory, read straight from the workspace tree.
const dirByName = new Map();
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join(packagesDir, entry.name, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }
  if (pkg.name) dirByName.set(pkg.name, path.join(packagesDir, entry.name));
}

/** A tarball file is forbidden if it is source, tests, secrets or tooling. */
function forbiddenReason(relPath) {
  const p = norm(relPath);
  const segments = p.split("/");
  const base = segments[segments.length - 1];

  if (p === "src" || p.startsWith("src/")) return "source tree (src/)";
  if (segments.some((s) => s === "test" || s === "tests" || s === "__tests__")) {
    return "test directory";
  }
  if (/\.test\.[cm]?[jt]sx?$/.test(base)) return "test file (*.test.*)";
  if (base === ".env" || base.startsWith(".env.")) return "environment file (.env*)";
  if (/^tsconfig(\..+)?\.json$/.test(base)) return "tsconfig";
  if (/^jest\.config\./.test(base)) return "jest config";
  if (base === ".npmrc") return ".npmrc";
  return null;
}

function packDryRun() {
  // stdout is the JSON report; the prepack (tsc) banners go to stderr, which we
  // let through so a build failure is visible.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspaces"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    return JSON.parse(out);
  } catch {
    // Be resilient to any leading/trailing noise on stdout.
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (start >= 0 && end > start) return JSON.parse(out.slice(start, end + 1));
    throw new Error("could not parse `npm pack --json` output");
  }
}

function checkPackage(entry) {
  const failures = [];
  const dir = dirByName.get(entry.name);
  if (!dir) {
    return { name: entry.name, skipped: false, failures: ["no workspace directory found"] };
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  if (pkg.private) return { name: entry.name, skipped: true, failures: [] };

  const files = new Set((entry.files || []).map((f) => norm(f.path)));

  // LICENSE bundled.
  if (!files.has("LICENSE") && !files.has("LICENCE")) {
    failures.push("missing LICENSE");
  }

  // main entry point present.
  if (pkg.main) {
    const main = norm(pkg.main);
    if (!files.has(main)) failures.push(`main "${main}" not in tarball`);
  }

  // every bin target present.
  if (pkg.bin) {
    const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin);
    for (const b of bins) {
      const bin = norm(b);
      if (!files.has(bin)) failures.push(`bin "${bin}" not in tarball`);
    }
  }

  // packages that ship dist must actually have compiled output.
  const declaresDist = Array.isArray(pkg.files) && pkg.files.some((f) => norm(f) === "dist");
  if (declaresDist && ![...files].some((f) => f.startsWith("dist/"))) {
    failures.push('declares files:["dist"] but tarball has no dist/ output');
  }

  // no forbidden files.
  for (const f of files) {
    const reason = forbiddenReason(f);
    if (reason) failures.push(`forbidden file "${f}" (${reason})`);
  }

  return { name: entry.name, skipped: false, failures };
}

function smokeTestCore() {
  const coreDir = dirByName.get("syncrona");
  const pkg = JSON.parse(readFileSync(path.join(coreDir, "package.json"), "utf8"));
  const tmp = mkdtempSync(path.join(tmpdir(), "syncrona-pack-"));
  try {
    const out = execFileSync(
      "npm",
      ["pack", "--workspace", "syncrona", "--pack-destination", tmp, "--json"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }
    );
    const meta = JSON.parse(out);
    const filename = meta[0].filename;

    execFileSync("tar", ["-xzf", path.join(tmp, filename), "-C", tmp]);
    const pkgRoot = path.join(tmp, "package");

    // Borrow the workspace's already-resolved dependency tree so the packed CLI
    // can require its (unpublished) sibling packages without a registry.
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(pkgRoot, "node_modules"), "dir");

    const binRel = norm(typeof pkg.bin === "string" ? pkg.bin : pkg.bin["syncrona"]);
    const stdout = execFileSync("node", [path.join(pkgRoot, binRel), "--version"], {
      cwd: pkgRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (!stdout.includes(pkg.version)) {
      return `CLI --version did not print version ${pkg.version} (got: ${stdout.trim()})`;
    }
    return null;
  } catch (err) {
    return `CLI smoke failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("Verifying tarball contents (npm pack --dry-run --workspaces)...\n");
const report = packDryRun();
const results = report.map(checkPackage);

let failed = false;
for (const r of results) {
  if (r.skipped) {
    console.log(`  -  ${r.name} (private, skipped)`);
  } else if (r.failures.length === 0) {
    console.log(`  ✓  ${r.name}`);
  } else {
    failed = true;
    console.log(`  ✗  ${r.name}`);
    for (const f of r.failures) console.log(`       - ${f}`);
  }
}

console.log("\nCLI smoke (pack core, unpack, run --version)...");
const smoke = smokeTestCore();
if (smoke) {
  failed = true;
  console.log(`  ✗  ${smoke}`);
} else {
  console.log("  ✓  syncrona CLI runs from packed tarball");
}

if (failed) {
  console.error("\nTarball-content gate FAILED.");
  process.exit(1);
}
console.log("\nTarball-content gate passed.");
