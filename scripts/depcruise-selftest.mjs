// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * dependency-cruiser boundary self-test (guards gap-analysis #11).
 *
 * The original `.dependency-cruiser.cjs` shipped a `types-is-leaf` rule whose
 * `from` glob (`^packages/types/src`) matched ZERO modules — `types` has no
 * `src/`, its declarations live at `packages/types/index.d.ts` — so the rule
 * could never fire and silently provided no protection. dependency-cruiser does
 * NOT treat a rule that matches no modules as an error, so this rot is invisible
 * to `npm run lint:boundaries`.
 *
 * This self-test closes that hole: it cruises the workspace exactly as
 * `lint:boundaries` does, then asserts that every boundary rule's `from` scope
 * reaches at least one real module. If a future edit re-introduces a glob that
 * matches nothing (or the `lint:boundaries` `--include-only` glob drops a
 * package the rules target), this check fails CI instead of passing vacuously.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, ".dependency-cruiser.cjs");

// The same include-only scope used by `lint:boundaries`.
const INCLUDE_ONLY = "^packages/([^/]+/src|types/)";

// Load the forbidden-rule set from the real config so this test always tracks it.
const require = createRequire(import.meta.url);
const config = require(configPath);
const rules = (config.forbidden || []).filter(
  (r) => r.from && typeof r.from.path === "string",
);

// Cruise the workspace once, as JSON.
let raw;
try {
  raw = execFileSync(
    "npx",
    [
      "depcruise",
      "packages",
      "--include-only",
      INCLUDE_ONLY,
      "--config",
      configPath,
      "--no-progress",
      "--output-type",
      "json",
    ],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
  );
} catch (err) {
  // depcruise exits non-zero when there ARE violations, but still prints JSON.
  raw = err.stdout;
  if (!raw) {
    console.error("depcruise self-test: could not obtain cruise output.");
    console.error(String(err && err.stderr ? err.stderr : err));
    process.exit(1);
  }
}

const result = JSON.parse(raw);
const sources = result.modules.map((m) => m.source);

const deadRules = [];
for (const rule of rules) {
  const re = new RegExp(rule.from.path);
  const matches = sources.filter((s) => re.test(s));
  if (matches.length === 0) {
    deadRules.push(rule.name);
  }
}

if (deadRules.length > 0) {
  console.error(
    "depcruise self-test FAILED: the following boundary rule(s) match ZERO " +
      "modules and can never fire (dead rule / silent no-op):",
  );
  for (const name of deadRules) console.error(`  - ${name}`);
  console.error(
    "\nFix the rule's `from` path, or widen the `lint:boundaries` " +
      "`--include-only` glob so the targeted package is in scope.",
  );
  process.exit(1);
}

console.log(
  `depcruise self-test OK: all ${rules.length} boundary rule(s) reach ` +
    `at least one of ${sources.length} cruised modules.`,
);
