#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Developer-side parity for the CI `secret-scan` job.
//
// WHY THIS EXISTS: `npm run check` reproduces every CI gate except one. The
// secret scan lived only in CI, so the first time a fixture value tripped
// gitleaks the failure surfaced *after* the push, on a red default branch, with
// no way to have caught it locally. `npm run check` was exit 0 on exactly the
// tree that CI rejected. This closes that asymmetry.
//
// WHAT IT IS NOT: this is not the enforcing gate. The CI `secret-scan` job runs
// gitleaks from a pinned action and uploads a SARIF report; that job is the
// authority and remains unchanged. This script is the local pre-push check that
// tells you the same thing seconds earlier.
//
// SCAN MODE: `gitleaks dir` over the working tree, not `gitleaks git`. CI scans
// committed history; locally the useful question is "is there a secret in what I
// am about to commit", which includes unstaged and untracked files that no
// history scan can see yet.
//
// SCOPE IS BROADER THAN CI, MEASURED NOT ASSUMED. `gitleaks dir` does NOT honour
// .gitignore -- a probe value planted in the gitignored `logs/` was reported,
// while the same probe planted in `node_modules/` was not (gitleaks excludes
// dependencies itself; 277 MB of node_modules never enters the 36.87 MB the walk
// reports, and the full walk costs ~6-7s). So `dist/`, `coverage/` and leftover
// `.stryker-tmp/` sandboxes ARE walked even though git ignores them. That is not
// a false-positive source -- every one of them is a derived copy of a source
// file the same run also scans -- but it does mean a finding can be reported at
// a generated path. Fix the original, never the copy.
//
// MISSING BINARY: exits 0 with an explicit notice rather than failing. gitleaks
// is not an npm dependency and cannot be assumed present; making `npm run check`
// fail on a missing optional tool would punish contributors for the tool's
// absence while CI already covers the risk. The notice names what was skipped
// and how to install it, so a skip is never silent.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const CONFIG = ".gitleaks.toml";

/** The config the CI job uses; scanning without it would report fixture placeholders. */
const configPath = path.join(repoRoot, CONFIG);
if (!fs.existsSync(configPath)) {
  console.error(
    `secret-scan: ${CONFIG} is missing from the repository root.\n` +
      "The CI secret-scan job reads that file, so a scan without it would apply a\n" +
      "different ruleset than CI and its result would be meaningless."
  );
  process.exit(2);
}

const probe = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  const lines = [
    "secret-scan: SKIPPED — gitleaks is not installed.",
    "",
    "  This is the local mirror of the CI `secret-scan` job. That job runs from a",
    "  pinned action and still enforces the scan on every push, so nothing is",
    "  unguarded — you just will not hear about a finding until CI reports it.",
    "",
    "  Install it to get the answer before you push:  brew install gitleaks",
  ];
  console.log(lines.join("\n"));
  process.exit(0);
}

const version = (probe.stdout || "").trim();
console.log(`secret-scan: gitleaks ${version} — scanning the working tree`);

// --redact keeps a finding's value out of the terminal and out of any CI log.
// --exit-code=2 distinguishes "leaks found" (2) from an operational failure (1).
const result = spawnSync(
  "gitleaks",
  [
    "dir",
    repoRoot,
    "--config",
    configPath,
    "--redact",
    "--no-banner",
    "--exit-code=2",
  ],
  { stdio: "inherit" }
);

if (result.error) {
  console.error(`secret-scan: could not run gitleaks — ${result.error.message}`);
  process.exit(1);
}

if (result.status === 2) {
  console.error(
    "\nsecret-scan: findings above. If a flagged value is a test fixture, do NOT\n" +
      "allowlist its directory — .gitleaks.toml deliberately stopped exempting test\n" +
      "paths after a real credential once leaked from one. Mark the specific line\n" +
      "with an inline `gitleaks:allow` comment and state why the value is inert."
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`secret-scan: gitleaks exited ${result.status}`);
  process.exit(1);
}

console.log("secret-scan: no findings.");
