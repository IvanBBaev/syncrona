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
// Finally, for every publishable bin (see SMOKE_TARGETS) it packs the package
// FOR REAL, unpacks it, supplies each `@syncrona/*` runtime dependency from ITS
// OWN packed tarball (never the unpublished workspace symlink), and smoke-runs
// the published entrypoint — the CLI with `--version`, the MCP server as a
// require-load (its bin opens a stdio transport in main() and would hang if
// executed). Resolving siblings from their tarballs proves a published package
// can find its published dependencies, which a whole-node_modules symlink hides.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// REV-107: every publishable bin is smoke-tested, not just the core CLI. Each
// target names a workspace package and how to exercise its bin:
//   - "exec":    run `node <bin> <args>` and (if expectVersion) assert stdout
//                carries the package version.
//   - "require": `node -e "require('<bin>')"` — load-only. The MCP server's bin
//                calls main() which connects a StdioServerTransport and blocks
//                forever, so it must never be executed; a clean require proves the
//                published entrypoint resolves its packed siblings and initialises.
export const SMOKE_TARGETS = [
  {
    name: "syncrona",
    mode: "exec",
    args: ["--version"],
    expectVersion: true,
    description: "syncrona CLI runs from its packed tarball and prints --version",
  },
  {
    name: "@syncrona/mcp-server",
    mode: "require",
    args: [],
    expectVersion: false,
    description: "@syncrona/mcp-server bin require-loads from its packed tarball with packed siblings",
  },
];

/** The `@syncrona/*` runtime dependencies of a package (its workspace siblings). */
export function syncronaRuntimeDeps(pkg) {
  return Object.keys(pkg.dependencies || {}).filter((dep) => dep.startsWith("@syncrona/"));
}

/** `npm pack` one workspace into `destDir`; return the absolute tarball path. */
function packWorkspace(name, destDir) {
  const out = execFileSync(
    "npm",
    ["pack", "--workspace", name, "--pack-destination", destDir, "--json"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  return path.join(destDir, JSON.parse(out)[0].filename);
}

/** Extract a tarball's `package/` dir into a fresh staging dir; return its path. */
function extractPackage(tarball, tmp) {
  const stage = mkdtempSync(path.join(tmp, "stage-"));
  execFileSync("tar", ["-xzf", tarball, "-C", stage]);
  return path.join(stage, "package");
}

/**
 * Pack `target`, unpack it, give it a private node_modules that borrows every
 * THIRD-PARTY dependency from the workspace but supplies each `@syncrona/*`
 * sibling from ITS OWN packed tarball, then smoke-run the packed bin. Returns a
 * failure string, or null on success.
 */
function smokeTestTarget(target) {
  const dir = dirByName.get(target.name);
  if (!dir) return `${target.name}: no workspace directory found`;
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const tmp = mkdtempSync(path.join(tmpdir(), "syncrona-pack-"));
  try {
    const pkgRoot = extractPackage(packWorkspace(target.name, tmp), tmp);

    // Private node_modules: symlink every workspace-resolved dependency EXCEPT
    // the `@syncrona` scope — those unpublished workspace links are exactly what
    // a published install would not have, so the packed siblings must stand in.
    // npm nests a dependency under the workspace package instead of hoisting it
    // when the root already holds a conflicting version (core's inquirer 14 and
    // chalk 5 sit next to a chalk 4 hoisted for the tooling), so the package's
    // own node_modules is linked first and wins, exactly as Node resolves it in
    // the workspace. Scope directories are merged member-by-member so a scope
    // split across both levels stays complete.
    const nodeModules = path.join(pkgRoot, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    for (const source of [path.join(dir, "node_modules"), path.join(repoRoot, "node_modules")]) {
      if (!existsSync(source)) continue;
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.name === "@syncrona") continue;
        if (entry.name.startsWith("@") && entry.isDirectory()) {
          const mergedScope = path.join(nodeModules, entry.name);
          mkdirSync(mergedScope, { recursive: true });
          for (const member of readdirSync(path.join(source, entry.name), { withFileTypes: true })) {
            const dest = path.join(mergedScope, member.name);
            if (existsSync(dest)) continue;
            symlinkSync(
              path.join(source, entry.name, member.name),
              dest,
              member.isDirectory() ? "dir" : "file",
            );
          }
          continue;
        }
        const dest = path.join(nodeModules, entry.name);
        if (existsSync(dest)) continue;
        symlinkSync(
          path.join(source, entry.name),
          dest,
          entry.isDirectory() ? "dir" : "file",
        );
      }
    }

    // Supply each runtime @syncrona/* sibling from its own freshly-packed tarball.
    const scopeDir = path.join(nodeModules, "@syncrona");
    mkdirSync(scopeDir, { recursive: true });
    for (const sib of syncronaRuntimeDeps(pkg)) {
      const sibRoot = extractPackage(packWorkspace(sib, tmp), tmp);
      renameSync(sibRoot, path.join(scopeDir, sib.slice("@syncrona/".length)));
    }

    const binRel = norm(typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0]);
    const binAbs = path.join(pkgRoot, binRel);
    const runOpts = { cwd: pkgRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };

    if (target.mode === "require") {
      // Load-only: executing the bin would block on the stdio transport.
      execFileSync("node", ["-e", `require(${JSON.stringify(binAbs)});process.exit(0);`], runOpts);
      return null;
    }

    const stdout = execFileSync("node", [binAbs, ...target.args], runOpts);
    if (target.expectVersion && !stdout.includes(pkg.version)) {
      return `${target.name}: bin did not print version ${pkg.version} (got: ${stdout.trim()})`;
    }
    return null;
  } catch (err) {
    return `${target.name}: smoke failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
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

  console.log("\nBin smoke (pack each bin + its packed @syncrona siblings, then run)...");
  for (const target of SMOKE_TARGETS) {
    const smoke = smokeTestTarget(target);
    if (smoke) {
      failed = true;
      console.log(`  ✗  ${smoke}`);
    } else {
      console.log(`  ✓  ${target.description}`);
    }
  }

  if (failed) {
    console.error("\nTarball-content gate FAILED.");
    process.exit(1);
  }
  console.log("\nTarball-content gate passed.");
}

// Only run when invoked as a script; importing (e.g. from the regression test)
// must not trigger `npm pack`, which runs each package's prepack build.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) main();

export { norm, forbiddenReason, checkPackage, smokeTestTarget, main };
